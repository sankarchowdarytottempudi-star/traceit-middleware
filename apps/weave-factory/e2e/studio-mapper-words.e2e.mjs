// The mapping dialog: a rule in plain words that puts text in front of a value ("New web", not "New"), a sample
// with a typing slip (pointed at, offered a repair, never shown as a confident result), a field that is not in the
// sample, the shape of the output (a list of objects from a list in the input) and the "What you can write" list.
// Creates one throw-away flow and deletes it.
import { parseArgs, Session, stamp, createFlow, addStep, saveFlow, selectNode, deleteFlowFromEditor, sweep } from "./studio-lib.mjs";

const opts = parseArgs();
const prefix = "e2e";
const s = new Session(opts);
const page = await s.start();
const SAMPLE = { data: { email: "jane@example.invalid", channel: "web", items: [{ sku: "X1", price: 10 }, { sku: "Y2", price: 25 }] } };
let flowId;
const settle = (ms = 900) => page.waitForTimeout(ms);
try {
  // the flow is set up at desktop size (the palette sits elsewhere on a phone); the dialog is then checked at the asked width
  const asked = page.viewportSize();
  const phone = asked && asked.width < 700;
  if (phone) await page.setViewportSize({ width: 1440, height: 900 });
  s.step("1. A flow with a mapping and a sample");
  flowId = await createFlow(s, `${prefix}-mapwords-${stamp()}`);
  await addStep(page, "transform.map");
  await saveFlow(s);
  const api = s.context.request, url = `${s.opts.base}/api/studio/flows/${flowId}`;
  const flow = ((b) => b.flow ?? b)(await (await api.get(url)).json());
  const node = flow.nodes.find((n) => n.type === "transform.map");
  node.config = { ...node.config, mapping: { ...(node.config?.mapping ?? {}), sampleSource: SAMPLE, rules: [] } };
  s.check((await api.put(url, { data: flow })).ok(), "the sample was stored with the flow");
  await s.goto(`/studio/flows/${flowId}`);
  await page.locator('[data-testid="flow-editor"]').waitFor();
  const panel = await selectNode(page, "transform.map");
  await panel.locator('[data-action="open-mapper"]').click();
  const mapper = page.locator('[data-testid="mapper"]');
  await mapper.waitFor();
  if (phone) { await page.setViewportSize(asked); await settle(400); }
  const rule = (i) => mapper.locator(`[data-rule-index="${i}"]`);
  const out = mapper.locator('[data-testid="mapping-output"]');
  const tab = async (name) => { const t = page.getByRole("tab", { name }); if (await t.count()) await t.first().click(); };
  const rawOut = async () => { const b = out.getByRole("button", { name: "Raw" }); if (await b.count()) await b.first().click().catch(() => {}); await settle(300); return (await out.innerText()).replace(/\s+/g, ""); };

  s.step('2. "add "New" before data.channel value" gives "New web"');
  await tab("Rules");
  await mapper.locator('[data-add-rule="instruction"]').click();
  await rule(0).getByLabel("Output field", { exact: true }).fill("channel");
  await rule(0).getByLabel("Rule in your words", { exact: true }).fill('add "New" before data.channel value');
  await rule(0).getByLabel("Output field", { exact: true }).focus();
  if (!(await rule(0).locator("[data-understood]").first().isVisible().catch(() => false))) await rule(0).locator('[data-action="understand"]').click({ timeout: 5000 }).catch(() => {});
  await rule(0).locator('[data-understood="yes"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('[data-rule-index="0"] [data-rule-value]')?.textContent?.includes("New web"), null, { timeout: 20_000 }).catch(() => {});
  s.check((await rule(0).locator("[data-rule-value]").innerText()).includes('"New web"'), 'the rule gives "New web"', await rule(0).locator("[data-rule-value]").innerText().catch(() => ""));
  s.check((await rule(0).innerText()).includes("confident"), "with a sample that has the field, it is confident");
  await s.shot("new-web");

  s.step("3. A typing slip in the sample is pointed at, the result says which sample it uses, and a repair is offered");
  await tab("Input");
  await mapper.getByRole("button", { name: /Edit sample/ }).click();
  const box = mapper.getByLabel("Sample input", { exact: true });
  await box.fill('{\n"data":{\n"email":"jane@example.invalid"\n"channel":"web",\n"items":[{"sku":"X1","price":10},{"sku":"Y2","price":25}]\n}\n}');
  await mapper.locator("[data-json-error]").waitFor({ timeout: 5000 });
  const errText = await mapper.locator("[data-json-error]").innerText();
  s.check(/Not valid JSON yet \(line \d+, column \d+\)/.test(errText), "the slip is pointed at by line and column", errText.slice(0, 120));
  await tab("Output");
  s.check(await mapper.locator('[data-testid="preview-on-last-sample"]').isVisible(), "the result says it uses the last valid sample");
  await tab("Input");
  await mapper.locator('[data-action="fix-json"]').click();
  const fixed = await mapper.locator("[data-json-fix-preview]").innerText();
  s.check(fixed.includes('"email":"jane@example.invalid",'), "the repair adds the missing comma, shown before it is used", fixed.slice(0, 120));
  await mapper.locator('[data-action="use-fixed-json"]').click();
  await settle();
  s.check((await mapper.locator("[data-json-error]").count()) === 0, "after the repair the sample is valid");

  s.step("4. A field that is not in the sample is never shown as a confident result");
  await tab("Rules");
  await mapper.locator('[data-add-rule="instruction"]').click();
  await rule(1).getByLabel("Output field", { exact: true }).fill("tagline");
  await rule(1).getByLabel("Rule in your words", { exact: true }).fill('add "Hello" before data.nickname');
  await rule(1).getByLabel("Output field", { exact: true }).focus();
  if (!(await rule(1).locator("[data-understood]").first().isVisible().catch(() => false))) await rule(1).locator('[data-action="understand"]').click({ timeout: 5000 }).catch(() => {});
  await rule(1).locator('[data-understood="yes"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => /not in the sample/.test(document.querySelector('[data-rule-index="1"]')?.textContent ?? ""), null, { timeout: 20_000 }).catch(() => {});
  const r1 = await rule(1).innerText();
  s.check(/check: data\.nickname is not in the sample/.test(r1) && !/\bconfident\b/.test(r1), "the rule says data.nickname is not in the sample instead of confident", r1.replace(/\s+/g, " ").slice(0, 200));
  await rule(1).getByLabel("Delete rule").click();

  s.step("5. The output can be a list of objects, one per item of a list in the input");
  await mapper.locator("[data-shape-kind]").selectOption("each");
  await mapper.locator("[data-shape-each]").fill("data.items");
  await mapper.locator('[data-add-rule="direct"]').click();
  const last = rule(1);
  await last.getByLabel("Output field", { exact: true }).fill("code");
  await last.getByLabel("Input field", { exact: true }).fill("item.sku");
  await rule(0).getByLabel("Delete rule").click();
  await tab("Output");
  await page.waitForFunction(() => /"code":\s*"Y2"/.test(document.querySelector('[data-testid="mapping-output"]')?.textContent ?? ""), null, { timeout: 20_000 }).catch(() => {});
  const shown = await rawOut();
  s.check(shown.includes('[{"code":"X1"},{"code":"Y2"}]'), "the output is a list with one object per item", shown.slice(0, 160));
  await tab("Rules");
  await mapper.locator("[data-shape-wrap]").fill("result");
  await tab("Output");
  await page.waitForFunction(() => /"result"/.test(document.querySelector('[data-testid="mapping-output"]')?.textContent ?? ""), null, { timeout: 20_000 }).catch(() => {});
  s.check((await rawOut()).includes('"result":[{"code":"X1"}'), "Wrap in puts the list under the key", (await rawOut()).slice(0, 120));
  await s.shot("shape-each");

  s.step('6. "What you can write" lists the phrases with an example and the expression');
  await tab("Rules");
  await mapper.locator('[data-action="phrase-help"]').click();
  const help = mapper.locator('[data-testid="phrase-help"]');
  await help.waitFor();
  const groups = await help.locator("[data-phrase-group]").count();
  s.check(groups >= 8, "the phrases are grouped (text, conditions, lists, dates, numbers, …)", `${groups} groups`);
  await help.locator("[data-phrase-filter]").fill("sort");
  const found = await help.locator("[data-phrase]").count();
  s.check(found >= 1 && (await help.innerText()).includes("$sort("), "finding 'sort' shows the sort phrases with their expression", `${found} found`);
  const before = await mapper.locator("[data-rule-index]").count();
  await help.locator('[data-action="use-phrase"]').first().click();
  s.check((await mapper.locator("[data-rule-index]").count()) === before + 1, "Use adds the phrase as a new rule");
  s.check((await s.overflow()) === 0, "the page does not scroll sideways");
  await s.shot("phrase-help");
  await page.locator('[data-action="close-mapper"]').click();
  if (phone) await page.setViewportSize({ width: 1440, height: 900 });
  await saveFlow(s);

  s.step("7. The shape is saved with the flow");
  const saved = ((b) => b.flow ?? b)(await (await api.get(url)).json());
  const m = saved.nodes.find((n) => n.type === "transform.map").config.mapping;
  s.check(m.shape?.kind === "each" && m.shape?.each === "data.items" && m.shape?.wrap === "result", "the flow holds the shape", JSON.stringify(m.shape ?? null));
} catch (e) {
  s.fail(`stopped: ${e.message}`);
} finally {
  if (flowId) { try { await deleteFlowFromEditor(s, flowId); s.ok("the throw-away flow was deleted"); } catch { await sweep(s, `${prefix}-mapwords-`); } }
  await s.finish();
}
