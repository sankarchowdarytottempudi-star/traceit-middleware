#!/usr/bin/env node
// Factory: versions in git on the Estate page (Versions tab), Edit and Clone as separate actions.
//   node e2e/estate-versions.e2e.mjs [baseUrl] [--api <name>] [--shots <dir>] [--width 390 --height 844]
// Read-only: every versions call is answered by a stand-in laid over the BFF; nothing is reverted,
// cloned, proposed or pushed.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs(["--api"]);
const i = opts.rest.indexOf("--api");
const api = i >= 0 ? opts.rest[i + 1] : "batch";
const s = new Session(opts);
const page = await s.start();
const V = `**/api/factory/versions`;
const rows = Array.from({ length: 10 }, (_, k) => ({ version: 12 - k, at: "2026-11-16T10:00:00Z", by: "owner", what: k === 3 ? "revert to v4" : `deployed change ${12 - k}`,
  revertOf: k === 3 ? 4 : undefined, commit: "abc1234", summary: { files: 2, changed: ["services/x/service.bal"] },
  results: { e2e: { status: "done", detail: "trial passed" }, parity: { status: "done", detail: "40/40" }, coverage: { status: "action_required", detail: "75%" } } }));
let reverted = null, cloned = null, proposed = null;
try {
  await page.route(`${V}/apis/${api}?limit=10`, (r) => r.fulfill({ json: { ok: true, versions: rows, total: 14, pending: 0 } }));
  await page.route(`${V}/apis/${api}/changes`, (r) => r.fulfill({ json: { ok: true, pulls: [{ number: 7, title: "faster trips", url: "https://github.test/pr/7", branch: `change/${api}/a1`, by: "agent" }] } }));
  await page.route(`${V}/apis/${api}/diff**`, (r) => r.fulfill({ json: { ok: true, patch: "--- a/service.bal\n+++ b/service.bal\n+// changed line\n", settingsAdded: ["[x.y] newKey"], settingsRemoved: [] } }));
  await page.route(`${V}/apis/${api}/revert`, (r) => { reverted = r.request().postDataJSON(); return r.fulfill({ status: 202, json: { id: "j1", kind: "version-revert", state: "done", result: { ok: true, message: "runs version 11 again", steps: [{ step: "build", state: "ok", message: "compiled" }] } } }); });
  await page.route(`${V}/apis/${api}/propose`, (r) => { proposed = r.request().postDataJSON(); return r.fulfill({ json: { ok: true, branch: `change/${api}/b2`, pr: { number: 8, url: "https://github.test/pr/8" } } }); });
  await page.route(`${V}/apis/${api}/clone`, (r) => { cloned = r.request().postDataJSON(); return r.fulfill({ status: 202, json: { id: "j2", kind: "api-clone", state: "done", result: { ok: true, message: "copy created" } } }); });
  await page.route(`**/api/factory/jobs/**`, (r) => r.fulfill({ json: { id: "j1", kind: "version-revert", state: "done", result: { ok: true, message: "done" } } }));

  s.step(`1. Edit and Clone are separate on ${api}`);
  await s.goto(`/estate/${api}`);
  await page.locator('[data-testid="estate-clone"]').waitFor();
  s.check((await page.locator('[data-testid="estate-edit"]').count()) === 1, "an Edit action is offered");
  s.check((await page.getByRole("button", { name: "Clone to edit" }).count()) === 0, "the old combined 'Clone to edit' is gone");

  s.step("2. Versions tab");
  await s.goto(`/estate/${api}?tab=versions`);
  const panel = page.locator('[data-testid="versions"]');
  await panel.waitFor();
  s.check((await panel.locator('[data-testid="version-row"]').count()) === 10, "the last 10 versions are listed");
  s.check((await panel.getByText("Show older versions (4 more)").count()) === 1, "older versions can be shown");
  s.check((await panel.locator('[data-version="12"]').getByText("running").count()) === 1, "the newest version is marked as running");
  s.check((await panel.getByText("back to v4").count()) === 1, "a revert shows which version it went back to");
  await panel.locator('[data-version="12"]').getByRole("button", { name: "View changes" }).click();
  await page.locator('[data-testid="version-diff"]').waitFor();
  const diffText = await page.locator('[data-testid="version-diff"]').innerText();
  s.check(diffText.includes("changed line") && diffText.includes("newKey"), "the code changes and changed setting names are shown");
  s.check(!/password|secret/i.test(diffText), "no settings values in the changes");
  await page.locator('[role="dialog"]').getByRole("button", { name: "Close", exact: true }).last().click();
  await page.locator('[data-testid="version-diff"]').waitFor({ state: "detached" });
  await panel.locator('[data-version="11"]').getByRole("button", { name: "Revert to this version" }).click();
  await page.locator('[data-testid="revert-confirm"]').waitFor();
  await page.getByRole("button", { name: "Revert to v11" }).click();
  await panel.locator('[data-testid="job-result"]').waitFor();
  s.check(reverted?.version === 11 && Object.keys(reverted).length === 1, "only the version number is sent");
  await s.shot("versions");

  s.step("3. Changes waiting for approval");
  s.check((await panel.locator('[data-testid="change-row"]').count()) === 1, "the open pull request is listed");
  s.check((await panel.getByRole("button", { name: "Approve and deploy" }).count()) === 1 && (await panel.getByRole("button", { name: "Close without deploying" }).count()) === 1, "it can be approved or closed");
  await panel.locator('[data-testid="propose-title"]').fill("tidy the mapping");
  await panel.getByRole("button", { name: "Propose change" }).click();
  await panel.getByText("opened on branch").waitFor();
  s.check(proposed?.title === "tidy the mapping" && proposed?.by === undefined, "the title is sent; the BFF adds who proposed it");

  s.step("4. Clone dialog");
  await s.goto(`/estate/${api}`);
  await page.locator('[data-testid="estate-clone"]').click();
  await page.locator('[data-testid="clone-name"]').fill(`${api}-v2`);
  await page.getByRole("button", { name: "Create the copy" }).click();
  await page.locator('[data-testid="job-result"]').waitFor();
  s.check(cloned?.name === `${api}-v2`, "the new name is sent");
  await s.shot("clone");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
