// Migration screens' server side: upload validation and streaming, safety guards, the merged
// workspace view and the rule that stored passwords and tokens never reach the browser.
import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerRoutes } from "../src/routes";
import { registerMigrate } from "../src/migrate/routes";
import { validateUpload, withoutSecrets, collisionOf, mergeWorkspaces, headerSafe, decisionOf, SOURCE_TECHNOLOGIES, TARGET_TECHNOLOGIES } from "../src/migrate/options";
import type { Config } from "../src/config";

const MT = "http://localhost:30900";
const cfg = { MT_BASE_URL: MT, MT_ADMIN_TOKEN: "tok", SESSION_SECRET: "x".repeat(20), MT_UPLOAD_LIMIT_MB: 1, MT_COMPARE_APIS: "orders-exp,stock-sys" } as unknown as Config;

function app(signedIn = true) {
  const a = Fastify();
  a.register(cookie, { secret: "x".repeat(20) });
  a.decorate("tokenFor", async () => (signedIn ? "access" : null));
  a.addHook("onRequest", async (req) => { (req as any).cookies = { sid: "s" }; (req as any).unsignCookie = () => ({ value: "sid1" }); });
  registerRoutes(a as any, cfg);
  registerMigrate(a as any, cfg);
  return a;
}
afterEach(() => nock.cleanAll());

describe("upload validation", () => {
  const ok = { name: "Orders", workspace: "Shop", filename: "orders.zip", target: "wso2" };
  it("builds the headers the migration tool expects", () => {
    expect(validateUpload(ok, 10, 5)).toEqual({ ok: true, headers: { "X-Name": "Orders", "X-Filename": "orders.zip", "X-Target-Tech": "wso2", "X-Workspace": "Shop" } });
    expect(validateUpload({ name: "Spec", filename: "api.json", sourceType: "spec" }, 10, 5)).toMatchObject({ ok: true, headers: { "X-Source-Type": "spec", "X-Target-Tech": "wso2" } });
    expect(validateUpload({ ...ok, filename: "C:\\work\\orders.JAR" }, 10, 5)).toMatchObject({ ok: true, headers: { "X-Filename": "orders.JAR" } });
  });
  it("explains what is wrong", () => {
    expect(validateUpload({ ...ok, name: " " }, 10, 5)).toMatchObject({ ok: false, status: 400 });
    expect(validateUpload({ ...ok, filename: "" }, 10, 5)).toMatchObject({ ok: false, status: 400 });
    expect(validateUpload({ ...ok, filename: "orders.tar.gz" }, 10, 5)).toMatchObject({ ok: false, status: 400 });
    expect(validateUpload({ ...ok, filename: "api.json" }, 10, 5)).toMatchObject({ ok: false, status: 400 });
    expect(validateUpload({ ...ok, sourceType: "spec" }, 10, 5)).toMatchObject({ ok: false, status: 400 });
    expect(validateUpload({ ...ok, target: "cobol" }, 10, 5)).toMatchObject({ ok: false, status: 400 });
    expect(validateUpload(ok, undefined, 5)).toMatchObject({ ok: false, status: 411 });
    expect(validateUpload(ok, 0, 5)).toMatchObject({ ok: false, status: 400 });
    expect(validateUpload(ok, 6 * 1024 * 1024, 5)).toMatchObject({ ok: false, status: 413 });
  });
  it("keeps header values plain", () => {
    expect(headerSafe("Café \"orders\"\r\nX-Evil: 1")).toBe("Caf- orders--X-Evil: 1");
    expect(headerSafe("a".repeat(300)).length).toBe(120);
  });
  it("offers every technology the migration tool reads and says what to do with anything else", () => {
    const ids = SOURCE_TECHNOLOGIES.map((t) => t.id);
    for (const id of ["auto", "mule4", "ibm", "oracle", "boomi", "webmethods", "workato", "dotnet", "java", "ballerina", "openapi", "spec", "other"]) expect(ids).toContain(id);
    expect(SOURCE_TECHNOLOGIES.find((t) => t.id === "other")!.hint).toMatch(/OpenAPI/);
    expect(TARGET_TECHNOLOGIES.find((t) => t.id === "wso2")!.depth).toBe("full");
  });
});

describe("secrets and workspaces", () => {
  it("replaces stored passwords and tokens by a flag", () => {
    expect(withoutSecrets({ name: "n", token: "abc", servers: { dev: { host: "h", password: "p" }, qa: { host: "", password: "" } }, list: [{ secret: "s" }] }))
      .toEqual({ name: "n", tokenSet: true, servers: { dev: { host: "h", passwordSet: true }, qa: { host: "", passwordSet: false } }, list: [{ secretSet: true }] });
  });
  it("finds another migration that produced the same API", () => {
    const list = [{ id: "a", apiName: "orders-proc-api" }, { id: "b", apiName: "orders-proc-api" }, { id: "c" }, { id: "d", apiName: "other" }];
    expect(collisionOf(list, "a")?.id).toBe("b");
    expect(collisionOf(list, "c")).toBeUndefined();
    expect(collisionOf(list, "d")).toBeUndefined();
    expect(collisionOf(list, "zz")).toBeUndefined();
  });
  it("merges workspace names from migrations with servers and environments", () => {
    const out = mergeWorkspaces(
      [{ name: "Shop", total: 2, deployed: 1, failed: 0 }],
      [{ id: "w1", name: "shop", servers: { dev: { host: "10.0.0.1", password: "p" } } }, { id: "w2", name: "Empty" }],
      [{ id: "e1", name: "Test", workspace: "Shop", baseUrl: "http://t", token: "tk" }],
      [{ id: "m1", name: "Orders", workspace: "Shop", progress: { outcome: "Deployed", overallPercent: 100 } }, { id: "m2", name: "Stock", workspace: "Shop", busy: true }, { id: "m3", name: "Loose" }],
    );
    expect(out.map((w) => w.name)).toEqual(["Shop", "Unassigned", "Empty"]);
    expect(out[0]).toMatchObject({ total: 2, deployed: 1, inProgress: 1 });
    expect(out[0].migrations).toHaveLength(2);
    expect(out[0].config).toMatchObject({ id: "w1", servers: { dev: { host: "10.0.0.1", passwordSet: true } } });
    expect(out[0].environments).toEqual([{ id: "e1", name: "Test", workspace: "Shop", baseUrl: "http://t", tokenSet: true }]);
    expect(out[1]).toMatchObject({ total: 1 });
    expect(JSON.stringify(out)).not.toContain("\"tk\"");
  });
  it("does not count a service that is installed but not finished as deployed or as in progress", () => {
    const out = mergeWorkspaces([{ name: "Shop", total: 5, deployed: 2, unfinished: 2, failed: 0 }], [], [], []);
    expect(out[0]).toMatchObject({ total: 5, deployed: 2, unfinished: 2, inProgress: 1 });
  });
});

describe("migration routes", () => {
  it("streams an upload to the migration tool with its headers", async () => {
    const body = Buffer.from("PK-not-really-a-zip");
    const scope = nock(MT, { reqheaders: { "x-admin-token": "tok", "x-name": "Orders", "x-workspace": "Shop", "x-filename": "orders.zip", "x-target-tech": "wso2", "content-length": String(body.length) } })
      .post("/api/migrations", (b) => Buffer.from(b, typeof b === "string" && /^[0-9a-f]+$/i.test(b) ? "hex" : "utf8").toString() === body.toString())
      .reply(201, { id: "new1", name: "Orders" });
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations?name=Orders&workspace=Shop&filename=orders.zip&target=wso2", headers: { "content-type": "application/octet-stream" }, payload: body });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ id: "new1", name: "Orders" });
    expect(scope.isDone()).toBe(true);
  });
  it("refuses a bad upload before contacting the migration tool", async () => {
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations?name=Orders&filename=orders.exe", headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("x") });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/not accepted/);
    const big = await app().inject({ method: "POST", url: "/api/factory/migrations?name=Orders&filename=orders.zip", headers: { "content-type": "application/octet-stream" }, payload: Buffer.alloc(1024 * 1024 + 10) });
    expect(big.statusCode).toBe(413);
    const anon = await app(false).inject({ method: "POST", url: "/api/factory/migrations?name=Orders&filename=orders.zip", headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("x") });
    expect(anon.statusCode).toBe(401);
  });
  it("asks before a step would replace an API another migration produced", async () => {
    const list = { migrations: [{ id: "m1", name: "Old", apiName: "orders-proc-api" }, { id: "m2", name: "New", apiName: "orders-proc-api" }] };
    nock(MT).get("/api/migrations").reply(200, list);
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations/m2/run/scaffold", payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ needsConfirm: true, apiName: "orders-proc-api", otherMigration: { id: "m1" } });
    const run = nock(MT).post("/api/migrations/m2/run/scaffold").reply(202, { ok: true });
    const again = await app().inject({ method: "POST", url: "/api/factory/migrations/m2/run/scaffold", payload: { confirmReplace: true } });
    expect(again.statusCode).toBe(202);
    expect(run.isDone()).toBe(true);
  });
  it("lets read-only steps through without the check and rejects unknown steps", async () => {
    const run = nock(MT).post("/api/migrations/m1/run/document").reply(202, { ok: true });
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations/m1/run/document", payload: {} });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ ok: true, ran: "document" });
    expect(run.isDone()).toBe(true);
    expect((await app().inject({ method: "POST", url: "/api/factory/migrations/m1/run/erase", payload: {} })).statusCode).toBe(404);
  });
  it("only produces documents when asked to run everything before the API name is known", async () => {
    nock(MT).get("/api/migrations").reply(200, { migrations: [{ id: "m9", name: "Fresh" }] });
    nock(MT).get("/api/migrations/m9").reply(200, { id: "m9", name: "Fresh" });
    const run = nock(MT).post("/api/migrations/m9/run/document").reply(202, { ok: true });
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations/m9/run/autorun", payload: {} });
    expect(r.json()).toMatchObject({ ran: "document" });
    expect(run.isDone()).toBe(true);
  });
  it("keeps the record of a deployed or running migration", async () => {
    nock(MT).get("/api/migrations/m1").reply(200, { id: "m1", progress: { outcome: "Deployed" } });
    expect((await app().inject({ method: "DELETE", url: "/api/factory/migrations/m1" })).statusCode).toBe(409);
    nock(MT).get("/api/migrations/m2").reply(200, { id: "m2", busy: true });
    expect((await app().inject({ method: "DELETE", url: "/api/factory/migrations/m2" })).statusCode).toBe(409);
    nock(MT).get("/api/migrations/m3").reply(200, { id: "m3", progress: { outcome: "Failed" } });
    const del = nock(MT).delete("/api/migrations/m3").reply(200, { ok: true });
    expect((await app().inject({ method: "DELETE", url: "/api/factory/migrations/m3" })).statusCode).toBe(200);
    expect(del.isDone()).toBe(true);
  });
  it("serves a generated document as text and as a download", async () => {
    nock(MT).get("/api/migrations/m1/docs/MAPPING.md").times(2).reply(200, "# Mapping\n", { "content-type": "text/markdown" });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/docs/MAPPING.md" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/markdown");
    expect(r.body).toBe("# Mapping\n");
    const d = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/docs/MAPPING.md?download=1" });
    expect(d.headers["content-disposition"]).toContain("attachment");
    nock(MT).get("/api/migrations/m1/docs/ESTIMATE.md").reply(404, { error: "no" });
    expect((await app().inject({ method: "GET", url: "/api/factory/migrations/m1/docs/ESTIMATE.md" })).statusCode).toBe(404);
  });
  it("shows workspaces from migrations even when no target server is defined", async () => {
    nock(MT).get("/api/workspaces").reply(200, { workspaces: [{ name: "Shop", total: 1, deployed: 1, failed: 0 }] });
    nock(MT).get("/api/workspace-configs").reply(200, { workspaces: [] });
    nock(MT).get("/api/environments").reply(200, { environments: [{ id: "e1", name: "T", workspace: "Shop", baseUrl: "http://t", token: "tk" }] });
    nock(MT).get("/api/migrations").reply(200, { migrations: [{ id: "m1", name: "Orders", workspace: "Shop" }] });
    const r = await app().inject({ method: "GET", url: "/api/factory/workspaces" });
    expect(r.json().workspaces).toHaveLength(1);
    expect(r.json().workspaces[0]).toMatchObject({ name: "Shop", total: 1, config: null });
    expect(r.body).not.toContain("\"tk\"");
  });
  it("validates an environment and never returns its token", async () => {
    expect((await app().inject({ method: "POST", url: "/api/factory/environments", payload: { name: "x", baseUrl: "ftp://x" } })).statusCode).toBe(400);
    nock(MT).post("/api/environments").reply(201, { id: "e2", name: "x", baseUrl: "http://x", token: "tk" });
    const r = await app().inject({ method: "POST", url: "/api/factory/environments", payload: { name: "x", baseUrl: "http://x", token: "tk" } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ id: "e2", name: "x", baseUrl: "http://x", tokenSet: true });
  });
  it("passes the user's request on for a check and a comparison of an API the tool can reach", async () => {
    const body = { envId: "e1", method: "GET", path: "/orders/1", headers: {} };
    const verify = nock(MT).post("/api/migrations/m1/verify", body).reply(200, { ok: true, status: 200 });
    expect((await app().inject({ method: "POST", url: "/api/factory/migrations/m1/verify", payload: body })).json().ok).toBe(true);
    expect(verify.isDone()).toBe(true);
    nock(MT).get("/api/migrations/m1").reply(200, { id: "m1", apiName: "orders-exp-api" });
    const parity = nock(MT).post("/api/migrations/m1/parity", body).reply(200, { match: true });
    expect((await app().inject({ method: "POST", url: "/api/factory/migrations/m1/parity", payload: body })).json().match).toBe(true);
    expect(parity.isDone()).toBe(true);
  });

  it("refuses to compare or optimise an API the tool would confuse with another one", async () => {
    for (const action of ["parity", "optimize"]) {
      if (action === "optimize") nock(MT).get("/api/migrations").reply(200, { migrations: [{ id: "m5", apiName: "billing-sys-api" }] });
      nock(MT).get("/api/migrations/m5").reply(200, { id: "m5", apiName: "billing-sys-api", layer: "system" });
      const r = await app().inject({ method: "POST", url: `/api/factory/migrations/m5/${action}`, payload: { envId: "e1", method: "POST", path: "/x" } });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatch(/cannot/);
    }
    expect(nock.pendingMocks()).toEqual([]);
  });

  it("offers the server connection check but not the install", async () => {
    const check = nock(MT).post("/api/workspace-configs/w1/provision/dev").reply(200, { ok: true, preflight: true });
    expect((await app().inject({ method: "POST", url: "/api/factory/workspace-configs/w1/check/dev" })).statusCode).toBe(200);
    expect(check.isDone()).toBe(true);
    expect((await app().inject({ method: "POST", url: "/api/factory/workspace-configs/w1/check/moon" })).statusCode).toBe(400);
    expect((await app().inject({ method: "POST", url: "/api/factory/workspace-configs/w1/provision/dev" })).statusCode).toBe(404);
  });
});

describe("finish this migration", () => {
  it("accepts the four decisions and forwards only their own fields", () => {
    expect(decisionOf({ id: "op:GET /items/{itemId}", action: "forward", backend: "catalogue", method: "get", path: " /items/{itemId} ", extra: "x" }))
      .toEqual({ ok: true, decision: { id: "op:GET /items/{itemId}", action: "forward", backend: "catalogue", method: "GET", path: "/items/{itemId}" } });
    expect(decisionOf({ id: "entry:nightlyFlow", action: "not_needed", reason: "no longer used", url: "http://x" }))
      .toEqual({ ok: true, decision: { id: "entry:nightlyFlow", action: "not_needed", reason: "no longer used" } });
    expect(decisionOf({ id: "backend:catalogue", action: "address", url: "https://catalogue.internal:8443/api" })).toMatchObject({ ok: true });
    expect(decisionOf({ id: "op:POST /pay", action: "note", note: "Calls the payment API and returns its receipt." })).toMatchObject({ ok: true });
    // an address taken from the old settings travels as the name of the settings file, never as an address
    expect(decisionOf({ id: "backend:catalogue", action: "address", from: " shore/uat ", url: "https://typed.example/api" }))
      .toEqual({ ok: true, decision: { id: "backend:catalogue", action: "address", from: "shore/uat" } });
    expect(decisionOf({ id: "op:ANY /db", action: "reopen", reason: "x", note: "y" })).toEqual({ ok: true, decision: { id: "op:ANY /db", action: "reopen" } });
  });
  it("passes a call on to an API the service does not know yet, and a confirmation only when it is a plain true", () => {
    expect(decisionOf({ id: "op:POST /points", action: "forward", newBackend: { name: " loyalty   engine ", url: " https://loyalty.internal/api ", token: "x" }, backend: "ignored", method: "post", path: "/points", confirm: true }))
      .toEqual({ ok: true, decision: { id: "op:POST /points", action: "forward", newBackend: { name: "loyalty engine", url: "https://loyalty.internal/api" }, method: "POST", path: "/points", confirm: true } });
    expect(decisionOf({ id: "op:GET /a", action: "forward", backend: "a", method: "GET", path: "/a", confirm: "yes" }))
      .toEqual({ ok: true, decision: { id: "op:GET /a", action: "forward", backend: "a", method: "GET", path: "/a" } });
    const bad = (b: unknown) => { const r = decisionOf(b); return r.ok ? "" : r.error; };
    expect(bad({ id: "op:GET /a", action: "forward", newBackend: { name: "1st", url: "https://x.internal" }, method: "GET", path: "/a" })).toMatch(/short name/);
    expect(bad({ id: "op:GET /a", action: "forward", newBackend: { name: "loyalty", url: "loyalty.internal" }, method: "GET", path: "/a" })).toMatch(/address of the new API/);
    expect(bad({ id: "op:GET /a", action: "forward", newBackend: { name: "loyalty", url: "https://x.internal/\"x" }, method: "GET", path: "/a" })).toMatch(/address of the new API/);
    expect(bad({ id: "op:GET /a", action: "forward", newBackend: { name: "loyalty", url: "https://x.internal" }, method: "GET", path: "a" })).toMatch(/path/);
    expect(bad({ id: "op:GET /a", action: "forward", newBackend: [], method: "GET", path: "/a" })).toMatch(/Choose the API/);
  });
  it("says what is wrong with a decision", () => {
    const bad = (b: unknown) => { const r = decisionOf(b); return r.ok ? "" : r.error; };
    expect(bad(null)).toMatch(/item/);
    expect(bad({ id: "x", action: "note", note: "abc" })).toMatch(/item/);
    expect(bad({ id: "op:GET /a", action: "forward", backend: "a b", method: "GET", path: "/a" })).toMatch(/API/);
    expect(bad({ id: "op:GET /a", action: "forward", backend: "a", method: "TRACE", path: "/a" })).toMatch(/method/);
    expect(bad({ id: "op:GET /a", action: "forward", backend: "a", method: "GET", path: "a?x=`1`" })).toMatch(/path/);
    expect(bad({ id: "op:GET /a", action: "forward", backend: "a", method: "GET", path: "/a${x}" })).toMatch(/path/);
    expect(bad({ id: "op:GET /a", action: "not_needed", reason: "" })).toMatch(/why/);
    expect(bad({ id: "backend:a", action: "address", url: "ftp://x" })).toMatch(/http/);
    expect(bad({ id: "backend:a", action: "address", url: "http://a b" })).toMatch(/http/);
    expect(bad({ id: "backend:a", action: "address", from: "../../etc/passwd" })).toMatch(/listed environments/);
    expect(bad({ id: "backend:a", action: "address", from: "uat\"; rm" })).toMatch(/listed environments/);
    expect(bad({ id: "op:GET /a", action: "delete" })).toMatch(/cannot/);
  });
  it("reads what is open from the tool and needs a signed-in user", async () => {
    const open = nock(MT).get("/api/migrations/m1/open-items").reply(200, { api: "orders-exp-api", exists: true, ready: false, items: [{ id: "op:GET /a", kind: "operation", title: "GET /a", can: ["forward"] }], closed: [], backends: ["stock"] });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/open-items" });
    expect(r.statusCode).toBe(200);
    expect(r.json().items[0].id).toBe("op:GET /a");
    expect(open.isDone()).toBe(true);
    expect((await app(false).inject({ method: "GET", url: "/api/factory/migrations/m1/open-items" })).statusCode).toBe(401);
    expect((await app(false).inject({ method: "POST", url: "/api/factory/migrations/m1/resolve", payload: { id: "op:GET /a", action: "note", note: "abc" } })).statusCode).toBe(401);
  });
  it("sends a checked decision on, passes a refusal back and stops a malformed one", async () => {
    const sent = nock(MT).post("/api/migrations/m1/resolve", { id: "op:GET /a", action: "forward", backend: "stock", method: "GET", path: "/a" }).reply(200, { ok: true, changed: true, message: "GET /a is now passed on to stock.", openItems: { items: [] } });
    const ok = await app().inject({ method: "POST", url: "/api/factory/migrations/m1/resolve", payload: { id: "op:GET /a", action: "forward", backend: "stock", method: "GET", path: "/a", token: "nope" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().changed).toBe(true);
    expect(sent.isDone()).toBe(true);
    nock(MT).post("/api/migrations/m1/resolve").reply(409, { error: "A step of this migration is running. Try again when it has finished." });
    const busy = await app().inject({ method: "POST", url: "/api/factory/migrations/m1/resolve", payload: { id: "op:GET /a", action: "not_needed", reason: "unused" } });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatch(/running/);
    const bad = await app().inject({ method: "POST", url: "/api/factory/migrations/m1/resolve", payload: { id: "op:GET /a", action: "forward", backend: "stock", method: "GET", path: "no-slash" } });
    expect(bad.statusCode).toBe(400);
    expect(nock.pendingMocks()).toEqual([]);
  });
});
