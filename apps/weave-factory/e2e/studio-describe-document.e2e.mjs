// "Describe the flow" with a whole requirement document: the newsletter document (sanitized copy, made-up
// e-mail and digits) is pasted, read in document mode, and the preview shows what was taken from it (with
// sections, lines and steps), the decisions needed, the conflicts, what needs a hand-written step and
// what is not used. The Zoho connection is offered pre-filled for the refresh-token sign-in (no secrets);
// the form warns about a pasted label and about two data centres. Accept creates the draft and the editor
// shows its steps. Creates one throw-away flow and deletes it; creates no connection; calls no Zoho.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs, Session, stamp, deleteFlowFromEditor, sweep, field } from "./studio-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DOC = readFileSync(join(here, "../../weave-factory-bff/test/fixtures/newsletter-requirement.txt"), "utf8");
const opts = parseArgs();
const prefix = "e2e";
const s = new Session(opts);
const page = await s.start();
const settle = (ms = 400) => page.waitForTimeout(ms);
const name = `${prefix}-describe-doc-${stamp()}`;
let flowId;
try {
  s.step("1. Paste the whole requirement document");
  await s.goto("/studio");
  await page.locator('[data-action="describe-flow"]').first().click();
  await page.locator('[data-testid="describe-dialog"]').waitFor();
  await page.locator("#ws-describe-text").fill(DOC);
  await page.locator('[data-action="describe-read"]').click();
  const sum = page.locator('[data-testid="describe-doc-summary"]');
  await sum.waitFor({ timeout: 30_000 });
  s.check(true, "read as a requirement document (not refused for its 501 lines)");
  s.check((await sum.getAttribute("data-steps")) === "17", "17 steps were made", await sum.getAttribute("data-steps"));
  s.check((await sum.getAttribute("data-blocking")) === "0", "nothing blocks the draft");
  s.check(Number(await sum.getAttribute("data-decisions")) >= 15, "the decisions are listed", await sum.getAttribute("data-decisions"));
  s.check(Number(await sum.getAttribute("data-conflicts")) >= 2, "the conflicts in the document are shown", await sum.getAttribute("data-conflicts"));
  await page.locator("#ws-describe-name").fill(name);

  s.step("2. What was taken from the document, each with section, line and steps");
  const items = page.locator('[data-testid="doc-items"] > li');
  s.check(await items.count() >= 40, "the items taken are listed", String(await items.count()));
  const ep = page.locator('[data-testid="doc-items"] > li[data-doc-item="endpoint"]').first();
  s.check((await ep.innerText()).includes("POST /newsletter/v1/subscribe") && (await ep.innerText()).includes("4.1 Endpoint · line 38"), "the endpoint comes with its section and line");
  const hdr = page.locator('[data-testid="doc-items"] > li[data-doc-item="header"]', { hasText: "X-Channel" }).first();
  await hdr.hover(); await settle(200);
  s.check(await page.locator('[data-testid="describe-canvas"] .ws-dsc-node-on').count() === 2, "pointing at the X-Channel header lights up the two steps it made");
  const upsert = page.locator('[data-testid="doc-items"] > li[data-doc-item="target"]').first();
  s.check((await upsert.innerText()).includes("/crm/v8/Leads/upsert"), "the Zoho upsert is listed");
  s.step("2b. Decisions, conflicts, hand-written steps, scenarios, not used");
  const dec = page.locator('[data-testid="doc-decisions"]');
  s.check((await dec.locator('[data-decision="Q10"]').innerText()).includes("Built as:"), "Q10 shows the choice that was built");
  s.check(await dec.locator('[data-decision="QUEUE"]').count() === 1, "the missing error queue is a decision, not a silent drop");
  const t7 = page.locator('[data-testid="doc-conflicts"] > li', { hasText: "Test 7" });
  s.check((await t7.count()) === 1 && (await t7.innerText()).includes("Choice made"), "the test-7 conflict is shown with the choice made");
  s.check(await page.locator('[data-testid="doc-conflicts"] > li', { hasText: "10 digits" }).count() === 1, "the 10-digit sample conflict is shown");
  s.check(await page.locator('[data-testid="doc-handwritten"] > li').count() >= 2, "rules that need a hand-written step are listed");
  await page.getByRole("button", { name: /Test scenarios from the document/ }).click();
  s.check(await page.locator('[data-testid="doc-scenarios"] > li[data-derived="yes"]').count() === 17, "17 test scenarios, all turned into requests");
  await page.getByRole("button", { name: /Not used for steps/ }).click();
  s.check((await page.locator('[data-testid="doc-notused"]').innerText()).includes("1 Background"), "background prose is listed as not used, not as an error");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  await s.shot("document-preview");

  s.step("3. The Zoho connection is offered pre-filled for the refresh-token sign-in (new, or an existing one that does not fit)");
  const miss = page.locator('[data-testid="describe-missing"] li[data-missing]').first();
  const existing = (await miss.count()) === 1 && (await miss.getAttribute("data-missing-existing")) === "yes";
  if (existing) {
    s.check(/signs in with|data centre/.test(await miss.innerText()), `the existing connection "${await miss.getAttribute("data-missing")}" is shown as not fitting the document, with the reason`);
    await miss.locator('[data-action="describe-edit-connection"]').click();
  } else {
    s.check((await miss.getAttribute("data-missing")) === "Zoho CRM", "the missing Zoho CRM connection is listed");
    await miss.locator('[data-action="describe-new-connection"]').click();
  }
  const form = page.locator('[data-testid="connection-form"]');
  await form.waitFor();
  if (!existing) s.check((await page.locator("#ws-conn-name").inputValue()) === "Zoho CRM", "named Zoho CRM");
  s.check((await field(form, "authType").locator("select").inputValue()) === "oauth2refresh", "sign-in: OAuth2 refresh token");
  const baseNow = await field(form, "baseUrl").locator("input").inputValue();
  const tokenNow = await field(form, "tokenUrl").locator("input").inputValue();
  const centre = /zohoapis\.([a-z.]+)$/.exec(baseNow)?.[1];
  if (existing) s.check(!!centre && tokenNow === `https://accounts.zoho.${centre}/oauth/v2/token`, `the existing connection keeps its data centre (.${centre}) with the matching token address`, `${baseNow} / ${tokenNow}`);
  else {
    s.check(baseNow === "https://www.zohoapis.in", "base URL from the document");
    s.check(tokenNow === "https://accounts.zoho.in/oauth/v2/token", "token address from the document");
  }
  s.check((await field(form, "clientAuth").locator("select").inputValue()) === "body", "client credentials in the form body");
  s.check((await field(form, "tokenPrefix").locator("input").inputValue()) === "Zoho-oauthtoken", "token prefix Zoho-oauthtoken");
  s.check((await field(form, "refreshToken").locator("input").first().inputValue()) === "" && (await field(form, "clientSecret").locator("input").first().inputValue()) === "", "no secret is filled in");
  await field(form, "clientSecret").locator("input").first().fill("Client Secret: 1000.not-a-real-value");
  await settle(200);
  const warnText = await form.innerText();
  s.check(warnText.includes("Paste only the value") && warnText.includes("Client secret"), "a pasted label is pointed out, by field");
  s.check(!warnText.includes("not-a-real-value"), "the value itself is never shown");
  await field(form, "tokenUrl").locator("input").fill(centre === "sa" ? "https://accounts.zoho.in/oauth/v2/token" : "https://accounts.zoho.sa/oauth/v2/token");
  await settle(200);
  s.check((await form.innerText()).includes("Two different Zoho data centres"), "a token address and a base URL from different data centres are pointed out");
  await s.shot("zoho-connection");
  await page.getByRole("dialog").last().getByRole("button", { name: "Cancel", exact: true }).click();

  s.step("4. Accept: the draft is created and the editor shows the steps");
  await page.locator('[data-action="describe-accept"]').click();
  await page.waitForURL(/\/studio\/flows\/[^/]+$/, { timeout: 30_000 });
  const editor = page.locator('[data-testid="flow-editor"]');
  await editor.waitFor();
  flowId = await editor.getAttribute("data-flow-id");
  await page.locator(".ws-node").first().waitFor();
  s.check(await page.locator(".ws-node").count() === 17, "the canvas shows the 17 steps", String(await page.locator(".ws-node").count()));
  for (const t of ["trigger.http", "vars.set", "transform.map", "http.request", "log", "respond"]) s.check(await page.locator(`.ws-node[data-node-type="${t}"]`).count() >= 1, `the canvas has a ${t} step`);
  s.check((await editor.getAttribute("data-dirty")) === "false", "saved as a draft");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  await s.shot("editor");
  await deleteFlowFromEditor(s, flowId); flowId = undefined;
  s.ok("the throw-away flow is deleted");
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  try { await sweep(s, `${prefix}-describe-doc-`); } catch { /* best effort */ }
  await s.finish();
}
