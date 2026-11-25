// The Factory server's own sign-in page per edition (WEAVE_EDITION read when the server starts).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server";
import type { Config } from "../src/config";
import type { SessionStore } from "../src/sessionStore";

const FORBIDDEN = /traceit-tottech|traceit|tottempudi/i;
function memoryStore(): SessionStore {
  const m = new Map<string, unknown>();
  return { get: async (k: string) => (m.get(k) ?? null) as never, set: async (k: string, v: unknown) => { m.set(k, v); }, del: async (k: string) => { m.delete(k); } } as unknown as SessionStore;
}
const cfg = {
  PUBLIC_BASE_URL: "https://weave.example.com/factory", APIM_BASE_URL: "https://wso2.test", APIM_PUBLIC_URL: "https://wso2.test", caPem: "", SESSION_SECRET: "x".repeat(24),
  APIM_DCR_USERNAME: "svc", APIM_DCR_PASSWORD: "pw",
  MT_BASE_URL: "http://localhost:30900", MT_ADMIN_TOKEN: "tok", RUNTIME_URL: "http://127.0.0.1:1", RUNTIME_INTERNAL_KEY: "", K8S_NAMESPACE: "wso2",
  ESTATE_NODE_HOST: "127.0.0.1", MT_UPLOAD_LIMIT_MB: 5, MT_COMPARE_APIS: "", DATA_DIR: ".data", PORT: 0,
} as unknown as Config;

async function signInPageFor(edition: string | undefined): Promise<string> {
  const keep = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "fac-edition-"));
  const spa = join(dir, "spa"); mkdirSync(spa); writeFileSync(join(spa, "index.html"), "<html><head></head><body></body></html>");
  Object.assign(process.env, { SPA_DIR: spa, LOG_LEVEL: "silent", AUTH_PROVIDER: "local", WEAVE_USERS_FILE: join(dir, "users.json") });
  delete process.env.WEAVE_PRODUCT_NAME; delete process.env.VITE_WEAVE_EDITION;
  if (edition) process.env.WEAVE_EDITION = edition; else delete process.env.WEAVE_EDITION;
  const app = await buildServer(cfg, { clientId: "cid", clientSecret: "sec" }, memoryStore());
  try {
    const r = await app.inject({ url: "/factory/api/auth/login" });
    expect(r.statusCode).toBe(200);
    return r.body;
  } finally {
    await app.close(); process.env = keep; rmSync(dir, { recursive: true, force: true });
  }
}

describe("Factory sign-in page per edition", () => {
  it("TraceIT (default): TraceIT Weave", async () => {
    const body = await signInPageFor(undefined);
    expect(body).toContain("<h1>TraceIT Weave</h1>");
  });
  it("Cruise Saudi: Cruise Saudi Weave and nothing of TraceIT/Tottempudi", async () => {
    const body = await signInPageFor("cruise-saudi");
    expect(body).toContain("<title>Sign in · Cruise Saudi Weave</title>");
    expect(body).toContain("<h1>Cruise Saudi Weave</h1>");
    expect(body).not.toMatch(FORBIDDEN);
  });
});
