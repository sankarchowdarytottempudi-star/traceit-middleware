// "Paste code" and single-file uploads: snippets are checked, laid out as a minimal project of their technology
// (the same layout as migration-factory/factory/paste.py), marked with PASTED.txt, zipped and sent to the
// migration tool like any upload. All code below is synthetic.
import { describe, it, expect, afterEach } from "vitest";
import { inflateRawSync } from "node:zlib";
import nock from "nock";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerRoutes } from "../src/routes";
import { registerMigrate } from "../src/migrate/routes";
import { validateUpload, UPLOAD_EXTENSIONS } from "../src/migrate/options";
import { PASTE_LIMITS, crc32, decodeText, layout, pastedOf, sniff, sniffAll, slug, wrapToZip, zipFiles } from "../src/migrate/paste";
import type { Config } from "../src/config";

const MT = "http://localhost:30900";
const cfg = { MT_BASE_URL: MT, MT_ADMIN_TOKEN: "tok", SESSION_SECRET: "x".repeat(20), MT_UPLOAD_LIMIT_MB: 1, MT_COMPARE_APIS: "" } as unknown as Config;
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

const MULE = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core" xmlns:http="http://www.mulesoft.org/schema/mule/http">
  <flow name="create-order-flow"><http:listener config-ref="HTTP_Listener_config" path="/orders"/><flow-ref name="sub"/></flow>
</mule>`;
const DWL = "%dw 2.0\noutput application/java\n---\n{ id: payload.orderId }\n";
const WM = `<?xml version="1.0" encoding="UTF-8"?>\n<FLOW VERSION="3.0"><INVOKE SERVICE="crm.customers:update"></INVOKE></FLOW>`;
const BOOMI = `<bns:Component xmlns:bns="http://api.platform.boomi.com/" componentId="a0000000-0000-4000-8000-000000000001" type="process" name="Sync"><bns:object/></bns:Component>`;
const JAVA = "package com.example.billing.api;\n\npublic class InvoiceService {\n  public int one() { return 1; }\n}\n";

/** nock hands a binary body over as hex, a text body as text. */
const asBuf = (b: unknown) => (typeof b === "string" && /^[0-9a-f]+$/i.test(b) && b.length % 2 === 0 ? Buffer.from(b, "hex") : Buffer.from(String(b), "utf8"));

/** A small zip reader for the tests: name -> text. */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const method = buf.readUInt16LE(at + 10), crc = buf.readUInt32LE(at + 16), csize = buf.readUInt32LE(at + 20);
    const nlen = buf.readUInt16LE(at + 28), elen = buf.readUInt16LE(at + 30), clen = buf.readUInt16LE(at + 32), off = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28);
    const raw = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    expect(crc32(data)).toBe(crc);
    out.set(name, data.toString("utf8"));
    at += 46 + nlen + elen + clen;
  }
  return out;
}

describe("technology from the content", () => {
  it("finds the platform markers first", () => {
    expect(sniff("a.xml", MULE)).toBe("mule4");
    expect(sniff("flow.xml", MULE)).toBe("mule4");
    expect(sniff("flow.xml", WM)).toBe("webmethods");
    expect(sniff("process.xml", BOOMI)).toBe("boomi");
    expect(sniff("t.dwl", DWL)).toBe("mule4");
    expect(sniff("", DWL)).toBe("mule4");
    expect(sniff("", JAVA)).toBe("java");
    expect(sniff("x.cs", "using System;")).toBe("dotnet");
    expect(sniff("api.yaml", "openapi: 3.0.0\n")).toBe("openapi");
    expect(sniffAll([{ name: "a.java", text: JAVA }, { name: "p.xml", text: BOOMI }])).toBe("boomi");
  });
});

describe("minimal project per technology (same layout as the factory)", () => {
  it("Mule: flows in src/main/mule, DataWeave in resources/dwl, generated project files said so", () => {
    const { technology, files } = layout([{ name: "order-flow.xml", text: MULE }, { name: "order-to-row.dwl", text: DWL }, { name: "flow.xml", text: MULE }], "mule4", "Orders API");
    expect(technology).toBe("mule4");
    expect([...files.keys()].sort()).toEqual(["PASTED.txt", "mule-artifact.json", "pom.xml", "src/main/mule/order-flow.xml", "src/main/mule/pasted-flow.xml", "src/main/resources/dwl/order-to-row.dwl"]);
    expect(files.get("pom.xml")).toContain("<artifactId>orders-api</artifactId>");
    const man = files.get("PASTED.txt")!;
    expect(man.split("\n").slice(0, 4)).toEqual(["PASTED SOURCE - not a whole project", "source: pasted", "technology: mule4", "created-by: weave-factory"]);
    expect(man).toContain("snippet: src/main/resources/dwl/order-to-row.dwl <- order-to-row.dwl (");
    expect(man).toContain("generated: mule-artifact.json");
  });
  it("webMethods: a package with ns/<Pkg>/<folder>/<service>/flow.xml and a minimal node.ndf", () => {
    const { files } = layout([{ name: "flow.xml", text: WM }], "auto", "customer sync");
    expect([...files.keys()].sort()).toEqual(["CustomerSync/manifest.v3", "CustomerSync/ns/CustomerSync/pasted/service1/flow.xml", "CustomerSync/ns/CustomerSync/pasted/service1/node.ndf", "PASTED.txt"]);
    expect(files.get("CustomerSync/ns/CustomerSync/pasted/service1/node.ndf")).toContain("svc_type");
    const named = layout([{ name: "orders.process:handleOrder", text: WM }, { name: "node.ndf", text: '<Values version="2.0"><value name="svc_type">flow</value></Values>' }], "webmethods", "x");
    expect(named.files.has("X/ns/X/orders/process/handleOrder/flow.xml")).toBe(true);
    expect(named.files.get("X/ns/X/orders/process/handleOrder/node.ndf")).toContain("svc_type");
  });
  it("Boomi components, Java by package, unique names, safe names", () => {
    expect([...layout([{ name: "process.xml", text: BOOMI }, { name: "process.xml", text: BOOMI }], "boomi", "b").files.keys()]).toEqual(["export/components/process.xml", "export/components/process-2.xml", "PASTED.txt"]);
    expect(layout([{ name: "", text: JAVA }], "auto", "j").files.has("src/main/java/com/example/billing/api/InvoiceService.java")).toBe(true);
    expect([...layout([{ name: "../../etc/x.java", text: JAVA }], "java", "../evil").files.keys()].every((k) => !k.includes(".."))).toBe(true);
    expect(slug("../Evil Name!")).toBe("evil-name");
  });
});

describe("zip", () => {
  it("writes a readable zip under one top folder", () => {
    const w = wrapToZip([{ name: "order-flow.xml", text: MULE }], "mule4", "Orders API", "pasted");
    expect(w.filename).toBe("orders-api.zip");
    const files = unzip(w.zip);
    expect([...files.keys()].every((k) => k.startsWith("orders-api/"))).toBe(true);
    expect(files.get("orders-api/src/main/mule/order-flow.xml")).toBe(MULE);
    expect(files.get("orders-api/PASTED.txt")).toContain("source: pasted");
    // the same snippets give the same bytes
    expect(wrapToZip([{ name: "order-flow.xml", text: MULE }], "mule4", "Orders API", "pasted").zip.equals(w.zip)).toBe(true);
  });
  it("keeps non-ASCII text", () => {
    const f = unzip(zipFiles([{ path: "a/ü.txt", data: Buffer.from("Grüße ✓", "utf8") }]));
    expect(f.get("a/ü.txt")).toBe("Grüße ✓");
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
    expect(decodeText(Buffer.from([0xe9]))).toBe("é");
  });
});

describe("the paste form is checked", () => {
  const targets = ["wso2", "workato"];
  const ok = { name: "Orders", workspace: "Shop", target: "workato", technology: "mule4", snippets: [{ name: "flow.xml", text: MULE }] };
  it("accepts a good form", () => {
    expect(pastedOf(ok, targets)).toMatchObject({ ok: true, value: { name: "Orders", workspace: "Shop", target: "workato", technology: "mule4" } });
    expect(pastedOf({ ...ok, technology: undefined }, targets)).toMatchObject({ ok: true, value: { technology: "auto" } });
  });
  it("says what is wrong", () => {
    const err = (b: unknown) => { const r = pastedOf(b, targets); return r.ok ? "" : r.error; };
    expect(err({ ...ok, name: " " })).toMatch(/name/);
    expect(err({ ...ok, target: "cobol" })).toMatch(/target/);
    expect(err({ ...ok, technology: "cobol" })).toMatch(/written in/);
    expect(err({ ...ok, snippets: [] })).toMatch(/at least one/);
    expect(err({ ...ok, snippets: [{ text: "  " }] })).toMatch(/Piece 1 is empty/);
    expect(err({ ...ok, snippets: Array.from({ length: PASTE_LIMITS.maxSnippets + 1 }, () => ({ text: "x" })) })).toMatch(/at most 20/);
    expect(err({ ...ok, snippets: [{ text: "x".repeat(PASTE_LIMITS.maxSnippetBytes + 1) }] })).toMatch(/larger than 1024 KB/);
    expect(err({ ...ok, snippets: [1, 2, 3].map(() => ({ text: "x".repeat(PASTE_LIMITS.maxSnippetBytes - 10) })) })).toMatch(/together/);
    expect(err({ ...ok, snippets: [{ name: "../x.xml", text: "a" }] })).toMatch(/file name of piece 1/);
    expect(err({ ...ok, snippets: [{ name: "a<b>.xml", text: "a" }] })).toMatch(/file name/);
    expect(err({ ...ok, snippets: [{ name: "a.dwl", text: "a" }, { name: "A.dwl", text: "b" }] })).toMatch(/both called/);
    // two webMethods flows may both be called flow.xml
    expect(pastedOf({ ...ok, snippets: [{ name: "flow.xml", text: WM }, { name: "flow.xml", text: WM }] }, targets).ok).toBe(true);
  });
});

describe("single files on the upload", () => {
  it("accepts the listed extensions and keeps refusing others", () => {
    for (const e of [".xml", ".html", ".htm", ".dwl", ".java", ".groovy", ".cs", ".js", ".ts", ".yaml", ".yml", ".wsdl", ".xsd", ".bal", ".properties"]) {
      expect(UPLOAD_EXTENSIONS).toContain(e);
      expect(validateUpload({ name: "n", filename: `a${e}` }, 10, 5)).toMatchObject({ ok: true });
    }
    expect(validateUpload({ name: "n", filename: "a.exe" }, 10, 5)).toMatchObject({ ok: false, status: 400 });
    expect(validateUpload({ name: "n", filename: "a.java" }, 11 * 1024 * 1024, 500)).toMatchObject({ ok: false, status: 413 });
    expect(validateUpload({ name: "n", filename: "a.zip" }, 11 * 1024 * 1024, 500)).toMatchObject({ ok: true });
  });
});

describe("routes", () => {
  it("offers the paste limits and technologies", async () => {
    const r = await app().inject({ method: "GET", url: "/api/factory/migrate/options" });
    const j = r.json();
    expect(j.paste.maxSnippets).toBe(20);
    expect(j.paste.technologies.map((t: { id: string }) => t.id)).toContain("webmethods");
    expect(j.singleFileExtensions).toContain(".dwl");
    expect(j.extensions).toContain(".java");
  });

  it("wraps pasted code into a project zip and uploads it through the tool", async () => {
    let seen: { headers: Record<string, string>; body: Buffer } | null = null;
    nock(MT).post("/api/migrations").reply(function (_uri, body) {
      seen = { headers: this.req.headers as Record<string, string>, body: asBuf(body) };
      return [201, { id: "m1", name: "Orders" }];
    });
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations/paste", payload: { name: "Orders API", workspace: "Shop", target: "workato", technology: "auto", snippets: [{ name: "order-flow.xml", text: MULE }, { name: "order-to-row.dwl", text: DWL }] } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ id: "m1" });
    expect(seen).not.toBeNull();
    expect(seen!.headers["x-filename"]).toBe("orders-api.zip");
    expect(seen!.headers["x-name"]).toBe("Orders API");
    expect(seen!.headers["x-workspace"]).toBe("Shop");
    expect(seen!.headers["x-target-tech"]).toBe("workato");
    expect(seen!.headers["x-admin-token"]).toBe("tok");
    const files = unzip(seen!.body);
    expect(files.get("orders-api/src/main/mule/order-flow.xml")).toBe(MULE);
    expect(files.get("orders-api/src/main/resources/dwl/order-to-row.dwl")).toBe(DWL);
    expect(files.get("orders-api/PASTED.txt")).toMatch(/source: pasted\ntechnology: mule4/);
  });

  it("refuses a bad paste before contacting the tool, and anonymous callers", async () => {
    const bad = await app().inject({ method: "POST", url: "/api/factory/migrations/paste", payload: { name: "x", snippets: [] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/at least one/);
    const anon = await app(false).inject({ method: "POST", url: "/api/factory/migrations/paste", payload: { name: "x", snippets: [{ text: "a" }] } });
    expect(anon.statusCode).toBe(401);
  });

  it("wraps one uploaded source file the same way", async () => {
    let seen: { headers: Record<string, string>; body: Buffer } | null = null;
    nock(MT).post("/api/migrations").reply(function (_uri, body) {
      seen = { headers: this.req.headers as Record<string, string>, body: asBuf(body) };
      return [201, { id: "m2" }];
    });
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations?name=Customer%20sync&filename=flow.xml&target=workato&sourceType=webmethods", headers: { "content-type": "application/octet-stream" }, payload: Buffer.from(WM) });
    expect(r.statusCode).toBe(201);
    expect(seen!.headers["x-filename"]).toBe("customer-sync.zip");
    const files = unzip(seen!.body);
    expect(files.get("customer-sync/CustomerSync/ns/CustomerSync/pasted/service1/flow.xml")).toBe(WM);
    expect(files.has("customer-sync/CustomerSync/ns/CustomerSync/pasted/service1/node.ndf")).toBe(true);
    expect(files.get("customer-sync/PASTED.txt")).toMatch(/source: single-file\ntechnology: webmethods/);
  });

  it("still streams a .zip unchanged", async () => {
    const zip = Buffer.from("PK\u0003\u0004 not really a zip");
    let got = "";
    nock(MT).post("/api/migrations").reply(function (_uri, body) { got = String(this.req.headers["x-filename"]); return [201, { id: "m3", len: asBuf(body).length }]; });
    const r = await app().inject({ method: "POST", url: "/api/factory/migrations?name=O&filename=orders.zip", headers: { "content-type": "application/octet-stream" }, payload: zip });
    expect(r.statusCode).toBe(201);
    expect(got).toBe("orders.zip");
  });
});
