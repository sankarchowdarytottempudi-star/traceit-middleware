// The Factory's side of sign-in: same users file as the Gateway, Migration role needed for its
// routes, the review workbench left to its own sign-in, cookie scoped to /factory.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import nock from "nock";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { factoryRule, switchRoleOf } from "../src/auth";
import { UserStore } from "../src/access/userStore";
import { hashPassword } from "../src/access/passwords";
import { createAuditLog } from "../src/access/audit";
import type { Config } from "../src/config";
import type { SessionStore } from "../src/sessionStore";

function memoryStore(): SessionStore {
  const m = new Map<string, unknown>();
  return { get: async (k: string) => (m.get(k) ?? null) as never, set: async (k: string, v: unknown) => { m.set(k, v); }, del: async (k: string) => { m.delete(k); } } as unknown as SessionStore;
}
const APIM = "https://wso2.test";
const cfg = {
  PUBLIC_BASE_URL: "https://weave.example.com/factory", APIM_BASE_URL: APIM, APIM_PUBLIC_URL: APIM, caPem: "", SESSION_SECRET: "x".repeat(24),
  APIM_DCR_USERNAME: "svc", APIM_DCR_PASSWORD: "pw",
  MT_BASE_URL: "http://localhost:30900", MT_ADMIN_TOKEN: "tok", RUNTIME_URL: "http://127.0.0.1:1", RUNTIME_INTERNAL_KEY: "", K8S_NAMESPACE: "wso2",
  ESTATE_NODE_HOST: "127.0.0.1", MT_UPLOAD_LIMIT_MB: 5, MT_COMPARE_APIS: "", DATA_DIR: ".data", PORT: 0,
} as unknown as Config;

describe("which role each Factory address needs", () => {
  it.each([["/api/auth/me", "public"], ["/api/review/info", "public"], ["/api/review", "public"], ["/api/factory/migrations", "migration"], ["/api/studio/*", "migration"], ["/api/reviewers", "migration"]])("%s -> %s", (p, r) => {
    expect(factoryRule(p)).toBe(r);
  });
  it("switching APIs on and off: apim:admin for API Manager sign-ins, the Gateway role otherwise", () => {
    expect(switchRoleOf({ sid: "", user: "a", name: "a", email: "", provider: "local", roles: ["migration", "gateway"], serviceAccount: true })).toBe("admin");
    expect(switchRoleOf({ sid: "", user: "a", name: "a", email: "", provider: "oidc", roles: ["migration", "admin"], serviceAccount: true })).toBe("viewer");
    expect(switchRoleOf({ sid: "", user: "a", name: "a", email: "", provider: "wso2", roles: ["migration"], serviceAccount: false, session: { expiresAt: 0, user: "a", tokens: { access_token: "x", expires_in: 1, scope: "apim:admin" } } })).toBe("admin");
  });
});

describe("Factory with local accounts in the shared users file", () => {
  let app: FastifyInstance; let dir: string; const keep = { ...process.env };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "fac-access-"));
    const spa = join(dir, "spa"); mkdirSync(spa); writeFileSync(join(spa, "index.html"), "<html><head></head><body></body></html>");
    const hash = await hashPassword("a good long password");
    new UserStore(join(dir, "users.json")).update((d) => {
      d.users.push({ id: "m", email: "mig@x.com", name: "Mig", provider: "local", roles: ["migration"], disabled: false, passwordHash: hash, createdAt: "", updatedAt: "" });
      d.users.push({ id: "g", email: "gw@x.com", name: "Gw", provider: "local", roles: ["gateway"], disabled: false, passwordHash: hash, createdAt: "", updatedAt: "" });
    });
    Object.assign(process.env, { SPA_DIR: spa, LOG_LEVEL: "silent", AUTH_PROVIDER: "local", WEAVE_USERS_FILE: join(dir, "users.json") });
    app = await buildServer(cfg, { clientId: "cid", clientSecret: "sec" }, memoryStore());
  });
  afterAll(async () => { await app.close(); process.env = keep; rmSync(dir, { recursive: true, force: true }); });
  afterEach(() => nock.cleanAll());

  async function signIn(email: string) {
    const r = await app.inject({ method: "POST", url: "/factory/api/auth/local", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `email=${encodeURIComponent(email)}&password=a+good+long+password` });
    expect(r.statusCode).toBe(302); expect(r.headers.location).toBe("/factory/");
    const c = r.cookies.find((k) => k.name === "weave_factory_sid")!;
    expect(c).toMatchObject({ path: "/factory", httpOnly: true, secure: true });
    return { weave_factory_sid: c.value };
  }

  it("the sign-in page is the Factory's, under its path", async () => {
    const r = await app.inject({ url: "/factory/api/auth/login" });
    expect(r.statusCode).toBe(200); expect(r.body).toContain('action="/factory/api/auth/local"'); expect(r.body).toContain("Factory");
  });

  it("a Migration user gets in; API Manager is called with the service account; the change is audited", async () => {
    const cookies = await signIn("mig@x.com");
    const me = (await app.inject({ url: "/factory/api/auth/me", cookies })).json();
    expect(me).toMatchObject({ user: "mig@x.com", provider: "local", roles: ["migration"], role: "viewer" });
    nock(APIM).post("/oauth2/token", (b) => b.grant_type === "password" && b.username === "svc").reply(200, { access_token: "svc-token", expires_in: 3600 });
    expect(await app.tokenFor(cookies.weave_factory_sid.split(".")[0])).toBe("svc-token");
    nock("http://localhost:30900").post("/api/proxy").reply(200, { status: 200 });
    const r = await app.inject({ method: "POST", url: "/factory/api/factory/proxy", cookies, payload: { api: "cms", path: "/x" } });
    expect(r.statusCode).toBe(200);
    const log = createAuditLog(join(dir, "audit.jsonl"), "t").read();
    expect(log[0]).toMatchObject({ user: "mig@x.com", app: "factory", action: "POST /api/factory/proxy", via: "service-account" });
  });

  it("a Gateway-only user is turned away from the Factory's routes with a plain message", async () => {
    const cookies = await signIn("gw@x.com");
    const r = await app.inject({ url: "/factory/api/factory/migrations", cookies });
    expect(r.statusCode).toBe(403);
    expect(r.json().title).toBe("You do not have access to Migration (Factory). Ask an administrator to grant it.");
    expect((await app.inject({ url: "/factory/api/auth/me", cookies })).json().roles).toEqual(["gateway"]);
  });

  it("not signed in: 401; unknown addresses: 404; the review workbench keeps its own sign-in", async () => {
    expect((await app.inject({ url: "/factory/api/factory/migrations" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/factory/api/nothing-here" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/factory/api/review/info" })).statusCode).not.toBe(401);
  });
});
