// "Change in your own words" (packages/weave-flow/src/edit.ts and the /api/factory/describe/edit routes):
// per step type with the owner's examples, the newsletter flow's real cases, structural changes, issues,
// connections, and preview -> apply -> undo against a stand-in flow engine. No real backend is called.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { editFlow, readDocument, type EditTarget, type Flow, type FullConnection } from "@traceit/weave-flow";
import { registerEdit } from "../src/describe/edit.js";
import { loadDescribeConfig } from "../src/describe/routes.js";

const DOC = fs.readFileSync(path.join(__dirname, "fixtures/newsletter-requirement.txt"), "utf8");
function newsletter(): Flow {
  const d = readDocument(DOC, {});
  const f = { id: "fl_news", slug: "newsletter", revision: 7, createdAt: "", updatedAt: "", ...d.flow, settings: { timeoutMs: 60000, ...d.flow.settings, basePath: "/newsletter/v1", gateway: { publish: true, security: "oauth2", context: "/newsletter", version: "v1" } } } as Flow;
  f.nodes.find((n) => n.type === "http.request")!.config.connection = "cx_z";
  return f;
}
const CONNS: FullConnection[] = [
  { id: "cx_z", name: "Zoho", type: "http", config: { baseUrl: "https://www.zohoapis.in", authType: "oauth2refresh", tokenUrl: "https://accounts.zoho.sa/oauth/v2/token", tokenPrefix: "Bearer", clientAuth: "body" } },
  { id: "cx_zi", name: "Zoho India", type: "http", config: { baseUrl: "https://www.zohoapis.in", authType: "oauth2refresh", tokenUrl: "https://accounts.zoho.in/oauth/v2/token", tokenPrefix: "Zoho-oauthtoken" } },
];
const ctx = (conns = CONNS) => ({ connections: conns.map(({ id, name, type }) => ({ id, name, type })), fullConnections: conns });
const node = (f: Flow, re: RegExp) => f.nodes.find((n) => re.test(n.name))!;
const run = (f: Flow, target: EditTarget, text: string, conns = CONNS) => editFlow(f, target, text, ctx(conns));
const at = (f: Flow, re: RegExp): EditTarget => ({ kind: "node", nodeId: node(f, re).id });
const statuses = (r: ReturnType<typeof run>) => r.lines.filter((l) => l.text).map((l) => l.status);

describe("triggers", () => {
  const f = newsletter();
  it("path, methods and a header made optional", () => {
    const r = run(f, at(f, /^POST/), "change the path to /newsletter/v2/subscribe\nalso accept PUT\nmake X-Channel optional");
    expect(statuses(r)).toEqual(["ok", "ok", "ok"]);
    expect(r.flow.settings).toMatchObject({ basePath: "/newsletter/v2", gateway: { context: "/newsletter", version: "v2" } });
    expect(node(r.flow, /^POST/).config).toMatchObject({ path: "/subscribe", methods: ["POST", "PUT"] });
    const check = node(r.flow, /^Check the request/).config.conditions as { expr: string }[];
    expect(check[0].expr).toMatch(/^\$vars\.channel != "" and \$not\(\$vars\.channel in/);
    expect(f.settings.basePath).toBe("/newsletter/v1");                      // the input is untouched
  });
  it("only / stop accepting methods; required again", () => {
    const r = run(f, at(f, /^POST/), "accept GET and POST\nstop accepting GET");
    expect(node(r.flow, /^POST|^GET/).config.methods).toEqual(["POST"]);
    expect(run(f, at(f, /^POST/), "stop accepting POST").lines[0]).toMatchObject({ status: "not-understood", message: expect.stringMatching(/at least one method/) });
    const opt = run(f, at(f, /^POST/), "make X-Channel optional").flow;
    expect((node(run(opt, at(opt, /^POST/), "make X-Channel required").flow, /^Check/).config.conditions as { expr: string }[])[0].expr).toMatch(/^\$vars\.channel = "" or /);
  });
});

describe("calls (HTTP and connector steps)", () => {
  const f = newsletter();
  it("the owner's examples", () => {
    const r = run(f, at(f, /^Upsert/), [
      "retry 3 times waiting 1 second then 3 seconds", "timeout 10 seconds", "add header Accept-Language from the request", "add header X-Source \"weave\"",
      "send the Company field too", "use the Zoho India connection", "send it in the background", "keep the answer as lead", "do not fail on 4xx",
    ].join("\n"));
    expect(statuses(r)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
    const c = node(r.flow, /^Upsert/).config;
    expect(c).toMatchObject({ retries: 3, retryDelaysMs: "1000, 3000", timeoutMs: 10000, forwardHeaders: ["Accept-Language"], headers: [{ key: "X-Source", value: "weave" }], connection: "cx_zi", background: true, resultVar: "lead", failOnStatus: false });
    expect(r.lines[4].understood).toMatch(/already sends Company/);
    // steps that read the old result name now read the new one
    expect(JSON.stringify(r.flow)).not.toContain("$vars.targetResponse");
    expect(node(r.flow, /^Did Zoho/).config.conditions).toEqual([expect.objectContaining({ expr: expect.stringContaining("$vars.lead.data[0].status") })]);
  });
  it("lesson-aware: retrying a POST and caching a POST say so", () => {
    const plain = run(f, at(f, /^Upsert/), "use POST\ncall /crm/v8/Leads instead").flow;
    const r = run(plain, at(plain, /^Upsert/), "retry 2 times\ncache the answer for 60 seconds");
    expect(r.lines[0]).toMatchObject({ status: "warning", message: expect.stringMatching(/^\[L4 L4\.retry-non-idempotent\]/) });
    expect(r.lines[1]).toMatchObject({ status: "warning", message: expect.stringMatching(/Only GET calls keep answers \(lesson L2\)/) });
    expect(run(plain, at(plain, /^Upsert/), "retry 2 times, even though it may change data").flow.nodes.find((n) => n.type === "http.request")!.config.retryUnsafe).toBe(true);
    expect(run(f, at(f, /^Upsert/), "timeout 40 seconds").lines[0].message).toMatch(/L4\.timeout-too-long/);
  });
  it("a connection that does not exist is offered as New connection, pre-filled without secrets", () => {
    const r = run(f, at(f, /^Upsert/), "use the Zoho Europe connection");
    expect(r.missing[0]).toMatchObject({ name: "Zoho Europe", suggested: { config: { baseUrl: "https://www.zohoapis.eu", authType: "oauth2refresh", tokenUrl: "https://accounts.zoho.eu/oauth/v2/token", tokenPrefix: "Zoho-oauthtoken" } } });
    expect(JSON.stringify(r.missing)).not.toMatch(/secret"|refreshToken/);
  });
  it("send a request field the record does not carry yet: a rule on the mapping that builds the body", () => {
    const r = run(f, at(f, /^Upsert/), "send the First_Name field too as Nickname");
    expect(r.changes).toEqual([expect.objectContaining({ kind: "add-rule", nodeName: "Build the Zoho CRM record", field: "mapping.Nickname", after: "$vars.firstName != \"\" ? $vars.firstName" })]);
    expect(r.lines[0].understood).toMatch(/left out when empty/);
  });
});

describe("conditions, maps, answers, logs", () => {
  const f = newsletter();
  it("condition: 'web' in lower case is already WEB because the header is upper-cased where it is read", () => {
    const r = run(f, at(f, /^Check the request/), "also treat 'web' in lower case as WEB");
    expect(r.lines[0]).toMatchObject({ status: "ok", understood: expect.stringMatching(/already compares in any letter case/) });
    expect(r.changes).toEqual([]);
  });
  it("condition: a code compared as written gets any letter case", () => {
    const g = newsletter(); const ch = node(g, /^Check the request/);
    (ch.config.conditions as { expr: string }[])[0].expr = "data.channel = \"WEB\" or data.channel in [\"MOBILE\", \"AGENCY\"]";
    const r = run(g, at(g, /^Check the request/), "ignore letter case");
    expect((node(r.flow, /^Check/).config.conditions as { expr: string }[])[0].expr).toBe("$uppercase(data.channel) = \"WEB\" or $uppercase(data.channel) in [\"MOBILE\", \"AGENCY\"]");
  });
  it("map: Mobile from two fields without a space, drop empty fields, remove and rename", () => {
    const r = run(f, at(f, /^Build/), "map Mobile from country code and contact without a space\ndrop empty fields\nremove Industry\nrename Description to Note");
    expect(statuses(r)).toEqual(["ok", "ok", "ok", "ok"]);
    const rules = (node(r.flow, /^Build/).config.mapping as { rules: { target: string; expr: string }[] }).rules;
    expect(rules.find((x) => x.target === "Mobile")!.expr).toBe("($x := $string($vars.countryCode) & \"\" & $string($vars.contactClean); ($x != \"\" and $x != null) ? $x)");
    expect(rules.some((x) => x.target === "Industry")).toBe(false);
    expect(rules.some((x) => x.target === "Note")).toBe(true);
    expect(r.changes.filter((c) => c.kind === "change-rule" || c.kind === "remove-rule" || c.kind === "add-rule").map((c) => c.field)).toEqual(expect.arrayContaining(["mapping.Mobile", "mapping.Industry", "mapping.Note (was Description)"]));
  });
  it("map: other words go to the mapping phrases (checked on the server)", () => {
    const r = run(f, at(f, /^Build/), "map Shout from email in upper case");
    expect(r.instructions).toEqual([expect.objectContaining({ instruction: "email in upper case" })]);
  });
  it("answer: status, correlation header, an answer with a call's id", () => {
    const r = run(f, at(f, /^Answer 200/), "answer 201 instead of 200\nadd the correlation id header\nanswer with the lead id");
    expect(statuses(r)).toEqual(["ok", "ok", "ok"]);
    const a = r.flow.nodes.find((n) => n.name === "Answer 201")!;
    expect(a.config).toMatchObject({ status: "201", body: "{ \"leadId\": $vars.targetResponse.data[0].details.id }", headers: [{ key: "X-Correlation-ID", value: "{{ $vars.correlationId }}" }] });
  });
  it("log: level and message", () => {
    const r = run(f, at(f, /^Log the subscription/), "log at warning\nchange the message to \"subscribed {email}\"");
    expect(node(r.flow, /^Log the subscription/).config).toMatchObject({ level: "warn", message: "subscribed {{ $vars.email }}" });
  });
});

describe("structural changes", () => {
  const f = newsletter();
  it("after / before this step, error path, remove, disable, rename", () => {
    const r = run(f, at(f, /^Log the subscription/), "after this step log \"subscribed {email}\"\nbefore this step wait 1 second");
    const added = r.flow.nodes.filter((n) => !f.nodes.some((o) => o.id === n.id));
    expect(added.map((n) => n.type)).toEqual(["log", "logic.delay"]);
    const logId = added[0].id, waitId = added[1].id, base = node(f, /^Log the subscription/).id;
    expect(r.flow.edges.filter((e) => e.from === base).map((e) => e.to)).toEqual([logId]);
    expect(r.flow.edges.filter((e) => e.from === logId).map((e) => r.flow.nodes.find((n) => n.id === e.to)!.name)).toEqual(["Answer 200"]);
    expect(r.flow.edges.some((e) => e.from === waitId && e.to === base)).toBe(true);
    const err = run(f, at(f, /^Upsert/), "if this call fails answer 502 with code CRM_ERROR");
    expect(err.lines[0].status).toBe("warning");                                // it replaces the existing error path, and says so
    const target = err.flow.edges.find((e) => e.from === node(f, /^Upsert/).id && e.fromPort === "error")!;
    expect(err.flow.nodes.find((n) => n.id === target.to)!.name).toBe("Answer 502 CRM_ERROR");
    expect(err.flow.nodes.filter((n) => n.name.startsWith("Answer 502 CRM_ERROR"))).toHaveLength(1);
    const rm = run(f, at(f, /^Log the subscription/), "remove this step");
    expect(rm.flow.nodes.some((n) => n.name === "Log the subscription")).toBe(false);
    expect(rm.flow.edges.some((e) => e.fromPort === "case:c1" && rm.flow.nodes.find((n) => n.id === e.to)?.name === "Answer 200")).toBe(true);
    expect(run(f, at(f, /^POST/), "remove this step").lines[0].status).toBe("not-understood");
    expect(run(f, at(f, /^Check the request/), "remove this step").lines[0].message).toMatch(/several paths/);
    const dis = run(f, at(f, /^Log the subscription/), "disable this step\nrename this step to Log it");
    expect(dis.flow.nodes.find((n) => n.name === "Log it")!.disabled).toBe(true);
  });
  it("in STEP NAME: addresses another step from the flow level", () => {
    const r = run(f, { kind: "flow" }, "in Upsert Zoho CRM Leads: timeout 12 seconds\nbase path /newsletter/v3");
    expect(node(r.flow, /^Upsert/).config.timeoutMs).toBe(12000);
    expect(r.flow.settings.basePath).toBe("/newsletter/v3");
  });
});

describe("issues the owner saw", () => {
  it("\"Answer 200 with the lead\" returned {}: the undefined name is found and the answer is fixed", () => {
    const g = newsletter(); const a = node(g, /^Answer 200/);
    a.config.body = "{ \"lead\": lead }";
    const r = run(g, at(g, /^Answer 200/), "this returns {} — it should return the lead id");
    expect(r.diagnoses[0].text).toMatch(/reads "lead", which no step before it produces/);
    expect(r.lines[0]).toMatchObject({ status: "ok", understood: expect.stringMatching(/^diagnosis: an undefined reference/) });
    expect(node(r.flow, /^Answer 200/).config.body).toBe("{ \"leadId\": $vars.targetResponse.data[0].details.id }");
    const plain = run(g, { kind: "flow" }, "the answer is empty");
    expect(node(plain.flow, /^Answer 200/).config.body).toBe("$vars.targetResponse");
  });
  it("Zoho 401: different data centres (the owner's .sa token on the .in API) is fixed on the connection", () => {
    const f = newsletter();
    const r = run(f, { kind: "flow" }, "Zoho answers 401 INVALID_TOKEN");
    expect(r.diagnoses[0]).toMatchObject({ lesson: "L7.zoho-dc-mismatch", text: expect.stringMatching(/Saudi Arabia data centre but the base URL is in India/) });
    expect(r.connection).toMatchObject({ id: "cx_z", before: { baseUrl: "https://www.zohoapis.in" }, after: { baseUrl: "https://www.zohoapis.sa" } });
    const same = [{ ...CONNS[0], config: { ...CONNS[0].config, baseUrl: "https://www.zohoapis.sa" } }];
    expect(run(f, { kind: "flow" }, "Zoho answers 401", same).connection?.after).toMatchObject({ tokenPrefix: "Zoho-oauthtoken" });
    const apiKey = [{ id: "cx_z", name: "Zoho", type: "http", config: { baseUrl: "https://www.zohoapis.sa", authType: "apiKey" } }];
    const k = run(f, { kind: "flow" }, "Zoho answers 401", apiKey);
    expect(k.connection?.after).toMatchObject({ authType: "oauth2refresh", tokenUrl: "https://accounts.zoho.sa/oauth/v2/token", tokenPrefix: "Zoho-oauthtoken" });
    expect(k.lines[0].message).toMatch(/Enter the client id, client secret and refresh token/);
  });
  it("Zoho INVALID_DATA: empty strings are left out of the record (L7)", () => {
    const g = newsletter(); const m = node(g, /^Build/);
    (m.config.mapping as { rules: { target: string; expr: string }[] }).rules.find((x) => x.target === "Industry")!.expr = "$vars.industry";
    const r = run(g, { kind: "flow" }, "Zoho rejects the record with INVALID_DATA");
    expect(r.diagnoses[0].lesson).toBe("L7.zoho-empty-string");
    expect((node(r.flow, /^Build/).config.mapping as { rules: { target: string; expr: string }[] }).rules.find((x) => x.target === "Industry")!.expr).toMatch(/\$x != ""/);
  });
  it("invalid_client: advice only (secrets are never touched); a second lead: insert becomes upsert", () => {
    const f = newsletter();
    const r = run(f, { kind: "flow" }, "Zoho answers invalid_client");
    expect(r.changes).toEqual([]);
    expect(r.lines[0].status).toBe("warning");
    expect(r.diagnoses[0].text).toMatch(/swapped, mistyped, or from another data centre/);
    const ins = newsletter(); node(ins, /^Upsert/).config.url = "/crm/v8/Leads";
    const u = run(ins, { kind: "flow" }, "the same guest creates a second lead");
    expect(node(u.flow, /^Upsert/).config.url).toBe("/crm/v8/Leads/upsert");
    expect(u.diagnoses[0].lesson).toBe("L7.zoho-insert-not-upsert");
  });
});

describe("connections and the flow", () => {
  const f = newsletter();
  it("a connection: data centre, prefix, credentials, refresh-token sign-in, TLS", () => {
    const r = run(f, { kind: "connection", connectionId: "cx_z" }, "use the Saudi data centre\ntoken prefix Zoho-oauthtoken\nsend client credentials as Basic header\ndo not verify TLS");
    expect(r.connection?.after).toMatchObject({ baseUrl: "https://www.zohoapis.sa", tokenUrl: "https://accounts.zoho.sa/oauth/v2/token", tokenPrefix: "Zoho-oauthtoken", clientAuth: "basic", tlsVerify: false });
    expect(r.lines[3].message).toMatch(/L8\.tls-disabled/);
    expect(r.changes.every((c) => c.kind === "connection")).toBe(true);
    expect(run(f, { kind: "connection", connectionId: "cx_z" }, "use the Atlantis data centre").lines[0].status).toBe("not-understood");
  });
  it("flow level: name, gateway, payloads, timeout", () => {
    const r = run(f, { kind: "flow" }, "rename the flow to Newsletter API\ndo not publish on the gateway\nkeep step payloads in traces\ntimeout 25 seconds");
    expect(r.flow).toMatchObject({ name: "Newsletter API", settings: { logPayloads: true, timeoutMs: 25000, gateway: { publish: false } } });
    expect(r.lines[2].status).toBe("warning");
  });
  it("not understood: the 3 closest phrasings for this kind of item, nothing guessed", () => {
    const r = run(f, at(f, /^Upsert/), "make it faster please\nretry 3 times");
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatchObject({ status: "not-understood", nodeIds: [] });
    expect(r.lines[0].suggestions).toHaveLength(3);
    expect(r.changes.every((c) => c.line === 2)).toBe(true);
  });
  it("lesson warnings say whether they are new", () => {
    const r = run(f, at(f, /^Answer 200/), "answer 202 instead of 200");
    expect(r.lessonWarnings.length).toBeGreaterThan(0);
    expect(r.lessonWarnings.every((w) => w.new === false)).toBe(true);
    const bad = run(f, at(f, /^Upsert/), "call /crm/v8/Leads instead");
    expect(bad.lessonWarnings.find((w) => w.lesson === "L7.zoho-insert-not-upsert")?.new).toBe(true);
  });
});

// ------------------------------------------------------------------ preview / apply / undo, stand-in flow engine
let stub: http.Server; let runtimeUrl = "";
const store = { flow: newsletter(), versions: [] as { revision: number; note?: string; flow: Flow }[], conns: JSON.parse(JSON.stringify(CONNS)) as FullConnection[], puts: [] as unknown[] };
beforeAll(async () => {
  store.versions.push({ revision: store.flow.revision, flow: JSON.parse(JSON.stringify(store.flow)) });
  stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      const json = (s: number, v: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      const u = req.url ?? "";
      if (req.method === "GET" && u === `/v1/flows/${store.flow.id}`) return json(200, store.flow);
      if (req.method === "PUT" && u === `/v1/flows/${store.flow.id}`) {
        if (body.revision !== store.flow.revision) return json(409, { title: "Edit conflict" });
        const { changeNote, ...rest } = body; store.puts.push(changeNote);
        store.flow = { ...rest, revision: store.flow.revision + 1 }; store.versions.push({ revision: store.flow.revision, note: changeNote, flow: JSON.parse(JSON.stringify(store.flow)) });
        return json(200, store.flow);
      }
      const rm = /^\/v1\/flows\/fl_news\/versions\/(\d+)\/restore$/.exec(u);
      if (req.method === "POST" && rm) { const v = store.versions.find((x) => x.revision === Number(rm[1]))!; store.flow = { ...v.flow, revision: store.flow.revision + 1 }; store.versions.push({ revision: store.flow.revision, note: `Restored from revision ${rm[1]}`, flow: store.flow }); return json(200, store.flow); }
      if (u === "/v1/connections" && req.method === "GET") return json(200, { connections: store.conns });
      const pc = /^\/v1\/connections\/(\w+)$/.exec(u);
      if (pc && req.method === "PUT") { const c = store.conns.find((x) => x.id === pc[1])!; c.config = body.config; return json(200, c); }
      if (u === "/v1/connectors" || u === "/v1/flows") return json(200, { connectors: [], flows: [] });
      if (u === "/v1/flows/validate") return json(200, { issues: body.flow.nodes.some((n: { config: { status?: string } }) => n.config.status === "299") ? [{ level: "error", message: "odd status" }] : [{ level: "warning", message: "already there" }] });
      json(404, { title: "no" });
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  runtimeUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => stub.close(r)); });
async function app() { const a = Fastify(); registerEdit(a, { runtimeUrl, internalKey: "k" }, async () => "tester", loadDescribeConfig({})); await a.ready(); return a; }

describe("preview, apply, undo", () => {
  it("preview changes nothing; apply saves a new revision with the words as the note; undo restores the one before", async () => {
    const a = await app();
    const answer = store.flow.nodes.find((n) => n.name === "Answer 200")!.id;
    const body = { flowId: "fl_news", target: { kind: "node", nodeId: answer }, text: "answer 201 instead of 200\nadd header X-Version \"1\"", baseRevision: 7 };
    const p = (await a.inject({ method: "POST", url: "/api/factory/describe/edit", payload: body })).json();
    expect(p).toMatchObject({ ok: true, baseRevision: 7, targetLabel: "Answer 200", issues: [{ message: "already there", new: false }] });
    expect(p.changes.map((c: { field: string }) => c.field)).toEqual(["status", "headers"]);
    expect(store.flow.revision).toBe(7);
    const ap = (await a.inject({ method: "POST", url: "/api/factory/describe/edit/apply", payload: body })).json();
    expect(ap).toMatchObject({ applied: true, previousRevision: 7, flow: { revision: 8 } });
    expect(store.puts[0]).toBe("In your own words (Answer 200): answer 201 instead of 200 add header X-Version \"1\"");
    expect(store.flow.nodes.find((n) => n.id === answer)!.config.status).toBe("201");
    const stale = await a.inject({ method: "POST", url: "/api/factory/describe/edit/apply", payload: body });
    expect(stale.statusCode).toBe(409);
    const un = (await a.inject({ method: "POST", url: "/api/factory/describe/edit/undo", payload: { flowId: "fl_news", revision: 7 } })).json();
    expect(un.flow.revision).toBe(9);
    expect(store.flow.nodes.find((n) => n.id === answer)!.config.status).toBe("200");
    expect(store.versions.at(-1)!.note).toBe("Restored from revision 7");
  });
  it("refuses to apply lines that are not understood, or changes that add an error", async () => {
    const a = await app();
    const answer = store.flow.nodes.find((n) => n.name === "Answer 200")!.id;
    const r1 = await a.inject({ method: "POST", url: "/api/factory/describe/edit/apply", payload: { flowId: "fl_news", target: { kind: "node", nodeId: answer }, text: "make it nicer", baseRevision: store.flow.revision } });
    expect(r1.statusCode).toBe(409);
    expect(r1.json().detail).toMatch(/Not understood/);
    const p = (await a.inject({ method: "POST", url: "/api/factory/describe/edit", payload: { flowId: "fl_news", target: { kind: "node", nodeId: answer }, text: "status 299" } })).json();
    expect(p.ok).toBe(false);
    expect(p.issues).toEqual(expect.arrayContaining([{ level: "error", message: "odd status", new: true }]));
  });
  it("a connection change is applied (secrets untouched) and undone", async () => {
    const a = await app();
    const ap = (await a.inject({ method: "POST", url: "/api/factory/describe/edit/apply", payload: { target: { kind: "connection", connectionId: "cx_z" }, text: "use the Saudi data centre\ntoken prefix Zoho-oauthtoken" } })).json();
    expect(ap.connection).toMatchObject({ id: "cx_z", before: { baseUrl: "https://www.zohoapis.in", tokenPrefix: "Bearer" } });
    expect(store.conns[0].config).toMatchObject({ baseUrl: "https://www.zohoapis.sa", tokenPrefix: "Zoho-oauthtoken" });
    expect(Object.keys(store.conns[0].config)).not.toEqual(expect.arrayContaining(["clientSecret", "refreshToken"]));
    await a.inject({ method: "POST", url: "/api/factory/describe/edit/undo", payload: { connection: ap.connection } });
    expect(store.conns[0].config).toMatchObject({ baseUrl: "https://www.zohoapis.in", tokenPrefix: "Bearer" });
  });
  it("needs a session and a target; the local model stays off by default", async () => {
    const a = await app();
    expect((await a.inject({ method: "POST", url: "/api/factory/describe/edit", payload: { text: "x" } })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: "/api/factory/describe/edit/model", payload: { flowId: "fl_news", target: { kind: "flow" }, text: "x" } })).statusCode).toBe(404);
    expect((await a.inject({ method: "GET", url: "/api/factory/describe/edit/phrases" })).json().model).toEqual({ enabled: false, configured: false });
  });
});
