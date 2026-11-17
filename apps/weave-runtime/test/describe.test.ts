// A flow written in words ("Describe the flow", packages/weave-flow/src/describe.ts) must be a flow this
// runtime accepts and runs: the example from the owner is read, validated here, and test-run against a
// stand-in for the CRM, once for a guest that is found and once for one that has to be created.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describeFlow, STEP_PHRASES, type ConnectorDef, type Flow } from "@traceit/weave-flow";
import { loadConfig } from "../src/config.js";
import { Runtime } from "../src/runtime.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wr-describe-"));
const env = { DATA_DIR: tmp, SECRET_KEY_FILE: path.join(tmp, "secret.key"), RUNTIME_INTERNAL_KEY: "test-key", PORT: "0", GATEWAY_RECONCILE_SECONDS: "0" } as NodeJS.ProcessEnv;
let rt: Runtime; let server: http.Server; let base = "";
const calls: { method: string; url: string; body: unknown }[] = [];
let connector: ConnectorDef;
const EXAMPLE = "When POST /guests/check arrives / Look up the contact in Zoho by email / If not found, create the contact in Zoho with first name, last name, email / Log \"guest checked\" / Answer 201 with the contact id";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method ?? "", url: req.url ?? "", body });
      const json = (status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      const u = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && u.pathname === "/contacts/search") return json(200, u.searchParams.get("email") === "known@example.invalid" ? { id: "c-known", email: "known@example.invalid" } : {});
      if (req.method === "POST" && u.pathname === "/contacts") return json(201, { id: "c-new", ...body });
      json(404, { error: "no such path" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rt = new Runtime(loadConfig(env));
  const conn = rt.createConnection({ name: "Zoho", type: "http", config: { baseUrl: base, authType: "none" } });
  connector = rt.createConnector({ name: "Zoho", connectionType: "http", defaultConnectionId: conn.id, operations: [
    { id: "searchContacts", name: "Search contacts", method: "GET", path: "/contacts/search", params: [{ key: "email", label: "Email", kind: "template" }], query: [{ key: "email", value: "{{ $params.email }}" }] },
    { id: "createContact", name: "Create contact", method: "POST", path: "/contacts", params: [] },
  ] });
});
afterAll(async () => { await rt.close(); await new Promise((r) => server.close(r)); fs.rmSync(tmp, { recursive: true, force: true }); });

const ctx = () => ({ connections: rt.store.listConnections().map((c) => ({ id: c.id, name: c.name, type: c.type })), connectors: [connector] });

describe("a described flow in the runtime", () => {
  let flow: Flow;
  it("is accepted by the validator without problems", async () => {
    const r = describeFlow(EXAMPLE, ctx());
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    flow = await rt.createFlow({ name: r.flow.name, flow: { nodes: r.flow.nodes, edges: r.flow.edges } as never, origin: { kind: "blank", ref: "described" } });
    const issues = await rt.validate(flow);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(issues).toEqual([]);
    expect(flow.nodes.map((n) => n.type)).toEqual(["trigger.http", `connector:${connector.id}:searchContacts`, "logic.choice", `connector:${connector.id}:createContact`, "log", "respond"]);
  });
  it("answers 201 with the id of a contact that is found, without creating one", async () => {
    calls.length = 0;
    const ex = await rt.testFlow(flow.id, { request: { method: "POST", path: "/guests/check", body: { email: "known@example.invalid", firstName: "Jane", lastName: "Doe" } } as never });
    expect(ex.status).toBe("success");
    expect(ex.response).toMatchObject({ status: 201, body: { contactId: "c-known" } });
    expect(calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual(["GET /contacts/search"]);
    expect(calls[0].url).toContain("email=known%40example.invalid");
  });
  it("creates the contact when it is not found and answers with the new id", async () => {
    calls.length = 0;
    const ex = await rt.testFlow(flow.id, { request: { method: "POST", path: "/guests/check", body: { email: "new@example.invalid", firstName: "Jane", lastName: "Doe" } } as never });
    expect(ex.status).toBe("success");
    expect(ex.response).toMatchObject({ status: 201, body: { contactId: "c-new" } });
    expect(calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual(["GET /contacts/search", "POST /contacts"]);
    expect(calls[1].body).toMatchObject({ email: "new@example.invalid", firstName: "Jane", lastName: "Doe" });
    const log = ex.steps.find((s) => s.nodeType === "log");
    expect(log?.status).toBe("success");
  });
  it("uses the sample request the reader wrote for the Test button", async () => {
    const sample = flow.nodes[0].config.sampleRequest as { method: string; path: string; body: Record<string, unknown> };
    expect(sample.body.email).toMatch(/@example\.invalid$/);
    const ex = await rt.testFlow(flow.id, { request: sample as never });
    expect(ex.status).toBe("success");
  });
  it("every example in the step phrase list makes a flow this validator understands (no unknown types, no bad expressions)", async () => {
    const c = { ...ctx(), connections: [...ctx().connections] };
    for (const p of STEP_PHRASES) {
      const pre = p.group === "Start" || p.group === "Other" ? "" : "When POST /x arrives\nLook up the contact in Zoho by email\n";
      const r = describeFlow(pre + p.example, c);
      if (!r.flow.nodes.length) { expect(p.group).toBe("Other"); continue; }
      const f = { id: "fl_x", name: "x", slug: "x", nodes: r.flow.nodes, edges: r.flow.edges, settings: { basePath: "/x/v1", gateway: { publish: false, security: "oauth2" } }, revision: 1, createdAt: "", updatedAt: "" } as unknown as Flow;
      const issues = await rt.validate(f);
      const bad = issues.filter((i) => i.level === "error" && !/connection|"URL or path" is required|is a path|no flow|flow it calls|is required for|"Flow" is required/i.test(i.message));
      expect(bad, `${p.example}: ${JSON.stringify(bad)}`).toEqual([]);
    }
  });
});
