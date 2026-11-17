// "Describe the flow": the step reader (packages/weave-flow/src/describe.ts), the preview route and the
// switched-off-by-default local model hook. No model and no outside service is ever called here: the
// flow engine is a stand-in on loopback, the model a fake fetch.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { describeFlow, closestPhrases, STEP_PHRASES, type ConnectorDef, type DescribeContext } from "@traceit/weave-flow";
import { askModel, conditionByWords, isLocalModelUrl, loadDescribeConfig, modelPrompt, registerDescribe } from "../src/describe/routes.js";

const EXAMPLE = "When POST /guests/check arrives / Look up the contact in Zoho by email / If not found, create the contact in Zoho with first name, last name, email / Log \"guest checked\" / Answer 201 with the contact id";
const zoho: ConnectorDef = { id: "zoho", name: "Zoho", connectionType: "http", defaultConnectionId: "cx_zoho", createdAt: "", updatedAt: "", operations: [
  { id: "searchContacts", name: "Search contacts", method: "GET", path: "/contacts/search", params: [{ key: "email", label: "Email", kind: "template" }] },
  { id: "createContact", name: "Create contact", method: "POST", path: "/contacts", params: [] },
  { id: "updateContact", name: "Update contact", method: "PUT", path: "/contacts/{id}", params: [{ key: "id", label: "Id", kind: "template" }] },
  { id: "deleteContact", name: "Delete contact", method: "DELETE", path: "/contacts/{id}", params: [{ key: "id", label: "Id", kind: "template" }] },
] };
const CTX: DescribeContext = {
  connections: [{ id: "cx_zoho", name: "Zoho", type: "http" }, { id: "cx_crm", name: "crm", type: "mysql" }, { id: "cx_dw", name: "dw", type: "mssql" }, { id: "cx_pg", name: "ledger", type: "postgres" }, { id: "cx_sys", name: "sample-system-api", type: "http" }],
  connectors: [zoho], flows: [{ id: "fl_leads", name: "Leads" }],
  apis: [{ name: "reservation-mgr-exp-api", basePath: "/reservations/v1", baseUrl: "http://node.example.invalid:30123", operations: [{ id: "getBooking", method: "GET", path: "/bookings/{bookingId}", summary: "Get booking" }] }],
};
const read = (text: string, ctx: DescribeContext = CTX, opts = {}) => describeFlow(text, ctx, opts);
const nodeOf = (r: ReturnType<typeof read>, line: number) => r.flow.nodes.filter((n) => r.lines.find((l) => l.line === line)!.nodeIds.includes(n.id));
const edges = (r: ReturnType<typeof read>) => r.flow.edges.map((e) => `${r.flow.nodes.find((n) => n.id === e.from)!.name} -${e.fromPort}-> ${r.flow.nodes.find((n) => n.id === e.to)!.name}`);

describe("the owner's example", () => {
  const r = read(EXAMPLE);
  it("is understood line by line, each line linked to the steps it made", () => {
    expect(r.ok).toBe(true);
    expect(r.lines.map((l) => l.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(r.flow.nodes.map((n) => n.type)).toEqual(["trigger.http", "connector:zoho:searchContacts", "logic.choice", "connector:zoho:createContact", "log", "respond"]);
    expect(nodeOf(r, 1)[0].config).toMatchObject({ methods: ["POST"], path: "/guests/check" });
    expect(nodeOf(r, 2)[0].config).toMatchObject({ connection: "cx_zoho", email: "{{ email }}", resultTarget: "variable", resultVar: "contact" });
    expect(nodeOf(r, 3).map((n) => n.type)).toEqual(["logic.choice", "connector:zoho:createContact"]);
    expect(nodeOf(r, 3)[0].config.conditions).toEqual([{ id: "c1", label: "Not found", expr: "$isEmpty($vars.contact)" }]);
    expect(nodeOf(r, 4)[0].config).toMatchObject({ level: "info", message: "guest checked" });
    expect(nodeOf(r, 5)[0].config).toMatchObject({ status: "201", body: "{ \"contactId\": $vars.contact.id }" });
  });
  it("joins both paths of the condition before the log line", () => {
    expect(edges(r)).toEqual([
      "POST /guests/check -out-> Look up contact in Zoho", "Look up contact in Zoho -out-> If not found", "If not found -case:c1-> Create contact in Zoho",
      "Create contact in Zoho -out-> Log guest checked", "If not found -otherwise-> Log guest checked", "Log guest checked -out-> Answer 201",
    ]);
  });
  it("lays the steps out left to right and writes a made-up sample request", () => {
    const xs = r.flow.nodes.map((n) => n.position.x);
    expect(new Set(r.flow.nodes.map((n) => `${n.position.x}:${n.position.y}`)).size).toBe(r.flow.nodes.length);
    expect(xs[0]).toBeLessThan(xs[xs.length - 1]);
    expect(r.flow.nodes[0].config.sampleRequest).toEqual({ method: "POST", path: "/guests/check", body: { email: "jane.doe@example.invalid", firstName: "Jane", lastName: "Doe" } });
    expect(r.flow.name).toBe("Guests check");
  });
  it("is deterministic", () => { expect(JSON.stringify(read(EXAMPLE))).toBe(JSON.stringify(r)); });
  it("without a Zoho connector, says the connection is missing and still makes the draft", () => {
    const x = read(EXAMPLE, {});
    expect(x.ok).toBe(true);
    expect(x.missing).toEqual([expect.objectContaining({ name: "Zoho", type: "http", lines: [2, 3] })]);
    expect(nodeOf(x, 2)[0]).toMatchObject({ type: "http.request", config: { method: "GET", connection: "", query: [{ key: "email", value: "{{ email }}" }] } });
    expect(nodeOf(x, 3)[1].config).toMatchObject({ method: "POST", bodyMode: "json", body: { firstName: "{{ firstName }}", lastName: "{{ lastName }}", email: "{{ email }}" } });
    expect(x.lines[1].status).toBe("warning");
  });
  it("reads the same steps written as a numbered list with a name line", () => {
    const x = read(["Guest check:", "1. When POST /guests/check arrives", "2. Look up the contact in Zoho by email", "3) If not found, create the contact in Zoho with first name, last name, email.", "- Log \"guest checked\"", "* Answer 201 with the contact id"].join("\n"));
    expect(x.flow.name).toBe("Guest check");
    expect(x.lines[0]).toMatchObject({ role: "header", status: "ok" });
    expect(x.flow.nodes.map((n) => n.type)).toEqual(r.flow.nodes.map((n) => n.type));
  });
});

describe("every phrase in \"What you can write\"", () => {
  for (const p of STEP_PHRASES) {
    it(`${p.group}: ${p.example.split("\n")[0]}`, () => {
      const pre = p.group === "Start" || p.group === "Other" ? "" : "When POST /x arrives\nLook up the contact in Zoho by email\n";
      const x = read(pre + p.example);
      const mine = x.lines.slice(pre ? 2 : 0).filter((l) => l.text);
      expect(mine.map((l) => [l.text, l.status]).filter(([, s]) => s === "not-understood")).toEqual([]);
      for (const l of mine) expect(l.understood, l.text).toBeTruthy();
    });
  }
  it("each makes the step it promises", () => {
    const one = (t: string) => read(`When POST /x arrives\nLook up the contact in Zoho by email\n${t}`).flow.nodes.slice(2);
    expect(read("Every 15 minutes").flow.nodes[0].config).toMatchObject({ mode: "interval", everySeconds: 900 });
    expect(read("Every day at 06:30").flow.nodes[0].config).toMatchObject({ mode: "cron", cron: "30 6 * * *" });
    expect(read("Every monday at 9").flow.nodes[0].config).toMatchObject({ mode: "cron", cron: "0 9 * * 1" });
    expect(read("On schedule \"*/5 * * * *\"").flow.nodes[0].config).toMatchObject({ mode: "cron", cron: "*/5 * * * *" });
    expect(read("When GET /bookings/{id} is called").flow.nodes[0].config).toMatchObject({ methods: ["GET"], path: "/bookings/:id" });
    expect(read("When GET or POST /items arrives").flow.nodes[0].config).toMatchObject({ methods: ["GET", "POST"] });
    const q = read("When a message arrives on queue guest-updates");
    expect(q.flow.nodes[0].type).toBe("trigger.manual");
    expect(q.lines[0].status).toBe("warning");
    expect(q.lines[0].message).toMatch(/no queue listener/);
    expect(one("Insert into table guests in database crm with first name, last name, email")[0].config).toMatchObject({ connection: "cx_crm", sql: "insert into guests (first_name, last_name, email) values (?, ?, ?)", params: ["firstName", "lastName", "email"] });
    expect(one("Find the guest in table guests in database dw by email")[0]).toMatchObject({ type: "mssql.query", config: { sql: "select * from guests where email = @p1", resultMode: "first", resultVar: "guest" } });
    expect(one("Read all rows from table entries in database ledger where status is \"open\"")[0]).toMatchObject({ type: "postgres.query", config: { sql: "select * from entries where status = $1", params: ["\"open\""], resultMode: "rows" } });
    expect(one("Update table guests in database crm set phone by email")[0].config).toMatchObject({ sql: "update guests set phone = ? where email = ?", params: ["phone", "email"] });
    expect(one("Delete from table sessions in database crm by session id")[0].config).toMatchObject({ sql: "delete from sessions where session_id = ?", params: ["sessionId"] });
    expect(one("Run procedure merge_guest in database dw with email, last name")[0].config).toMatchObject({ operation: "procedure", procedure: "merge_guest", procInputs: [{ key: "email", value: "email" }, { key: "last_name", value: "lastName" }] });
    expect(one("Run SQL \"select count(*) as n from guests\" on database crm")[0].config).toMatchObject({ sql: "select count(*) as n from guests", resultMode: "rows" });
    expect(one("Update the contact in Zoho with phone")[0].config).toMatchObject({ id: "{{ $vars.contact.id }}" });
    expect(one("Delete the contact in Zoho by contact id")[0]).toMatchObject({ type: "connector:zoho:deleteContact", config: { id: "{{ $vars.contact.id }}" } });
    expect(one("Call Zoho searchContacts with email")[0].type).toBe("connector:zoho:searchContacts");
    expect(one("Call GET /reference/ships on sample-system-api")[0].config).toMatchObject({ connection: "cx_sys", method: "GET", url: "/reference/ships" });
    expect(one("Run flow Leads")[0]).toMatchObject({ type: "flow.call", config: { flow: "fl_leads" } });
    expect(one("Set source to \"web\"")[0].config).toEqual({ assignments: [{ key: "source", value: "\"web\"" }] });
    expect(one("Remember the contact id as contactId")[0].config).toEqual({ assignments: [{ key: "contactId", value: "$vars.contact.id" }] });
    expect(one("Log \"guest {email} checked\"")[0].config).toMatchObject({ message: "guest {{ email }} checked" });
    expect(one("Log a warning \"contact missing\"")[0].config).toMatchObject({ level: "warn" });
    expect(one("Log the contact id")[0].config).toMatchObject({ message: "contactId: {{ $vars.contact.id }}" });
    expect(one("Require email and last name")[0].config).toMatchObject({ status: 400, rules: [{ expr: "$not($isEmpty(email))" }, { expr: "$not($isEmpty(lastName))" }] });
    expect(one("Reject with 422 if the age is less than 18")[0].config).toMatchObject({ status: 422, rules: [{ expr: "$not(age < 18)" }] });
    expect(one("Fail with 409 \"already checked in\"")[0].config).toEqual({ mode: "error", status: 409, message: "already checked in" });
    expect(one("Answer 200 with the contact")[0].config).toMatchObject({ status: "200", body: "$vars.contact" });
    expect(one("Answer 404 with message \"guest not found\"")[0].config).toMatchObject({ body: "{ \"message\": \"guest not found\" }" });
    expect(one("Answer 200 with {\"ok\": true}")[0].config).toMatchObject({ body: "{\"ok\": true}" });
    expect(one("Answer created with the contact")[0].config).toMatchObject({ status: "201" });
    expect(one("Wait 2 seconds")[0].config).toEqual({ ms: 2000 });
    expect(one("Convert the XML to JSON")[0].config).toMatchObject({ mode: "xml2json" });
  });
  it("calls an operation of a migrated API, and offers its address for the missing connection", () => {
    const x = read("When GET /b/:id arrives\nGet the booking in reservation-mgr-exp-api by path parameter id");
    expect(x.flow.nodes[1]).toMatchObject({ type: "http.request", config: { method: "GET", url: "/reservations/v1/bookings/{{ $request.params.id }}" } });
    expect(x.missing).toEqual([expect.objectContaining({ name: "reservation-mgr-exp-api", type: "http", suggested: { baseUrl: "http://node.example.invalid:30123" } })]);
  });
  it("names the missing database and its kind", () => {
    const x = read("When POST /x arrives\nInsert into table t in the SQL Server database archive with email");
    expect(x.flow.nodes[1].type).toBe("mssql.query");
    expect(x.missing).toEqual([expect.objectContaining({ name: "archive", type: "mssql" })]);
    const y = read("When POST /x arrives\nInsert into table t in database archive with email");
    expect(y.lines[1].status).toBe("warning");
    expect(y.lines[1].message).toMatch(/MySQL is assumed/);
  });
});

describe("conditions", () => {
  const cond = (c: string) => { const x = read(`When POST /x arrives\nIf ${c}, log "y"`); return x.lines[1].status === "ok" ? (x.flow.nodes[1].config.conditions as { expr: string }[])[0].expr : null; };
  it("reads the condition words into expressions", () => {
    expect(cond("the status is \"VIP\"")).toBe("status = \"VIP\"");
    expect(cond("the status is not cancelled")).toBe("status != \"cancelled\"");
    expect(cond("the email is empty")).toBe("$isEmpty(email)");
    expect(cond("the email is not empty")).toBe("$not($isEmpty(email))");
    expect(cond("the email contains \"@\"")).toBe("$contains(email, \"@\")");
    expect(cond("the email starts with \"jane\"")).toBe("$substring(email, 0, 4) = \"jane\"");
    expect(cond("the email ends with \".invalid\"")).toBe("$substring(email, -8) = \".invalid\"");
    expect(cond("the age is greater than 17")).toBe("age > 17");
    expect(cond("the age is less than 18")).toBe("age < 18");
    expect(cond("the age is at least 18")).toBe("age >= 18");
    expect(cond("the age is at most 65")).toBe("age <= 65");
    expect(cond("the age is between 18 and 65")).toBe("age >= 18 and age <= 65");
    expect(cond("the country is one of \"US\", \"CA\"")).toBe("country in [\"US\", \"CA\"]");
    expect(cond("the guest is vip and the age is at least 18")).toBe("(guest = \"vip\") and (age >= 18)");
    expect(cond("the channel is \"web\" or the channel is \"app\"")).toBe("(channel = \"web\") or (channel = \"app\")");
    expect(cond("active is true")).toBe("$toBool(active) = true");
    expect(cond("the query parameter page is 2")).toBe("$request.query.page = 2");
    expect(cond("header x-tenant is \"a\"")).toBe("$request.headers.\"x-tenant\" = \"a\"");
    expect(cond("found")).toBe("$not($isEmpty($))");
    expect(cond("the contact is found")).toBe("$not($isEmpty(contact))");
  });
  it("does not guess: text of several words must be quoted", () => {
    expect(cond("the moon is made of cheese")).toBeNull();
  });
  it("falls back to the mapping phrase rules only for what they compile, keeping just the condition", () => {
    const c = conditionByWords("data.status is \"A\"");
    expect(c === null || !/\?\s*true/.test(c.expr)).toBe(true);
  });
  it("nests conditions by indentation, with Otherwise if and Otherwise", () => {
    const x = read([
      "When POST /guests arrives",
      "Look up the contact in Zoho by email",
      "If not found:",
      "  If the country is \"US\":",
      "    Create the contact in Zoho with first name, email",
      "  Otherwise if the country is \"CA\", log \"ca guest\"",
      "  Otherwise:",
      "    Log \"not a US guest\"",
      "    Answer 422 with message \"only US and CA guests\"",
      "Answer 200 with the contact",
    ].join("\n"));
    expect(x.ok).toBe(true);
    const inner = x.flow.nodes.find((n) => n.name === "If the country is \"US\"")!;
    expect(inner.config.conditions).toEqual([{ id: "c1", label: "The country is \"US\"", expr: "country = \"US\"" }, { id: "c2", label: "The country is \"CA\"", expr: "country = \"CA\"" }]);
    expect(edges(x)).toEqual(expect.arrayContaining([
      "If not found -case:c1-> If the country is \"US\"", "If the country is \"US\" -case:c1-> Create contact in Zoho", "If the country is \"US\" -case:c2-> Log ca guest",
      "If the country is \"US\" -otherwise-> Log not a US guest", "Log not a US guest -out-> Answer 422", "Create contact in Zoho -out-> Answer 200", "Log ca guest -out-> Answer 200", "If not found -otherwise-> Answer 200",
    ]));
    expect(edges(x).filter((e) => e.startsWith("Answer 422"))).toEqual([]);
  });
  it("reads If / Otherwise / End if written flat, and If … then … otherwise … on one line", () => {
    const x = read(["When GET /x arrives", "If the age is at least 18", "Log \"adult\"", "Otherwise", "Log \"minor\"", "End if", "Log \"after\""].join("\n"));
    expect(x.ok).toBe(true);
    expect(edges(x)).toEqual(["GET /x -out-> If the age is at least 18", "If the age is at least 18 -case:c1-> Log adult", "If the age is at least 18 -otherwise-> Log minor", "Log adult -out-> Log after", "Log minor -out-> Log after"]);
    const y = read("When GET /x arrives\nIf the status is \"VIP\" then log \"vip\" otherwise log \"regular\"");
    expect(edges(y)).toEqual(["GET /x -out-> If the status is \"VIP\"", "If the status is \"VIP\" -case:c1-> Log vip", "If the status is \"VIP\" -otherwise-> Log regular"]);
  });
});

describe("loops, errors and retries", () => {
  it("For each: the item name means the current entry; the flow carries on after the loop", () => {
    const x = read("When POST /orders arrives\nFor each line in the order lines:\n  Log \"line {line sku}\"\nAnswer 200");
    expect(x.flow.nodes[1]).toMatchObject({ type: "logic.foreach", config: { items: "orderLines" } });
    expect(x.flow.nodes[2].config.message).toBe("line {{ $item.sku }}");
    expect(edges(x)).toEqual(["POST /orders -out-> For each line", "For each line -each-> Log line …", "For each line -done-> Answer 200"]);
    expect((x.flow.nodes[0].config.sampleRequest as { body: unknown }).body).toEqual({ orderLines: [{ sku: "sample" }] });
  });
  it("If the call fails: wired to the On error output of the call above", () => {
    const x = read("When POST /x arrives\nLook up the contact in Zoho by email\nRetry 3 times waiting 2 seconds\nTime out after 10 seconds\nIf the call fails, answer 502 with the error\nAnswer 200 with the contact");
    expect(x.flow.nodes[1].config).toMatchObject({ retries: 3, retryDelayMs: 2000, timeoutMs: 10000 });
    expect(x.lines[2].nodeIds).toEqual([x.flow.nodes[1].id]);
    expect(edges(x)).toEqual(expect.arrayContaining(["Look up contact in Zoho -error-> Answer 502", "Look up contact in Zoho -out-> Answer 200"]));
    expect(x.flow.nodes.find((n) => n.name === "Answer 502")!.config.body).toBe("{ \"error\": { \"message\": $error.message } }");
  });
  it("an error path that only logs carries on with the flow", () => {
    const x = read("When POST /x arrives\nLook up the contact in Zoho by email, retry 2 times\nOn error, log an error \"zoho down\"\nAnswer 200");
    expect(x.flow.nodes[1].config.retries).toBe(2);
    expect(edges(x)).toEqual(expect.arrayContaining(["Look up contact in Zoho -error-> Log error", "Log error -out-> Answer 200", "Look up contact in Zoho -out-> Answer 200"]));
  });
  it("lists lines it does not understand with the 3 closest phrasings, and guesses nothing", () => {
    const x = read(["When GET /x arrives", "Retry 3 times", "Otherwise, log \"x\"", "Make the coffee please", "If the call fails, log \"x\"", "End", "Answer 200", "Log \"after the answer\""].join("\n"));
    expect(x.ok).toBe(false);
    const bad = x.lines.filter((l) => l.status === "not-understood");
    expect(bad.map((l) => l.line)).toEqual([2, 3, 4, 5, 6, 8]);
    for (const l of bad) { expect(l.suggestions).toHaveLength(3); expect(l.nodeIds).toEqual([]); expect(l.message).toBeTruthy(); }
    expect(bad[0].message).toMatch(/no call above/);
    expect(bad[1].message).toMatch(/needs an "If/);
    expect(bad[5].message).toMatch(/Nothing leads to this line/);
    expect(x.flow.nodes.map((n) => n.type)).toEqual(["trigger.http", "respond"]);
    expect(closestPhrases("retry three times")[0].phrase).toMatch(/^Retry/);
  });
  it("starts with a Manual start when no start is written, and says so", () => {
    const x = read("Log \"hello\"");
    expect(x.flow.nodes[0].type).toBe("trigger.manual");
    expect(x.notes[0]).toMatch(/Manual/);
  });
  it("attach mode (adding to an open canvas) invents no start and names the first step", () => {
    const x = read("Log \"hello\"\nAnswer 200", CTX, { attach: true });
    expect(x.flow.nodes.map((n) => n.type)).toEqual(["log", "respond"]);
    expect(x.entry).toEqual([x.flow.nodes[0].id]);
  });
  it("Map lines make one Transform step; plain fields copy, other words go to the mapping phrases with a made-up sample", () => {
    const x = read("When POST /x arrives\nLook up the contact in Zoho by email\nMap: fullName from join first name and last name with a space\nMap: email from email\nMap: id from the contact id\nAnswer 200");
    const map = x.flow.nodes.find((n) => n.type === "transform.map")!;
    expect((map.config.mapping as { rules: unknown[] }).rules).toEqual([
      { id: "r1", target: "fullName", kind: "instruction", instruction: "join first name and last name with a space", compiled: null },
      { id: "r2", target: "email", kind: "direct", source: "email" },
      { id: "r3", target: "id", kind: "expr", expr: "$vars.contact.id" },
    ]);
    expect((map.config.mapping as { sampleSource: unknown }).sampleSource).toMatchObject({ firstName: "Jane", lastName: "Doe" });
    expect(x.instructions).toEqual([{ nodeId: map.id, ruleId: "r1", line: 3, instruction: "join first name and last name with a space" }]);
    expect(x.flow.nodes.at(-1)!.config.body).toBe("$");
  });
});

// ------------------------------------------------------------------ routes, with a stand-in flow engine
let stub: http.Server; let runtimeUrl = "";
const seen: { method: string; url: string; body: any }[] = [];
beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      const json = (s: number, v: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.headers["x-weave-key"] !== "k") return json(401, { title: "no key" });
      if (req.url === "/v1/connections") return json(200, { connections: [{ id: "cx_zoho", name: "Zoho", type: "http", config: { baseUrl: "http://hidden.example.invalid" } }] });
      if (req.url === "/v1/connectors") return json(200, { connectors: [zoho] });
      if (req.url === "/v1/flows") return json(200, { flows: [{ id: "fl_leads", name: "Leads", slug: "leads" }] });
      if (req.url === "/v1/flows/validate") return json(200, { issues: body.flow.nodes.some((n: any) => n.type === "http.request" && !n.config.url) ? [{ level: "error", message: "URL or path is required" }] : [] });
      if (req.url === "/v1/mapping/compile-instruction") return json(200, /join/.test(body.instruction) && body.sampleSource?.firstName ? { compiled: { expr: "firstName & \" \" & lastName", explanation: "first name and last name joined", confidence: "exact", engine: "rules" }, suggestions: [] } : { compiled: null, suggestions: ["upper case of FIELD", "join FIELD and FIELD2 with \" \"", "FIELD"], reason: "not clear" });
      json(404, { title: "not here" });
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  runtimeUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => stub.close(r)); });

async function app(user: string | null = "tester", env: NodeJS.ProcessEnv = {}) {
  const a = Fastify();
  registerDescribe(a, { runtimeUrl, internalKey: "k" }, async () => user, undefined, loadDescribeConfig(env));
  await a.ready();
  return a;
}

describe("POST /api/factory/describe/preview", () => {
  it("reads the text with the server's connectors, compiles map words and returns the engine's check", async () => {
    const a = await app();
    seen.length = 0;
    const r = await a.inject({ method: "POST", url: "/api/factory/describe/preview", payload: { text: EXAMPLE.replace(" / Answer 201", " / Map: fullName from join first name and last name with a space / Map: shout from shout the email loudly / Answer 201") } });
    expect(r.statusCode).toBe(200);
    const p = r.json();
    expect(p.engine).toBe("rules");
    expect(p.flow.nodes[1].type).toBe("connector:zoho:searchContacts");
    expect(p.missing).toEqual([]);
    expect(p.issues).toEqual([]);
    const l6 = p.lines.find((l: any) => l.line === 5), l7 = p.lines.find((l: any) => l.line === 6);
    expect(l6.status).toBe("ok");
    expect(l7.status).toBe("not-understood");
    expect(l7.suggestions).toHaveLength(3);
    expect(l7.suggestions.every((x: any) => x.phrase.startsWith("Map: shout from "))).toBe(true);
    expect(p.ok).toBe(false);
    const map = p.flow.nodes.find((n: any) => n.type === "transform.map");
    expect(map.config.mapping.rules[0].compiled.expr).toBe("firstName & \" \" & lastName");
    expect(seen.map((s) => s.url)).toEqual(expect.arrayContaining(["/v1/connections", "/v1/connectors", "/v1/flows", "/v1/mapping/compile-instruction", "/v1/flows/validate"]));
    expect(seen.find((s) => s.url === "/v1/flows/validate")!.body.flow.settings.basePath).toBe("/guests-check/v1");
    expect(JSON.stringify(p)).not.toContain("hidden.example.invalid");
  });
  it("passes the engine's problems through, saves nothing", async () => {
    const a = await app();
    seen.length = 0;
    const r = await a.inject({ method: "POST", url: "/api/factory/describe/preview", payload: { text: "When GET /x arrives\nLook up the weather in Meteo by city\nAnswer 200 with the weather" } });
    const p = r.json();
    expect(p.missing.map((m: any) => m.name)).toEqual(["Meteo"]);
    expect(p.issues).toEqual([{ level: "error", message: "URL or path is required" }]);
    expect(seen.filter((s) => s.method !== "GET" && s.url === "/v1/flows")).toEqual([]);
  });
  it("add mode returns the first step instead of a start", async () => {
    const a = await app();
    const p = (await a.inject({ method: "POST", url: "/api/factory/describe/preview", payload: { text: "Log \"x\"", mode: "add" } })).json();
    expect(p.flow.nodes.map((n: any) => n.type)).toEqual(["log"]);
    expect(p.entry).toEqual([p.flow.nodes[0].id]);
  });
  it("refuses without a session, without text and for very long text", async () => {
    expect((await (await app(null)).inject({ method: "POST", url: "/api/factory/describe/preview", payload: { text: "x" } })).statusCode).toBe(401);
    const a = await app();
    expect((await a.inject({ method: "POST", url: "/api/factory/describe/preview", payload: { text: "  " } })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: "/api/factory/describe/preview", payload: { text: "x".repeat(20_001) } })).statusCode).toBe(400);
  });
  it("says when the flow engine cannot check the draft", async () => {
    const a = Fastify();
    registerDescribe(a, { runtimeUrl: "http://127.0.0.1:9", internalKey: "k" }, async () => "tester", undefined, loadDescribeConfig({}));
    const p = (await a.inject({ method: "POST", url: "/api/factory/describe/preview", payload: { text: "When GET /x arrives\nAnswer 200" } })).json();
    expect(p.issues).toBeNull();
    expect(p.validationError).toMatch(/could not be reached/);
    expect(p.flow.nodes).toHaveLength(2);
  });
});

describe("Draft with the local model (switched off unless DESCRIBE_MODEL_ENABLED)", () => {
  it("is off by default, and the config says so", async () => {
    expect(loadDescribeConfig({}).modelEnabled).toBe(false);
    const a = await app();
    expect((await a.inject({ method: "GET", url: "/api/factory/describe" })).json().model).toEqual({ enabled: false, configured: false });
    const r = await a.inject({ method: "POST", url: "/api/factory/describe/model", payload: { text: "check guests" } });
    expect(r.statusCode).toBe(404);
    expect(r.json().title).toMatch(/switched off/);
  });
  it("says plainly when it is on but has no address", async () => {
    const a = await app("tester", { DESCRIBE_MODEL_ENABLED: "true" });
    expect((await a.inject({ method: "GET", url: "/api/factory/describe" })).json().model).toEqual({ enabled: true, configured: false });
    const r = await a.inject({ method: "POST", url: "/api/factory/describe/model", payload: { text: "check guests" } });
    expect(r.statusCode).toBe(503);
    expect(r.json().title).toBe("The local model is not configured");
  });
  it("only talks to a model on this machine or the private network", () => {
    for (const u of ["http://127.0.0.1:8099", "http://localhost:8099", "http://weave-change-model:8080", "http://10.1.2.3", "http://192.168.0.4:1"]) expect(isLocalModelUrl(u), u).toBe(true);
    for (const u of ["https://api.example.com", "http://8.8.8.8", "ftp://127.0.0.1", "not a url"]) expect(isLocalModelUrl(u), u).toBe(false);
  });
  it("asks for step lines, and its answer goes through the same reader", async () => {
    let asked: any = null;
    const fake = (async (url: string, init: any) => { asked = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ choices: [{ message: { content: "```\nWhen POST /guests/check arrives\nLook up the contact in Zoho by email\nAnswer 200 with the contact\n```" } }] }), { status: 200 }); }) as unknown as typeof fetch;
    const m = await askModel({ modelEnabled: true, modelUrl: "http://127.0.0.1:8099", modelTimeoutMs: 5000, nodeHost: "x" }, "when a guest checks, find them in zoho and answer", CTX, fake);
    expect(m.ok).toBe(true);
    expect(asked.url).toBe("http://127.0.0.1:8099/v1/chat/completions");
    expect(asked.body.temperature).toBe(0);
    expect(asked.body.messages[0].content).toContain("Look up | Find | Get the THING in SYSTEM by FIELD");
    expect(asked.body.messages[0].content).toContain("Zoho (connector: searchContacts");
    if (m.ok) { expect(m.lines).not.toContain("```"); expect(read(m.lines).ok).toBe(true); }
  });
  it("says so when the model is slow or unreachable", async () => {
    const slow = (async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }) as unknown as typeof fetch;
    const r = await askModel({ modelEnabled: true, modelUrl: "http://127.0.0.1:8099", modelTimeoutMs: 5000, nodeHost: "x" }, "x", {}, slow);
    expect(r).toMatchObject({ ok: false, status: 504, title: "The local model did not answer within 5 seconds" });
    const down = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await askModel({ modelEnabled: true, modelUrl: "http://127.0.0.1:8099", modelTimeoutMs: 5000, nodeHost: "x" }, "x", {}, down)).toMatchObject({ ok: false, status: 502, title: "The local model cannot be reached" });
  });
  it("the prompt carries names only, never connection settings", () => {
    const p = modelPrompt("x", { connections: [{ id: "cx", name: "Zoho", type: "http" }] });
    expect(p.system).toContain("Zoho (http connection)");
    expect(p.system).not.toMatch(/cx\b|baseUrl|password/);
  });
});
