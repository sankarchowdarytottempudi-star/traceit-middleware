#!/usr/bin/env node
// Factory Estate: an API whose work starts by itself (timer / queue) is described as such, not as
// "answers health checks only"; an operation API and a really empty API keep their wording.
//
//   node e2e/estate-starts.e2e.mjs [baseUrl] [--shots <dir>] [--width 390 --height 844]
//
// Read-only: the estate answers are stand-ins laid over the page; nothing on the cluster is read or changed.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs([]);
const s = new Session(opts);
const page = await s.start();
const HEALTH_ONLY = "The deployed code answers health checks only; no business operations were found.";
const base = { layer: "process", technology: "Ballerina", status: "running", replicas: 1, readyReplicas: 1, health: "healthy", deployed: true, sourceAvailable: true,
  internalUrl: "http://x.wso2.svc:80", basePath: "/x/v1", lastDeployedAt: new Date().toISOString(), features: [], components: [], metricsAvailable: false,
  connectorCount: 2, connectors: [], mappings: [], config: [], links: [], pods: [{ name: "x-1", phase: "Running", ready: true, restarts: 0, startedAt: new Date().toISOString() }] };
const APIS = {
  "stand-in-timer-job": { ...base, name: "stand-in-timer-job", migrationId: "m-timer", operationCount: 0, operations: [], startsBySelf: 2, warnings: [],
    selfStarting: [
      { name: "interfaceFlow", starts: "runs on a timer", kind: "scheduler", switch: "timer", on: true, live: "on", said: "ON, every 60.0s (mode delta, error e-mail on, OSS copy off)" },
      { name: "active-MQFlow", starts: "starts from a message queue", kind: "jms:listener", switch: "queue", on: false, live: "off", said: "off" },
    ],
    runs: { finished: 41, failed: 2, lastAt: new Date().toISOString(), last: "finished" } },
  "stand-in-stuck-job": { ...base, name: "stand-in-stuck-job", migrationId: "m-stuck", operationCount: 0, operations: [], startsBySelf: 1, warnings: [],
    selfStarting: [{ name: "interfaceFlow", starts: "runs on a timer", kind: "scheduler", switch: "timer", on: true, live: "not-started", said: "NOT STARTED, the database could not be reached with the configured address and account", why: "the database could not be reached with the configured address and account" }] },
  "stand-in-operations-api": { ...base, name: "stand-in-operations-api", operationCount: 2, startsBySelf: 0, warnings: [],
    operations: [{ id: "a", method: "GET", path: "/x/v1/items", implemented: true, calls: [] }, { id: "b", method: "POST", path: "/x/v1/items", implemented: true, calls: [] }] },
  "stand-in-empty-api": { ...base, name: "stand-in-empty-api", operationCount: 0, operations: [], startsBySelf: 0, warnings: [HEALTH_ONLY] },
};
const list = { apis: Object.values(APIS).map((a) => ({ name: a.name, layer: a.layer, health: a.health, operations: a.operationCount, startsBySelf: a.startsBySelf, gateway: { published: false, known: true } })), links: [], counts: {} };
await s.context.route(/\/api\/factory\/estate(\?.*)?$/, (r) => r.fulfill({ json: list }));
await s.context.route(/\/api\/factory\/estate\/(stand-in-[a-z-]+)(\?.*)?$/, (r) => {
  const name = /\/estate\/(stand-in-[a-z-]+)/.exec(r.request().url())[1];
  return APIS[name] ? r.fulfill({ json: APIS[name] }) : r.fulfill({ status: 404, json: { error: "no such API" } });
});

try {
  s.step("1. A timer job");
  await s.goto("/estate/stand-in-timer-job");
  const starts = page.locator('[data-testid="estate-starts"]');
  await starts.waitFor();
  const text = await page.locator("main").innerText().catch(async () => page.locator("body").innerText());
  s.check(!/answers health checks only/.test(text), "no \"health checks only\" banner for a job that starts by itself");
  s.check((await page.getByText("0 · Starts by itself 2", { exact: true }).count()) === 1, "the operations card says it starts by itself");
  s.check(/works from a timer \(interfaceFlow\) and a message queue \(active-MQFlow\)/.test(text), "\"What it is\" says what it works from");
  const on = starts.locator('[data-testid="estate-start"][data-live="on"]');
  s.check(/every 60 s\. It is switched on and running/.test(await on.innerText()), "the timer shows switched on, every 60 s");
  s.check(/switched off, so this service does not do that work; the old application still does it/.test(await starts.locator('[data-testid="estate-start"][data-live="off"]').innerText()), "the queue shows switched off with the reason");
  s.check(/41 finished, 2 failed/.test(await page.locator('[data-testid="estate-runs"]').innerText()), "recent runs are counted");
  s.check((await page.getByRole("link", { name: "Parts that start by themselves" }).getAttribute("href")) === "/migrations/m-timer#starts", "the card links to the migration's switches");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  await s.shot("timer-job");

  s.step("2. A timer job that did not start");
  await s.goto("/estate/stand-in-stuck-job");
  const stuck = page.locator('[data-testid="estate-start"][data-live="not-started"]');
  await stuck.waitFor();
  const st = await stuck.innerText();
  s.check(/Switched on, not started/.test(st) && /did not start: the database could not be reached/.test(st), "a part that did not start is shown in red with the reason");
  s.check(/deploy again/i.test(st), "it says what to do");
  await s.shot("stuck-job");

  s.step("3. An API with operations");
  await s.goto("/estate/stand-in-operations-api");
  await page.getByText("What it is").first().waitFor();
  s.check((await page.locator('[data-testid="estate-starts"]').count()) === 0, "no \"Starts by itself\" panel");
  s.check(/A process API with 2 operations/.test(await page.locator("body").innerText()), "it keeps its wording");

  s.step("4. An API with neither");
  await s.goto("/estate/stand-in-empty-api");
  await page.getByText("What it is").first().waitFor();
  s.check((await page.getByText(/answers health checks only/).count()) === 1, "the \"health checks only\" banner stays for an API that really does nothing else");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
