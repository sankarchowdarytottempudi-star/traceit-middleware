// "Describe the flow": write the requirement in your own words, see the preview (each line next to the
// steps it made, the missing connection, the flow engine's check), fix a line that was not understood,
// accept, and find the steps on the canvas as a draft. Then add one more step from words inside the
// editor. Read by fixed rules on the server; the local-model button is off by default and must not show.
// Creates one throw-away flow and deletes it; creates no connection.
import { parseArgs, Session, stamp, deleteFlowFromEditor, sweep } from "./studio-lib.mjs";

const opts = parseArgs();
const prefix = "e2e";
const s = new Session(opts);
const page = await s.start();
const settle = (ms = 400) => page.waitForTimeout(ms);
const name = `${prefix}-describe-${stamp()}`;
// a system name no connection on the server can have, so it is always offered as missing
const SYS = `Crm${stamp()}`;
const dialog = () => page.locator('[data-testid="describe-dialog"]');
const line = (n) => page.locator(`[data-testid="describe-lines"] [data-line="${n}"]`);
let flowId;
try {
  s.step("1. The Flows page offers \"Describe a flow\"; the dialog explains itself and lists what can be written");
  await s.goto("/studio");
  await page.locator('[data-action="describe-flow"]').first().click();
  await dialog().waitFor();
  s.check(await page.locator("#ws-describe-text").isVisible(), "a text box for the steps");
  s.check(await page.locator('[data-action="describe-model"]').count() === 0, "\"Draft with the local model\" is not offered (switched off by default)");
  await page.locator('[data-action="describe-help"]').click();
  const help = page.locator('[data-testid="describe-help"]');
  await help.waitFor();
  const groups = await help.locator("h4").allTextContents();
  s.check(["Start", "Call a system", "Database", "Conditions", "Loops", "Data", "Log", "Errors and retries", "Answer"].every((g) => groups.includes(g)), "\"What you can write\" lists every group of phrasings", groups.join(", "));
  s.check((await help.innerText()).includes("If the call fails, answer 502 with the error"), "each phrasing comes with an example");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  await s.shot("help");
  await page.locator('[data-action="describe-help"]').click();

  s.step("2. The owner's example, read into a preview: every line linked to the steps it made");
  const text = [
    `${name}:`,
    "When POST /guests/check arrives",
    `Look up the contact in ${SYS} by email`,
    `If not found, create the contact in ${SYS} with first name, last name, email`,
    "Log \"guest checked\"",
    "Answer 201 with the contact id",
  ].join("\n");
  await page.locator("#ws-describe-text").fill(text);
  await page.locator('[data-action="describe-read"]').click();
  await page.locator('[data-testid="describe-lines"]').waitFor({ timeout: 30_000 });
  const summary = page.locator('[data-testid="describe-summary"]');
  s.check((await summary.getAttribute("data-bad")) === "0" && (await summary.getAttribute("data-steps")) === "6", "6 steps, no line left not understood", `${await summary.getAttribute("data-steps")} steps, ${await summary.getAttribute("data-bad")} not understood`);
  s.check((await page.locator("#ws-describe-name").inputValue()) === name, "the first line names the flow");
  for (const n of [2, 3, 4, 5, 6]) s.check(["ok", "warning"].includes(await line(n).getAttribute("data-line-status")), `line ${n} was understood`);
  s.check((await line(1).innerText()).includes("Name"), "line 1 is shown as the name");
  const nodes = page.locator('[data-testid="describe-canvas"] [data-node-id]');
  s.check(await nodes.count() === 6, "the preview draws the 6 steps");
  const types = await nodes.evaluateAll((els) => els.map((e) => e.getAttribute("data-node-type")));
  s.check(["trigger.http", "logic.choice", "log", "respond"].every((t) => types.includes(t)), "listener, condition, log and answer are there", types.join(", "));
  await line(4).hover();
  await settle(200);
  s.check(await page.locator('[data-testid="describe-canvas"] .ws-dsc-node-on').count() === 2, "pointing at the If line lights up the two steps it made (the condition and the create)");
  s.check((await line(4).innerText()).includes("$isEmpty($vars.contact)"), "\"not found\" is shown as understood: the contact kept above is empty");
  const answerNode = page.locator('[data-testid="describe-canvas"] [data-node-type="respond"]');
  s.check((await answerNode.getAttribute("data-lines")) === "6", "the answer step says it came from line 6");
  await answerNode.hover();
  await settle(200);
  s.check(await line(6).evaluate((el) => el.classList.contains("ws-dsc-line-on")), "pointing at a step lights up its line");
  s.step("2b. The CRM is not a connection here yet: it is listed with \"New connection…\"");
  const missing = page.locator(`[data-testid="describe-missing"] [data-missing="${SYS}"]`);
  s.check(await missing.count() === 1, "the missing CRM connection is listed, with the lines that need it");
  await missing.locator('[data-action="describe-new-connection"]').click();
  await page.locator('[data-testid="connection-form"]').waitFor();
  s.check((await page.locator("#ws-conn-name").inputValue()) === SYS && (await page.locator("#ws-conn-type").inputValue()) === "http", "the connection form opens with the name and the kind filled in");
  await s.shot("new-connection");
  await page.getByRole("dialog").last().getByRole("button", { name: "Cancel", exact: true }).click();
  s.check(await page.locator('[data-testid="describe-issues"]').count() === 1, "the flow engine's check is shown");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  await s.shot("preview");

  s.step("3. A line that is not understood: listed with the 3 closest phrasings; accepting waits until it is fixed");
  await page.locator('[data-action="describe-back"]').click();
  await page.locator("#ws-describe-text").fill(`${text}\nMake the coffee please`);
  await page.locator('[data-action="describe-read"]').click();
  await line(7).waitFor({ timeout: 30_000 });
  s.check((await line(7).getAttribute("data-line-status")) === "not-understood", "the line is marked Not understood");
  s.check((await line(7).getAttribute("data-line-nodes")) === "", "nothing was guessed for it");
  s.check(await line(7).locator('[data-testid="describe-suggestions"] li').count() === 3, "the 3 closest phrasings are offered");
  s.check(await page.locator('[data-action="describe-accept"]').isDisabled(), "Create is not possible yet");
  s.check(await page.locator('[data-testid="describe-blocked"]').isVisible(), "the dialog says why");
  await s.shot("not-understood");
  await line(7).locator('[data-action="remove-line"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="describe-lines"] [data-line="7"]'), null, { timeout: 30_000 });
  s.check(!(await page.locator('[data-action="describe-accept"]').isDisabled()), "after removing the line, the draft can be created");

  s.step("4. Accept: the flow is created as a draft and the editor shows the steps");
  await page.locator('[data-action="describe-accept"]').click();
  await page.waitForURL(/\/studio\/flows\/[^/]+$/, { timeout: 30_000 });
  const editor = page.locator('[data-testid="flow-editor"]');
  await editor.waitFor();
  flowId = await editor.getAttribute("data-flow-id");
  await page.locator(".ws-node").first().waitFor();
  s.check(await page.locator(".ws-node").count() === 6, "the canvas shows the 6 steps");
  for (const t of ["trigger.http", "logic.choice", "log", "respond"]) s.check(await page.locator(`.ws-node[data-node-type="${t}"]`).count() >= 1, `the canvas has the ${t} step`);
  s.check((await editor.getAttribute("data-dirty")) === "false", "it is saved");
  s.check(!(await page.locator(".ws-bar-state").innerText()).match(/\bLive\b/), "it is a draft, not live");
  await s.shot("editor");

  s.step("5. Inside the editor: add a step from words");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Add steps from a description" }).click();
  await dialog().waitFor();
  await page.locator("#ws-describe-text").fill("Log \"added from words\"");
  await page.locator('[data-action="describe-read"]').click();
  await line(1).waitFor({ timeout: 30_000 });
  s.check((await line(1).getAttribute("data-line-status")) === "ok", "the line is understood");
  s.check(await page.locator('[data-testid="describe-canvas"] [data-node-type="trigger.manual"]').count() === 0, "no extra start is invented when adding to a canvas");
  await page.locator('[data-action="describe-accept"]').click();
  await settle(600);
  s.check(await page.locator(".ws-node").count() === 7, "the canvas now has 7 steps");
  s.check((await editor.getAttribute("data-dirty")) === "true", "the change waits to be saved");
  await page.locator('[data-action="save"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="flow-editor"]')?.getAttribute("data-dirty") === "false", null, { timeout: 20_000 });
  s.ok("saved");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");

  await deleteFlowFromEditor(s, flowId); flowId = undefined;
  s.ok("the throw-away flow is deleted");
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  try { await sweep(s, `${prefix}-describe-`); } catch { /* best effort */ }
  await s.finish();
}
