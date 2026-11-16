#!/usr/bin/env node
// Factory: "Request a change" on a running API. The requirement, examples, live steps, review with
// diff and results, pull request, approve / reject. All answers are stand-ins laid over the
// change-request calls: no model, tool or service is used or changed.
//
//   node e2e/change-requests.e2e.mjs [baseUrl] [--api <name>] [--shots <dir>] [--width 390 --height 844]
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs(["--api"]);
const i = opts.rest.indexOf("--api");
const api = i >= 0 ? opts.rest[i + 1] : "person-profile-api";
const s = new Session(opts);
const page = await s.start();
const CID = "abcdef012345";
let state = "running", sent = null, acted = [];
const change = () => ({ id: CID, api, status: state, round: 1, by: "dev-tester", createdAt: 1794800000,
  request: { requirement: "When the catalogue answers 404 for an item, answer 404 with ITEM_NOT_FOUND." },
  steps: state === "running" ? [{ name: "baseline", state: "done", detail: "tests pass, coverage 81" }, { name: "model", round: 1, state: "running", detail: "the local model is writing the change" }]
    : [{ name: "baseline", state: "done" }, { name: "model", round: 1, state: "done", detail: "maps 404 to ITEM_NOT_FOUND" }, { name: "build and unit tests", round: 1, state: "done", detail: "12 tests pass, coverage 82" }, { name: "closed-room trial", round: 1, state: "done", detail: "4 of 4 answered" }, { name: "parity", round: 1, state: "done", detail: "3 of 3 old flows" }],
  ...(state !== "running" ? { explanation: "Maps a 404 of the catalogue to ITEM_NOT_FOUND.", results: { tests: 12, coverage: 82, trial: "4 of 4 answered", parity: "3 of 3 old flows" }, baseline: { coverage: 81 },
    diff: "--- a/services/x/service.bal\n+++ b/services/x/service.bal\n@@ -1 +1 @@\n-        return reply;\n+        return reply.statusCode == 404 ? notFound(itemId) : reply;\n" } : {}),
  ...(state === "proposed" ? { pr: 7, prUrl: "https://github.invalid/pr/7" } : {}) });

try {
  await page.route(`**/api/factory/changes/apis/${api}`, (r) => {
    if (r.request().method() === "POST") { sent = r.request().postDataJSON(); return r.fulfill({ status: 202, json: { ok: true, id: CID } }); }
    return r.fulfill({ json: { ok: true, changes: sent ? [{ id: CID, status: state, requirement: change().request.requirement, by: "dev-tester", createdAt: 1794800000 }] : [] } });
  });
  await page.route(`**/api/factory/changes/${CID}`, (r) => r.fulfill({ json: change() }));
  await page.route(`**/api/factory/changes/${CID}/*`, (r) => { const a = r.request().url().split("/").pop(); acted.push(a); state = a === "propose" ? "proposed" : a === "reject" ? "rejected" : "approved"; return r.fulfill({ json: { ok: true, pr: { number: 7 } } }); });

  s.step(`1. Ask for a change on ${api}`);
  await s.goto(`/estate/${encodeURIComponent(api)}`);
  await page.getByRole("tab", { name: /^Request a change/ }).click();
  const panel = page.locator('[data-testid="changes"]');
  await panel.waitFor();
  s.check((await page.getByText("Model runs on this server", { exact: true }).count()) === 1, "the page says the model runs on this server");
  s.check(await panel.locator('[data-testid="change-start"]').isDisabled(), "a request cannot be sent before it is described");
  await panel.locator('[data-testid="change-text"]').fill("When the catalogue answers 404 for an item, answer 404 with ITEM_NOT_FOUND.");
  await panel.getByRole("button", { name: "Add an example" }).click();
  const ex = panel.locator('[data-testid="change-example"]');
  await ex.locator("input").nth(0).fill("items 42");
  s.check(/looks like/.test(await panel.innerText()) && await panel.locator('[data-testid="change-start"]').isDisabled(), "a malformed example is pointed out and blocks the request");
  await ex.locator("input").nth(0).fill("GET /items/{itemId}");
  await ex.locator("input").nth(1).fill('{"itemId":"42"}');
  await ex.locator("input").nth(3).fill("catalogueRequestConfig");
  await ex.locator("input").nth(4).fill("404");
  await ex.locator("input").nth(6).fill("404");
  await ex.locator("input").nth(7).fill("ITEM_NOT_FOUND");
  await panel.locator('[data-testid="change-start"]').click();
  await panel.locator('[data-testid="change-view"]').waitFor();
  s.check(sent?.requirement?.startsWith("When the catalogue") && sent?.examples?.[0]?.op === "GET /items/{itemId}" && sent.examples[0].expectStatus === 404
    && sent.examples[0].backendReplies?.[0]?.backend === "catalogueRequestConfig" && sent.by === undefined, "only the requirement and the examples are sent (the server sets who)");
  s.check(/being written and tested/i.test(await panel.innerText()), "the job shows as running with its steps");
  await s.shot("running");

  s.step("2. Review and decide");
  state = "ready";
  await page.locator('[data-testid="change-results"]').waitFor({ timeout: 15000 });
  s.check(/12 pass/.test(await page.locator('[data-testid="change-results"]').innerText()) && /before 81%/.test(await page.locator('[data-testid="change-results"]').innerText()), "tests, coverage (with the earlier figure), trial and check are shown");
  s.check((await page.locator('[data-testid="change-diff"]').innerText()).includes("notFound(itemId)"), "the code change is shown");
  await panel.getByRole("button", { name: "Open the pull request" }).click();
  await panel.getByRole("button", { name: "Approve and deploy" }).waitFor();
  s.check(acted.includes("propose"), "the pull request is opened on request");
  await panel.getByRole("button", { name: "Approve and deploy" }).click();
  await page.waitForTimeout(500);
  s.check(acted.includes("approve"), "approving is a separate, explicit step");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  await s.shot("review");
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
