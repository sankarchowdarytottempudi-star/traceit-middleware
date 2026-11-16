// Choosing which part of a Node.js project a migration covers: only the part's own fields travel on.
import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerParts, partOf, scopeHeaderOf } from "../src/migrate/parts";
import { validateUpload } from "../src/migrate/options";
import type { Config } from "../src/config";

const MT = "http://localhost:30900";
const cfg = { MT_BASE_URL: MT, MT_ADMIN_TOKEN: "tok", SESSION_SECRET: "x".repeat(20) } as unknown as Config;
function app(signedIn = true) {
  const a = Fastify();
  a.register(cookie, { secret: "x".repeat(20) });
  a.decorate("tokenFor", async () => (signedIn ? "access" : null));
  a.addHook("onRequest", async (req) => { (req as any).cookies = { sid: "s" }; (req as any).unsignCookie = () => ({ value: "sid1" }); });
  registerParts(a as any, cfg);
  return a;
}
afterEach(() => nock.cleanAll());

describe("choosing a part", () => {
  it("accepts a prefix, a module or routes, and drops anything else", () => {
    expect(partOf({ prefix: " /api/mobile/check-in ", workers: true, name: "check-in-wrapper-api", extra: 1 }))
      .toEqual({ ok: true, spec: { prefix: "/api/mobile/check-in", workers: true, name: "check-in-wrapper-api" }, keepService: false, confirm: false });
    expect(partOf({ routes: ["POST /a", "POST /a", "GET /b"] })).toMatchObject({ ok: true, spec: { routes: ["GET /b", "POST /a"] } });
    expect(partOf({ module: "src/modules/mobile", keepService: true })).toMatchObject({ ok: true, keepService: true });
    expect(partOf({})).toMatchObject({ ok: false });
    expect(partOf({ prefix: "../etc" })).toMatchObject({ ok: false });
    expect(partOf({ routes: ["DROP TABLE x"] })).toMatchObject({ ok: false });
    expect(partOf({ prefix: "/a", name: "Bad Name" })).toMatchObject({ ok: false });
    expect(partOf({ prefix: "/a", workers: "yes" })).toMatchObject({ ok: true, spec: { prefix: "/a" } });
  });
  it("turns the part chosen at upload into the tool's header", () => {
    expect(scopeHeaderOf(undefined)).toEqual({ ok: true });
    expect(scopeHeaderOf('{"prefix":"/api/x","junk":1}')).toEqual({ ok: true, header: '{"prefix":"/api/x"}' });
    expect(scopeHeaderOf("not json")).toMatchObject({ ok: false });
    const v = validateUpload({ name: "Check in", filename: "app.zip", scope: '{"module":"src/modules/mobile"}' }, 10, 5);
    expect(v).toMatchObject({ ok: true, headers: { "X-Scope": '{"module":"src/modules/mobile"}' } });
    expect(validateUpload({ name: "Check in", filename: "app.zip", scope: "{}" }, 10, 5)).toMatchObject({ ok: false, status: 400 });
  });
  it("passes the routes list and the part on, signed in only", async () => {
    nock(MT).get("/api/migrations/m1/routes").reply(200, { routes: [{ method: "POST", path: "/api/mobile/check-in/submit", file: "src/a.js" }] });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/routes" });
    expect(r.statusCode).toBe(200);
    expect(r.json().routes).toHaveLength(1);
    let sent: any = null;
    nock(MT).post("/api/migrations/m1/scope", (b) => { sent = b; return true; }).reply(200, { ok: true, message: "The part is changed." });
    const s = await app().inject({ method: "POST", url: "/api/factory/migrations/m1/scope", payload: { prefix: "/api/mobile/check-in", keepService: true, password: "x" } });
    expect(s.statusCode).toBe(200);
    expect(sent).toEqual({ prefix: "/api/mobile/check-in", keepService: true });
    const bad = await app().inject({ method: "POST", url: "/api/factory/migrations/m1/scope", payload: {} });
    expect(bad.statusCode).toBe(400);
    const anon = await app(false).inject({ method: "GET", url: "/api/factory/migrations/m1/routes" });
    expect(anon.statusCode).toBe(401);
  });
});
