// "Change in your own words": select a step on the canvas, describe the change, see the preview (a line that
// is not understood blocks Apply until it is removed), apply it (a new version), and undo it (the version
// before comes back). Creates one throw-away flow and deletes it; calls no backend.
import { parseArgs, Session, stamp, deleteFlowFromEditor, sweep } from "./studio-lib.mjs";

const opts = parseArgs();
const prefix = "e2e";
const s = new Session(opts);
const page = await s.start();
const settle = (ms = 400) => page.waitForTimeout(ms);
const name = `${prefix}-edit-words-${stamp()}`;
let flowId;
try {
  s.step("1. A small flow to change (made with Describe)");
  await s.goto("/studio");
  await page.locator('[data-action="describe-flow"]').first().click();
  await page.locator("#ws-describe-text").fill([`${name}:`, `When GET /${name} arrives`, "Log \"hello\"", "Answer 200 with message \"hi\""].join("\n"));
  await page.locator('[data-action="describe-read"]').click();
  await page.locator('[data-testid="describe-lines"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-action="describe-accept"]').click();
  await page.waitForURL(/\/studio\/flows\/[^/]+$/, { timeout: 30_000 });
  const editor = page.locator('[data-testid="flow-editor"]');
  await editor.waitFor();
  flowId = await editor.getAttribute("data-flow-id");
  const revision0 = Number(await editor.getAttribute("data-revision"));
  s.check(await page.locator('.ws-node[data-node-type="respond"]').count() === 1, "the flow has its answer step");

  s.step("2. Select the answer step and open \"Change in your own words\"");
  s.check(await page.getByRole("button", { name: "More actions" }).count() === 1, "the editor has its More menu");
  await page.getByRole("button", { name: "More actions" }).click();
  s.check(await page.getByRole("menuitem", { name: "Change this flow in your own words" }).count() === 1, "the flow-level entry is in the More menu");
  await page.keyboard.press("Escape");
  await page.locator('.ws-node[data-node-type="respond"]').first().click();
  await page.locator('[data-action="change-in-words"]').waitFor();
  await page.locator('[data-action="change-in-words"]').click();
  const dlg = page.locator('[data-testid="edit-dialog"]');
  await dlg.waitFor();
  s.check((await page.getByRole("dialog").last().innerText()).includes("Change \"Answer 200\" in your own words"), "the dialog names the selected step");

  s.step("3. Preview: one line understood, one not; Apply waits");
  await page.locator("#ws-edit-text").fill("answer 202 instead of 200\nmake it nicer please");
  await page.locator('[data-action="edit-read"]').click();
  await page.locator('[data-testid="edit-lines"]').waitFor({ timeout: 30_000 });
  const l1 = page.locator('[data-testid="edit-lines"] [data-line="1"]'), l2 = page.locator('[data-testid="edit-lines"] [data-line="2"]');
  s.check((await l1.getAttribute("data-line-status")) === "ok", "line 1 is understood");
  s.check((await l2.getAttribute("data-line-status")) === "not-understood" && await l2.locator('[data-testid="edit-suggestions"] li').count() === 3, "line 2 is not understood, with the 3 closest phrasings");
  s.check(await page.locator('[data-action="edit-apply"]').isDisabled(), "Apply waits until it is fixed");
  const change = page.locator('[data-testid="edit-changes"] [data-change-field="status"]');
  s.check((await change.innerText()).includes("200") && (await change.innerText()).includes("202"), "before → after shows 200 → 202");
  await s.shot("preview");
  await l2.locator('[data-action="remove-line"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="edit-lines"] [data-line="2"]'), null, { timeout: 30_000 });
  s.check(!(await page.locator('[data-action="edit-apply"]').isDisabled()), "after removing the line, Apply is possible");

  s.step("4. Apply: a new version; the canvas shows the change");
  await page.locator('[data-action="edit-apply"]').click();
  await page.locator('[data-testid="edit-applied"]').waitFor({ timeout: 30_000 });
  s.check((await page.locator('[data-testid="edit-applied"]').innerText()).includes(`revision ${revision0 + 1}`), `saved as revision ${revision0 + 1}`);
  await page.locator('[data-action="edit-done"]').click();
  await settle(500);
  s.check(await page.locator('.ws-node', { hasText: "Answer 202" }).count() === 1, "the canvas shows Answer 202");
  s.check((await editor.getAttribute("data-dirty")) === "false", "nothing left unsaved");

  s.step("5. Undo from the same dialog: the version before comes back");
  await page.locator('.ws-node[data-node-type="respond"]').first().click();
  await page.locator('[data-action="change-in-words"]').click();
  await dlg.waitFor();
  await page.locator("#ws-edit-text").fill("answer 203 instead of 202");
  await page.locator('[data-action="edit-read"]').click();
  await page.locator('[data-testid="edit-lines"] [data-line="1"][data-line-status="ok"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-action="edit-apply"]').click();
  await page.locator('[data-testid="edit-applied"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-action="edit-undo"]').click();
  await page.locator('[data-testid="edit-dialog"]').waitFor({ state: "detached", timeout: 30_000 });
  await page.locator('.ws-node', { hasText: "Answer 202" }).waitFor({ timeout: 30_000 });
  s.check(await page.locator('.ws-node', { hasText: "Answer 203" }).count() === 0, "after Undo the canvas shows Answer 202 again, not 203");
  s.check(Number(await editor.getAttribute("data-revision")) === revision0 + 3, "undo is a new version that restores the one before");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  await s.shot("after-undo");
  await deleteFlowFromEditor(s, flowId); flowId = undefined;
  s.ok("the throw-away flow is deleted");
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  try { await sweep(s, `${prefix}-edit-words-`); } catch { /* best effort */ }
  await s.finish();
}
