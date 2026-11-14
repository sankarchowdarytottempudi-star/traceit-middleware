// Weave Studio, end to end, through the UI only, against the real flow engine.
//
//   node e2e/studio.e2e.mjs [baseUrl] [--shots <dir>] [--keep] [--headed]
//   default baseUrl: http://127.0.0.1:8798 (or WEAVE_BASE_URL)
//
// 1. create a connection and a flow (HTTP Listener -> HTTP Request to a read-only health
//    endpoint of a real in-cluster service -> Map with a copied field, an expression and a rule
//    written in plain words -> Respond); test it; assert the step traces and the mapped output
// 2. deploy it, call it through the gateway (and directly) from the UI, find the execution
// 3. import an OpenAPI description as a connector and use one of its operations in a flow
// 4. executions and logs; then take everything offline and delete it again
//
// Only read-only calls are made to the backend. Everything created is named "e2e-<stamp>-...".
import { Session, parseArgs, stamp, field, setField, selectField, openGroup, confirm, createFlow, addStep, selectNode, nodeOf, saveFlow, runTest, deleteFlowFromEditor, sweep, toastText } from "./studio-lib.mjs";

const opts = parseArgs();
const BACKEND = process.env.WEAVE_E2E_BACKEND || "http://seaware-sys-api.wso2.svc";
const HEALTH = process.env.WEAVE_E2E_HEALTH || "/health/ready";
const OWNER_RULE = "add the _ inbetween if name came as two words(customer.name)";
const PREFIX = `e2e-${stamp()}`;
const CONN = `${PREFIX}-backend`;
const FLOW = `${PREFIX}-health-check`;
const CONNECTOR = `${PREFIX}-health-api`;
const FLOW2 = `${PREFIX}-connector-flow`;
const SPEC = {
  openapi: "3.0.0",
  info: { title: "e2e health", version: "1.0.0" },
  servers: [{ url: BACKEND }],
  paths: {
    [HEALTH]: { get: { operationId: "getReadiness", summary: "Is the service ready", responses: { 200: { description: "ready" } } } },
    "/health/live": { get: { operationId: "getLiveness", summary: "Is the service alive", parameters: [{ name: "verbose", in: "query", schema: { type: "string" } }], responses: { 200: { description: "alive" } } } },
  },
};

const s = new Session(opts);
const page = await s.start();
let flowId = null, flow2Id = null, interpreter = "unknown";
s.log(`Weave Studio e2e against ${opts.base}, names start with ${PREFIX}`);

async function connection() {
  s.step("1a. Create a connection and test it");
  await s.goto("/studio/connections");
  await page.locator('[data-action="new-connection"]').click();
  const form = page.locator('[data-testid="connection-form"]');
  await form.waitFor();
  await page.locator("#ws-conn-name").fill(CONN);
  await page.locator("#ws-conn-type").selectOption("http");
  await setField(form, "baseUrl", BACKEND);
  await setField(form, "healthPath", HEALTH);
  await page.locator('[data-action="test-connection"]').click();
  const outcome = form.locator("[data-test-result]");
  await outcome.waitFor({ timeout: 30_000 });
  s.check((await outcome.getAttribute("data-test-result")) === "ok", "the connection test reaches the backend", await outcome.innerText());
  await s.shot("connection-form");
  await page.locator('[data-action="save-connection"]').click();
  const row = page.locator(`tr[data-connection="${CONN}"]`);
  await row.waitFor();
  s.ok(`connection "${CONN}" is listed`);
  await row.locator('[data-action="test"]').click();
  await row.locator('[data-test-result="ok"]').waitFor({ timeout: 30_000 });
  s.ok("the saved connection tests fine from the list");
}

async function buildFlow() {
  s.step("1b. Create a flow and build it on the canvas");
  flowId = await createFlow(s, FLOW, "blank");
  s.ok(`flow created (${flowId})`);
  let panel = await addStep(page, "trigger.http");
  await setField(panel, "path", "/check");
  panel = await addStep(page, "http.request");
  await field(panel, "connection").locator("select").selectOption({ label: CONN });
  await setField(panel, "url", HEALTH);
  await openGroup(panel, "Result");
  await selectField(panel, "resultTarget", "variable");
  await setField(panel, "resultVar", "backend");
  panel = await addStep(page, "transform.map");
  await setField(panel, "input", '{ "customer": { "name": $request.query.name }, "backend": $vars.backend }');
  panel = await addStep(page, "respond");
  await page.waitForTimeout(300);
  s.check((await page.locator(".ws-node").count()) === 4, "four steps are on the canvas");
  s.check((await page.locator(".react-flow__edge").count()) === 3, "the steps were connected in order", `${await page.locator(".react-flow__edge").count()} connections`);
  await saveFlow(s);
  s.ok("saved");
  await s.shot("canvas-built");
}

async function firstRun() {
  s.step("1c. Run a test before any mapping exists");
  const { execution, dock } = await runTest(s, { query: { name: "John Smith" } });
  const result = dock.locator('[data-testid="test-result"]');
  s.check((await result.getAttribute("data-run-status")) === "success", "the test run succeeds", JSON.stringify(execution?.error ?? execution?.status));
  const steps = execution?.steps ?? [];
  s.check(steps.length === 4 && steps.every((t) => t.status === "success"), "four step traces, all successful", steps.map((t) => `${t.nodeName}:${t.status}`).join(", "));
  const call = steps.find((t) => t.nodeType === "http.request");
  s.check(JSON.stringify(call?.output ?? {}).includes("UP"), "the HTTP Request step shows what the backend answered", JSON.stringify(call?.output ?? null).slice(0, 200));
}

async function mapping() {
  s.step("1d. Build the mapping: copy a field, an expression, and a rule in plain words");
  const panel = await selectNode(page, "transform.map");
  await panel.locator('[data-action="open-mapper"]').click();
  const mapper = page.locator('[data-testid="mapper"]');
  await mapper.waitFor();
  const rule = (i) => mapper.locator(`[data-rule-index="${i}"]`);
  await mapper.locator('.ws-map-tree [data-path="backend.status"]').waitFor();
  s.ok("the input tree shows the real data from the test run");

  // rule 0: copy a field, by dragging it from the input tree onto the rule
  await mapper.locator('[data-add-rule="direct"]').click();
  await rule(0).getByLabel("Output field", { exact: true }).fill("service.state");
  await mapper.locator('.ws-map-tree [data-path="backend.status"]').dragTo(rule(0));
  let dragged = await rule(0).getByLabel("Input field", { exact: true }).inputValue();
  if (dragged !== "backend.status") { s.warn(`dragging a field onto a rule did not fill it (got "${dragged}"); typed it instead`); await rule(0).getByLabel("Input field", { exact: true }).fill("backend.status"); }
  else s.ok("dragging an input field onto a rule fills it");

  // rule 1: expression
  await mapper.locator('[data-add-rule="expr"]').click();
  await rule(1).getByLabel("Output field", { exact: true }).fill("service.healthy");
  await rule(1).getByLabel("Expression", { exact: true }).fill('backend.status = "UP"');

  // rule 2: the owner's own sentence, typed into an expression box as they did
  await mapper.locator('[data-add-rule="expr"]').click();
  await rule(2).getByLabel("Output field", { exact: true }).fill("customerName");
  await rule(2).getByLabel("Expression", { exact: true }).fill(OWNER_RULE);
  const offer = rule(2).locator('[data-action="treat-as-words"]');
  await offer.waitFor({ timeout: 15_000 });
  s.ok('a sentence typed as an expression is recognised and "Treat this as a rule in your words" is offered');
  s.check((await rule(2).getAttribute("data-rule-state")) !== "ok", "until then the rule is visibly failing, not silently dropped");
  await offer.click();
  await mapper.locator('[data-rule-index="2"][data-rule-kind="instruction"]').waitFor();
  const verdict = rule(2).locator("[data-understood]");
  if (!(await verdict.first().isVisible().catch(() => false))) await rule(2).locator('[data-action="understand"]').click().catch(() => {});
  await verdict.first().waitFor({ timeout: 30_000 });
  interpreter = (await verdict.first().getAttribute("data-understood")) === "yes" ? "understood" : "not-understood";
  await s.shot("mapper-in-your-words");

  if (interpreter === "understood") {
    const said = await rule(2).locator(".ws-understood-head").innerText();
    s.ok(`the rule was understood. ${said}`);
    await rule(2).getByRole("button", { name: "Show expression" }).click();
    s.ok(`generated expression: ${await rule(2).locator("[data-compiled-expr]").innerText()}`);
    s.check((await rule(2).getAttribute("data-rule-state")) === "ok", "the rule is resolved");
  } else {
    s.fail(`the plain-words interpreter did not understand the owner's sentence "${OWNER_RULE}"`);
    s.check((await rule(2).getAttribute("data-rule-state")) === "unresolved", "the rule is shown as unresolved");
    s.check(await rule(2).locator('[data-rule-msg="unresolved"]').isVisible(), "the rule row says it is unresolved");
  }

  // a sentence nobody could understand must stay visible and must block deployment
  await mapper.locator('[data-add-rule="instruction"]').click();
  await rule(3).getByLabel("Output field", { exact: true }).fill("nonsense");
  await rule(3).getByLabel("Rule in your words", { exact: true }).fill("frobnicate the zorgle quux sideways");
  await rule(3).getByLabel("Output field", { exact: true }).focus();
  if (!(await rule(3).locator("[data-understood]").first().isVisible().catch(() => false))) await rule(3).locator('[data-action="understand"]').click({ timeout: 5000 }).catch(() => {});
  await rule(3).locator('[data-understood="no"]').waitFor({ timeout: 30_000 });
  s.check((await rule(3).getAttribute("data-rule-state")) === "unresolved", "a sentence that cannot be understood stays on screen as unresolved");
  await page.locator('[data-action="close-mapper"]').click();
  await page.locator('[data-action="open-deploy"]').click();
  const dialog = page.locator('[data-testid="deploy-dialog"]');
  await dialog.waitFor();
  s.check(await page.locator('[data-action="deploy"]').isDisabled(), "a flow with an unresolved rule cannot be deployed");
  await s.shot("deploy-blocked");
  await page.getByRole("dialog").last().getByRole("button", { name: "Close", exact: true }).last().click();

  // remove the nonsense rule; if the interpreter is not available, resolve the owner's rule by hand so the rest can be checked
  await page.locator(".ws-panel").locator('[data-action="open-mapper"]').click();
  await mapper.waitFor();
  await rule(3).getByRole("button", { name: "Delete rule" }).click();
  if (interpreter !== "understood") {
    await rule(2).getByRole("button", { name: "Write an expression instead" }).click();
    await rule(2).getByLabel("Expression", { exact: true }).fill('$replace(customer.name, " ", "_")');
  }
  await mapper.locator('[data-rule-index="2"] [data-rule-value]').waitFor({ timeout: 15_000 });
  const out = mapper.locator('[data-testid="mapping-output"]');
  await out.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="mapping-output"]')?.textContent?.includes("John_Smith"), null, { timeout: 15_000 }).catch(() => {});
  const preview = await out.innerText();
  s.check(preview.includes("John_Smith") && preview.includes("UP"), "the live preview shows the mapped result on the sample", preview.replace(/\s+/g, " ").slice(0, 200));
  await rule(1).getByRole("button", { name: "Add a note to this rule" }).click();
  await rule(1).getByLabel("Note", { exact: true }).fill("e2e: true when the backend reports UP");
  await s.shot("mapper-preview");
  await page.locator('[data-action="close-mapper"]').click();
}

async function secondRun() {
  s.step("1e. Save, test again and check the mapped output");
  await saveFlow(s);
  const { execution, dock } = await runTest(s);
  const result = dock.locator('[data-testid="test-result"]');
  s.check((await result.getAttribute("data-run-status")) === "success", "the test run succeeds");
  s.check((await result.getAttribute("data-response-status")) === "200", "the flow answers 200");
  const body = execution?.response?.body ?? null;
  s.check(body?.service?.state === "UP", 'copied field: service.state is "UP"', JSON.stringify(body));
  s.check(body?.service?.healthy === true, "expression: service.healthy is true", JSON.stringify(body));
  s.check(body?.customerName === "John_Smith", 'plain-words rule: customerName is "John_Smith"', JSON.stringify(body));
  const names = await dock.locator("[data-step-name]").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-step-name")}:${e.getAttribute("data-step-status")}`));
  s.check(names.length === 4 && names.every((n) => n.endsWith(":success")), "the step list shows four successful steps", names.join(", "));
  s.check((await page.locator('.ws-node [data-run="success"]').count()) === 4, "every step on the canvas carries its result and duration");
  s.check((await dock.locator('[data-testid="test-response"]').innerText()).includes("John_Smith"), "the response shown in the test panel contains the mapped value");
  await s.shot("test-result");
  // one step alone, with the data of the last run pinned
  const panel = await selectNode(page, "transform.map");
  await panel.locator('[data-action="test-step"]').click();
  const stepDock = page.locator('[data-testid="test-panel"][data-test-mode="step"]');
  await stepDock.waitFor();
  await stepDock.locator('[data-action="run-step"]').click();
  const one = stepDock.locator("[data-step-result]");
  await one.waitFor({ timeout: 30_000 });
  s.check((await one.getAttribute("data-step-result")) === "success" && (await one.innerText()).includes("John_Smith"), '"Test this step" runs the Map step alone on pinned data');
  s.check((await s.overflow()) === 0, "no horizontal page scroll in the editor");
}

async function deploy() {
  s.step("2. Deploy, call it through the gateway from the UI, find the execution");
  await page.locator('[data-action="open-deploy"]').click();
  const dialog = page.locator('[data-testid="deploy-dialog"]');
  await dialog.waitFor();
  await page.locator('[data-action="deploy"]').click();
  await page.locator('[data-testid="deploy-dialog"][data-deploy-status="deployed"]').waitFor({ timeout: 120_000 }).catch(() => {});
  if (!s.check((await dialog.getAttribute("data-deploy-status")) === "deployed", "the flow is deployed", await toastText(page))) return;
  const gw = await dialog.getAttribute("data-gateway-status");
  s.check(gw === "published", "it is published on the API gateway", `gateway status: ${gw}`);
  if (gw === "published") s.ok(`gateway address: ${(await dialog.locator('[data-testid="gateway-url"]').innerText()).split("\n")[0]}`);
  const tryIt = dialog.locator('[data-testid="try-it"]');
  await tryIt.getByLabel("Path", { exact: true }).fill("/check?name=John Smith");
  const send = async (via, tries) => {
    await tryIt.locator(`[data-via="${via}"]`).click();
    let status = 0, text = "";
    for (let i = 0; i < tries; i++) {
      await tryIt.locator('[data-action="invoke"]').click();
      const res = tryIt.locator('[data-testid="invoke-result"]');
      const got = await Promise.race([res.waitFor({ timeout: 60_000 }).then(() => "result"), tryIt.locator(".mf-callout-bad").waitFor({ timeout: 60_000 }).then(() => "error")]).catch(() => "timeout");
      if (got === "result") { status = Number(await res.getAttribute("data-invoke-status")); text = await res.innerText(); if (status >= 200 && status < 300) break; }
      else text = got === "error" ? await tryIt.locator(".mf-callout-bad").innerText() : "no answer in 60 s";
      if (i < tries - 1) await page.waitForTimeout(6000); // a freshly published API can take a moment to become routable
    }
    return { status, text };
  };
  if (gw === "published") {
    s.allow(/\/invoke/);
    const viaGw = await send("gateway", 8);
    s.check(viaGw.status >= 200 && viaGw.status < 300 && viaGw.text.includes("John_Smith"), `called through the gateway: HTTP ${viaGw.status} with the mapped answer`, viaGw.text.replace(/\s+/g, " ").slice(0, 240));
    await s.shot("deploy-try-it");
  }
  const direct = await send("direct", 2);
  s.check(direct.status >= 200 && direct.status < 300 && direct.text.includes("John_Smith"), `called directly on the engine: HTTP ${direct.status}`, direct.text.replace(/\s+/g, " ").slice(0, 240));
  const link = tryIt.locator('[data-action="open-execution"]');
  if (s.check(await link.isVisible().catch(() => false), "the call links to its execution")) {
    await link.click();
    await page.waitForURL(/tab=executions/);
    const view = page.locator("[data-execution]").first();
    await view.waitFor({ timeout: 20_000 });
    s.check((await view.getAttribute("data-execution-status")) === "success", "the execution opens with its result");
    s.check((await view.locator("[data-step-name]").count()) === 4, "and shows what every step did");
    await s.shot("execution-drawer");
    await page.getByRole("dialog").last().getByRole("button", { name: "Close", exact: true }).last().click();
  }
  const live = page.locator('[data-testid="executions"] [data-execution-row][data-execution-mode="live"]');
  await live.first().waitFor({ timeout: 15_000 }).catch(() => {});
  s.check((await live.count()) >= 1, "live calls appear in the flow's executions", `${await live.count()} live rows`);
}

async function connector() {
  s.step("3. Import an OpenAPI description as a connector and use an operation in a flow");
  await s.goto("/studio/connectors");
  // from an address this server cannot read: a clear message, nothing saved
  await page.locator('[data-action="import-openapi"]').click();
  const imp = page.locator('[data-testid="connector-import"]');
  await imp.waitFor();
  s.allow(/import-openapi/);
  await imp.getByRole("tab", { name: "From an address" }).click();
  await page.locator("#ws-imp-url").fill("http://127.0.0.1:9/openapi.json");
  await page.locator('[data-action="import-connector"]').click();
  await imp.locator(".mf-callout-bad").waitFor({ timeout: 30_000 });
  s.ok(`an address that cannot be read gives a clear message: ${(await imp.locator(".mf-callout-bad").innerText()).replace(/\s+/g, " ").slice(0, 140)}`);
  // from a file
  await imp.getByRole("tab", { name: "Upload a file" }).click();
  await imp.locator('[data-testid="connector-file"]').setInputFiles({ name: "e2e-health.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(SPEC, null, 2)) });
  await imp.locator(".ws-drop strong").waitFor();
  s.ok("a description can be uploaded as a file");
  // pasted
  await imp.getByRole("tab", { name: "Paste" }).click();
  await page.locator("#ws-imp-name").fill(CONNECTOR);
  await page.locator("#ws-imp-spec").fill(JSON.stringify(SPEC, null, 2));
  await page.locator('[data-action="import-connector"]').click();
  const form = page.locator('[data-testid="connector-form"]');
  await form.waitFor({ timeout: 30_000 });
  const ops = form.locator("li.ws-opitem");
  s.check((await ops.count()) === 2, "both operations of the description were read", `${await ops.count()} operations`);
  await page.locator("#ws-cx-name").fill(CONNECTOR);
  await page.locator("#ws-cx-conn").selectOption({ label: CONN });
  await s.shot("connector-form");
  await page.locator('[data-action="save-connector"]').click();
  const card = page.locator(`[data-connector="${CONNECTOR}"]`);
  await card.waitFor();
  const connectorId = await card.getAttribute("data-connector-id");
  s.ok(`connector "${CONNECTOR}" saved (${connectorId})`);

  flow2Id = await createFlow(s, FLOW2, "blank");
  let panel = await addStep(page, "trigger.http");
  await setField(panel, "path", "/ready");
  const item = page.locator(`.ws-palette-item[data-node-type^="connector:${connectorId}:"]`);
  s.check((await item.count()) === 2, "the imported operations appear in the list of steps", `${await item.count()} items`);
  await page.getByLabel("Search steps", { exact: true }).fill("ready");
  const type = await item.first().getAttribute("data-node-type");
  await page.getByLabel("Search steps", { exact: true }).fill("");
  panel = await addStep(page, type);
  s.ok(`added the step "${await panel.getAttribute("data-panel-node")}"`);
  panel = await addStep(page, "respond");
  await saveFlow(s);
  const { execution, dock } = await runTest(s);
  s.check((await dock.locator('[data-testid="test-result"]').getAttribute("data-run-status")) === "success", "the flow using the imported operation runs", JSON.stringify(execution?.error ?? null));
  s.check(execution?.response?.status === 200 && JSON.stringify(execution?.response?.body ?? "").includes("UP"), "and returns what the backend answered", JSON.stringify(execution?.response ?? null).slice(0, 200));
  await s.shot("connector-flow");
}

async function observe() {
  s.step("4a. Executions and logs");
  await s.goto("/studio/executions");
  const list = page.locator('[data-testid="executions"]');
  await list.locator("[data-execution-row]").first().waitFor();
  const mine = list.locator("[data-execution-row]", { hasText: FLOW });
  s.check((await mine.count()) >= 2, "the executions of the e2e flow are in the overall list", `${await mine.count()} rows`);
  await mine.first().click();
  const view = page.locator("[data-execution]").first();
  await view.waitFor();
  s.check((await view.locator("[data-step-name]").count()) >= 1, "an execution opens with its steps");
  await s.shot("executions");
  s.check((await s.overflow()) === 0, "no horizontal page scroll on the executions page");
  await page.getByRole("dialog").last().getByRole("button", { name: "Close", exact: true }).last().click();

  await s.goto(`/studio/flows/${flowId}?tab=logs`);
  const logs = page.locator('[data-testid="logs"]');
  await logs.locator("[data-log-count]").waitFor({ timeout: 20_000 }).catch(() => {});
  const count = Number(await logs.locator("[data-log-count]").getAttribute("data-log-count").catch(() => "0"));
  s.check(count > 0, "the flow's log has lines", `${count} lines`);
  await logs.getByLabel("Search the log", { exact: true }).fill("zz-no-such-line-zz");
  await logs.getByText("No matching lines").waitFor();
  s.ok("the log search filters the lines");
  await logs.getByLabel("Search the log", { exact: true }).fill("");
  await logs.getByLabel("Level", { exact: true }).selectOption("error");
  await page.waitForTimeout(800);
  await logs.getByLabel("Level", { exact: true }).selectOption("");
  await s.shot("logs");
  await page.locator('[data-tab="versions"]').click();
  await page.locator('[data-testid="versions-tab"] [data-version]').first().waitFor();
  s.check((await page.locator('[data-testid="versions-tab"] [data-version]').count()) >= 2, "saved versions are listed");
  await page.locator('[data-tab="connections"]').click();
  const usesConn = await page.locator('[data-testid="connections-tab"]').getByText(CONN).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  s.check(usesConn, "the Connections tab shows the connection this flow uses");
  await s.shot("connections-tab");
  await page.locator('[data-tab="mappings"]').click();
  s.check((await page.locator('[data-testid="mappings-tab"]').innerText()).includes("customerName"), "the Mappings tab lists the rules of the flow");
  await s.shot("mappings-tab");
}

async function cleanup() {
  s.step("4b. Take offline and delete everything this run created");
  if (flowId) {
    await s.goto(`/studio/flows/${flowId}`);
    await page.locator('[data-testid="flow-editor"]').waitFor();
    await page.locator('[data-action="open-deploy"]').click();
    const dialog = page.locator('[data-testid="deploy-dialog"]');
    await dialog.waitFor();
    if ((await dialog.getAttribute("data-deploy-status")) === "deployed") {
      await page.locator('[data-action="undeploy"]').click();
      await confirm(page, "Take offline");
      await page.waitForFunction(() => document.querySelector('[data-testid="deploy-dialog"]')?.getAttribute("data-deploy-status") !== "deployed", null, { timeout: 90_000 });
      s.ok("the flow was taken offline");
    }
    await page.getByRole("dialog").last().getByRole("button", { name: "Close", exact: true }).last().click();
    await deleteFlowFromEditor(s, flowId);
    s.ok(`deleted flow "${FLOW}"`);
  }
  if (flow2Id) { await deleteFlowFromEditor(s, flow2Id); s.ok(`deleted flow "${FLOW2}"`); }
  await page.locator('[data-testid="flows"], .mf-empty').first().waitFor();
  s.check((await page.locator(`[data-flow-card^="${PREFIX}"], [data-flow-row^="${PREFIX}"]`).count()) === 0, "no e2e flow is left in the list");
  await s.goto("/studio/connectors");
  const card = page.locator(`[data-connector="${CONNECTOR}"]`);
  if (await card.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) {
    await card.getByRole("button", { name: `Delete ${CONNECTOR}` }).click();
    await confirm(page, "Delete");
    await card.waitFor({ state: "detached" });
    s.ok(`deleted connector "${CONNECTOR}"`);
  }
  await s.goto("/studio/connections");
  const row = page.locator(`tr[data-connection="${CONN}"]`);
  if (await row.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) {
    await row.getByRole("button", { name: `Delete ${CONN}` }).click();
    await confirm(page, "Delete");
    await row.waitFor({ state: "detached" });
    s.ok(`deleted connection "${CONN}"`);
  }
}

try {
  await connection();
  await buildFlow();
  await firstRun();
  await mapping();
  await secondRun();
  await deploy();
  await connector();
  await observe();
} catch (e) {
  s.fail(`stopped: ${String(e?.message ?? e).split("\n").slice(0, 4).join(" / ")}`);
  await s.shot("stopped");
}
if (!opts.keep) {
  try { await cleanup(); } catch (e) { s.fail(`clean-up through the UI stopped: ${String(e?.message ?? e).split("\n")[0]}`); await s.shot("cleanup-stopped"); }
  const left = await sweep(s, PREFIX);
  if (left.length) s.warn(`removed through the API after the UI clean-up did not: ${left.join(", ")}`);
}
s.log(`\nplain-words interpreter: ${interpreter}`);
await s.finish();
