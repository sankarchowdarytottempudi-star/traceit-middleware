// Requirement-document mode of "Describe the flow" (packages/weave-flow/src/document.ts): detection, each
// table kind, rule lists, conflicts, Zoho data centres, and the preview route with a stand-in flow engine.
// The newsletter fixture is a sanitized copy of the owner's document (made-up e-mail and digits).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { looksLikeDocument, readDocument, secretLooksLabelled, zohoApiFor, zohoMismatch, zohoTokenUrlFor } from "@traceit/weave-flow";
import { loadDescribeConfig, registerDescribe } from "../src/describe/routes.js";

const NEWSLETTER = fs.readFileSync(path.join(__dirname, "fixtures/newsletter-requirement.txt"), "utf8");
const lines = (...l: string[]) => l.join("\n");
/** A small document built from parts; every part is optional. */
const mini = (parts: Partial<Record<"endpoint" | "headers" | "body" | "response" | "errors" | "mapping" | "rules" | "target" | "nfr" | "tests" | "questions", string>>) => lines(
  "Orders to the ERP – Integration Requirement",
  "1. Background",
  "Customers place orders on the web site and the orders must reach the ERP system quickly, with the right customer and channel data.",
  "The team will build an API that receives the order, checks it, transforms it and writes it to the ERP, then answers the front end.",
  "Everything is logged and errors are answered in one standard shape so the front end can show a message to the customer.",
  "2. API contract",
  "2.1 Endpoint",
  parts.endpoint ?? lines("Item", "Value", "Method", "POST", "Path", "/orders/v1/create", "Content type", "application/json"),
  "2.2 Request headers",
  parts.headers ?? lines("Header", "Mandatory", "Allowed values", "Notes", "X-Source", "Yes", "SHOP, APP", "Case-insensitive. Missing or any other value returns 400.", "X-Correlation-ID", "No", "Any unique string", "If not sent, the service generates one and returns it in the response header."),
  "2.3 Request body",
  parts.body ?? lines("{", "  \"order\": {", "    \"Email\": \"a@example.invalid\",", "    \"Name\": \"Sam\",", "    \"Qty\": \"\"", "  }", "}"),
  "2.4 Success response",
  "HTTP 200 OK",
  parts.response ?? lines("{", "  \"order\": {", "    \"Email\": \"a@example.invalid\",", "    \"Name\": \"Sam\",", "    \"Qty\": \"\"", "  }", "}"),
  "2.5 Error response",
  "{", "  \"error\": {", "    \"code\": \"INVALID_SOURCE\",", "    \"message\": \"X-Source is missing or not allowed\",", "    \"correlationId\": \"abc\"", "  }", "}",
  parts.errors ?? lines("HTTP status", "Error code", "When", "400", "INVALID_SOURCE", "X-Source missing or not an allowed value", "400", "INVALID_REQUEST", "Body is not valid JSON or order object is missing", "400", "INVALID_EMAIL", "Email missing or not a valid format", "502", "ERP_ERROR", "The ERP returned an error after retries", "504", "ERP_TIMEOUT", "The ERP did not respond in time after retries"),
  "3. Field mapping",
  "3.1 Mapping",
  parts.mapping ?? lines("Front-end field", "Mandatory", "ERP field (API name)", "Response field", "Rule",
    "Email", "Yes", "Email", "Email", "Trim spaces, convert to lower case, valid email format, max 100 characters.",
    "Name", "No", "Name", "Name", "Trim. Max 40 characters.",
    "Qty", "No", "Quantity", "Qty", "Send only if not empty. Must be a whole number.",
    "X-Source header", "Yes", "Channel", "not returned", "SHOP → Web Shop, APP → Mobile App",
    "(fixed by service)", "–", "Origin", "not returned", "Always set to Online",
    "(fixed by service)", "–", "Note", "not returned", "Order via {channel}"),
  parts.rules ?? "",
  "4. ERP integration details",
  parts.target ?? lines("Item", "Value / requirement", "API base URL", "https://erp.example.invalid", "Operation to use", "POST https://erp.example.invalid/api/orders"),
  "5. Non-functional requirements",
  parts.nfr ?? lines("Area", "Requirement", "ERP timeout", "5 seconds per call", "Retries", "Up to 3 retries with back-off (1 s, then 2 s, then 4 s) on 5xx, 429 or timeout. No retry on 4xx data errors.", "Response time", "95% within 2 seconds"),
  "6. Test cases",
  parts.tests ?? lines("#", "Scenario", "Expected result", "1", "Valid request, X-Source: SHOP", "200, order stored", "2", "X-Source missing", "400 INVALID_SOURCE, nothing written to ERP", "3", "Invalid email (x@)", "400 INVALID_EMAIL", "4", "Qty: \"many\"", "400 INVALID_REQUEST", "5", "The moon is full", "200"),
  "7. Open questions",
  parts.questions ?? lines("#", "Question / input", "Owner", "Status", "Q1", "Should Qty be returned as a number?", "Owner", "Open", "P1", "ERP credentials", "Owner", "Received 1 Jan (shared securely)"),
  "8. Deliverables",
  "1.  API definition published on the gateway.",
);

describe("detection", () => {
  it("reads the newsletter document, a small document, and keeps step text in step mode", () => {
    expect(looksLikeDocument(NEWSLETTER)).toBe(true);
    expect(looksLikeDocument(mini({}))).toBe(true);
    expect(looksLikeDocument("When POST /guests/check arrives\nLook up the contact in Zoho by email\nAnswer 201 with the contact id")).toBe(false);
    expect(looksLikeDocument(lines("Guest check:", "1. When POST /guests/check arrives", "2. Look up the contact in Zoho by email", "3. If not found, create the contact in Zoho with first name, last name, email", "4. Log \"guest checked\"", "5. Answer 201 with the contact id"))).toBe(false);
    expect(looksLikeDocument("Just one long sentence that explains what we want from the integration in very general terms and nothing more, really, at all, honestly.")).toBe(false);
  });
});

describe("the newsletter requirement document", () => {
  const r = readDocument(NEWSLETTER, {});
  it("builds the flow: listener, checks, Zoho record, upsert, error paths, log and answer", () => {
    expect(r.ok).toBe(true);
    expect(r.doc.blocking).toEqual([]);
    expect(r.flow.nodes.map((n) => `${n.type} | ${n.name}`)).toEqual([
      "trigger.http | POST /newsletter/v1/subscribe", "vars.set | Prepare the request", "logic.choice | Check the request",
      "respond | Answer 400 INVALID_CHANNEL", "respond | Answer 400 INVALID_REQUEST", "respond | Answer 400 INVALID_EMAIL", "respond | Answer 400 MISSING_FIELD", "respond | Answer 400 INVALID_MOBILE",
      "transform.map | Build the Zoho CRM record", "http.request | Upsert Zoho CRM Leads", "logic.choice | Did Zoho CRM accept it?", "log | Log the failed subscription",
      "logic.choice | Timed out?", "respond | Answer 504 CRM_TIMEOUT", "respond | Answer 502 CRM_ERROR", "log | Log the subscription", "respond | Answer 200",
    ]);
    expect(r.flow.settings).toMatchObject({ basePath: "/newsletter/v1", logPayloads: false, gateway: { publish: true, security: "oauth2", context: "/newsletter", version: "v1" } });
    expect(r.flow.nodes[0].config).toMatchObject({ methods: ["POST"], path: "/subscribe" });
  });
  it("calls Zoho as the document says: upsert with duplicate check, workflow trigger, 10 s, 2 retries 1 s then 3 s", () => {
    const call = r.flow.nodes.find((n) => n.type === "http.request")!;
    expect(call.config).toMatchObject({ method: "POST", url: "/crm/v8/Leads/upsert", timeoutMs: 10000, retries: 2, retryDelayMs: 1000, retryDelaysMs: "1000, 3000", body: { data: ["{{ $vars.record }}"], duplicate_check_fields: ["Email"], trigger: ["workflow"] } });
    const rules = (r.flow.nodes.find((n) => n.type === "transform.map")!.config.mapping as { rules: { target: string; expr: string }[] }).rules;
    expect(rules.map((x) => x.target)).toEqual(["Email", "First_Name", "Last_Name", "Mobile", "Company", "Lead_Source", "Submission_Channel", "Marketing_Opt_In", "Description", "Tag", "Industry", "No_of_Employees", "Country", "Currency"]);
    const byT = Object.fromEntries(rules.map((x) => [x.target, x.expr]));
    expect(byT).toMatchObject({ Company: "\"Individual Guest\"", Lead_Source: "\"Newsletter\"", Marketing_Opt_In: "true", Tag: "[{\"name\":\"Newsletter\"}]", Submission_Channel: "$vars.channelLabel", Mobile: "$vars.mobileForTarget", Industry: "$vars.industry != \"\" ? $vars.industry", No_of_Employees: "$vars.noOfEmployees != \"\" ? $number($vars.noOfEmployees)" });
    expect(byT.Description).toBe("\"Newsletter subscription via \" & $vars.channelLabel");
  });
  it("offers the Zoho connection pre-filled for the refresh-token sign-in, without any secret", () => {
    expect(r.missing).toEqual([expect.objectContaining({ name: "Zoho CRM", type: "http" })]);
    expect(r.missing[0].suggested?.config).toEqual({ baseUrl: "https://www.zohoapis.in", authType: "oauth2refresh", tokenUrl: "https://accounts.zoho.in/oauth/v2/token", clientAuth: "body", tokenPrefix: "Zoho-oauthtoken", scope: "ZohoCRM.modules.leads.ALL,ZohoCRM.settings.fields.READ", timeoutMs: 10000 });
  });
  it("links each item to its section, line and steps", () => {
    const by = (kind: string, title: RegExp) => r.doc.items.find((i) => i.kind === kind && title.test(i.title))!;
    expect(by("endpoint", /POST \/newsletter/).ref).toEqual({ section: "4.1 Endpoint", line: 38 });
    expect(by("header", /X-Channel/).detail).toBe("required; allowed: WEB, MOBILE, AGENT_BOOKING, AGENCY; any letter case");
    expect(by("header", /X-Correlation-ID/).detail).toMatch(/generated when missing/);
    expect(by("error", /400 INVALID_CHANNEL/).ref.section).toBe("4.5 Error response");
    expect(by("mapping", /^Email$/).detail).toMatch(/trim spaces, lower case, valid e-mail format, at most 100 characters, the duplicate check/);
    expect(r.doc.items.filter((i) => i.kind === "rule" && /^Rule \d/.test(i.title))).toHaveLength(6);
    for (const i of r.doc.items.filter((x) => !["security"].includes(x.kind) && !/^(?:401|429)/.test(x.title) && !/Content-Type|Authorization/.test(x.title) && x.title !== "Step traces keep no payload")) expect(i.nodeIds.length, `${i.kind} ${i.title}`).toBeGreaterThan(0);
  });
  it("lists the open questions as decisions, with the choices that shaped the build", () => {
    const ids = r.doc.decisions.map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "Q10", "Q11", "P3", "P4", "THROTTLE", "QUEUE", "TAGS", "ENV"]));
    expect(ids).not.toContain("P1");
    expect(r.doc.decisions.find((d) => d.id === "Q10")!.choice).toMatch(/no space/);
    expect(r.doc.decisions.find((d) => d.id === "Q4")!.choice).toMatch(/Individual Guest/);
    expect(r.doc.notUsed.some((n) => /^P1 /.test(n.section))).toBe(true);
  });
  it("shows the document's contradictions with the choice made", () => {
    expect(r.doc.conflicts).toHaveLength(2);
    expect(r.doc.conflicts[0].text).toMatch(/10 digits.*9 digits/);
    expect(r.doc.conflicts[1].text).toMatch(/^Test 7 expects the Mobile stored with a space, but the mapping table and Q10/);
    expect(r.doc.conflicts[1].choice).toMatch(/without a space/);
  });
  it("turns every row of the test table into a scenario with made-up data", () => {
    expect(r.doc.scenarios.map((s) => s.id)).toEqual(["1", "2-MOBILE", "2-AGENT_BOOKING", "2-AGENCY", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"]);
    expect(r.doc.scenarios.every((s) => s.derived)).toBe(true);
    expect(r.doc.scenarios.find((s) => s.id === "3")!.requests[0].headers).not.toHaveProperty("x-channel");
    expect(r.doc.scenarios.find((s) => s.id === "13")).toMatchObject({ expect: { status: 504, code: "CRM_TIMEOUT", checks: ["retried", "error-record"] }, standIn: { timeout: true } });
    const all = JSON.stringify(r.doc.scenarios);
    expect(all.match(/[\w.+-]+@[\w.-]+/g)!.every((e) => e.endsWith("example.invalid") || e === "abc@")).toBe(true);
    expect(r.flow.nodes[0].config.testScenarios).toHaveLength(17);
  });
  it("keeps prose out of the steps, listed as not used", () => {
    expect(r.doc.notUsed.map((n) => n.section)).toEqual(expect.arrayContaining(["1 Background", "2 Scope", "8 Confirmation email", "13 Deliverables from the WSO2 team", "14 Acceptance criteria", "Credentials note"]));
    expect(r.doc.sections.find((s) => s.num === "5.2")!.use).toBe("used");
  });
});

describe("each table kind on a small document", () => {
  const r = readDocument(mini({}), {});
  it("endpoint, headers, samples and errors", () => {
    expect(r.ok).toBe(true);
    expect(r.flow.nodes[0].config).toMatchObject({ methods: ["POST"], path: "/create" });
    expect(r.flow.settings?.basePath).toBe("/orders/v1");
    const check = r.flow.nodes.find((n) => n.name === "Check the request")!;
    expect((check.config.conditions as { label: string }[]).map((c) => c.label)).toEqual(["X-Source missing or not allowed", "\"order\" object missing", "Email missing or not a valid e-mail (at most 100)", "Name longer than 40; Qty not a whole number"]);
    expect(r.flow.nodes.filter((n) => n.name === "Answer 400 INVALID_REQUEST")).toHaveLength(1);
    expect(r.flow.edges.filter((e) => e.to === r.flow.nodes.find((n) => n.name === "Answer 400 INVALID_REQUEST")!.id)).toHaveLength(2);
    expect(r.flow.nodes.find((n) => n.name === "Answer 400 INVALID_SOURCE")!.config.body).toBe("{ \"error\": { \"code\": \"INVALID_SOURCE\", \"message\": \"X-Source is missing or not allowed\", \"correlationId\": $vars.correlationId } }");
    expect(r.flow.nodes.map((n) => n.name)).toEqual(expect.arrayContaining(["Answer 504 ERP_TIMEOUT", "Answer 502 ERP_ERROR"]));
  });
  it("mapping rules: trim, lower case, whole number, left out when empty, value map, fixed value, template", () => {
    const prep = r.flow.nodes.find((n) => n.type === "vars.set")!.config.assignments as { key: string; value: string }[];
    const byK = Object.fromEntries(prep.map((a) => [a.key, a.value]));
    expect(byK.email).toMatch(/^\$lowercase\(\$trim\(/);
    expect(byK.source).toMatch(/^\$uppercase\(\$trim\(/);
    expect(byK.sourceLabel).toBe("$lookup({\"SHOP\":\"Web Shop\",\"APP\":\"Mobile App\"}, $vars.source)");
    const rules = Object.fromEntries(((r.flow.nodes.find((n) => n.type === "transform.map")!.config.mapping as { rules: { target: string; expr: string }[] }).rules).map((x) => [x.target, x.expr]));
    expect(rules).toEqual({ Email: "$vars.email", Name: "$vars.name", Quantity: "$vars.qty != \"\" ? $number($vars.qty)", Channel: "$vars.sourceLabel", Origin: "\"Online\"", Note: "\"Order via \" & $vars.sourceLabel" });
  });
  it("non-functional: timeout, retries and the back-off list; the rest is not used for steps", () => {
    expect(r.flow.nodes.find((n) => n.type === "http.request")!.config).toMatchObject({ url: "/api/orders", timeoutMs: 5000, retries: 3, retryDelaysMs: "1000, 2000, 4000" });
    expect(r.doc.notUsed.some((n) => /Response time/.test(n.section))).toBe(true);
  });
  it("tests: each row becomes a scenario; one it cannot read is shown as not derived", () => {
    expect(r.doc.scenarios.map((s) => [s.id, s.derived, s.expect.status, s.expect.code ?? ""])).toEqual([["1", true, 200, ""], ["2", true, 400, "INVALID_SOURCE"], ["3", true, 400, "INVALID_EMAIL"], ["4", true, 400, "INVALID_REQUEST"], ["5", false, 200, ""]]);
  });
  it("questions: open ones are decisions, received inputs are not used", () => {
    expect(r.doc.decisions.find((d) => d.id === "Q1")).toMatchObject({ status: "Open" });
    expect(r.doc.decisions.some((d) => d.id === "P1")).toBe(false);
  });
  it("rule lists: known rules become expressions, an unknown rule needs a hand-written step", () => {
    const x = readDocument(mini({
      body: lines("{", "  \"order\": {", "    \"Email\": \"a@example.invalid\",", "    \"Name\": \"Sam\",", "    \"code\": \"+44\",", "    \"phone\": \"07700 900123\"", "  }", "}"),
      mapping: lines("Front-end field", "Mandatory", "ERP field (API name)", "Response field", "Rule", "Email", "Yes", "Email", "Email", "Trim, valid email format.", "code", "Yes", "part of Phone", "part of Phone", "Must start with + followed by 1 to 3 digits.", "phone", "Yes", "part of Phone", "part of Phone", "Digits only after cleaning (see 3.2).", "(built by service)", "–", "Phone", "Phone", "ERP: code + phone, no space. Response: with one space."),
      rules: lines("3.2 Phone number rules", "1.  Remove spaces, dashes and dots from phone.", "2.  Remove one leading 0 if present.", "3.  For +44 (UK): the result must be exactly 10 digits starting with 7. Otherwise return 400 INVALID_MOBILE.", "4.  Ask the guest to confirm the number by SMS.", "5.  Never cut digits off to make a number fit."),
    }), {});
    const prep = x.flow.nodes.find((n) => n.type === "vars.set")!.config.assignments as { key: string; value: string }[];
    expect(prep.map((a) => a.key)).toEqual(expect.arrayContaining(["phoneStep1", "phoneStep2", "phoneClean", "phoneForTarget", "phoneForResponse"]));
    expect(prep.find((a) => a.key === "phoneStep1")!.value).toBe("$replace($vars.phone, /[\\s\\-.]/, \"\")");
    const check = x.flow.nodes.find((n) => n.name === "Check the request")!;
    expect(JSON.stringify(check.config)).toContain("$vars.code = \\\"+44\\\" and $not($contains($vars.phoneClean, /^7\\\\d{9}$/))");
    expect(x.doc.handWritten.map((h) => h.text)).toContain("Ask the guest to confirm the number by SMS.");
    expect(x.doc.items.filter((i) => i.kind === "rule").length).toBe(4);
  });
  it("no endpoint: Create is blocked with a plain reason", () => {
    const x = readDocument(mini({ endpoint: lines("Item", "Value", "Owner", "Sales team") }).replace(/\/orders\/v1\/create/g, ""), {});
    expect(x.ok).toBe(false);
    expect(x.doc.blocking[0]).toMatch(/No endpoint was found/);
  });
});

describe("Zoho data centres and pasted secrets", () => {
  it("pairs the accounts host with the API host of the same centre", () => {
    expect(zohoApiFor("https://accounts.zoho.sa/oauth/v2/token")).toBe("https://www.zohoapis.sa");
    expect(zohoApiFor("https://accounts.zoho.in")).toBe("https://www.zohoapis.in");
    expect(zohoApiFor("https://accounts.zoho.com")).toBe("https://www.zohoapis.com");
    expect(zohoApiFor("https://accounts.zoho.eu")).toBe("https://www.zohoapis.eu");
    expect(zohoApiFor("https://accounts.zoho.com.au")).toBe("https://www.zohoapis.com.au");
    expect(zohoApiFor("https://accounts.zoho.jp")).toBe("https://www.zohoapis.jp");
    expect(zohoApiFor("https://accounts.zoho.com.cn")).toBe("https://www.zohoapis.com.cn");
    expect(zohoApiFor("https://accounts.zohocloud.ca")).toBe("https://www.zohoapis.ca");
    expect(zohoApiFor("https://example.invalid")).toBeNull();
    expect(zohoTokenUrlFor("https://www.zohoapis.sa")).toBe("https://accounts.zoho.sa/oauth/v2/token");
    expect(zohoMismatch("https://accounts.zoho.sa/oauth/v2/token", "https://www.zohoapis.in")).toMatch(/Saudi Arabia.*India/);
    expect(zohoMismatch("https://accounts.zoho.sa/oauth/v2/token", "https://www.zohoapis.sa")).toBeNull();
  });
  it("a document with the Saudi accounts host gets the Saudi API host; two centres are a conflict", () => {
    const sa = readDocument(NEWSLETTER.replace(/accounts\.zoho\.in/g, "accounts.zoho.sa").replace(/zohoapis\.in/g, "zohoapis.sa"), {});
    expect(sa.missing[0].suggested?.config).toMatchObject({ baseUrl: "https://www.zohoapis.sa", tokenUrl: "https://accounts.zoho.sa/oauth/v2/token" });
    expect(sa.doc.conflicts.some((c) => /data centre/.test(c.text))).toBe(false);
    const mixed = readDocument(NEWSLETTER.replace(/accounts\.zoho\.in/g, "accounts.zoho.sa"), {});
    const c = mixed.doc.conflicts.find((x) => /data centre/.test(x.text))!;
    expect(c.text).toMatch(/Saudi Arabia data centre but the base URL is in India/);
    expect(c.choice).toMatch(/www\.zohoapis\.sa/);
    expect(mixed.missing[0].suggested?.config).toMatchObject({ baseUrl: "https://www.zohoapis.sa" });
  });
  it("spots a pasted value that still carries its label", () => {
    for (const v of ["Client Secret: 1000.abc", "refresh_token=1000.x", "Refresh Token : x", "client id: 1000.y"]) expect(secretLooksLabelled(v), v).toBe(true);
    for (const v of ["1000.abcdef", "", undefined, "secretive"]) expect(secretLooksLabelled(v as string), String(v)).toBe(false);
  });
});

// ------------------------------------------------------------------ route, with a stand-in flow engine
let stub: http.Server; let runtimeUrl = "";
const validated: any[] = [];
beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
      const json = (s: number, v: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.url === "/v1/connections" || req.url === "/v1/connectors" || req.url === "/v1/flows") return json(200, { connections: [], connectors: [], flows: [] });
      if (req.url === "/v1/flows/validate") { validated.push(JSON.parse(raw).flow); return json(200, { issues: [{ level: "warning", message: "Zoho CRM: choose a connection" }] }); }
      json(404, {});
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  runtimeUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => stub.close(r)); });
async function app() { const a = Fastify(); registerDescribe(a, { runtimeUrl, internalKey: "k" }, async () => "tester", undefined, loadDescribeConfig({})); await a.ready(); return a; }

describe("POST /api/factory/describe/preview with a document", () => {
  it("reads a 501-line document in document mode and checks it with the flow's own settings", async () => {
    const a = await app();
    validated.length = 0;
    const r = await a.inject({ method: "POST", url: "/api/factory/describe/preview", payload: { text: NEWSLETTER } });
    expect(r.statusCode).toBe(200);
    const p = r.json();
    expect(p.mode).toBe("document");
    expect(p.ok).toBe(true);
    expect(p.flow.nodes).toHaveLength(17);
    expect(p.doc.decisions.length).toBeGreaterThan(10);
    expect(p.issues).toEqual([{ level: "warning", message: "Zoho CRM: choose a connection" }]);
    expect(validated[0].settings).toMatchObject({ basePath: "/newsletter/v1", logPayloads: false });
  });
  it("keeps the step-mode limit for step text and gives documents a larger one", async () => {
    const a = await app();
    const steps = Array.from({ length: 401 }, () => "Log \"x\"").join("\n");
    const r1 = await a.inject({ method: "POST", url: "/api/factory/describe/preview", payload: { text: steps } });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().title).toMatch(/more than 400 step lines and does not read like a requirement document/);
    const big = NEWSLETTER + "\n" + Array.from({ length: 2600 }, (_v, i) => `Appendix line ${i} with some words in it.`).join("\n");
    const r2 = await a.inject({ method: "POST", url: "/api/factory/describe/preview", payload: { text: big } });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().title).toMatch(/more than 3000 lines/);
  });
});

describe("an existing connection that does not fit", () => {
  it("is offered for editing; its own (Saudi) data centre is kept and the difference is a conflict", () => {
    const r = readDocument(NEWSLETTER, { connections: [{ id: "cx_z", name: "Zoho", type: "http", authType: "apiKey", baseUrl: "https://www.zohoapis.sa" }] });
    expect(r.missing).toEqual([expect.objectContaining({ name: "Zoho", existingId: "cx_z" })]);
    expect(r.missing[0].why).toMatch(/signs in with an API key, but the document asks for .*a refresh token/);
    expect(r.missing[0].suggested?.config).toMatchObject({ baseUrl: "https://www.zohoapis.sa", authType: "oauth2refresh", tokenUrl: "https://accounts.zoho.sa/oauth/v2/token", tokenPrefix: "Zoho-oauthtoken", clientAuth: "body" });
    expect(r.doc.conflicts.find((c) => /existing connection "Zoho" is in Saudi Arabia/.test(c.text))?.choice).toMatch(/Saudi Arabia\) is kept/);
    expect(r.flow.nodes.find((n) => n.type === "http.request")!.config.connection).toBe("cx_z");
  });
  it("a connection that already fits is used as it is", () => {
    const r = readDocument(NEWSLETTER, { connections: [{ id: "cx_z", name: "Zoho CRM", type: "http", authType: "oauth2refresh", baseUrl: "https://www.zohoapis.in" }] });
    expect(r.missing).toEqual([]);
  });
});
