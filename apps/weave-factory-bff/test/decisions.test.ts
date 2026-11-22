// Open decisions, edited documents, target platform accounts and the import: passed on to the
// migration tool with who made the change; only checked fields travel; tokens never come back.
import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerRoutes } from "../src/routes";
import { registerMigrate } from "../src/migrate/routes";
import { answersOf, docEditOf, docNameOk, targetAccountOf, DOCUMENT_MAX } from "../src/migrate/decisions";
import type { Config } from "../src/config";

const MT = "http://localhost:30900";
const cfg = { MT_BASE_URL: MT, MT_ADMIN_TOKEN: "tok", SESSION_SECRET: "x".repeat(20), MT_UPLOAD_LIMIT_MB: 1 } as unknown as Config;

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

describe("checks", () => {
  it("keeps only the fields of each kind of answer", () => {
    const r = answersOf({ answers: [
      { id: "d1", answer: { type: "connector", connector: "sap", operation: "rfc", extra: "x" }, scope: "workspace", note: " ok ", other: 1 },
      { id: "d2", answer: { type: "call", services: ["a", " ", "b"] } },
      { id: "d3", answer: { type: "drop", text: "ignored" }, scope: "nonsense" },
    ] });
    expect(r).toEqual({ ok: true, answers: [
      { id: "d1", answer: { type: "connector", connector: "sap", operation: "rfc" }, scope: "workspace", note: "ok" },
      { id: "d2", answer: { type: "call", services: ["a", "b"] }, scope: "api" },
      { id: "d3", answer: { type: "drop" }, scope: "api" },
    ] });
    expect(answersOf({ answers: [] }).ok).toBe(false);
    expect(answersOf({ answers: [{ id: "d1", answer: { type: "shell" } }] }).ok).toBe(false);
    expect(answersOf({ answers: [{ id: "d1", answer: { type: "code", language: "java", text: "  " } }] }).ok).toBe(false);
  });
  it("accepts plain document names only", () => {
    expect(docNameOk("MAPPING.md")).toBe(true);
    expect(docNameOk("../etc.md")).toBe(false);
    expect(docNameOk(".hidden.md")).toBe(false);
    expect(docNameOk("_notes.md")).toBe(true);
    expect(docNameOk("analysis.json")).toBe(false);
    expect(docEditOf({ text: "x".repeat(DOCUMENT_MAX + 1) })).toMatchObject({ ok: false, status: 413 });
    expect(docEditOf({ note: "n" })).toMatchObject({ ok: false, status: 400 });
  });
  it("checks a target account and leaves an empty token to the tool", () => {
    expect(targetAccountOf("boomi", { accountId: "acme-AB12", user: "a@acme.com", token: "", extra: 1 })).toEqual({ ok: true, account: { accountId: "acme-AB12", user: "a@acme.com", token: "" } });
    expect(targetAccountOf("workato", { apiBase: "https://app.eu.workato.com", token: "t", parentFolderId: "123" })).toEqual({ ok: true, account: { apiBase: "https://app.eu.workato.com", token: "t", parentFolderId: "123" } });
    expect(targetAccountOf("workato", { apiBase: "https://evil.example.com", token: "t" }).ok).toBe(false);
    expect(targetAccountOf("workato", { apiBase: "https://www.workato.com", token: "t", parentFolderId: "abc" }).ok).toBe(false);
    expect(targetAccountOf("boomi", { accountId: "a b", user: "a@b.c" }).ok).toBe(false);
    expect(targetAccountOf("boomi", { accountId: "acme", user: "a@b.c", token: "x\ny" }).ok).toBe(false);
  });
});

describe("decisions", () => {
  it("passes the list on", async () => {
    nock(MT, { reqheaders: { "x-admin-token": "tok" } }).get("/api/migrations/m1/decisions").reply(200, { api: "orders-api", decisions: [], counts: { open: 0, answered: 0 } });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/decisions" });
    expect(r.statusCode).toBe(200);
    expect(r.json().api).toBe("orders-api");
  });
  it("sends the checked answers with who answered, and the tool's 422 rows back", async () => {
    let got: any = null;
    nock(MT, { reqheaders: { "x-user": "anna@example.com", "content-type": "application/json" } })
      .post("/api/migrations/m1/decisions", (b) => { got = b; return true; })
      .reply(422, { errors: [{ id: "d1", problem: "No such connector." }] });
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations/m1/decisions", payload: { answers: [{ id: "d1", answer: { type: "manual" }, scope: "api", hack: true }] } });
    expect(r.statusCode).toBe(422);
    expect(r.json().errors[0].problem).toBe("No such connector.");
    expect(got).toEqual({ answers: [{ id: "d1", answer: { type: "manual" }, scope: "api" }] });
  });
  it("refuses a malformed request without bothering the tool, and more than 1 MB", async () => {
    expect((await app().inject({ method: "POST", url: "/api/factory/migrations/m1/decisions", payload: { answers: "x" } })).statusCode).toBe(400);
    const big = { answers: [{ id: "d1", answer: { type: "expression", text: "x".repeat(1024 * 1024) } }] };
    expect((await app().inject({ method: "POST", url: "/api/factory/migrations/m1/decisions", payload: big })).statusCode).toBe(413);
  });
  it("needs a signed-in user", async () => {
    expect((await app(false).inject({ method: "GET", url: "/api/factory/migrations/m1/decisions" })).statusCode).toBe(401);
  });
});

describe("documents a person edits", () => {
  it("passes the source text on as text", async () => {
    nock(MT).get("/api/migrations/m1/documents/MAPPING.md/source").reply(200, "# Mapping\n", { "Content-Type": "text/plain" });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/documents/MAPPING.md/source" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/plain");
    expect(r.body).toBe("# Mapping\n");
  });
  it("saves and reverts with who did it, and passes a running step's 409 on", async () => {
    let got: any = null;
    nock(MT, { reqheaders: { "x-user": "anna@example.com" } }).put("/api/migrations/m1/documents/MAPPING.md/source", (b) => { got = b; return true; }).reply(200, { ok: true });
    const r = await app().inject({ method: "PUT", url: "/api/factory/migrations/m1/documents/MAPPING.md/source", payload: { text: "# new", note: "fix", x: 1 } });
    expect(r.statusCode).toBe(200);
    expect(got).toEqual({ text: "# new", note: "fix" });
    nock(MT, { reqheaders: { "x-user": "anna@example.com" } }).delete("/api/migrations/m1/documents/MAPPING.md/source").reply(409, { error: "A step is running." });
    const d = await app().inject({ method: "DELETE", url: "/api/factory/migrations/m1/documents/MAPPING.md/source" });
    expect(d.statusCode).toBe(409);
    expect(d.json().error).toBe("A step is running.");
  });
  it("refuses an odd name and a document over 2 MB", async () => {
    expect((await app().inject({ method: "GET", url: "/api/factory/migrations/m1/documents/..%2Fx.md/source" })).statusCode).toBe(404);
    const big = await app().inject({ method: "PUT", url: "/api/factory/migrations/m1/documents/MAPPING.md/source", payload: { text: "x".repeat(DOCUMENT_MAX + 10) } });
    expect(big.statusCode).toBe(413);
  });
  it("lists the edits", async () => {
    nock(MT).get("/api/migrations/m1/documents/edits").reply(200, { edits: [{ doc: "MAPPING.md", by: "anna", at: "2026-11-21T09:00:00Z", size: 12 }], names: ["MAPPING.md"] });
    const r = await app().inject({ method: "GET", url: "/api/factory/migrations/m1/documents/edits" });
    expect(r.json().names).toEqual(["MAPPING.md"]);
  });
});

describe("target platform accounts and the import", () => {
  it("never passes a token back", async () => {
    nock(MT).get("/api/target-accounts").reply(200, { accounts: [{ target: "boomi", configured: true, hasToken: true, accountId: "****CD12", user: "a***@acme.com", token: "SECRET" }] });
    const r = await app().inject({ method: "GET", url: "/api/factory/target-accounts" });
    expect(r.body).not.toContain("SECRET");
    expect(r.json().accounts[0]).toMatchObject({ accountId: "****CD12", hasToken: true, tokenSet: true });
  });
  it("saves a checked account with who saved it; unknown platforms are refused", async () => {
    let got: any = null;
    nock(MT, { reqheaders: { "x-user": "anna@example.com" } }).put("/api/target-accounts/workato", (b) => { got = b; return true; }).reply(200, { target: "workato", configured: true });
    const r = await app().inject({ method: "PUT", url: "/api/factory/target-accounts/workato", payload: { apiBase: "https://www.workato.com", token: "t1", junk: "x" } });
    expect(r.statusCode).toBe(200);
    expect(got).toEqual({ apiBase: "https://www.workato.com", token: "t1" });
    expect((await app().inject({ method: "PUT", url: "/api/factory/target-accounts/mule", payload: {} })).statusCode).toBe(404);
    expect((await app().inject({ method: "PUT", url: "/api/factory/target-accounts/boomi", payload: { accountId: "", user: "" } })).statusCode).toBe(400);
  });
  it("tests and removes an account", async () => {
    nock(MT).post("/api/target-accounts/boomi/test").reply(200, { ok: false, message: "401 Unauthorized" });
    expect((await app().inject({ method: "POST", url: "/api/factory/target-accounts/boomi/test" })).json()).toEqual({ ok: false, message: "401 Unauthorized" });
    nock(MT).delete("/api/target-accounts/boomi").reply(200, { ok: true });
    expect((await app().inject({ method: "DELETE", url: "/api/factory/target-accounts/boomi" })).statusCode).toBe(200);
  });
  it("starts an import and passes the tool's refusal on", async () => {
    nock(MT, { reqheaders: { "x-user": "anna@example.com" } }).post("/api/migrations/m1/import").reply(202, { ok: true, message: "queued" });
    expect((await app().inject({ method: "POST", url: "/api/factory/migrations/m1/import" })).statusCode).toBe(202);
    nock(MT).post("/api/migrations/m1/import").reply(400, { error: "No Boomi account is set up." });
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations/m1/import" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("No Boomi account is set up.");
  });
  it("switches automatic import with a yes or no only", async () => {
    let got: any = null;
    nock(MT).post("/api/migrations/m1/options", (b) => { got = b; return true; }).reply(200, { ok: true });
    expect((await app().inject({ method: "POST", url: "/api/factory/migrations/m1/options", payload: { autoImport: true, apiName: "x" } })).statusCode).toBe(200);
    expect(got).toEqual({ autoImport: true });
    expect((await app().inject({ method: "POST", url: "/api/factory/migrations/m1/options", payload: { autoImport: "yes" } })).statusCode).toBe(400);
  });
});
