#!/usr/bin/env node
// Factory: Tool health — the migration tool's corpus run (stubbed answer; nothing real is read).
//   node e2e/tool-health.e2e.mjs [baseUrl] [--shots <dir>] [--width 390 --height 844]
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs([]);
const s = new Session(opts);
const page = await s.start();
const report = {
  ok: true, run: "20261116-111908", finished: new Date(Date.now() - 3600e3).toISOString(),
  projects: [
    { name: "mobile-exp-api", operations: 38, ported: 38, build: { rc: 1, errors: 1 }, tests: { coverage: null }, trial: {}, stops: [{ stage: "build", class: "generic", what: "compile error" }] },
    { name: "batch", operations: 1, ported: 1, build: { rc: 0, errors: 0 }, tests: { coverage: 88.7 }, trial: { ran: true, started: true, passed: true }, stops: [] },
  ],
  backlog: [{ stage: "parity", gap: "parity gap: kafka:publish", projects: ["check-in-proc-api", "email-sys-api"], count: 4 }],
  decisions: [{ project: "check-in-proc-api", stage: "addresses", class: "decision", what: "backend address not set: no address for it in any old settings file", backend: "hTTPRequestConfig" }],
  fixed: [{ gap: "compile error: method is too large", before: 1, after: 0 }],
};
try {
  await s.context.route("**/api/factory/tool-health", (r) => r.fulfill({ json: report }));
  s.step("1. Tool health page");
  await s.goto("/tool-health");
  const root = page.locator('[data-testid="tool-health"]');
  await root.waitFor();
  s.check((await page.locator('[data-testid="th-projects"] tbody tr').count()) === 2, "every project of the run is listed");
  s.check(/kafka:publish/.test(await page.locator('[data-testid="th-backlog"]').innerText()), "the tool gaps are listed with their projects");
  s.check(/hTTPRequestConfig/.test(await page.locator('[data-testid="th-decisions"]').innerText()), "the owner's decisions are listed apart");
  s.check(/1 → 0/.test(await page.locator('[data-testid="th-fixed"]').innerText()), "fixed gaps show before and after");
  s.check(!/https?:\/\//.test(await root.innerText()), "no address is shown");
  s.check((await page.locator('a[href$="/tool-health"]').count()) >= 1, "the page is in the navigation (folded away at phone width)");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  await s.shot("tool-health");
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
