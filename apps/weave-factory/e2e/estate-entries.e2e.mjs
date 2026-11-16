#!/usr/bin/env node
// Weave Studio: a migrated job opened as a flow shows every entry point (HTTP, timer, queue)
// and the tree of old sub-flows behind each, with where it lives in the new code.
//
//   node e2e/estate-entries.e2e.mjs [baseUrl] [--shots <dir>] [--width 390 --height 844]
//
// Read-only and stubbed: the estate answers for one batch-like service are laid over the page.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs([]);
const desktop = opts.width > 1024;
const API = "batch-like-api";
const node = (id, type, name, config = {}, notes) => ({ id, type, name, position: { x: 0, y: 0 }, config, ...(notes ? { notes } : {}) });

// timer with 8 modules x 4 sub-flows under an aggregator, plus 4 first-level sub-flows; a queue with one
const nodes = [
  node("h1", "trigger.http", "ANY /clearObjectStore", { methods: ["GET"], path: "/clearObjectStore" }),
  node("h2", "respond", "Send response", { status: "200" }),
  node("t0", "trigger.schedule", "Timer: interfaceFlow", { mode: "interval", everySeconds: 60, __entry: { kind: "timer", state: "switched on and running", everySeconds: 60 } }, "Every 60 s, switched on and running.\nOld flow interfaceFlow: found in the new code."),
  node("q0", "trigger.manual", "Queue: active-MQFlow", { __entry: { kind: "queue", state: "switched off" } }, "Starts from a message queue, switched off."),
  node("q1", "flow.call", "active-MQ-implSub_Flow", { __depth: 1, __subflow: { status: "complete" } }, "Old sub-flow active-MQ-implSub_Flow: found in the new code."),
];
const edges = [{ id: "e0", from: "h1", fromPort: "out", to: "h2" }, { id: "eq", from: "q0", fromPort: "out", to: "q1" }];
const sub = (id, name, depth, parent, extra = "") => { nodes.push(node(id, "flow.call", name, { __depth: depth, __subflow: { status: "complete" } }, `Old sub-flow ${name}: found in the new code.\nIn the new code: services/batch/modules/core/job.bal:${100 + nodes.length}${extra}`)); edges.push({ id: `e_${id}`, from: parent, fromPort: "out", to: id }); };
sub("s1", "retrieve_date", 1, "t0"); sub("s2", "batch-implSub_Flow", 1, "t0", "\nConditions: delta"); sub("s3", "Seaware_GraphQL_API_Sub_Flow", 2, "s2"); sub("s4", "oss-implSub_Flow", 2, "s2");
sub("s5", "batch-aggregatorSub_Flow", 1, "t0"); sub("s6", "Batch_zoho_modules", 2, "s5");
["Accounts", "Contacts", "Reservation_Names", "Cabin_Info", "Addons", "Group_Agency", "Voyages", "Finance"].forEach((m, i) => {
  sub(`m${i}`, `zoho-${m}-Upsert`, 3, "s6", `\nCalls: POST /crm/v6/${m}/upsert`);
  sub(`m${i}a`, `zohoUpsert_${m}_Request`, 4, `m${i}`); sub(`m${i}b`, `db-sys-${m}`, 4, `m${i}`); sub(`m${i}c`, `retry-${m}`, 4, `m${i}`);
});
const flow = { id: `estate:${API}`, name: API, slug: API, readOnly: true, revision: 1, origin: { kind: "migrated", ref: API }, settings: { basePath: "/batch/v1" }, nodes, edges };
const detail = { name: API, layer: "process", technology: "Ballerina", status: "running", operations: [{ id: "a", method: "ANY", path: "/clearObjectStore", implemented: true }], connectors: [], mappings: [] };

const s = new Session(opts);
const page = await s.start();
try {
  await page.route(/\/api\/factory\/estate(\/|\?|$)/, async (route) => {
    const rest = new URL(route.request().url()).pathname.replace(/^.*\/api\/factory\/estate/, "");
    const json = (b, st = 200) => route.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(b) });
    if (rest === `/${API}/flow`) return json(flow);
    if (rest === `/${API}`) return json(detail);
    if (rest === `/${API}/logs`) return json({ lines: [] });
    if (rest === "" || rest === "/") return json({ apis: [{ name: API, layer: "process", operations: 1, connectors: 0 }] });
    return json({ title: "Not found", status: 404 }, 404);
  });

  s.step("1. Every entry point is offered");
  await s.goto(`/studio/estate/${API}`);
  await page.locator('[data-testid="estate-flow"]').waitFor({ timeout: 20_000 });
  if (!desktop) { await page.locator('[data-action="pick-operation"]').click(); await page.getByRole("dialog", { name: "Operations" }).waitFor(); }
  const picker = page.locator('[data-testid="estate-operations"]');
  const items = picker.locator("li.ws-opitem");
  s.check((await items.count()) === 3, "the HTTP operation, the timer and the queue are all offered", `saw ${await items.count()}`);
  const text = await picker.innerText();
  s.check(/TIMER/.test(text) && /QUEUE/.test(text), "the timer and the queue are labelled as such");
  s.check(/switched on and running/.test(text) && /switched off/.test(text), "each shows whether it is switched on");
  await s.shot("entries");
  await picker.locator('li.ws-opitem[data-operation="t0"] button').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="estate-flow"]')?.getAttribute("data-operation") === "t0");
  await page.waitForTimeout(600);

  s.step("2. The timer's sub-flows, first level, then all");
  const tools = page.locator('[data-testid="estate-canvas-tools"]');
  await tools.waitFor({ timeout: 10_000 });
  const first = await page.locator(".ws-node").count();
  s.check(first === 4, "a large tree opens with the first level of sub-flows only", `saw ${first} steps`);
  await page.locator('[data-testid="estate-nested"] input').check({ force: true });
  await page.waitForTimeout(700);
  const all = await page.locator(".ws-node").count();
  s.check(all === 1 + 6 + 32, "switching on nested sub-flows shows the whole tree (timer + 38 sub-flows)", `saw ${all}`);
  await s.shot("tree");

  s.step("3. Finding a sub-flow and reading where it lives in the new code");
  await tools.locator('input[type="search"]').fill("Group_Agency-Upsert");
  const hit = tools.locator(".ws-stepfind-list button").first();
  await hit.waitFor({ timeout: 5000 });
  await hit.click();
  const panel = desktop ? page.locator('aside[aria-label="Step details"]') : page.getByRole("dialog", { name: "Step details" });
  await panel.waitFor({ timeout: 10_000 });
  const ptext = await panel.innerText();
  s.check(/zoho-Group_Agency-Upsert/.test(ptext), "the found sub-flow opens");
  s.check(/In the new code: services\/batch/.test(ptext), "it says where it lives in the new code");
  s.check(/POST \/crm\/v6\/Group_Agency\/upsert/.test(ptext), "and what it calls");
  const editable = await panel.locator("input:not([disabled]):not([readonly]):not([type=search]), textarea:not([disabled]):not([readonly]), select:not([disabled])").count();
  s.check(editable === 0, "nothing in it can be edited", `${editable} editable control(s)`);
  await s.shot("found");
  s.check(!/:\/\/(?!<)/.test(await page.locator("body").innerText()), "no address is shown");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
