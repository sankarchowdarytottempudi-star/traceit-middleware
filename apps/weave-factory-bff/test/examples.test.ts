// "Test data": examples (request and the answer expected) go to the migration tool as checked JSON
// or as the filled workbook; the list, the workbook and the suggestions come back as the tool sends them.
import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerRoutes } from "../src/routes";
import { registerMigrate } from "../src/migrate/routes";
import { examplesOf, EXAMPLES_MAX, EXAMPLES_XLSX_MAX } from "../src/migrate/examples";
import type { Config } from "../src/config";

const MT = "http://localhost:30900";
const cfg = { MT_BASE_URL: MT, MT_ADMIN_TOKEN: "tok", SESSION_SECRET: "x".repeat(20), MT_UPLOAD_LIMIT_MB: 1 } as unknown as Config;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const WORKBOOK = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("stand-in workbook")]);
const OP = { kind: "operation", operation: "GET /orders/{orderId}", name: "found", request: { method: "GET", path: "/orders/7", pathParams: { orderId: "7" } }, response: { status: 200, body: { id: 7 } } };

function app(signedIn = true, user: string | null = "anna@example.com") {
  const a = Fastify();
  a.register(cookie, { secret: "x".repeat(20) });
  a.decorate("tokenFor", async () => (signedIn ? "access" : null));
  a.decorate("userFor", async () => (signedIn ? user : null));
  a.addHook("onRequest", async (req) => { (req as any).cookies = { sid: "s" }; (req as any).unsignCookie = () => ({ value: "sid1" }); });
  registerRoutes(a as any, cfg);
  registerMigrate(a as any, cfg);
  return a;
}
const upXlsx = (a: ReturnType<typeof app>, payload: Buffer, type = XLSX) =>
  a.inject({ method: "POST", url: "/api/factory/migrations/m1/examples", headers: { "content-type": type }, payload });
afterEach(() => nock.cleanAll());

describe("checks", () => {
  it("keeps only the fields of each kind of example", () => {
    const r = examplesOf({ examples: [
      { ...OP, note: " n ", hack: 1 },
      { kind: "step", step: "T-1a2b3c4d", input: { a: 1 }, output: { b: 1 }, request: { x: 1 } },
      { id: "E-12345678", delete: true, operation: "ignored" },
    ] });
    expect(r).toEqual({ ok: true, examples: [
      { kind: "operation", operation: OP.operation, name: "found", note: "n", request: OP.request, response: OP.response },
      { kind: "step", step: "T-1a2b3c4d", input: { a: 1 }, output: { b: 1 } },
      { kind: "operation", id: "E-12345678", delete: true },
    ] });
  });
  it("says in plain words what is missing", () => {
    expect(examplesOf({})).toEqual({ ok: false, error: "No examples were sent." });
    expect(examplesOf({ examples: [{ kind: "thing" }] }).ok).toBe(false);
    expect(examplesOf({ examples: [{ ...OP, response: undefined }] })).toEqual({ ok: false, error: "Give the answer you expect for each example." });
    expect(examplesOf({ examples: [{ kind: "step", step: "T-1", input: 1 }] }).ok).toBe(false);
    expect(examplesOf({ examples: [{ delete: true }] })).toEqual({ ok: false, error: "Say which example to remove." });
    expect(examplesOf({ examples: [{ ...OP, operation: "GET /a\nPOST /b" }] }).ok).toBe(false);
  });
});

describe("the examples and the suggestions", () => {
  it("passes the list on", async () => {
    nock(MT, { reqheaders: { "x-admin-token": "tok" } }).get("/api/migrations/m1/examples")
      .reply(200, { api: "orders-api", operations: [], todoSteps: [], examples: [], contract: {}, counts: { examples: 0, operations: 0, steps: 0 } });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/examples" });
    expect(r.statusCode).toBe(200);
    expect(r.json().api).toBe("orders-api");
  });
  it("passes the tool's refusal on in its words", async () => {
    nock(MT).get("/api/migrations/m1/examples").reply(409, { error: "There are no documents yet." });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/examples" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("There are no documents yet.");
  });
  it("passes the suggestions on", async () => {
    nock(MT).get("/api/migrations/m1/examples/suggestions").reply(200, { api: "orders-api", suggestions: [{ id: "T-1", status: "nothing", why: "No step example." }] });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/examples/suggestions" });
    expect(r.statusCode).toBe(200);
    expect(r.json().suggestions[0].why).toBe("No step example.");
  });
  it("says the tool did not answer when it is down", async () => {
    nock(MT).get("/api/migrations/m1/examples").replyWithError("connection refused");
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/examples" });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/did not answer/);
  });
  it("needs a signed-in user", async () => {
    expect((await app(false).inject({ method: "GET", url: "/api/factory/migrations/m1/examples" })).statusCode).toBe(401);
    expect((await app(false).inject({ method: "GET", url: "/api/factory/migrations/m1/examples/suggestions" })).statusCode).toBe(401);
    expect((await app(false).inject({ method: "POST", url: "/api/factory/migrations/m1/examples", payload: { examples: [OP] } })).statusCode).toBe(401);
  });
});

describe("save examples as JSON", () => {
  it("sends the checked examples with who sent them, and the tool's answer back", async () => {
    let got: any = null;
    nock(MT, { reqheaders: { "x-user": "anna@example.com", "content-type": "application/json" } })
      .post("/api/migrations/m1/examples", (b) => { got = b; return true; })
      .reply(202, { ok: true, applied: 1, rerun: true, changes: [{ id: "E-1", action: "added", kind: "operation", summary: "found" }], removed: [], message: "Kept." });
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations/m1/examples", payload: { examples: [{ ...OP, extra: true }], other: 1 } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ ok: true, applied: 1, rerun: true });
    expect(got).toEqual({ examples: [{ kind: "operation", operation: OP.operation, name: "found", request: OP.request, response: OP.response }] });
  });
  it("passes the rows the tool could not accept on with 422", async () => {
    const errors = [{ id: "E-1", problem: "No such operation." }];
    nock(MT).post("/api/migrations/m1/examples").reply(422, { ok: false, errors, error: "1 example was not accepted." });
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations/m1/examples", payload: { examples: [OP] } });
    expect(r.statusCode).toBe(422);
    expect(r.json().errors).toEqual(errors);
  });
  it("refuses a malformed request and more than 2 MB without asking the tool", async () => {
    const scope = nock(MT).post("/api/migrations/m1/examples").reply(500, {});
    expect((await app().inject({ method: "POST", url: "/api/factory/migrations/m1/examples", payload: { examples: "x" } })).statusCode).toBe(400);
    const big = { examples: [{ ...OP, request: { ...OP.request, body: "x".repeat(EXAMPLES_MAX) } }] };
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations/m1/examples", payload: big });
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toMatch(/2 MB/);
    expect(scope.isDone()).toBe(false);
  });
});

describe("the examples workbook", () => {
  it("passes the workbook on with its name", async () => {
    nock(MT, { reqheaders: { "x-admin-token": "tok" } }).get("/api/migrations/m1/examples.xlsx")
      .reply(200, WORKBOOK, { "Content-Type": XLSX, "Content-Disposition": 'attachment; filename="orders-api-examples.xlsx"' });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/examples.xlsx" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("spreadsheetml");
    expect(r.headers["content-disposition"]).toBe('attachment; filename="orders-api-examples.xlsx"');
    expect(r.rawPayload.equals(WORKBOOK)).toBe(true);
  });
  it("says in plain words why there is none", async () => {
    nock(MT).get("/api/migrations/m1/examples.xlsx").reply(404, { error: "This migration has no operations yet." });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/examples.xlsx" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe("This migration has no operations yet.");
    nock(MT).get("/api/migrations/m1/examples.xlsx").reply(200, "<html>", { "Content-Type": "text/html" });
    expect((await app().inject({ method: "GET", url: "/api/factory/migrations/m1/examples.xlsx" })).statusCode).toBe(502);
    expect((await app(false).inject({ method: "GET", url: "/api/factory/migrations/m1/examples.xlsx" })).statusCode).toBe(401);
  });
  it("sends the filled workbook as a workbook, with who sent it", async () => {
    let got: Buffer | null = null;
    nock(MT, { reqheaders: { "x-admin-token": "tok", "content-type": XLSX, "x-user": "anna@example.com" } })
      .post("/api/migrations/m1/examples", (b) => { got = Buffer.from(b, "hex"); return true; })
      .reply(202, { ok: true, applied: 3, rerun: true, changes: [], removed: ["request header Authorization removed (secret)"], message: "Kept." });
    const r = await upXlsx(app(), WORKBOOK);
    expect(r.statusCode).toBe(202);
    expect(r.json().removed).toEqual(["request header Authorization removed (secret)"]);
    expect(got).not.toBeNull();
    nock(MT, { reqheaders: { "content-type": XLSX } }).post("/api/migrations/m1/examples").reply(200, { ok: true, applied: 0, rerun: false, message: "Nothing changed." });
    expect((await upXlsx(app(), WORKBOOK, "application/octet-stream")).statusCode).toBe(200);
  });
  it("refuses what is not a workbook, an empty upload and a too large one without asking the tool", async () => {
    const scope = nock(MT).post("/api/migrations/m1/examples").reply(500, {});
    expect((await upXlsx(app(), Buffer.from("name,request\nfoo,{}"))).statusCode).toBe(400);
    expect((await upXlsx(app(), Buffer.alloc(0))).statusCode).toBe(400);
    expect((await upXlsx(app(), Buffer.concat([WORKBOOK, Buffer.alloc(EXAMPLES_XLSX_MAX)]))).statusCode).toBe(413);
    expect(scope.isDone()).toBe(false);
  });
  it("passes the rows of the workbook that need fixing on", async () => {
    const errors = [{ sheet: "Examples", row: 4, problem: "The request body is not valid JSON." }];
    nock(MT).post("/api/migrations/m1/examples").reply(422, { ok: false, errors, error: "1 row needs fixing." });
    const r = await upXlsx(app(), WORKBOOK);
    expect(r.statusCode).toBe(422);
    expect(r.json().errors).toEqual(errors);
  });
});
