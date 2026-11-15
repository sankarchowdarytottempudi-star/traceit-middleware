#!/usr/bin/env node
// Weave Studio: the calls that went through the migrated services, under Executions.
//
//   node e2e/studio-migrated.e2e.mjs [baseUrl] [--fixture] [--shots <dir>] [--width 390 --height 844] [--headed]
//
// Read-only. It uses what the Factory under test has recorded; when that Factory has no migrated
// services (or --fixture is given) a small built-in example is served to the page instead.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs();
const s = new Session(opts);
const page = await s.start();
const API = "/api/factory/estate/executions";

const at = (ms) => new Date(Date.now() - ms).toISOString();
const FIX_SUMMARY = [
  { id: "fx-call-1", kind: "call", api: "orders-exp-api", layer: "exp", chain: ["orders-exp-api", "stock-sys-api"], operation: "CreateOrder", route: "POST /orders", startedAt: at(60_000), finishedAt: at(59_700), durationMs: 312, serviceMs: 300, status: "success", httpStatus: 200, errors: 0, warnings: 1, via: "gateway", application: "shop-app", stepCount: 5, source: "both" },
  { id: "gw:fx-2", kind: "call", api: "billing-exp-api", layer: "exp", chain: ["billing-exp-api"], startedAt: at(120_000), status: "error", httpStatus: 401, errors: 1, warnings: 0, via: "gateway", stepCount: 0, source: "gateway" },
  { id: "fx-job-1", kind: "job", api: "orders-proc-api", component: "orders-proc-loader", layer: "proc", chain: ["orders-proc-loader", "stock-sys-api"], operation: "prices", startedAt: at(600_000), finishedAt: at(589_000), durationMs: 11_000, status: "success", outcome: "SUCCEEDED", errors: 0, warnings: 0, trigger: "scheduled", stepCount: 1002, source: "logs" },
];
const FIX_DETAIL = {
  "fx-call-1": { ...FIX_SUMMARY[0], correlationId: "fx-call-1", hiddenSteps: 0, steps: [
    { at: at(60_000), offsetMs: 0, api: "orders-exp-api", level: "info", message: "EXP request started", fields: { operationName: "CreateOrder", clientChannel: "web" } },
    { at: at(59_998), offsetMs: 2, api: "orders-exp-api", level: "info", message: "Requesting process API", fields: { targetApi: "/orders-proc-api" } },
    { at: at(59_990), offsetMs: 10, api: "stock-sys-api", level: "warn", message: "Retrying backend call", fields: { attempt: 1, errorType: "TIMEOUT" } },
    { at: at(59_710), offsetMs: 290, api: "stock-sys-api", level: "info", message: "Backend response received", fields: { status: 200, attempt: 2 } },
    { at: at(59_700), offsetMs: 300, api: "orders-exp-api", level: "info", message: "EXP request completed", fields: { operationName: "CreateOrder", status: 200 } },
  ], gateway: { at: at(60_008), method: "POST", context: "/orders/v1", resource: "/orders", status: 200, targetStatus: 200, responseLatency: 312, backendLatency: 306, requestMediationLatency: 3, responseMediationLatency: 3, application: "shop-app", keyType: "PRODUCTION", cacheHit: false, responseSize: 512, matchedBy: "time" } },
  "gw:fx-2": { ...FIX_SUMMARY[1], hiddenSteps: 0, steps: [], gateway: { at: at(120_000), status: 401, errorType: "AUTH", errorMessage: "AUTHENTICATION_FAILURE", matchedBy: "record" } },
  "fx-job-1": { ...FIX_SUMMARY[2], correlationId: "fx-job-1", hiddenSteps: 998, steps: [
    { at: at(600_000), offsetMs: 0, api: "orders-proc-api", component: "orders-proc-loader", level: "info", message: "Job started", fields: { job: "prices", trigger: "SCHEDULED" } },
    { at: at(589_000), offsetMs: 11_000, api: "orders-proc-api", component: "orders-proc-loader", level: "info", message: "Job finished", fields: { job: "prices", outcome: "SUCCEEDED", durationMs: 11000 } },
  ] },
};
function fixtureList(url) {
  const q = url.searchParams;
  const hit = FIX_SUMMARY.filter((x) => (!q.get("api") || x.api === q.get("api") || x.chain.includes(q.get("api"))) && (!q.get("status") || x.status === q.get("status")) && (!q.get("kind") || x.kind === q.get("kind")) && (!q.get("via") || x.via === q.get("via"))
    && (!q.get("q") || JSON.stringify(x).toLowerCase().includes(q.get("q").toLowerCase())));
  return {
    executions: hit, total: hit.length, recorded: FIX_SUMMARY.length, failed: 1,
    apis: [{ api: "orders-exp-api", total: 1, errors: 0 }, { api: "billing-exp-api", total: 1, errors: 1 }, { api: "orders-proc-api", total: 1, errors: 0 }, { api: "stock-sys-api", total: 0, errors: 0 }],
    window: { from: at(600_000), to: at(60_000) },
    sources: { logs: { available: true, parts: 4, lines: 1009 }, gateway: { configured: true, available: true, records: 2, from: at(120_000), to: at(60_008) } },
    notes: [], generatedAt: new Date().toISOString(),
  };
}

try {
  // ------------------------------------------------------------ where does the data come from?
  let own = null;
  if (!opts.rest.includes("--fixture")) {
    const r = await s.context.request.get(`${opts.base}${API}?limit=200`, { timeout: 60_000 }).catch(() => null);
    if (r?.ok()) own = await r.json().catch(() => null);
  }
  const fixture = !own || !own.executions?.length;
  s.log(`calls: ${fixture ? "built-in example" : `this Factory (${own.recorded} recorded, gateway records ${own.sources?.gateway?.available ? "connected" : "not connected"})`}`);
  if (fixture) {
    await page.route(`**${API}**`, (route) => {
      const url = new URL(route.request().url());
      const id = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(API) + API.length + 1));
      if (!id) return route.fulfill({ json: fixtureList(url) });
      return FIX_DETAIL[id] ? route.fulfill({ json: FIX_DETAIL[id] }) : route.fulfill({ status: 404, json: { title: "This execution is no longer recorded" } });
    });
  }
  const known = fixture ? fixtureList(new URL("http://x/")) : own;

  // ------------------------------------------------------------ 1. the Executions page offers both sources
  s.step("1. Executions: flows built here, and migrated APIs");
  await s.goto("/studio/executions");
  await page.locator('[data-testid="executions"]').waitFor();
  s.ok("the executions of the flows built here are still the first thing shown");
  const tab = page.locator('[role="tab"][data-tab="migrated"]');
  s.check(await tab.isVisible(), 'a "Migrated APIs" tab is offered');
  await tab.click();
  await page.waitForURL(/source=migrated/);
  const list = page.locator('[data-testid="migrated-executions"]');
  await list.waitFor();
  const rows = list.locator("[data-migrated-row]");
  await rows.first().waitFor({ timeout: 60_000 });
  const n = await rows.count();
  s.check(n >= 1, "the calls of the migrated services are listed", `${n} rows`);
  s.check((await page.locator('[data-testid="executions"]').count()) === 0, "and the flow runs are not mixed into them");
  const foot = (await list.locator("[data-migrated-footer]").innerText().catch(() => "")).replace(/\s+/g, " ");
  s.check(/recorded/.test(foot), "the page says how much is recorded and where it is read from", foot.slice(0, 160));
  await s.shot("migrated-executions");
  s.check((await s.overflow()) === 0, "no horizontal page scroll on the list");

  // ------------------------------------------------------------ 2. one call, followed from service to service
  s.step("2. One call followed across the services");
  const withSteps = known.executions.find((x) => x.kind === "call" && x.stepCount > 0 && x.chain.length > 1) ?? known.executions.find((x) => x.stepCount > 0);
  if (!withSteps) s.warn("no recorded call has log lines right now; the detail of a traced call was not checked");
  else {
    const wanted = list.locator(`[data-migrated-row="${withSteps.id}"]`);
    const row = (await wanted.count()) ? wanted : list.locator('[data-migrated-row]:not([data-migrated-row^="gw:"])').first();
    await row.click();
    await page.waitForURL(/execution=/);
    const sheet = page.getByRole("dialog").last();
    const detail = sheet.locator("[data-migrated-execution]");
    await detail.waitFor({ timeout: 30_000 });
    const steps = sheet.locator("[data-migrated-step]");
    const count = await steps.count();
    s.check(count >= 1, "the lines each service logged are shown in order", `${count} lines`);
    const services = new Set(await steps.evaluateAll((els) => els.map((e) => e.getAttribute("data-migrated-step"))));
    if (withSteps.chain.length > 1 && (await wanted.count())) s.check(services.size > 1, "lines of more than one service are in the same call", [...services].join(", "));
    const first = steps.locator("button:not([disabled])").first();
    if (await first.count()) {
      await first.click();
      s.check((await sheet.locator(".ws-trace-body dt").count()) >= 2, "a line opens to the fields the service logged");
    }
    const gwBlock = sheet.locator(".mf-collapse-head", { hasText: "gateway's record" });
    if (await gwBlock.count()) {
      if ((await gwBlock.getAttribute("aria-expanded")) !== "true") await gwBlock.click();
      const text = (await sheet.locator("[data-migrated-gateway]").innerText()).replace(/\s+/g, " ");
      s.check(/Answered HTTP \d{3}/.test(text), "the gateway's record of the same call is attached", text.slice(0, 80).replace(/\d{1,3}(\.\d{1,3}){3}/g, "<address>"));
    } else if (withSteps.via === "gateway") s.fail("a call that came through the gateway shows no gateway record");
    else s.ok("this call did not come through the gateway, so there is no gateway record to show");
    await s.shot("migrated-execution");
    s.check((await s.overflow()) === 0, "no horizontal page scroll with the call open");
    await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
    await page.waitForFunction(() => !new URL(location.href).searchParams.get("execution"));
    s.ok("closing the call returns to the list");
  }

  // ------------------------------------------------------------ 3. filters
  s.step("3. Narrowing the list");
  const busiest = known.apis.find((a) => a.total > 0);
  if (busiest) {
    await list.getByLabel("Service", { exact: true }).selectOption(busiest.api);
    await page.waitForURL(/api=/);
    await page.waitForFunction((api) => { const r = [...document.querySelectorAll("[data-migrated-row]")]; return r.length > 0 && r.every((e) => e.getAttribute("data-migrated-api") === api || (e.textContent || "").includes(api)); }, busiest.api, { timeout: 30_000 }).then(() => s.ok(`choosing a service lists only the calls that touched it (${busiest.api})`)).catch(() => s.fail("choosing a service did not narrow the list"));
    await list.getByLabel("Service", { exact: true }).selectOption("");
  }
  if (known.failed > 0) {
    await list.getByLabel("Result", { exact: true }).selectOption("error");
    await page.waitForFunction(() => { const r = [...document.querySelectorAll("[data-migrated-row]")]; return r.length > 0 && r.every((e) => e.getAttribute("data-migrated-status") === "error"); }, null, { timeout: 30_000 }).then(() => s.ok("the result filter shows only the failed calls")).catch(() => s.fail("the result filter did not narrow the list"));
    await s.shot("migrated-failed");
    await list.getByLabel("Result", { exact: true }).selectOption("");
  } else s.ok("nothing failed in what is recorded, so the result filter was not exercised");
  await list.getByLabel("Search calls").fill("zz-no-such-call-zz");
  await list.getByText("No matching calls").waitFor({ timeout: 30_000 });
  s.ok("a search that matches nothing says so calmly");
  await list.getByLabel("Search calls").fill("");

  // ------------------------------------------------------------ 4. the same list on the page of one service
  s.step("4. The Executions tab of one running API");
  const one = (busiest ?? known.apis[0])?.api;
  if (one && !fixture) {
    await s.goto(`/estate/${encodeURIComponent(one)}?tab=executions`);
    const own2 = page.locator('[data-testid="migrated-executions"]');
    await own2.waitFor({ timeout: 30_000 });
    await own2.locator("[data-migrated-row]").first().waitFor({ timeout: 60_000 });
    s.check((await own2.getByLabel("Service", { exact: true }).count()) === 0, "the list is already narrowed to this service");
    s.check((await page.locator('[role="tab"][aria-selected="true"]').innerText()).includes("Executions"), "it sits next to Logs and Traffic of the service");
    await s.shot("estate-executions-tab");
    s.check((await s.overflow()) === 0, "no horizontal page scroll on the service page");
  } else s.ok("skipped with the built-in example (it has no service pages)");

  // ------------------------------------------------------------ 5. back to the flows
  s.step("5. Back to the flows built here");
  await s.goto("/studio/executions?source=migrated");
  await page.locator('[data-testid="migrated-executions"]').waitFor();
  await page.locator('[role="tab"][data-tab="flows"]').click();
  await page.locator('[data-testid="executions"]').waitFor();
  s.check(!/source=/.test(page.url()), "the flows tab is the plain /studio/executions address");
} catch (e) {
  s.fail(`stopped: ${String(e && e.message ? e.message : e).split("\n")[0]}`);
  await s.shot("stopped");
} finally {
  await s.finish();
}
