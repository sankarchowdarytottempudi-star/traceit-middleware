// Acceptance: the newsletter requirement document (a sanitized copy: made-up e-mail and digits) is read
// in requirement-document mode; the flow it makes passes this runtime's validation, and every test
// scenario it generated from the document's test table runs against a stand-in Zoho CRM on loopback
// (token endpoint + Leads upsert). No real Zoho, no e-mails.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readDocument, type DocScenario, type DocumentResult, type Flow } from "@traceit/weave-flow";
import { loadConfig } from "../src/config.js";
import { Runtime } from "../src/runtime.js";

const FIXTURE = process.env.DOC_FIXTURE ?? path.join(__dirname, "../../weave-factory-bff/test/fixtures/newsletter-requirement.txt");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wr-doc-"));
const env = { DATA_DIR: tmp, SECRET_KEY_FILE: path.join(tmp, "secret.key"), RUNTIME_INTERNAL_KEY: "test-key", PORT: "0", GATEWAY_RECONCILE_SECONDS: "0" } as NodeJS.ProcessEnv;
let rt: Runtime; let server: http.Server; let base = "";

// ---- stand-in Zoho CRM
interface Lead { id: string; fields: Record<string, unknown>; tags: string[]; }
const leads = new Map<string, Lead>();
const upserts: { auth?: string; body: any }[] = [];
let tokenCalls = 0, issued = 0;
const valid = new Set<string>();
let mode: "ok" | "slow" = "ok";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
      const json = (s: number, v: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.url === "/oauth/v2/token") {
        tokenCalls++;
        const f = new URLSearchParams(raw);
        if (f.get("grant_type") !== "refresh_token" || f.get("refresh_token") !== "rt-standin" || f.get("client_secret") !== "cs-standin") return json(400, { error: "invalid_code" });
        const t = `tok-${++issued}`; valid.add(t);
        return json(200, { access_token: t, expires_in: 3600 });
      }
      if (req.method === "POST" && req.url === "/crm/v8/Leads/upsert") {
        if (mode === "slow") { setTimeout(() => json(200, {}), 1500); return; }
        const tok = /^Zoho-oauthtoken (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
        if (!tok || !valid.has(tok)) return json(401, { code: "INVALID_TOKEN", message: "invalid oauth token", status: "error" });
        const body = JSON.parse(raw);
        upserts.push({ auth: req.headers.authorization, body });
        const rec = body.data?.[0] ?? {};
        if (Object.values(rec).some((v) => v === "")) return json(200, { data: [{ code: "INVALID_DATA", details: {}, message: "invalid data", status: "error" }] });
        if (!rec.Email || !rec.Last_Name) return json(200, { data: [{ code: "MANDATORY_NOT_FOUND", details: {}, message: "required field not found", status: "error" }] });
        const key = String(rec.Email);
        const cur = leads.get(key);
        const tags = [...(cur?.tags ?? []), ...((rec.Tag ?? []) as { name: string }[]).map((t) => t.name)].filter((t, i, a) => a.indexOf(t) === i);
        const { Tag: _t, ...fields } = rec;
        const lead: Lead = { id: cur?.id ?? `zl-${leads.size + 1}`, fields: { ...(cur?.fields ?? {}), ...fields }, tags };
        leads.set(key, lead);
        return json(cur ? 200 : 201, { data: [{ code: "SUCCESS", details: { id: lead.id }, message: cur ? "record updated" : "record added", status: "success", action: cur ? "update" : "insert" }] });
      }
      json(404, { error: "no such path" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rt = new Runtime(loadConfig(env));
});
afterAll(async () => { await rt.close(); await new Promise((r) => server.close(r)); fs.rmSync(tmp, { recursive: true, force: true }); });

let doc: DocumentResult;
let flow: Flow;      // a copy with step tracing on, so the answers can be read in the test run
let built: Flow;     // the flow exactly as built (no payloads in traces)
const RESPONSE_FIELDS = ["Email", "First_Name", "Last_Name", "Mobile", "Industry", "Lead_Source", "No_of_Employees", "Country", "Currency"];
const CHANNEL: Record<string, string> = { WEB: "Web", MOBILE: "Mobile App", AGENT_BOOKING: "Agent Booking", AGENCY: "Agency" };

describe("the newsletter requirement document", () => {
  it("builds a flow the runtime accepts", async () => {
    const text = fs.readFileSync(FIXTURE, "utf8");
    // the connection is offered pre-filled; here it is created as the owner would, with stand-in secrets
    const pre = readDocument(text, {});
    const offer = pre.missing.find((m) => m.name === "Zoho CRM")!;
    expect(offer.suggested?.config).toMatchObject({ authType: "oauth2refresh", tokenPrefix: "Zoho-oauthtoken", clientAuth: "body", baseUrl: "https://www.zohoapis.in", tokenUrl: "https://accounts.zoho.in/oauth/v2/token" });
    for (const k of ["clientSecret", "refreshToken", "password", "token", "apiKey", "clientId"]) expect(offer.suggested!.config).not.toHaveProperty(k);
    const conn = rt.createConnection({ name: "Zoho CRM", type: "http", config: { ...(offer.suggested!.config as Record<string, unknown>), baseUrl: base, tokenUrl: `${base}/oauth/v2/token`, clientId: "client-standin" }, secrets: { clientSecret: "cs-standin", refreshToken: "rt-standin" } });
    doc = readDocument(text, { connections: [{ id: conn.id, name: conn.name, type: "http" }] });
    expect(doc.ok).toBe(true);
    expect(doc.missing).toEqual([]);
    flow = await rt.createFlow({ name: doc.flow.name, description: doc.flow.description, flow: { nodes: doc.flow.nodes, edges: doc.flow.edges, settings: doc.flow.settings } as never, origin: { kind: "blank", ref: "document" } });
    const issues = await rt.validate(flow);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(flow.settings.basePath).toBe("/newsletter/v1");
    expect(flow.settings.logPayloads).toBe(false);
    built = flow;
    flow = await rt.createFlow({ name: `${doc.flow.name} (traced copy)`, flow: { nodes: doc.flow.nodes, edges: doc.flow.edges, settings: { ...doc.flow.settings, logPayloads: true } } as never });
    expect(flow.nodes.map((n) => n.type)).toEqual(["trigger.http", "vars.set", "logic.choice", "respond", "respond", "respond", "respond", "respond", "transform.map", "http.request", "logic.choice", "log", "logic.choice", "respond", "respond", "log", "respond"]);
  });

  const run = async (q: DocScenario["requests"][number]) => rt.testFlow(flow.id, { request: { method: q.method, path: q.path, headers: q.headers, body: q.body } as never });
  const scenarioIds = ["1", "2-MOBILE", "2-AGENT_BOOKING", "2-AGENCY", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"];
  for (const id of scenarioIds) {
    it(`test case ${id} from section 11 passes against the stand-in Zoho`, async () => {
      const sc = doc.doc.scenarios.find((s) => s.id === id)!;
      expect(sc, id).toBeTruthy();
      expect(sc.derived).toBe(true);
      leads.clear(); upserts.length = 0; mode = "ok";
      const email = String((sc.requests[0].body as { data: { Email: string } }).data.Email).trim().toLowerCase();
      if (sc.standIn?.existingTags) leads.set(email, { id: "zl-old", fields: { Email: email, Last_Name: "Guest" }, tags: [...sc.standIn.existingTags] });
      if (sc.standIn?.tokenExpired) { await run(doc.doc.scenarios[0].requests[0]); leads.clear(); upserts.length = 0; valid.clear(); }
      let restore: Flow | null = null;
      if (sc.standIn?.timeout) {
        // the document's 10 s timeout with 1 s / 3 s back-off, scaled down for the test run
        mode = "slow";
        const cur = rt.store.getFlow(flow.id)!;
        restore = cur;
        const fast = { ...cur, nodes: cur.nodes.map((n) => (n.type === "http.request" ? { ...n, config: { ...n.config, timeoutMs: 200, retryDelaysMs: "20, 60" } } : n)) };
        await rt.updateFlow(flow.id, fast as Flow);
      }
      const tokensBefore = tokenCalls;
      const results = [] as Awaited<ReturnType<typeof run>>[];
      for (const q of sc.requests) results.push(await run(q));
      if (restore) { const cur = rt.store.getFlow(flow.id)!; await rt.updateFlow(flow.id, { ...restore, revision: cur.revision } as Flow); }
      for (const ex of results) {
        expect(ex.response?.status, `${id}: ${JSON.stringify(ex.error ?? ex.response?.body)}`).toBe(sc.expect.status);
        if (sc.expect.code) expect((ex.response?.body as { error?: { code?: string } })?.error?.code).toBe(sc.expect.code);
        expect(ex.response?.headers?.["x-correlation-id"] ?? ex.response?.headers?.["X-Correlation-ID"]).toBeTruthy();
      }
      const stored = leads.get(email);
      for (const c of sc.expect.checks) {
        if (c === "nothing-written") expect(upserts).toHaveLength(0);
        else if (c === "one-record") { expect(leads.size).toBe(1); expect(upserts).toHaveLength(2); }
        else if (c === "no-empty-fields") { expect(upserts).toHaveLength(1); expect(Object.values(upserts[0].body.data[0]).some((v) => v === "")).toBe(false); expect(upserts[0].body.data[0]).not.toHaveProperty("Industry"); }
        else if (c === "tags-kept") expect(stored?.tags).toEqual(["VIP", "Newsletter"]);
        else if (c === "response-shape") { const body = results[0].response?.body as { data: Record<string, unknown> }; expect(Object.keys(body.data)).toEqual(RESPONSE_FIELDS); expect(body.data).not.toHaveProperty("contact"); expect(String(body.data.Mobile)).toMatch(/^\+966 5\d{8}$/); }
        else if (c === "channel-label") expect(stored?.fields.Submission_Channel).toBe(CHANNEL[sc.requests[0].headers["x-channel"]]);
        else if (c === "lead-source") expect(stored?.fields.Lead_Source).toBe("Newsletter");
        else if (c === "tag") expect(stored?.tags).toContain("Newsletter");
        else if (c.startsWith("stored:")) expect(stored?.fields.Mobile).toBe(c.slice(7));
        else if (c === "token-refreshed") { expect(tokenCalls).toBe(tokensBefore + 1); expect(stored).toBeTruthy(); }
        else if (c === "retried") expect(results[0].logs?.filter((l) => /retrying/.test(l.message))).toHaveLength(2);
        else if (c === "error-record") {
          const line = results[0].logs?.find((l) => l.level === "error" && /Failed after retries/.test(l.message));
          expect(line?.message).toMatch(/email ne\*\*\*@example\.invalid, mobile \+966 51\*\*\*\*\*\d\d/);
          expect(line?.message).not.toContain(email);
        } else throw new Error(`unknown check ${c}`);
      }
      // the upsert the document asked for
      if (upserts.length) {
        const b = upserts[0].body;
        expect(b.duplicate_check_fields).toEqual(["Email"]);
        expect(b.trigger).toEqual(["workflow"]);
        expect(b.data[0]).toMatchObject({ Company: "Individual Guest", Lead_Source: "Newsletter", Marketing_Opt_In: true, Tag: [{ name: "Newsletter" }] });
        expect(String(b.data[0].Description)).toMatch(/^Newsletter subscription via (Web|Mobile App|Agent Booking|Agency)$/);
        expect(String(b.data[0].Mobile)).toMatch(/^\+966\d{9}$/);
        expect(upserts[0].auth).toMatch(/^Zoho-oauthtoken tok-\d+$/);
      }
    }, 20_000);
  }
  it("as built, logs masked e-mail and mobile only and keeps no payloads in the trace", async () => {
    leads.clear(); mode = "ok";
    const q = doc.doc.scenarios[0].requests[0];
    const ex = await rt.testFlow(built.id, { request: { method: q.method, path: q.path, headers: q.headers, body: q.body } as never });
    expect(ex.response?.status).toBe(200);
    expect(ex.response?.body).toBeUndefined();
    const line = ex.logs?.find((l) => /Stored:/.test(l.message));
    expect(line?.message).toMatch(/result created, record zl-1, \d+ ms, email ne\*\*\*@example\.invalid, mobile \+966 51\*\*\*\*\*\d\d/);
    expect(JSON.stringify(ex.logs)).not.toContain("newsletter.test@example.invalid");
    expect(ex.steps.every((s) => s.input === undefined)).toBe(true);
  });
  it("keeps a correlation id the caller sends", async () => {
    const q = doc.doc.scenarios[0].requests[0];
    const ex = await run({ ...q, headers: { ...q.headers, "x-correlation-id": "corr-123" } });
    expect(ex.response?.headers?.["x-correlation-id"] ?? ex.response?.headers?.["X-Correlation-ID"]).toBe("corr-123");
    const bad = await run({ ...q, headers: { ...q.headers, "x-correlation-id": "corr-9", "x-channel": "nope" } });
    expect((bad.response?.body as { error: { correlationId: string } }).error.correlationId).toBe("corr-9");
  });
});
