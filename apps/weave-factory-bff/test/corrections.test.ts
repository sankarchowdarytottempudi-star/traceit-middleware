// Corrections: the analysis workbook goes down, the corrected workbook goes up, both through the
// migration tool. Status and answer of the tool reach the screen as they are.
import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerRoutes } from "../src/routes";
import { registerMigrate, CORRECTIONS_MAX } from "../src/migrate/routes";
import type { Config } from "../src/config";

const MT = "http://localhost:30900";
const cfg = { MT_BASE_URL: MT, MT_ADMIN_TOKEN: "tok", SESSION_SECRET: "x".repeat(20), MT_UPLOAD_LIMIT_MB: 1 } as unknown as Config;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const WORKBOOK = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("stand-in workbook")]);

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
const up = (a: ReturnType<typeof app>, payload: Buffer, id = "m1") =>
  a.inject({ method: "POST", url: `/api/factory/migrations/${id}/corrections`, headers: { "content-type": "application/octet-stream" }, payload });
afterEach(() => nock.cleanAll());

describe("download the analysis workbook", () => {
  it("passes the workbook on with its name", async () => {
    nock(MT, { reqheaders: { "x-admin-token": "tok" } }).get("/api/migrations/m1/corrections.xlsx")
      .reply(200, WORKBOOK, { "Content-Type": XLSX, "Content-Disposition": 'attachment; filename="orders-api-corrections.xlsx"' });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/corrections.xlsx" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("spreadsheetml");
    expect(r.headers["content-disposition"]).toBe('attachment; filename="orders-api-corrections.xlsx"');
    expect(r.rawPayload.equals(WORKBOOK)).toBe(true);
  });
  it("says in plain words why there is none", async () => {
    nock(MT).get("/api/migrations/m1/corrections.xlsx").reply(404, { error: "There are no documents yet." });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/corrections.xlsx" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe("There are no documents yet.");
    nock(MT).get("/api/migrations/m1/corrections.xlsx").reply(409, { error: "A step of this migration is running." });
    expect((await app().inject({ method: "GET", url: "/api/factory/migrations/m1/corrections.xlsx" })).statusCode).toBe(409);
    nock(MT).get("/api/migrations/m1/corrections.xlsx").reply(200, "<html>", { "Content-Type": "text/html" });
    expect((await app().inject({ method: "GET", url: "/api/factory/migrations/m1/corrections.xlsx" })).statusCode).toBe(502);
  });
  it("needs a signed-in user", async () => {
    expect((await app(false).inject({ method: "GET", url: "/api/factory/migrations/m1/corrections.xlsx" })).statusCode).toBe(401);
  });
});

describe("upload the corrected workbook", () => {
  it("sends the file as it is, with who sent it, and passes the tool's answer on", async () => {
    let got: Buffer | null = null;
    nock(MT, { reqheaders: { "x-admin-token": "tok", "content-type": "application/octet-stream", "x-user": "anna@example.com" } })
      .post("/api/migrations/m1/corrections", (b) => { got = Buffer.from(b, "hex"); return true; })
      .reply(202, { ok: true, rerun: true, applied: { changed: 2, added: 0, deleted: 1, marked: 0 }, changes: [{ sheet: "Operations", id: "op-3", action: "change", summary: "x" }] });
    const r = await up(app(), WORKBOOK);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ ok: true, rerun: true, applied: { changed: 2, deleted: 1 } });
    expect(got).not.toBeNull();
  });
  it("passes the rows that need fixing on with status 400", async () => {
    const errors = [{ sheet: "Fields", row: 4, problem: "Action must be change, delete, add, live or dead" }];
    nock(MT).post("/api/migrations/m1/corrections").reply(400, { ok: false, error: "1 row of the workbook needs fixing.", errors });
    const r = await up(app(), WORKBOOK);
    expect(r.statusCode).toBe(400);
    expect(r.json().errors).toEqual(errors);
  });
  it("passes a refusal of the tool on (a step is running, checked-only package)", async () => {
    nock(MT).post("/api/migrations/m1/corrections").reply(409, { ok: false, error: "A step of this migration is running." });
    expect((await up(app(), WORKBOOK)).statusCode).toBe(409);
  });
  it("refuses what is not a workbook, an empty upload and a too large one without asking the tool", async () => {
    const scope = nock(MT).post("/api/migrations/m1/corrections").reply(500, {});
    expect((await up(app(), Buffer.from("name,action\nfoo,change"))).statusCode).toBe(400);
    expect((await up(app(), Buffer.alloc(0))).statusCode).toBe(400);
    expect((await up(app(), Buffer.concat([WORKBOOK, Buffer.alloc(CORRECTIONS_MAX)]))).statusCode).toBe(413);
    expect(scope.isDone()).toBe(false);
  });
  it("needs a signed-in user and leaves the user header out when the name is not known", async () => {
    expect((await up(app(false), WORKBOOK)).statusCode).toBe(401);
    nock(MT, { badheaders: ["x-user"] }).post("/api/migrations/m1/corrections").reply(202, { ok: true });
    expect((await up(app(true, null), WORKBOOK)).statusCode).toBe(202);
  });
  it("is not mistaken for another migration action", async () => {
    nock(MT).post("/api/migrations/m2/corrections").reply(202, { ok: true });
    expect((await up(app(), WORKBOOK, "m2")).statusCode).toBe(202);
  });
});

describe("download the importable package", () => {
  const PKG = Buffer.from("PK\x03\x04 workato package");
  it("passes the package file on with its name", async () => {
    nock(MT, { reqheaders: { "x-admin-token": "tok" } }).get("/api/migrations/m1/package")
      .reply(200, PKG, { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="pay-api-workato-package.zip"' });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/package" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/zip");
    expect(r.headers["content-disposition"]).toBe('attachment; filename="pay-api-workato-package.zip"');
    expect(r.rawPayload.equals(PKG)).toBe(true);
  });
  it("says in plain words when there is none", async () => {
    nock(MT).get("/api/migrations/m1/package").reply(404, { error: "This Workato project has no package to import." });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/package" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe("This Workato project has no package to import.");
    nock(MT).get("/api/migrations/m1/package").reply(200, "<html>", { "Content-Type": "text/html" });
    expect((await app().inject({ method: "GET", url: "/api/factory/migrations/m1/package" })).statusCode).toBe(502);
    expect((await app(false).inject({ method: "GET", url: "/api/factory/migrations/m1/package" })).statusCode).toBe(401);
  });
});
