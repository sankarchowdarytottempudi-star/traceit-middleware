// Customer servers, environments and releases: only each action's own fields travel on, the
// signed-in user is the one recorded, and write-only values never come back.
import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerServers, serverActionBody, environmentsBody, settingsBody } from "../src/servers/routes";
import type { Config } from "../src/config";

const MT = "http://localhost:30900";
const cfg = { MT_BASE_URL: MT, MT_ADMIN_TOKEN: "tok", SESSION_SECRET: "x".repeat(20) } as unknown as Config;

function app(signedIn = true) {
  const a = Fastify();
  a.register(cookie, { secret: "x".repeat(20) });
  a.decorate("tokenFor", async () => (signedIn ? "access" : null));
  a.decorate("userFor", async () => "ana.lopez");
  a.addHook("onRequest", async (req) => { (req as any).cookies = { sid: "s" }; (req as any).unsignCookie = () => ({ value: "sid1" }); });
  registerServers(a as any, cfg);
  return a;
}
afterEach(() => nock.cleanAll());

describe("body checks", () => {
  it("passes on only what each server action takes", () => {
    expect(serverActionBody("trust-host-key", { fingerprint: " SHA256:abcdefghijklmnopqrstuvwxyz0123 ", x: 1 })).toEqual({ ok: true, body: { fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123" } });
    expect(serverActionBody("trust-host-key", { fingerprint: "md5:aa" })).toMatchObject({ ok: false });
    expect(serverActionBody("install-key", { password: "pw\nx" })).toMatchObject({ ok: false });
    expect(serverActionBody("install", { dryRun: "yes" })).toEqual({ ok: true, body: { dryRun: false } });
    expect(serverActionBody("uninstall", { confirm: true, purge: "true" })).toEqual({ ok: true, body: { confirm: true, purge: false } });
    expect(serverActionBody("preflight", { anything: 1 })).toEqual({ ok: true, body: {} });
  });
  it("checks environments and settings", () => {
    expect(environmentsBody({ environments: [{ name: "UAT", server: "uat", approval: "yes" }, { name: "prod", server: "prod", approval: true }] }))
      .toEqual({ ok: true, body: { environments: [{ name: "uat", server: "uat", approval: false }, { name: "prod", server: "prod", approval: true }] } });
    expect(environmentsBody({ environments: [] })).toMatchObject({ ok: false });
    expect(environmentsBody({ environments: [{ name: "a b", server: "uat" }] })).toMatchObject({ ok: false });
    expect(settingsBody({ text: " " })).toMatchObject({ ok: false });
    expect(settingsBody({ text: "x".repeat(201 * 1024) })).toMatchObject({ ok: false });
  });
});

describe("routes", () => {
  it("refuses when not signed in", async () => {
    const r = await app(false).inject({ method: "GET", url: "/api/factory/workspace-configs/w1" });
    expect(r.statusCode).toBe(401);
  });
  it("records the signed-in user, not one the browser sends", async () => {
    let seen: any = null;
    nock(MT).post("/api/workspace-configs/w1/servers/uat/install", (b) => { seen = b; return true; }).reply(202, { started: true, job: { id: "j1" } });
    const r = await app().inject({ method: "POST", url: "/api/factory/workspace-configs/w1/servers/uat/install", payload: { dryRun: true, by: "mallory" } });
    expect(r.statusCode).toBe(202);
    expect(seen).toEqual({ dryRun: true, by: "ana.lopez" });
  });
  it("forwards the one-time password and never returns it", async () => {
    let seen: any = null;
    nock(MT).post("/api/workspace-configs/w1/servers/uat/install-key", (b) => { seen = b; return true; }).reply(200, { ok: true, message: "The password was not kept." });
    const r = await app().inject({ method: "POST", url: "/api/factory/workspace-configs/w1/servers/uat/install-key", payload: { password: "S3cret-pw!" } });
    expect(r.statusCode).toBe(200);
    expect(seen.password).toBe("S3cret-pw!");
    expect(r.body).not.toContain("S3cret-pw!");
  });
  it("forwards settings text only to its environment and API, answers with the key count", async () => {
    let seen: any = null;
    nock(MT).post("/api/workspace-configs/w1/environments/uat/settings/zoho-sys-api", (b) => { seen = b; return true; }).reply(200, { ok: true, keys: 2 });
    const text = 'url = "https://x"\npassword = "Very-Secret-1"\n';
    const r = await app().inject({ method: "POST", url: "/api/factory/workspace-configs/w1/environments/uat/settings/zoho-sys-api", payload: { text } });
    expect(r.json()).toEqual({ ok: true, keys: 2 });
    expect(seen).toEqual({ text, by: "ana.lopez" });
    const bad = await app().inject({ method: "POST", url: "/api/factory/workspace-configs/w1/environments/uat/settings/Bad_Api", payload: { text } });
    expect(bad.statusCode).toBe(404);
  });
  it("needs a named approver and sends only the promotion fields", async () => {
    const a = app();
    expect((await a.inject({ method: "POST", url: "/api/factory/releases/r1/approve", payload: { env: "prod", approver: "x" } })).statusCode).toBe(400);
    let ap: any = null, pr: any = null;
    nock(MT).post("/api/releases/r1/approve", (b) => { ap = b; return true; }).reply(200, { ok: true });
    nock(MT).post("/api/workspace-configs/w1/promote", (b) => { pr = b; return true; }).reply(202, { started: true, job: { id: "j2" } });
    await a.inject({ method: "POST", url: "/api/factory/releases/r1/approve", payload: { env: "prod", approver: "Head of IT", note: "ok" } });
    await a.inject({ method: "POST", url: "/api/factory/workspace-configs/w1/promote", payload: { api: "zoho-sys-api", from: "uat", to: "prod", approval: { by: "forged" } } });
    expect(ap).toEqual({ env: "prod", approver: "Head of IT", note: "ok", by: "ana.lopez" });
    expect(pr).toEqual({ api: "zoho-sys-api", from: "uat", to: "prod", by: "ana.lopez" });
  });
  it("rejects unknown actions and ids", async () => {
    const a = app();
    expect((await a.inject({ method: "POST", url: "/api/factory/workspace-configs/w1/servers/uat/rm-rf" })).statusCode).toBe(404);
    expect((await a.inject({ method: "GET", url: "/api/factory/workspace-configs/w1/servers/uat/key-file" })).statusCode).toBe(404);
    expect((await a.inject({ method: "GET", url: "/api/factory/jobs/..%2F" })).statusCode).toBe(404);
  });
});
