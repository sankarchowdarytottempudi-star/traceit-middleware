// A rule in plain words about the values of a list ("add _ if name came as two words" where name is a list of
// names) must be decided item by item, and a rule stored with an older, failing reading must repair itself when
// the mapping is opened. Creates one throw-away flow and deletes it.
import { parseArgs, Session, stamp, createFlow, addStep, saveFlow, selectNode, deleteFlowFromEditor, sweep } from "./studio-lib.mjs";

const opts = parseArgs();
const prefix = "e2e";
const s = new Session(opts);
const page = await s.start();
const SAMPLE = { kind: "currencies", items: [{ code: "CAD", name: "Canadian Dollar" }, { code: "USD", name: "USD Dollar" }, { code: "SAR", name: "Riyal" }, { code: "AED", name: "United Arab Emirates Dirham" }] };
const WORDS = "add the _ in between if name came as two words (items.name)";
// what the interpreter stored before it read list rules item by item: it fails on a list
const OLD = { expr: '$count($split($trim(items.name), /\\s+/)) = 2 ? $map(items.name, function($v) { $join($split($trim($v), /\\s+/), "_") }) : items.name', explanation: "If items.name has exactly two words, for each item: join its words with _, otherwise keep it as is", confidence: "exact", engine: "rules" };
let flowId;
try {
  s.step("1. A flow whose mapping holds the rule with its old, failing reading");
  flowId = await createFlow(s, `${prefix}-listrule-${stamp()}`);
  await addStep(page, "transform.map");
  await saveFlow(s);
  const api = s.context.request, url = `${s.opts.base}/api/studio/flows/${flowId}`;
  const got = await (await api.get(url)).json();
  const flow = got.flow ?? got;
  const node = flow.nodes.find((n) => n.type === "transform.map");
  node.config = { ...node.config, mapping: { ...(node.config?.mapping ?? {}), sampleSource: SAMPLE, rules: [{ id: "r_old", target: "names", kind: "instruction", instruction: WORDS, compiled: OLD }] } };
  const put = await api.put(url, { data: flow });
  s.check(put.ok(), "the flow was stored with the old reading", `HTTP ${put.status()}`);

  s.step("2. Opening the mapping repairs the reading");
  await s.goto(`/studio/flows/${flowId}`);
  await page.locator('[data-testid="flow-editor"]').waitFor();
  const panel = await selectNode(page, "transform.map");
  await panel.locator('[data-action="open-mapper"]').click();
  const mapper = page.locator('[data-testid="mapper"]');
  await mapper.waitFor();
  const rule = (i) => mapper.locator(`[data-rule-index="${i}"]`);
  const out = mapper.locator('[data-testid="mapping-output"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="mapping-output"]')?.textContent?.includes("Canadian_Dollar"), null, { timeout: 20_000 }).catch(() => {});
  const preview = (await out.innerText()).replace(/\s+/g, " ");
  s.check(preview.includes("Canadian_Dollar") && preview.includes("USD_Dollar") && preview.includes("Riyal") && preview.includes("United Arab Emirates Dirham"), "names of two words get the _, the others stay as they are", preview.slice(0, 220));
  await page.waitForFunction(() => /For each item of items\.name/.test(document.querySelector('[data-rule-index="0"] .ws-understood-head')?.textContent ?? ""), null, { timeout: 20_000 }).catch(() => {});
  const said = (await rule(0).locator(".ws-understood-head").innerText()).replace(/\s+/g, " ");
  s.check(/For each item of items\.name: if it has exactly two words/.test(said), "the rule now reads as a decision for each item", said);
  s.check((await rule(0).locator('[data-rule-msg="error"]').count()) === 0, 'no "Expression failed" on the rule');
  s.check((await mapper.innerText()).includes("Expression failed") === false, "nothing in the mapping reports a failed expression");
  await s.shot("list-rule-repaired");

  s.step("3. A new rule about each value of a list, typed in");
  await mapper.locator('[data-add-rule="instruction"]').click();
  await rule(1).getByLabel("Output field", { exact: true }).fill("codes");
  await rule(1).getByLabel("Rule in your words", { exact: true }).fill("if items.code is CAD use Canada otherwise keep it");
  await rule(1).getByLabel("Output field", { exact: true }).focus();
  if (!(await rule(1).locator("[data-understood]").first().isVisible().catch(() => false))) await rule(1).locator('[data-action="understand"]').click({ timeout: 5000 }).catch(() => {});
  await rule(1).locator('[data-understood="yes"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="mapping-output"]')?.textContent?.includes("Canada"), null, { timeout: 20_000 }).catch(() => {});
  const preview2 = (await out.innerText()).replace(/\s+/g, " ");
  s.check(preview2.includes('"Canada"') && preview2.includes('"USD"') && preview2.includes("Canadian_Dollar"), "each code is decided on its own, next to the first rule's result", preview2.slice(0, 260));
  s.check((await s.overflow()) === 0, "the page does not scroll sideways");
  await s.shot("list-rule-typed");
  await page.locator('[data-action="close-mapper"]').click();
  await saveFlow(s);

  s.step("4. The repaired reading is what was saved");
  const savedBody = await (await api.get(url)).json();
  const saved = savedBody.flow ?? savedBody;
  const kept = saved.nodes.find((n) => n.type === "transform.map").config.mapping.rules.find((r) => r.id === "r_old");
  s.check(String(kept?.compiled?.expr ?? "").startsWith("$map(items.name"), "the flow holds the new reading, not the failing one", String(kept?.compiled?.expr ?? "").slice(0, 80));
} catch (e) {
  s.fail(`stopped: ${e.message}`);
} finally {
  if (flowId) { try { await deleteFlowFromEditor(s, flowId); s.ok("the throw-away flow was deleted"); } catch { await sweep(s, `${prefix}-listrule-`); } }
  await s.finish();
}
