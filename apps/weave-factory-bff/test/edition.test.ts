// WEAVE_EDITION=cruise-saudi: the server accepts MuleSoft (Mule 4) to WSO2 only and refuses the rest with a
// plain 400; unset, everything works as before. All code below is synthetic.
import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerRoutes } from "../src/routes";
import { registerMigrate } from "../src/migrate/routes";
import { MSG, editionOf, pasteOk, singleFileOk, uploadOk } from "../src/edition";
import type { Config } from "../src/config";

const MT = "http://localhost:30900";
const base = { MT_BASE_URL: MT, MT_ADMIN_TOKEN: "tok", SESSION_SECRET: "x".repeat(20), MT_UPLOAD_LIMIT_MB: 1, MT_COMPARE_APIS: "" };
function app(edition?: string) {
  const cfg = { ...base, ...(edition ? { WEAVE_EDITION: edition } : {}) } as unknown as Config;
  const a = Fastify();
  a.register(cookie, { secret: "x".repeat(20) });
  a.decorate("tokenFor", async () => "access");
  a.addHook("onRequest", async (req) => { (req as any).cookies = { sid: "s" }; (req as any).unsignCookie = () => ({ value: "sid1" }); });
  registerRoutes(a as any, cfg);
  registerMigrate(a as any, cfg);
  return a;
}
afterEach(() => nock.cleanAll());

const MULE = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core" xmlns:http="http://www.mulesoft.org/schema/mule/http">
  <flow name="get-order-flow"><http:listener config-ref="HTTP_Listener_config" path="/orders"/></flow>
</mule>`;
const DWL = "%dw 2.0\noutput application/json\n---\n{ id: payload.orderId }\n";
const BOOMI = `<bns:Component xmlns:bns="http://api.platform.boomi.com/" componentId="a0000000-0000-4000-8000-000000000001" type="process" name="Sync"><bns:object/></bns:Component>`;
const JAVA = "package com.example.billing.api;\n\npublic class InvoiceService {\n  public int one() { return 1; }\n}\n";
const octet = { "content-type": "application/octet-stream" };

describe("the edition setting", () => {
  it("is the default edition unless it says cruise-saudi", () => {
    expect(editionOf({})).toBe("traceit");
    expect(editionOf({ WEAVE_EDITION: "" })).toBe("traceit");
    expect(editionOf({ WEAVE_EDITION: "something" })).toBe("traceit");
    expect(editionOf({ WEAVE_EDITION: " Cruise-Saudi " })).toBe("cruise-saudi");
  });
  it("checks uploads, single files and pasted code", () => {
    const cs = "cruise-saudi" as const;
    expect(uploadOk(cs, { filename: "a.zip" }).ok).toBe(true);
    expect(uploadOk(cs, { filename: "a.jar", sourceType: "mule4", target: "wso2" }).ok).toBe(true);
    expect(uploadOk(cs, { filename: "a.zip", sourceType: "boomi" })).toEqual({ ok: false, error: MSG.source });
    expect(uploadOk(cs, { filename: "a.zip", target: "workato" })).toEqual({ ok: false, error: MSG.target });
    expect(uploadOk(cs, { filename: "a.docx", sourceType: "requirements" })).toEqual({ ok: false, error: MSG.requirements });
    expect(uploadOk(cs, { filename: "a.json", sourceType: "spec" })).toEqual({ ok: false, error: MSG.spec });
    expect(uploadOk(cs, { filename: "a.java" })).toEqual({ ok: false, error: MSG.file });
    expect(uploadOk(cs, { filename: "a.bwp" })).toEqual({ ok: false, error: MSG.file });
    expect(singleFileOk(cs, "a.xml", MULE).ok).toBe(true);
    expect(singleFileOk(cs, "a.xml", BOOMI).ok).toBe(false);
    expect(pasteOk(cs, { technology: "auto", snippets: [{ text: DWL }] }).ok).toBe(true);
    expect(pasteOk(cs, { technology: "mule4", snippets: [{ text: "<x/>" }] }).ok).toBe(true);
    expect(pasteOk(cs, { technology: "auto", snippets: [{ text: "<x/>" }] }).ok).toBe(false);
    expect(pasteOk(cs, { technology: "mule4", snippets: [{ name: "A.java", text: JAVA }] }).ok).toBe(false);
    expect(pasteOk(cs, { technology: "java", snippets: [{ text: JAVA }] })).toEqual({ ok: false, error: MSG.source });
    // the default edition never refuses here
    for (const r of [uploadOk("traceit", { filename: "a.zip", sourceType: "boomi", target: "workato" }), singleFileOk("traceit", "a.xml", BOOMI), pasteOk("traceit", { technology: "java", snippets: [{ text: JAVA }] })]) expect(r.ok).toBe(true);
  });
});

describe("cruise-saudi edition over HTTP", () => {
  it("offers Mule 4 to WSO2 only", async () => {
    const r = await app("cruise-saudi").inject({ method: "GET", url: "/api/factory/migrate/options" });
    expect(r.statusCode).toBe(200);
    const o = r.json();
    expect(o.edition).toBe("cruise-saudi");
    expect(o.technologies.map((t: { id: string }) => t.id)).toEqual(["mule4"]);
    expect(o.targets.map((t: { id: string }) => t.id)).toEqual(["wso2"]);
    expect(o.paste.technologies.map((t: { id: string }) => t.id)).toEqual(["mule4"]);
    expect(o.requirements).toBeUndefined();
    expect(o.integrationFileExtensions).toEqual([]);
    expect(o.extensions).toContain(".zip");
    expect(o.extensions).toContain(".jar");
    expect(o.extensions).not.toContain(".json");
    expect(o.extensions).not.toContain(".java");
  });
  it("passes a Mule upload to WSO2 on to the tool", async () => {
    const scope = nock(MT, { reqheaders: { "x-target-tech": "wso2" } }).post("/api/migrations").reply(201, { id: "n1", name: "Orders" });
    const r = await app("cruise-saudi").inject({ method: "POST", url: "/api/factory/migrations?name=Orders&filename=orders.zip&target=wso2&sourceType=mule4", headers: octet, payload: Buffer.from("PK-zip") });
    expect(r.statusCode).toBe(201);
    expect(scope.isDone()).toBe(true);
  });
  it("refuses another source, another target, requirements and a written specification without calling the tool", async () => {
    const a = app("cruise-saudi");
    const cases: [string, string][] = [
      ["/api/factory/migrations?name=O&filename=o.zip&sourceType=boomi", MSG.source],
      ["/api/factory/migrations?name=O&filename=o.zip&target=springboot", MSG.target],
      ["/api/factory/migrations?name=O&filename=o.docx&sourceType=requirements&target=workato", MSG.requirements],
      ["/api/factory/migrations?name=O&filename=o.json&sourceType=spec", MSG.spec],
      ["/api/factory/migrations?name=O&filename=Svc.java", MSG.file],
    ];
    for (const [url, error] of cases) {
      const r = await a.inject({ method: "POST", url, headers: octet, payload: Buffer.from("x") });
      expect(r.statusCode, url).toBe(400);
      expect(r.json().error).toBe(error);
    }
    expect(nock.pendingMocks()).toEqual([]);
  });
  it("refuses a single file that is not Mule, and wraps a Mule file as a Mule project", async () => {
    const a = app("cruise-saudi");
    const bad = await a.inject({ method: "POST", url: "/api/factory/migrations?name=S&filename=process.xml", headers: octet, payload: Buffer.from(BOOMI) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe(MSG.notMule);
    const scope = nock(MT).post("/api/migrations").reply(201, { id: "n2" });
    const ok = await a.inject({ method: "POST", url: "/api/factory/migrations?name=S&filename=orders.xml", headers: octet, payload: Buffer.from(MULE) });
    expect(ok.statusCode).toBe(201);
    expect(scope.isDone()).toBe(true);
  });
  it("refuses pasted code that is not Mule or a target other than WSO2", async () => {
    const a = app("cruise-saudi");
    const java = await a.inject({ method: "POST", url: "/api/factory/migrations/paste", payload: { name: "B", target: "wso2", technology: "java", snippets: [{ text: JAVA }] } });
    expect(java.statusCode).toBe(400);
    expect(java.json().error).toBe(MSG.source);
    const sniffed = await a.inject({ method: "POST", url: "/api/factory/migrations/paste", payload: { name: "B", target: "wso2", technology: "auto", snippets: [{ name: "p.xml", text: BOOMI }] } });
    expect(sniffed.json().error).toBe(MSG.notMule);
    const tgt = await a.inject({ method: "POST", url: "/api/factory/migrations/paste", payload: { name: "B", target: "workato", technology: "mule4", snippets: [{ text: DWL }] } });
    expect(tgt.statusCode).toBe(400);
    expect(tgt.json().error).toBe(MSG.target);
    const scope = nock(MT).post("/api/migrations").reply(201, { id: "n3" });
    const ok = await a.inject({ method: "POST", url: "/api/factory/migrations/paste", payload: { name: "B", target: "wso2", technology: "auto", snippets: [{ name: "f.xml", text: MULE }] } });
    expect(ok.statusCode).toBe(201);
    expect(scope.isDone()).toBe(true);
  });
  it("refuses Boomi / Workato accounts and imports, requirements workbooks and the requirements and spec steps", async () => {
    const a = app("cruise-saudi");
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/factory/target-accounts"],
      ["PUT", "/api/factory/target-accounts/boomi", { accountId: "a", user: "u@example.com", token: "t" }],
      ["DELETE", "/api/factory/target-accounts/workato"],
      ["POST", "/api/factory/target-accounts/workato/test", {}],
      ["POST", "/api/factory/migrations/m1/import", {}],
      ["POST", "/api/factory/migrations/m1/options", { autoImport: true }],
      ["GET", "/api/factory/requirements/template.xlsx"],
      ["GET", "/api/factory/migrations/m1/requirements.xlsx"],
      ["GET", "/api/factory/migrations/m1/requirements-template.xlsx"],
      ["POST", "/api/factory/migrations/m1/run/generate", {}],
      ["POST", "/api/factory/migrations/m1/run/spec", {}],
    ];
    for (const [method, url, payload] of calls) {
      const r = await a.inject({ method: method as any, url, ...(payload !== undefined ? { payload: payload as any } : {}) });
      expect(r.statusCode, `${method} ${url}`).toBe(400);
      expect(r.json().error, url).toMatch(/WSO2 only|Mule 4\) projects/);
    }
    const wb = await a.inject({ method: "POST", url: "/api/factory/migrations/m1/requirements", headers: octet, payload: Buffer.from("PK\u0003\u0004x") });
    expect(wb.statusCode).toBe(400);
    expect(wb.json().error).toBe(MSG.requirements);
  });
  it("still runs the Mule to WSO2 steps", async () => {
    const scope = nock(MT).post("/api/migrations/m1/run/document").reply(202, { ok: true });
    const r = await app("cruise-saudi").inject({ method: "POST", url: "/api/factory/migrations/m1/run/document", payload: {} });
    expect(r.statusCode).toBe(202);
    expect(scope.isDone()).toBe(true);
  });
  it("imports only Mule 4 projects of a repository", async () => {
    const repos = { repos: [{ id: "abcdef12", projects: [{ path: "orders", technology: "mule4" }, { path: "legacy", technology: "java" }] }] };
    const a = app("cruise-saudi");
    nock(MT).get("/api/repos").reply(200, repos);
    const bad = await a.inject({ method: "POST", url: "/api/factory/repos/abcdef12/import", payload: { paths: ["orders", "legacy"], workspace: "Shop" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("legacy");
    nock(MT).get("/api/repos").reply(200, repos);
    const scope = nock(MT).post("/api/repos/abcdef12/import").reply(201, { created: [{ id: "m5" }] });
    const ok = await a.inject({ method: "POST", url: "/api/factory/repos/abcdef12/import", payload: { paths: ["orders"], workspace: "Shop" } });
    expect(ok.statusCode).toBe(201);
    expect(scope.isDone()).toBe(true);
  });
});

describe("default edition over HTTP (WEAVE_EDITION unset)", () => {
  it("offers every technology and target, and requirements", async () => {
    const o = (await app().inject({ method: "GET", url: "/api/factory/migrate/options" })).json();
    expect(o.edition).toBe("traceit");
    expect(o.technologies.length).toBeGreaterThan(5);
    expect(o.targets.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(["wso2", "mule", "workato", "boomi"]));
    expect(o.requirements.extensions).toContain(".docx");
    expect(o.paste.technologies.map((t: { id: string }) => t.id)).toContain("auto");
  });
  it("passes another source and target on to the tool", async () => {
    const scope = nock(MT, { reqheaders: { "x-target-tech": "workato" } }).post("/api/migrations").reply(201, { id: "n9" });
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations?name=O&filename=o.zip&sourceType=boomi&target=workato", headers: octet, payload: Buffer.from("PK") });
    expect(r.statusCode).toBe(201);
    expect(scope.isDone()).toBe(true);
  });
  it("keeps the Boomi / Workato accounts", async () => {
    nock(MT).get("/api/target-accounts").reply(200, []);
    const r = await app().inject({ method: "GET", url: "/api/factory/target-accounts" });
    expect(r.statusCode).toBe(200);
  });
});
