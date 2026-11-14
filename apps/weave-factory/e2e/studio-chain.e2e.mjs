// Weave Studio acceptance chain, built through the UI only, against the real flow engine.
//
//   node e2e/studio-chain.e2e.mjs [baseUrl] [--prefix <name>] [--shots <dir>] [--keep] [--headed]
//
// Rebuilds the shape of a migrated estate under new names, as three flows a person makes by hand:
//   system layer      <prefix>-seaware-system        wraps the system of record (read-only GraphQL)
//   process layer     <prefix>-common-cache          serves cached kinds from the cache API, the rest via Call Flow
//   experience layer  <prefix>-reservation-manager   screen-ready lists and a read-query operation, published on the gateway
// Every flow is tested on the canvas, deployed, and the experience flow is called through the
// gateway; the executions of all three layers are then looked up.
//
// Only read-only calls reach the real backends. With --keep the flows stay for inspection;
// a later run with the same --prefix replaces them.
import { Session, parseArgs, stamp, field, setField, selectField, openGroup, confirm, createFlow, addStep, saveFlow, deleteFlowFromEditor, sweep, toastText } from "./studio-lib.mjs";

const opts = parseArgs(["--prefix"]);
const pi = opts.rest.indexOf("--prefix");
const PREFIX = pi >= 0 && opts.rest[pi + 1] ? opts.rest[pi + 1] : `e2e-${stamp()}`;
const SYS_BACKEND = process.env.WEAVE_E2E_BACKEND || "http://seaware-sys-api.wso2.svc";
const CACHE_BACKEND = process.env.WEAVE_E2E_CACHE || "http://seaware-cache-proc-api.wso2.svc";
const ENGINE = process.env.WEAVE_E2E_ENGINE || "http://127.0.0.1:8790/run";
const C_SYS = `${PREFIX}-seaware-backend`, C_CACHE = `${PREFIX}-cache-backend`, C_ENGINE = `${PREFIX}-flow-engine`;
const F_SYS = `${PREFIX}-seaware-system`, F_PROC = `${PREFIX}-common-cache`, F_EXP = `${PREFIX}-reservation-manager`;
const QUERIES = `(
  $queries := {
    "ships": "query Ships { ships { key name } }",
    "ports": "query Ports { ports { key name } }",
    "destinations": "query Destinations { destinations { key name } }",
    "currencies": "query Currencies { currencies { key name } }"
  };
  { "kind": $request.params.kind, "query": $lookup($queries, $request.params.kind) }
)`;
const READ_QUERY = "query Ships { ships { key name } }";

const s = new Session(opts);
const page = await s.start();
const ids = { sys: null, proc: null, exp: null };
const direct = { sys: "", proc: "" };
s.log(`Weave Studio acceptance chain against ${opts.base}, names start with ${PREFIX}`);

// ------------------------------------------------------------------ small verbs
const brief = (v, n = 220) => JSON.stringify(v ?? null).replace(/\s+/g, " ").slice(0, n);
async function add(type, name) {
  const panel = await addStep(page, type);
  if (name) {
    await panel.getByLabel("Step name", { exact: true }).fill(name);
    await page.locator(`.ws-node[data-node-name="${name}"]`).waitFor();
  }
  return page.locator(".ws-panel");
}
async function selectByName(name) {
  await page.getByRole("button", { name: "Fit the flow on screen" }).click();
  await page.waitForTimeout(350);
  await page.locator(`.ws-node[data-node-name="${name}"] .ws-node-name`).first().click();
  const panel = page.locator(".ws-panel");
  await panel.waitFor();
  return panel;
}
async function condition(panel, key, i, label, expr) {
  const f = field(panel, key);
  if (!(await f.getByLabel(`Label ${i}`, { exact: true }).isVisible().catch(() => false))) await f.getByRole("button", { name: /Add condition/ }).click();
  await f.getByLabel(`Label ${i}`, { exact: true }).fill(label);
  await f.getByLabel(`Condition ${i}`, { exact: true }).fill(expr);
}
async function methodsOnly(panel, method) {
  const f = field(panel, "methods");
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const box = f.locator("label", { hasText: new RegExp(`^\\s*${m}\\s*$`) }).locator("input");
    if ((await box.isChecked()) !== (m === method)) await f.locator("label", { hasText: new RegExp(`^\\s*${m}\\s*$`) }).click();
  }
}
async function httpCall(panel, { connection, method = "GET", url, body, header, resultVar }) {
  await field(panel, "connection").locator("select").selectOption({ label: connection });
  if (method !== "GET") await selectField(panel, "method", method);
  await setField(panel, "url", url);
  if (body) {
    await selectField(panel, "bodyMode", "json");
    await field(panel, "body").locator("textarea").first().fill(JSON.stringify(body, null, 2));
  }
  if (header) {
    await openGroup(panel, "Headers");
    const f = field(panel, "headers");
    await f.getByRole("button", { name: "Add row" }).click();
    await f.getByLabel("Name 1", { exact: true }).fill(header[0]);
    await f.getByLabel("Value 1", { exact: true }).fill(header[1]);
  }
  if (resultVar) {
    await openGroup(panel, "Result");
    await selectField(panel, "resultTarget", "variable");
    await setField(panel, "resultVar", resultVar);
  }
}
/** Opens the mapper of the selected Map step, adds the rules, closes it again. Returns how many plain-words rules were understood. */
async function mapRules(panel, rules, shot) {
  await panel.locator('[data-action="open-mapper"]').click();
  const mapper = page.locator('[data-testid="mapper"]');
  await mapper.waitFor();
  let understood = 0;
  for (const [i, [kind, target, value]] of rules.entries()) {
    await mapper.locator(`[data-add-rule="${kind}"]`).click();
    const r = mapper.locator(`[data-rule-index="${i}"]`);
    await r.getByLabel("Output field", { exact: true }).fill(target);
    if (kind === "direct") await r.getByLabel("Input field", { exact: true }).fill(value);
    else if (kind === "expr") await r.getByLabel("Expression", { exact: true }).fill(value);
    else if (kind === "const") await r.getByLabel("Fixed value", { exact: true }).fill(value);
    else {
      await r.getByLabel("Rule in your words", { exact: true }).fill(value);
      await r.getByLabel("Output field", { exact: true }).focus();
      const verdict = r.locator("[data-understood]");
      if (!(await verdict.first().isVisible().catch(() => false))) await r.locator('[data-action="understand"]').click({ timeout: 5000 }).catch(() => {});
      await verdict.first().waitFor({ timeout: 30_000 });
      const yes = (await verdict.first().getAttribute("data-understood")) === "yes";
      if (yes) understood++;
      s.check(yes, `plain words understood: "${value}"`, yes ? "" : "the rule stays unresolved");
      if (yes) s.ok(`  ${(await r.locator(".ws-understood-head").innerText()).replace(/\s+/g, " ")}`);
    }
  }
  if (shot) await s.shot(shot);
  await page.locator('[data-action="close-mapper"]').click();
  return understood;
}
/** Draws a connection by dragging from an output port to the input of another step. */
async function drag(fromName, port, toName) {
  await page.getByRole("button", { name: "Tidy up the layout" }).click();
  await page.waitForTimeout(500);
  const close = page.locator(".ws-panel").getByRole("button", { name: "Close panel" });
  if (await close.isVisible().catch(() => false)) await close.click();
  await page.getByRole("button", { name: "Fit the flow on screen" }).click();
  await page.waitForTimeout(500);
  const before = await page.locator(".react-flow__edge").count();
  const src = page.locator(`.ws-node[data-node-name="${fromName}"] .react-flow__handle.source[data-handleid="${port}"]`).first();
  const dst = page.locator(`.ws-node[data-node-name="${toName}"] .react-flow__handle.target`).first();
  const a = await src.boundingBox(), b = await dst.boundingBox();
  if (!a || !b) return false;
  const ax = a.x + a.width / 2, ay = a.y + a.height / 2, bx = b.x + b.width / 2, by = b.y + b.height / 2;
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(ax + 12, ay + 6, { steps: 4 });
  await page.mouse.move((ax + bx) / 2, (ay + by) / 2, { steps: 10 });
  await page.mouse.move(bx, by, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(400);
  return (await page.locator(".react-flow__edge").count()) === before + 1;
}
async function tidy() {
  await page.getByRole("button", { name: "Tidy up the layout" }).click();
  await page.waitForTimeout(500);
}
/** Runs the flow from the Test dock. */
async function run({ start, params, body } = {}) {
  const dock = page.locator('[data-testid="test-panel"]');
  if (!(await dock.isVisible().catch(() => false))) await page.locator('[data-action="test"]').click();
  await dock.waitFor();
  const reqTab = dock.getByRole("tab", { name: "Request" });
  if (await reqTab.isVisible().catch(() => false)) await reqTab.click();
  if (start) await dock.getByLabel("Start from", { exact: true }).selectOption({ label: start });
  for (const [k, v] of Object.entries(params ?? {})) await dock.getByLabel(`Value for ${k}`, { exact: true }).fill(v);
  if (body !== undefined) await dock.getByLabel("Request body", { exact: true }).fill(JSON.stringify(body, null, 2));
  const [res] = await Promise.all([
    page.waitForResponse((r) => /\/api\/studio\/flows\/[^/]+\/test$/.test(new URL(r.url()).pathname) && r.request().method() === "POST", { timeout: 90_000 }),
    dock.locator('[data-action="run-test"]').click(),
  ]);
  const execution = await res.json().catch(() => null);
  await dock.locator('[data-testid="test-result"]').waitFor({ timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(300);
  return { execution, dock, status: execution?.response?.status, body: execution?.response?.body };
}
const stepsOk = (x) => (x?.steps ?? []).filter((t) => t.status !== "skipped").every((t) => t.status === "success");
const stepList = (x) => (x?.steps ?? []).map((t) => `${t.nodeName}:${t.status}`).join(", ");
async function deployFlow(publish) {
  await page.locator('[data-action="open-deploy"]').click();
  const dialog = page.locator('[data-testid="deploy-dialog"]');
  await dialog.waitFor();
  const sw = dialog.getByRole("switch").first();
  if ((await sw.isChecked()) !== publish) await dialog.locator(".mf-toggle").first().click();
  s.check((await sw.isChecked()) === publish, publish ? "publishing on the gateway is switched on" : "publishing on the gateway is switched off (internal layer)");
  await page.locator('[data-action="deploy"]').click();
  await page.locator('[data-testid="deploy-dialog"][data-deploy-status="deployed"]').waitFor({ timeout: 150_000 }).catch(() => {});
  const ok = s.check((await dialog.getAttribute("data-deploy-status")) === "deployed", "the flow is deployed", await toastText(page));
  const url = ok ? (await dialog.locator("dl.mf-kv dd").nth(1).locator("code").first().innerText().catch(() => "")).trim() : "";
  return { dialog, ok, url, gateway: await dialog.getAttribute("data-gateway-status") };
}
const closeDialog = () => page.getByRole("dialog").last().getByRole("button", { name: "Close", exact: true }).last().click();
async function send(dialog, { operation, method, path, body, via, tries = 1 }) {
  const tryIt = dialog.locator('[data-testid="try-it"]');
  const op = tryIt.getByLabel("Operation", { exact: true });
  if (operation && (await op.isVisible().catch(() => false))) await op.selectOption({ label: operation });
  if (method) await tryIt.getByLabel("Method", { exact: true }).selectOption(method);
  await tryIt.getByLabel("Path", { exact: true }).fill(path);
  if (body !== undefined) await tryIt.getByLabel("Request body", { exact: true }).fill(JSON.stringify(body, null, 2));
  await tryIt.locator(`[data-via="${via}"]`).click();
  let status = 0, text = "";
  for (let i = 0; i < tries; i++) {
    await tryIt.locator('[data-action="invoke"]').click();
    const res = tryIt.locator('[data-testid="invoke-result"]');
    const got = await Promise.race([res.waitFor({ timeout: 90_000 }).then(() => "result"), tryIt.locator(".mf-callout-bad").waitFor({ timeout: 90_000 }).then(() => "error")]).catch(() => "timeout");
    if (got === "result") { status = Number(await res.getAttribute("data-invoke-status")); text = await res.innerText(); if (status >= 200 && status < 300) break; }
    else text = got === "error" ? await tryIt.locator(".mf-callout-bad").innerText() : "no answer in 90 s";
    if (i < tries - 1) await page.waitForTimeout(6000); // a freshly published API can take a moment to become routable
  }
  return { status, text: text.replace(/\s+/g, " "), tryIt };
}

// ------------------------------------------------------------------ the story
async function connections() {
  s.step("0. Three connections: the system of record, the cache, and the flow engine itself");
  const make = async (name, baseUrl, healthPath) => {
    await s.goto("/studio/connections");
    await page.locator('[data-action="new-connection"]').first().click();
    const form = page.locator('[data-testid="connection-form"]');
    await form.waitFor();
    await page.locator("#ws-conn-name").fill(name);
    await page.locator("#ws-conn-type").selectOption("http");
    await setField(form, "baseUrl", baseUrl);
    if (healthPath) {
      await setField(form, "healthPath", healthPath);
      await page.locator('[data-action="test-connection"]').click();
      const outcome = form.locator("[data-test-result]");
      await outcome.waitFor({ timeout: 30_000 });
      s.check((await outcome.getAttribute("data-test-result")) === "ok", `"${name}" reaches ${baseUrl}`, (await outcome.innerText()).replace(/\s+/g, " "));
    }
    await page.locator('[data-action="save-connection"]').click();
    await page.locator(`tr[data-connection="${name}"]`).waitFor();
  };
  await make(C_SYS, SYS_BACKEND, "/health/ready");
  await make(C_CACHE, CACHE_BACKEND, "/health/ready");
  await make(C_ENGINE, ENGINE, "");
  s.ok("three connections saved");
  await s.shot("connections");
}

async function systemFlow() {
  s.step(`1. System layer: ${F_SYS}`);
  ids.sys = await createFlow(s, F_SYS, "blank");
  let p = await add("trigger.http", "Get reference list");
  await setField(p, "path", "/reference/:kind");
  await setField(p, "summary", "Reference data straight from the system of record");
  p = await add("transform.expr", "Pick the query");
  await setField(p, "expr", QUERIES);
  p = await add("logic.validate", "Known kind");
  await condition(p, "rules", 1, "Unknown reference kind. Use ships, ports, destinations or currencies", "$exists(query)");
  await setField(p, "status", "404");
  p = await add("http.request", "Ask Seaware");
  await httpCall(p, { connection: C_SYS, method: "POST", url: "/seaware-sys-api/v1/integration-tasks", body: { query: "{{ $payload.query }}" }, resultVar: "system" });
  p = await add("transform.map", "Shape the list");
  await mapRules(p, [
    ["direct", "kind", "kind"],
    ["expr", "items", '[$lookup($vars.system.data, kind).{ "code": key, "name": name }]'],
    ["expr", "count", "$count($lookup($vars.system.data, kind))"],
    ["const", "layer", "system"],
  ]);
  await add("respond", "Answer list");
  // a second operation on the same flow: a read-only query passed straight through
  p = await add("trigger.http", "Run a read query");
  await methodsOnly(p, "POST");
  await setField(p, "path", "/integration-tasks");
  p = await add("logic.validate", "Read only");
  await condition(p, "rules", 1, "query is required", "$exists($request.body.query)");
  await condition(p, "rules", 2, "only read queries are allowed here", '$not($contains($lowercase($string($request.body.query)), "mutation"))');
  p = await add("http.request", "Forward to Seaware");
  await httpCall(p, { connection: C_SYS, method: "POST", url: "/seaware-sys-api/v1/integration-tasks", body: { query: "{{ $request.body.query }}" } });
  await add("respond", "Answer query");
  await tidy();
  s.check((await page.locator(".ws-node").count()) === 10, "ten steps on the canvas, two operations", `${await page.locator(".ws-node").count()} steps`);
  s.check((await page.locator(".react-flow__edge").count()) === 8, "both chains are connected", `${await page.locator(".react-flow__edge").count()} connections`);
  await saveFlow(s);
  await s.shot("system-canvas");

  let r = await run({ start: "Get reference list", params: { kind: "ships" } });
  s.check(r.status === 200 && r.body?.kind === "ships" && r.body?.count > 0 && Array.isArray(r.body?.items) && r.body?.layer === "system", `GET /reference/ships answers with ${r.body?.count} ships from the system of record`, `${brief(r.execution?.error ?? r.body)} | ${stepList(r.execution)}`);
  s.check(stepsOk(r.execution), "every step of the run succeeded", stepList(r.execution));
  await s.shot("system-test");
  s.allow(/\/api\/studio\/flows\/[^/]+\/(test|invoke)/);
  r = await run({ start: "Get reference list", params: { kind: "bogus" } });
  s.check(r.status === 404, "an unknown kind is refused with 404 by the Validate step", `HTTP ${r.status} ${brief(r.body)}`);
  r = await run({ start: "Run a read query", body: { query: READ_QUERY } });
  s.check(r.status === 200 && Array.isArray(r.body?.data?.ships), "POST /integration-tasks passes a read query through", `HTTP ${r.status} ${brief(r.execution?.error ?? r.body)}`);
  r = await run({ start: "Run a read query", body: { query: "mutation Nope { nope }" } });
  s.check(r.status === 400, "a mutation is refused with 400 before anything is sent", `HTTP ${r.status} ${brief(r.body)}`);
  const d = await deployFlow(false);
  direct.sys = d.url;
  s.check(/\/run\/.+/.test(d.url), `it answers inside the network at ${d.url}`);
  s.check(d.gateway !== "published", "it is not on the public gateway", `gateway status: ${d.gateway}`);
  await closeDialog();
}

async function processFlow() {
  s.step(`2. Process layer: ${F_PROC}`);
  ids.proc = await createFlow(s, F_PROC, "blank");
  let p = await add("trigger.http", "Get reference list");
  await setField(p, "path", "/reference/:kind");
  p = await add("logic.choice", "Cached kind");
  await condition(p, "conditions", 1, "Kept in the cache", '$request.params.kind in ["languages", "countries"]');
  p = await add("http.request", "Read the cache");
  await httpCall(p, { connection: C_CACHE, url: "/seaware-cache-proc-api/v1/cache", header: ["operationName", "{{ $request.params.kind }}"] });
  p = await add("transform.map", "Shape cached list");
  await mapRules(p, [
    ["expr", "kind", "$request.params.kind"],
    ["expr", "items", '[$lookup(data, $request.params.kind).{ "code": key, "name": name }]'],
    ["expr", "count", "$count($lookup(data, $request.params.kind))"],
    ["const", "source", "cache"],
  ]);
  await add("respond", "Answer");
  // the other branch of the choice: everything that is not cached goes to the system flow
  await selectByName("Cached kind");
  p = await add("flow.call", "Ask the system flow");
  await field(p, "flow").locator("select").selectOption({ label: F_SYS });
  await selectField(p, "entry", "http");
  await field(p, "request").locator("textarea").first().fill(JSON.stringify({ method: "GET", path: "/reference/{{ $request.params.kind }}" }, null, 2));
  p = await add("transform.map", "Shape system list");
  await mapRules(p, [
    ["direct", "kind", "kind"],
    ["direct", "items", "items"],
    ["direct", "count", "count"],
    ["const", "source", "system"],
  ]);
  const drawn = await drag("Shape system list", "out", "Answer");
  if (drawn) s.ok("both branches were joined into one Respond step by dragging a connection");
  else {
    s.warn("dragging a connection between two steps did not create it; added a second Respond step instead");
    await selectByName("Shape system list");
    await add("respond", "Answer from system");
  }
  await tidy();
  const edgesOnChoice = await page.locator('.react-flow__edge').count();
  s.check(edgesOnChoice >= 7, "the choice has both of its branches wired", `${edgesOnChoice} connections`);
  await saveFlow(s);
  await s.shot("process-canvas");

  let r = await run({ params: { kind: "languages" } });
  s.check(r.status === 200 && r.body?.source === "cache" && r.body?.count > 0, `a cached kind is served from the cache API (${r.body?.count} languages)`, `HTTP ${r.status} ${brief(r.execution?.error ?? r.body)} | ${stepList(r.execution)}`);
  r = await run({ params: { kind: "ships" } });
  s.check(r.status === 200 && r.body?.source === "system" && r.body?.count > 0, `anything else goes through Call Flow to the system layer (${r.body?.count} ships)`, `HTTP ${r.status} ${brief(r.execution?.error ?? r.body)} | ${stepList(r.execution)}`);
  s.check((r.execution?.steps ?? []).some((t) => t.nodeType === "flow.call" && t.status === "success"), "the Call Flow step shows in the trace", stepList(r.execution));
  await s.shot("process-test");
  const d = await deployFlow(false);
  direct.proc = d.url;
  s.check(/\/run\/.+/.test(d.url), `it answers inside the network at ${d.url}`);
  await closeDialog();
}

async function experienceFlow() {
  s.step(`3. Experience layer: ${F_EXP}`);
  const pathOf = (u) => { try { return new URL(u).pathname.replace(/^\/run/, ""); } catch { return ""; } };
  const procPath = pathOf(direct.proc), sysPath = pathOf(direct.sys);
  if (!s.check(!!procPath && !!sysPath, "the addresses of the two inner layers are known", `${direct.proc} ${direct.sys}`)) return;
  ids.exp = await createFlow(s, F_EXP, "blank");
  let p = await add("trigger.http", "Catalog list");
  await setField(p, "path", "/catalog/:kind");
  p = await add("http.request", "Ask the process layer");
  await httpCall(p, { connection: C_ENGINE, url: `${procPath}/reference/{{ $request.params.kind }}` });
  await add("transform.map", "Screen ready list");
  await add("respond", "Answer catalog");
  p = await add("trigger.http", "Run a read query");
  await methodsOnly(p, "POST");
  await setField(p, "path", "/integration-tasks");
  p = await add("http.request", "Ask the system layer");
  await httpCall(p, { connection: C_ENGINE, method: "POST", url: `${sysPath}/integration-tasks`, body: { query: "{{ $request.body.query }}" } });
  await add("respond", "Answer query");
  await tidy();
  await saveFlow(s);

  // run once so the mapper shows real data, then map it, partly in plain words
  let r = await run({ start: "Catalog list", params: { kind: "ships" } });
  // a Map step without rules answers with an empty object, so only the run itself is checked here
  s.check(r.status === 200 && stepsOk(r.execution), "before any mapping the experience flow already reaches the process layer", `HTTP ${r.status} ${brief(r.execution?.error ?? r.body)} | ${stepList(r.execution)}`);
  p = await selectByName("Screen ready list");
  const understood = await mapRules(p, [
    ["instruction", "title", "kind in title case"],
    ["instruction", "code", "kind in upper case"],
    ["direct", "total", "count"],
    ["direct", "servedFrom", "source"],
    ["expr", "options", '[items.{ "id": code, "label": name }]'],
  ], "experience-mapper");
  await saveFlow(s);
  await s.shot("experience-canvas");

  r = await run({ start: "Catalog list", params: { kind: "ships" } });
  s.check(r.status === 200 && r.body?.total > 0 && r.body?.servedFrom === "system" && Array.isArray(r.body?.options), `GET /catalog/ships: ${r.body?.total} options, served from the system layer`, `HTTP ${r.status} ${brief(r.execution?.error ?? r.body)} | ${stepList(r.execution)}`);
  if (understood === 2) s.check(r.body?.title === "Ships" && r.body?.code === "SHIPS", 'the plain-words rules give title "Ships" and code "SHIPS"', brief(r.body));
  r = await run({ start: "Catalog list", params: { kind: "languages" } });
  s.check(r.status === 200 && r.body?.servedFrom === "cache" && r.body?.total > 0, `GET /catalog/languages: ${r.body?.total} options, served from the cache`, `HTTP ${r.status} ${brief(r.execution?.error ?? r.body)}`);
  r = await run({ start: "Run a read query", body: { query: READ_QUERY } });
  s.check(r.status === 200 && Array.isArray(r.body?.data?.ships), "POST /integration-tasks returns the ships through the system layer", `HTTP ${r.status} ${brief(r.execution?.error ?? r.body)} | ${stepList(r.execution)}`);
  await s.shot("experience-test");

  s.step("4. Deploy the experience flow on the gateway and call it as an outside caller would");
  const d = await deployFlow(true);
  if (!d.ok) return;
  s.check(d.gateway === "published", "it is published on the API gateway", `gateway status: ${d.gateway}`);
  if (d.gateway === "published") s.ok(`gateway address: ${(await d.dialog.locator('[data-testid="gateway-url"]').innerText()).split("\n")[0]}`);
  const via = d.gateway === "published" ? "gateway" : "direct";
  let c = await send(d.dialog, { operation: "Catalog list", path: "/catalog/ships", via, tries: 8 });
  s.check(c.status === 200 && c.text.includes("Ships") && c.text.includes("system"), `through the ${via}: GET /catalog/ships is HTTP ${c.status}`, c.text.slice(0, 260));
  await s.shot("gateway-catalog");
  c = await send(d.dialog, { operation: "Catalog list", path: "/catalog/languages", via, tries: 2 });
  s.check(c.status === 200 && c.text.includes("cache"), `through the ${via}: GET /catalog/languages is HTTP ${c.status}, from the cache`, c.text.slice(0, 260));
  c = await send(d.dialog, { operation: "Catalog list", path: "/catalog/bogus", via, tries: 1 });
  s.check(c.status >= 400, `through the ${via}: an unknown kind is an error (HTTP ${c.status})`, c.text.slice(0, 200));
  c = await send(d.dialog, { operation: "Run a read query", method: "POST", path: "/integration-tasks", body: { query: READ_QUERY }, via, tries: 2 });
  s.check(c.status === 200 && c.text.includes("ships"), `through the ${via}: POST /integration-tasks is HTTP ${c.status}`, c.text.slice(0, 260));
  await s.shot("gateway-post");
  const link = c.tryIt.locator('[data-action="open-execution"]');
  if (s.check(await link.isVisible().catch(() => false), "the call links to its execution")) {
    await link.click();
    await page.waitForURL(/tab=executions/);
    const view = page.locator("[data-execution]").first();
    await view.waitFor({ timeout: 20_000 });
    s.check((await view.getAttribute("data-execution-status")) === "success", "the execution opens with its result");
    s.check((await view.locator("[data-step-name]").count()) === 3, "and shows what each of its three steps did", `${await view.locator("[data-step-name]").count()} steps`);
    await s.shot("execution");
    await closeDialog();
  } else await closeDialog();
}

async function observe() {
  s.step("5. Every layer left its own executions and log lines");
  await s.goto("/studio/executions");
  const list = page.locator('[data-testid="executions"]');
  await list.locator("[data-execution-row]").first().waitFor();
  for (const [layer, name] of [["experience", F_EXP], ["process", F_PROC], ["system", F_SYS]]) {
    const live = await list.locator('[data-execution-row][data-execution-mode="live"]', { hasText: name }).count();
    const all = await list.locator("[data-execution-row]", { hasText: name }).count();
    s.check(live >= 1, `${layer} layer: live executions of "${name}" are listed`, `${live} live, ${all} in all`);
  }
  await s.shot("executions");
  s.check((await s.overflow()) === 0, "no horizontal page scroll on the executions page");
  for (const [layer, id] of [["experience", ids.exp], ["process", ids.proc], ["system", ids.sys]]) {
    if (!id) continue;
    await s.goto(`/studio/flows/${id}?tab=logs`);
    const logs = page.locator('[data-testid="logs"]');
    await logs.locator("[data-log-count]").waitFor({ timeout: 20_000 }).catch(() => {});
    const count = Number(await logs.locator("[data-log-count]").getAttribute("data-log-count").catch(() => "0"));
    s.check(count > 0, `${layer} layer: the flow log has lines`, `${count} lines`);
  }
  await s.shot("logs");
  await s.goto(`/studio/flows/${ids.exp}?tab=mappings`);
  s.check((await page.locator('[data-testid="mappings-tab"]').innerText()).includes("servedFrom"), "the Mappings tab of the experience flow lists its rules");
  await s.goto("/studio");
  await page.locator('[data-testid="flows"], .mf-empty').first().waitFor();
  for (const name of [F_SYS, F_PROC, F_EXP]) s.check((await page.locator(`[data-flow-card="${name}"], [data-flow-row="${name}"]`).count()) >= 1, `"${name}" is in the list of flows`);
  await s.shot("flows-list");
}

async function cleanup() {
  s.step("6. Take everything offline and delete it again");
  for (const id of [ids.exp, ids.proc, ids.sys]) {
    if (!id) continue;
    await s.goto(`/studio/flows/${id}`);
    await page.locator('[data-testid="flow-editor"]').waitFor();
    await page.locator('[data-action="open-deploy"]').click();
    const dialog = page.locator('[data-testid="deploy-dialog"]');
    await dialog.waitFor();
    if ((await dialog.getAttribute("data-deploy-status")) === "deployed") {
      await page.locator('[data-action="undeploy"]').click();
      await confirm(page, "Take offline");
      await page.waitForFunction(() => document.querySelector('[data-testid="deploy-dialog"]')?.getAttribute("data-deploy-status") !== "deployed", null, { timeout: 90_000 });
    }
    await closeDialog();
    await deleteFlowFromEditor(s, id);
  }
  s.ok("the three flows were taken offline and deleted");
  for (const name of [C_SYS, C_CACHE, C_ENGINE]) {
    await s.goto("/studio/connections");
    const row = page.locator(`tr[data-connection="${name}"]`);
    if (await row.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) {
      await row.getByRole("button", { name: `Delete ${name}` }).click();
      await confirm(page, "Delete");
      await row.waitFor({ state: "detached" });
    }
  }
  s.ok("the three connections were deleted");
}

// a fixed prefix is reused between runs: start from a clean slate
if (pi >= 0) { await s.goto("/studio"); const old = await sweep(s, `${PREFIX}-`); if (old.length) s.log(`replaced from an earlier run: ${old.join(", ")}`); }
try {
  await connections();
  await systemFlow();
  await processFlow();
  await experienceFlow();
  await observe();
} catch (e) {
  s.fail(`stopped: ${String(e?.message ?? e).split("\n").slice(0, 4).join(" / ")}`);
  await s.shot("stopped");
}
if (!opts.keep) {
  try { await cleanup(); } catch (e) { s.fail(`clean-up through the UI stopped: ${String(e?.message ?? e).split("\n")[0]}`); await s.shot("cleanup-stopped"); }
  const left = await sweep(s, `${PREFIX}-`);
  if (left.length) s.warn(`removed through the API after the UI clean-up did not: ${left.join(", ")}`);
}
await s.finish();
