// New from requirements: the requirement document goes to the migration tool as it is (X-Source-Type: requirements),
// the review workbook and the blank template come down, the reviewed workbook goes up, and the service is generated.
import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerRoutes } from "../src/routes";
import { registerMigrate, REQUIREMENTS_MAX } from "../src/migrate/routes";
import { validateUpload, REQUIREMENT_EXTENSIONS } from "../src/migrate/options";
import type { Config } from "../src/config";

const MT = "http://localhost:30900";
const cfg = { MT_BASE_URL: MT, MT_ADMIN_TOKEN: "tok", SESSION_SECRET: "x".repeat(20), MT_UPLOAD_LIMIT_MB: 5 } as unknown as Config;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const WORKBOOK = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("stand-in review workbook")]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("stand-in requirement document")]);

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
afterEach(() => nock.cleanAll());

describe("validateUpload for a requirement document", () => {
  const q = { name: "Order intake", filename: "order-intake.docx", sourceType: "requirements", target: "workato", workspace: "Shop" };
  it("accepts the document types and passes the source type on", () => {
    expect(REQUIREMENT_EXTENSIONS).toEqual([".docx", ".xlsx", ".md", ".txt", ".pdf"]);
    expect(validateUpload(q, 10, 5)).toEqual({ ok: true, headers: { "X-Name": "Order intake", "X-Filename": "order-intake.docx", "X-Target-Tech": "workato", "X-Source-Type": "requirements", "X-Workspace": "Shop" } });
    for (const f of ["a.xlsx", "a.md", "a.txt", "a.PDF"]) expect(validateUpload({ ...q, filename: f }, 10, 5)).toMatchObject({ ok: true });
  });
  it("refuses other files, unknown targets, empty and too large documents", () => {
    expect(validateUpload({ ...q, filename: "orders.zip" }, 10, 5)).toMatchObject({ ok: false, status: 400 });
    expect(validateUpload({ ...q, filename: "notes.json" }, 10, 5)).toMatchObject({ ok: false, status: 400 });
    expect(validateUpload({ ...q, target: "cobol" }, 10, 5)).toMatchObject({ ok: false, status: 400 });
    expect(validateUpload(q, 0, 5)).toMatchObject({ ok: false, status: 400 });
    expect(validateUpload(q, undefined, 5)).toMatchObject({ ok: false, status: 411 });
    expect(validateUpload(q, 6 * 1024 * 1024, 5)).toMatchObject({ ok: false, status: 413 });
    expect(validateUpload(q, 26 * 1024 * 1024, 500)).toMatchObject({ ok: false, status: 413 });
  });
  it("a document is not a source upload", () => {
    expect(validateUpload({ ...q, sourceType: undefined }, 10, 5)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("create from a requirement document", () => {
  it("streams the document as it is (never wrapped) with the source type", async () => {
    let got: Buffer | null = null;
    nock(MT, { reqheaders: { "x-admin-token": "tok", "x-source-type": "requirements", "x-filename": "order-intake.md", "x-target-tech": "workato", "x-name": "Order intake" } })
      .post("/api/migrations", (b) => { got = Buffer.from(b, "hex"); return true; })
      .reply(201, { id: "m1", sourceType: "requirements", phases: [], progress: {} });
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations?name=Order%20intake&filename=order-intake.md&sourceType=requirements&target=workato",
      headers: { "content-type": "application/octet-stream" }, payload: DOCX });
    expect(r.statusCode).toBe(201);
    expect(r.json().id).toBe("m1");
    expect(got).not.toBeNull();
  });
  it("tells the options what a requirement document may be", async () => {
    const r = await app().inject({ method: "GET", url: "/api/factory/migrate/options" });
    expect(r.json().requirements).toEqual({ extensions: [".docx", ".xlsx", ".md", ".txt", ".pdf"], maxMb: 5 });
  });
});

describe("workbooks down", () => {
  it("passes the review workbook on with its name", async () => {
    nock(MT, { reqheaders: { "x-admin-token": "tok" } }).get("/api/migrations/m1/requirements.xlsx")
      .reply(200, WORKBOOK, { "Content-Type": XLSX, "Content-Disposition": 'attachment; filename="order-intake-api-requirements-review.xlsx"' });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/requirements.xlsx" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("spreadsheetml");
    expect(r.headers["content-disposition"]).toBe('attachment; filename="order-intake-api-requirements-review.xlsx"');
    expect(r.rawPayload.equals(WORKBOOK)).toBe(true);
  });
  it("passes the blank template on, with and without a migration", async () => {
    nock(MT).get("/api/requirements/template.xlsx").reply(200, WORKBOOK, { "Content-Type": XLSX, "Content-Disposition": 'attachment; filename="requirements-template.xlsx"' });
    const r = await app().inject({ method: "GET", url: "/api/factory/requirements/template.xlsx" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-disposition"]).toBe('attachment; filename="requirements-template.xlsx"');
    nock(MT).get("/api/migrations/m1/requirements-template.xlsx").reply(200, WORKBOOK, { "Content-Type": XLSX });
    const r2 = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/requirements-template.xlsx" });
    expect(r2.statusCode).toBe(200);
    expect(r2.headers["content-disposition"]).toBe('attachment; filename="requirements-template.xlsx"');
  });
  it("says in plain words why there is none", async () => {
    nock(MT).get("/api/migrations/m1/requirements.xlsx").reply(409, { error: "The requirement document has not been read yet." });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/requirements.xlsx" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("The requirement document has not been read yet.");
    nock(MT).get("/api/migrations/m1/requirements.xlsx").reply(200, "<html>", { "Content-Type": "text/html" });
    expect((await app().inject({ method: "GET", url: "/api/factory/migrations/m1/requirements.xlsx" })).statusCode).toBe(502);
  });
  it("needs a signed-in user", async () => {
    expect((await app(false).inject({ method: "GET", url: "/api/factory/migrations/m1/requirements.xlsx" })).statusCode).toBe(401);
    expect((await app(false).inject({ method: "GET", url: "/api/factory/requirements/template.xlsx" })).statusCode).toBe(401);
  });
});

describe("reviewed workbook up", () => {
  const up = (a: ReturnType<typeof app>, payload: Buffer, id = "m1") =>
    a.inject({ method: "POST", url: `/api/factory/migrations/${id}/requirements`, headers: { "content-type": "application/octet-stream" }, payload });
  it("sends the file as it is, with who sent it, and passes the answer on", async () => {
    let got: string | null = null;
    nock(MT, { reqheaders: { "x-admin-token": "tok", "content-type": "application/octet-stream", "x-user": "anna@example.com" } })
      .post("/api/migrations/m1/requirements", (b) => { got = String(b); return true; })
      .reply(200, { ok: true, changes: [{ action: "answer", id: "Q1", answer: "ZB2B" }], openQuestions: 2, review: { at: "x", by: "anna@example.com", changes: 1, openQuestions: 2 } });
    const r = await up(app(), WORKBOOK);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, openQuestions: 2 });
    expect(got).toContain("stand-in review workbook");      // the workbook, not a re-encoded copy
  });
  it("passes the rows that need fixing on with status 400", async () => {
    const errors = [{ sheet: "Rules", row: 3, problem: "Action \"maybe\" is not one of: (empty), change, delete, add" }];
    nock(MT).post("/api/migrations/m1/requirements").reply(400, { ok: false, error: "1 row of the workbook needs fixing.", errors });
    const r = await up(app(), WORKBOOK);
    expect(r.statusCode).toBe(400);
    expect(r.json().errors).toEqual(errors);
  });
  it("refuses what is not a workbook, an empty upload and a too large one without asking the tool", async () => {
    const scope = nock(MT).post("/api/migrations/m1/requirements").reply(500, {});
    expect((await up(app(), Buffer.from("name,action\n"))).statusCode).toBe(400);
    expect((await up(app(), Buffer.alloc(0))).statusCode).toBe(400);
    expect((await up(app(), Buffer.concat([WORKBOOK, Buffer.alloc(REQUIREMENTS_MAX)]))).statusCode).toBe(413);
    expect(scope.isDone()).toBe(false);
  });
  it("needs a signed-in user", async () => {
    expect((await up(app(false), WORKBOOK)).statusCode).toBe(401);
  });
});

describe("generate", () => {
  it("is a step the tool runs, with the tool's refusal passed on", async () => {
    nock(MT).get("/api/migrations").reply(200, { migrations: [{ id: "m1", apiName: null }] });
    nock(MT).post("/api/migrations/m1/run/generate").reply(202, { ok: true, message: "started" });
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations/m1/run/generate", payload: {} });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ ok: true, ran: "generate" });
    nock(MT).get("/api/migrations").reply(200, { migrations: [] });
    nock(MT).post("/api/migrations/m2/run/generate").reply(409, { ok: false, message: "The requirement document has not been read yet." });
    const r2 = await app().inject({ method: "POST", url: "/api/factory/migrations/m2/run/generate", payload: {} });
    expect(r2.statusCode).toBe(409);
  });
  it("does not write over another migration's API unless asked", async () => {
    nock(MT).get("/api/migrations").reply(200, { migrations: [{ id: "m1", apiName: "order-intake-api", name: "mine" }, { id: "m9", apiName: "order-intake-api", name: "other", progress: { outcome: "Deployed" } }] });
    const scope = nock(MT).post("/api/migrations/m1/run/generate").reply(202, { ok: true });
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations/m1/run/generate", payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ needsConfirm: true, otherMigration: { id: "m9" } });
    expect(scope.isDone()).toBe(false);
    nock(MT).get("/api/migrations").reply(200, { migrations: [] });
    const r2 = await app().inject({ method: "POST", url: "/api/factory/migrations/m1/run/generate", payload: { confirmReplace: true } });
    expect(r2.statusCode).toBe(202);
  });
});
