#!/usr/bin/env node
// Weave Studio: an already-migrated service opened as a read-only flow.
//
//   node e2e/studio-estate.e2e.mjs [baseUrl] [--api <service>] [--estate-from <otherFactoryUrl>] [--fixture]
//                                  [--no-clone] [--shots <dir>] [--width 390 --height 844] [--headed]
//
// Where the service data comes from:
//   - the Factory under test, when it offers /api/factory/estate (the normal case after the merge);
//   - another Factory (--estate-from or WEAVE_ESTATE_FROM), whose answers are passed through to the page;
//   - a small built-in example (--fixture, or when neither of the above answers).
// On a Factory without the estate endpoints the script first checks that the Studio says so calmly.
// "Clone to edit" really makes a flow (named e2e-...) and deletes it again; with the built-in example
// only the request is checked.
import { deleteFlowFromEditor, parseArgs, Session, stamp, sweep } from "./studio-lib.mjs";
import { FIXTURE, FIXTURE_API, pickEstate, pickService, wireEstate } from "./estate-fixture.mjs";

const opts = parseArgs(["--api", "--estate-from"]);
const arg = (name) => { const i = opts.rest.indexOf(name); return i >= 0 ? opts.rest[i + 1] : undefined; };
const flag = (name) => opts.rest.includes(name);
const from = (arg("--estate-from") || process.env.WEAVE_ESTATE_FROM || "").replace(/\/+$/, "");
const PREFIX = `e2e-${stamp()}`;
const desktop = opts.width > 1024;

const s = new Session(opts);
const page = await s.start();
let cloneId = null;

try {
  // ------------------------------------------------------------ where does the data come from?
  const { mode, list, own } = await pickEstate(s.context.request, opts.base, from, flag("--fixture"));
  s.log(`estate data: ${mode === "own" ? "this Factory" : mode === "borrowed" ? `passed through from ${from}` : "built-in example"}`);

  // ------------------------------------------------------------ 0. a Factory without the estate endpoints
  if (!own) {
    s.step("0. A Factory that does not offer migrated services yet");
    await s.goto("/studio");
    const section = page.locator('[data-testid="estate-section"]');
    await section.waitFor({ timeout: 20_000 }).catch(() => {});
    s.check((await section.getAttribute("data-estate").catch(() => null)) === "unavailable", "the list of flows explains that migrated services are not available here");
    s.check(await page.locator('[data-action="new-flow"]').first().isVisible(), "the rest of the page still works (a new flow can be started)");
    await s.goto(`/studio/estate/${FIXTURE_API}`);
    const none = page.locator('[data-testid="estate-unavailable"]');
    await none.waitFor({ timeout: 20_000 }).catch(() => {});
    s.check(await none.isVisible().catch(() => false), "opening a service shows a calm explanation instead of a broken page");
    s.check(await none.getByRole("link", { name: "Back to flows" }).isVisible().catch(() => false), "with a way back to the flows");
    s.check((await s.overflow()) === 0, "no sideways scrolling");
    await s.shot("estate-unavailable");
  }

  // ------------------------------------------------------------ wire the data in
  let api = arg("--api");
  if (mode === "fixture") api = FIXTURE_API;
  else if (!api) api = pickService(list);
  await wireEstate(page, mode, from);
  const dataBase = mode === "borrowed" ? from : opts.base;
  const realFlow = mode === "fixture" ? FIXTURE.flow : await s.context.request.get(`${dataBase}/api/factory/estate/${encodeURIComponent(api)}/flow`).then((r) => r.json());
  const triggers = realFlow.nodes.filter((n) => String(n.type).startsWith("trigger."));
  s.log(`service: ${api} (${realFlow.nodes.length} steps, ${triggers.length} operation${triggers.length === 1 ? "" : "s"})`);

  // ------------------------------------------------------------ 1. from the list of flows
  s.step("1. Migrated services in the list of flows");
  await s.goto("/studio");
  const section = page.locator('[data-testid="estate-section"][data-estate="ok"]');
  await section.waitFor({ timeout: 20_000 });
  const card = section.locator(`[data-estate-card="${api}"]`);
  s.check(await card.isVisible(), `the service "${api}" is listed`);
  s.check((await s.overflow()) === 0, "no sideways scrolling in the list");
  await s.shot("estate-list");
  await card.getByRole("link", { name: "Open", exact: true }).click();
  await page.waitForURL(new RegExp(`/studio/estate/${api.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  // ------------------------------------------------------------ 2. the flow, read-only
  s.step("2. The service as a flow, read-only");
  const view = page.locator('[data-testid="estate-flow"]');
  await view.waitFor({ timeout: 30_000 });
  await page.locator(".ws-node").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  s.check(await view.locator(".ws-bar").getByText(/read-only/i).first().isVisible(), "it is marked as a read-only service");
  const opId = await view.getAttribute("data-operation");
  const reach = (start) => { const seen = new Set([start]); let grew = true; while (grew) { grew = false; for (const e of realFlow.edges) if (seen.has(e.from) && !seen.has(e.to)) { seen.add(e.to); grew = true; } } return seen; };
  const expected = opId ? reach(opId).size : realFlow.nodes.length;
  const shown = await page.locator(".ws-node").count();
  s.check(shown === expected, `the canvas shows the ${expected} steps of the first operation`, `saw ${shown}`);
  s.check((await page.locator(".react-flow__edge").count()) >= Math.max(1, expected - 1), "the steps are connected");
  s.check((await page.locator(".ws-palette-item").count()) === 0, "there is no palette to add steps from");
  s.check((await page.locator('[data-action="save"], [data-action="deploy"], [data-action="test"]').count()) === 0, "there is no save, test or deploy");
  await s.shot("estate-flow");

  // a step: details, original code, nothing editable
  const firstStep = page.locator(".ws-node").nth(Math.min(1, shown - 1));
  await firstStep.locator(".ws-node-name").click();
  const panel = desktop ? page.locator('aside[aria-label="Step details"]') : page.getByRole("dialog", { name: "Step details" });
  await panel.waitFor({ timeout: 10_000 });
  const editable = await panel.locator("input:not([disabled]):not([readonly]):not([type=search]), textarea:not([disabled]):not([readonly]), select:not([disabled])").count();
  s.check(editable === 0, "the step's details cannot be edited", `${editable} editable control(s)`);
  const hasSource = realFlow.nodes.some((n) => n.config && n.config.__source && n.config.__source.code);
  if (hasSource) {
    const source = panel.locator("[data-source-file]");
    s.check(await source.isVisible().catch(() => false), "the step shows where it comes from in the service's code");
    s.check(((await source.innerText().catch(() => "")).length) > 20, "with the lines of code themselves");
  }
  await s.shot("estate-step");
  if (desktop) {
    await page.keyboard.press("Delete");
    await page.waitForTimeout(300);
    s.check((await page.locator(".ws-node").count()) === shown, "pressing Delete does not remove a step");
  } else {
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
  }

  // ------------------------------------------------------------ 3. operations
  s.step("3. Choosing another operation");
  if (triggers.length > 1) {
    if (!desktop) { await page.locator('[data-action="pick-operation"]').click(); await page.getByRole("dialog", { name: "Operations" }).waitFor(); }
    const picker = page.locator('[data-testid="estate-operations"]');
    const items = picker.locator("li.ws-opitem");
    s.check((await items.count()) === triggers.length, `all ${triggers.length} operations are offered`, `saw ${await items.count()}`);
    await s.shot("estate-operations");
    const second = items.nth(1);
    const secondId = await second.getAttribute("data-operation");
    await second.locator("button").click();
    await page.waitForFunction((id) => document.querySelector('[data-testid="estate-flow"]')?.getAttribute("data-operation") === id, secondId);
    await page.waitForTimeout(500);
    s.check(page.url().includes("operation="), "the chosen operation is part of the address, so it can be shared");
    const now = await page.locator(".ws-node").count();
    s.check(now === reach(secondId).size, `the canvas now shows the ${reach(secondId).size} steps of that operation`, `saw ${now}`);
    await s.shot("estate-second-operation");
  } else s.ok("this service has a single operation, nothing to choose");

  // ------------------------------------------------------------ 4. connectors, mappings, log
  s.step("4. Connectors, mappings and the log");
  const tab = async (name) => { await view.getByRole("tab", { name: new RegExp(`^${name}`) }).click(); };
  await tab("Connectors");
  await page.locator('[data-testid="estate-connectors"]').waitFor();
  s.check(await page.locator('[data-testid="estate-connectors"]').isVisible(), "the Connectors tab opens");
  const shownIds = reach((await view.getAttribute("data-operation")) || "");
  const calling = realFlow.nodes.filter((n) => shownIds.has(n.id) && n.config && (n.config.__connector || n.config.__target)).length;
  if (calling > 0) {
    const rows = await page.locator('[data-testid="estate-calls"] tbody tr').count();
    s.check(rows === calling, `the ${calling} calls this operation makes to other systems are listed`, `saw ${rows}`);
  }
  s.check((await s.overflow()) === 0, "no sideways scrolling on the Connectors tab");
  await s.shot("estate-connectors");
  await tab("Mappings");
  await page.locator('[data-testid="estate-mappings"]').waitFor();
  s.check(await page.locator('[data-testid="estate-mappings"]').isVisible(), "the Mappings tab opens");
  await s.shot("estate-mappings");
  await tab("Logs");
  const logs = page.locator('[data-testid="estate-logs"]');
  await logs.waitFor();
  await page.waitForFunction(() => { const el = document.querySelector('[data-testid="estate-logs"]'); return !!el && (!!el.querySelector("ol.ws-log") || !!el.querySelector(".mf-empty") || !!el.querySelector(".mf-callout")); }, null, { timeout: 30_000 }).catch(() => {});
  const lines = Number((await logs.locator("ol.ws-log").getAttribute("data-log-count").catch(() => "0")) || 0);
  s.check(lines > 0 || (await logs.locator(".mf-empty, .mf-callout").count()) > 0, lines > 0 ? `the log shows ${lines} lines` : "the log says clearly that there is nothing to show");
  const [searched] = await Promise.all([
    page.waitForRequest((r) => /\/estate\/[^/]+\/logs/.test(r.url()) && /[?&]q=/.test(r.url()), { timeout: 10_000 }).catch(() => null),
    logs.getByLabel("Search the log", { exact: true }).fill("POST"),
  ]);
  s.check(!!searched, "typing in the search box searches the service's log");
  await page.waitForTimeout(600);
  s.check((await s.overflow()) === 0, "no sideways scrolling");
  await s.shot("estate-logs");
  await tab("Flow");
  await page.locator(".ws-node").first().waitFor();

  // ------------------------------------------------------------ 5. links and the editable copy
  s.step("5. Service details and an editable copy");
  const details = view.getByRole("link", { name: "Service details" });
  s.check(((await details.getAttribute("href")) || "").endsWith(`/estate/${encodeURIComponent(api)}`), "\"Service details\" leads to the service's own page");
  await page.locator('[data-action="clone"]').click();
  const dialog = page.getByRole("dialog", { name: "Clone to edit" });
  await dialog.waitFor();
  await s.shot("estate-clone-dialog");
  const cloneName = `${PREFIX}-copy`;
  await page.locator("#ws-clone-name").fill(cloneName);
  if (flag("--no-clone")) {
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    s.ok("the copy was not made (--no-clone)");
  } else if (mode === "fixture") {
    s.allow(/fl_e2e_fixture/);
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.method() === "POST" && /\/estate\/[^/]+\/clone$/.test(new URL(r.url()).pathname)),
      page.locator('[data-action="confirm-clone"]').click(),
    ]);
    s.check(req.postDataJSON()?.name === cloneName, "the copy is asked for under the name that was typed");
    await page.waitForURL(/\/studio\/flows\/fl_e2e_fixture$/);
    s.ok("and the new flow is opened in the editor");
  } else {
    await page.locator('[data-action="confirm-clone"]').click();
    const opened = await page.waitForURL(/\/studio\/flows\/[^/]+$/, { timeout: 30_000 }).then(() => true).catch(() => false);
    if (!s.check(opened, "the copy is made and opened in the editor", (await dialog.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200))) {
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click().catch(() => {});
    } else {
      const editor = page.locator('[data-testid="flow-editor"]');
      await editor.waitFor({ timeout: 20_000 });
      cloneId = await editor.getAttribute("data-flow-id");
      await page.locator(".ws-node").first().waitFor({ timeout: 20_000 });
      s.check((await page.locator(".ws-node").count()) >= 2, "the copy has the steps of the service");
      s.check((await page.locator('[data-action="save"]').count()) > 0, "and it can be edited and saved");
      await s.shot("estate-clone-editor");
      await deleteFlowFromEditor(s, cloneId);
      cloneId = null;
      s.ok("the copy was deleted again");
    }
  }
} catch (e) {
  s.fail(`stopped: ${String(e && e.message ? e.message : e).split("\n")[0]}`);
  await s.shot("stopped");
} finally {
  const left = await sweep(s, PREFIX).catch(() => []);
  if (left.length) s.warn(`removed by the safety net: ${left.join(", ")}`);
  await s.finish();
}
