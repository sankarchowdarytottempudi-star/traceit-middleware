import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { basePath } from "../src/auth";
import type { Config } from "../src/config";
import type { SessionStore } from "../src/sessionStore";

// The Factory can share the Weave address with the Gateway: https://host/factory.
const HTML = `<!doctype html><html><head>
<link rel="icon" href="./brand/favicon.svg" /><script type="module" crossorigin src="./assets/index-abc.js"></script>
</head><body><div id="root"></div></body></html>`;

function memoryStore(): SessionStore {
  const m = new Map<string, unknown>();
  return { get: async (k: string) => (m.get(k) ?? null) as never, set: async (k: string, v: unknown) => { m.set(k, v); }, del: async (k: string) => { m.delete(k); } } as unknown as SessionStore;
}
const cfgFor = (publicUrl: string) => ({
  PUBLIC_BASE_URL: publicUrl, APIM_BASE_URL: "https://wso2.test", APIM_PUBLIC_URL: "https://wso2.test", caPem: "", SESSION_SECRET: "x".repeat(24),
  MT_BASE_URL: "http://localhost:30900", MT_ADMIN_TOKEN: "tok", RUNTIME_URL: "http://127.0.0.1:1", RUNTIME_INTERNAL_KEY: "", K8S_NAMESPACE: "wso2",
  ESTATE_NODE_HOST: "127.0.0.1", MT_UPLOAD_LIMIT_MB: 5, MT_COMPARE_APIS: "", DATA_DIR: ".data", PORT: 0,
} as unknown as Config);

describe("basePath", () => {
  it.each([["https://factory.example.com", ""], ["https://factory.example.com/", ""], ["https://weave.example.com/factory", "/factory"], ["https://weave.example.com/factory/", "/factory"]])("%s -> %j", (u, p) => {
    expect(basePath(u)).toBe(p);
  });
});

describe("served under a path of a shared address", () => {
  let dir: string; let app: FastifyInstance; let keep: string | undefined;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "spa-")); mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), HTML); writeFileSync(join(dir, "assets", "index-abc.js"), "console.log(1)");
    keep = process.env.SPA_DIR; process.env.SPA_DIR = dir; process.env.LOG_LEVEL = "silent";
    app = await buildServer(cfgFor("https://weave.example.com/factory"), { clientId: "cid", clientSecret: "sec" }, memoryStore());
  });
  afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); if (keep === undefined) delete process.env.SPA_DIR; else process.env.SPA_DIR = keep; });

  it("answers its routes with and without the path", async () => {
    expect((await app.inject({ url: "/factory/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/factory/api/auth/me" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/factory/api/nothing-here" })).statusCode).toBe(404);
    // a name that only begins the same way is not the path
    expect((await app.inject({ url: "/factoryx/healthz" })).body).toContain('<meta name="weave-base" content="" />');
  });
  it("reports the installed version on /healthz (WEAVE_VERSION, set by the installer)", async () => {
    const keepV = process.env.WEAVE_VERSION;
    try {
      delete process.env.WEAVE_VERSION;
      expect((await app.inject({ url: "/factory/healthz" })).json()).toEqual({ status: "UP" });
      process.env.WEAVE_VERSION = "1.2.3-test";
      expect((await app.inject({ url: "/factory/healthz" })).json()).toEqual({ status: "UP", version: "1.2.3-test" });
    } finally { if (keepV === undefined) delete process.env.WEAVE_VERSION; else process.env.WEAVE_VERSION = keepV; }
  });
  it.each(["/factory", "/factory/", "/factory/studio/flows/abc", "/factory?tab=1", "/factory/index.html"])("%s is the app, with its files and its place stated", async (url) => {
    const r = await app.inject({ url });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.body).toContain('<meta name="weave-base" content="/factory" />');
    expect(r.body).toContain('src="/factory/assets/index-abc.js"');
    expect(r.body).toContain('href="/factory/brand/favicon.svg"');
  });
  it("asked without the path (health checks, the test instance) the page points at the root", async () => {
    const r = await app.inject({ url: "/studio/flows/abc" });
    expect(r.body).toContain('<meta name="weave-base" content="" />');
    expect(r.body).toContain('src="/assets/index-abc.js"');
  });
  it("serves the files of the app under the path, and never a page in place of a missing file", async () => {
    expect((await app.inject({ url: "/factory/assets/index-abc.js" })).body).toBe("console.log(1)");
    const gone = await app.inject({ url: "/factory/assets/index-old.js" });
    expect(gone.statusCode).toBe(404); expect(gone.body).not.toContain("<html");
  });
  it("starts sign-in with a callback under the path", async () => {
    const r = await app.inject({ url: "/factory/api/auth/login" });
    expect(r.statusCode).toBe(302);
    expect(new URL(String(r.headers.location)).searchParams.get("redirect_uri")).toBe("https://weave.example.com/factory/api/auth/callback");
  });
});

describe("served at the root of its own address", () => {
  it("is unchanged: no path is taken off and the page points at the root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spa-")); writeFileSync(join(dir, "index.html"), HTML);
    const keep = process.env.SPA_DIR; process.env.SPA_DIR = dir;
    const app = await buildServer(cfgFor("https://factory.example.com"), { clientId: "cid", clientSecret: "sec" }, memoryStore());
    try {
      const r = await app.inject({ url: "/factory" });
      expect(r.body).toContain('<meta name="weave-base" content="" />');
      expect(r.body).toContain('src="/assets/index-abc.js"');
      const login = await app.inject({ url: "/api/auth/login" });
      expect(new URL(String(login.headers.location)).searchParams.get("redirect_uri")).toBe("https://factory.example.com/api/auth/callback");
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); if (keep === undefined) delete process.env.SPA_DIR; else process.env.SPA_DIR = keep; }
  });
});
