import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerRoutes } from "../src/routes";
import type { Config } from "../src/config";

const MT = "http://localhost:30900";
const cfg = { MT_BASE_URL: MT, MT_ADMIN_TOKEN: "tok", SESSION_SECRET: "x".repeat(20) } as unknown as Config;

function app(signedIn = true) {
  const a = Fastify();
  a.register(cookie, { secret: "x".repeat(20) });
  a.decorate("tokenFor", async () => (signedIn ? "access" : null));
  // minimal cookie presence so need() reads a sid
  a.addHook("onRequest", async (req) => { (req as any).cookies = { sid: "s" }; (req as any).unsignCookie = () => ({ value: "sid1" }); });
  registerRoutes(a as any, cfg);
  return a;
}
afterEach(() => nock.cleanAll());

describe("factory routes proxy to the migration-tool with the admin token", () => {
  it("lists migrations and injects X-Admin-Token", async () => {
    const scope = nock(MT, { reqheaders: { "x-admin-token": "tok" } }).get("/api/migrations").reply(200, { migrations: [{ id: "m1" }] });
    const a = app();
    const r = await a.inject({ method: "GET", url: "/api/factory/migrations" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ migrations: [{ id: "m1" }] });
    expect(scope.isDone()).toBe(true);
  });
  it("forwards the playground proxy POST body", async () => {
    nock(MT).post("/api/proxy", { api: "cms", path: "/x" }).reply(200, { status: 200, body: "real" });
    const a = app();
    const r = await a.inject({ method: "POST", url: "/api/factory/proxy", payload: { api: "cms", path: "/x" } });
    expect(r.json()).toMatchObject({ status: 200, body: "real" });
  });
  it("rejects when not signed in", async () => {
    const a = app(false);
    const r = await a.inject({ method: "GET", url: "/api/factory/knowledge" });
    expect(r.statusCode).toBe(401);
  });
  it("blocks unknown migration actions", async () => {
    const a = app();
    const r = await a.inject({ method: "POST", url: "/api/factory/migrations/m1/danger" });
    expect(r.statusCode).toBe(404);
  });
});
