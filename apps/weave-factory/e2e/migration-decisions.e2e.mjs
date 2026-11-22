#!/usr/bin/env node
// Factory: "Open decisions" (the steps where the agent needs a person's choice), editing a generated
// document, and the import of a Boomi project into the saved account.
//
//   node e2e/migration-decisions.e2e.mjs [baseUrl] --id <migrationId> [--shots <dir>] [--width 390 --height 844]
//
// Read-only: the migration is read from the real tool (any migration with documents), but the
// decisions, the document source and edits, the target accounts and the import go to stand-in
// answers laid over those calls, so nothing is stored, rebuilt or imported. The last step checks
// the same screens at phone width (390 px) as well.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs(["--id"]);
const i = opts.rest.indexOf("--id");
const id = i >= 0 ? opts.rest[i + 1] : "";
const s = new Session(opts);
const page = await s.start();

const DECISIONS = [
  { id: "d1", flow: "ProcessOrder", where: "step 4: Send the order to SAP with a very long step name that has to wrap on a phone", source: "flows/process-order/flow.xml:42", kind: "connector", construct: "sap:execute-rfc",
    summary: "Sends the order to SAP.", why: "No SAP connector is known for this target.", answerTypes: ["connector", "manual"],
    options: [{ connector: "sap", operation: "rfc-call", label: "SAP · call an RFC" }, { connector: "http", operation: "post", label: "HTTP · POST" }], answer: null },
  { id: "d2", flow: "ProcessOrder", where: "step 6: Price", source: "src/main/java/com/acme/Price.java:77", kind: "java", construct: "com.acme.Price#compute", summary: "Works out the price.", why: "Java code is not translated by the agent.",
    answerTypes: ["code", "expression", "drop"], answer: null },
  { id: "d3", flow: "Nightly", where: "step 1", source: "flows/nightly.xml:3", kind: "dynamic-call", summary: "Calls a service chosen while running.", why: "The service name is only known while running.", answerTypes: ["call"],
    answer: { type: "call", services: ["billing", "ledger"] }, answeredBy: "e2e", answeredAt: new Date().toISOString(), scope: "workspace" },
];
const SOURCE = "# Mapping\n\n| Target | Source |\n| --- | --- |\n| orderId | $.id |\n";

try {
  if (!id) s.fail("no migration id was given, so nothing was checked");
  else {
    const view = { decisions: DECISIONS.map((d) => ({ ...d })), target: "", importResult: null, autoImport: false, edits: [] };
    const openCount = () => view.decisions.filter((d) => !d.answer).length;
    await s.context.route(`**/api/factory/migrations/${id}`, async (r) => {
      if (r.request().method() !== "GET") return r.continue();
      const res = await r.fetch();
      const m = await res.json();
      return r.fulfill({ response: res, json: { ...m, apiName: m.apiName || "stand-in-api", busy: false, queued: 0, checkOnly: false,
        decisionsCounts: { open: openCount(), answered: view.decisions.length - openCount() }, docEdits: view.edits.map((e) => e.doc),
        ...(view.target ? { targetTech: view.target, serviceDir: m.serviceDir || "services/stand-in-api", importResult: view.importResult, autoImport: view.autoImport } : {}) } });
    });
    const posts = [];
    await s.context.route(`**/api/factory/migrations/${id}/decisions`, (r) => {
      if (r.request().method() === "GET") return r.fulfill({ json: { api: "stand-in-api", decisions: view.decisions, counts: { open: openCount(), answered: view.decisions.length - openCount() } } });
      const body = r.request().postDataJSON();
      posts.push(body);
      if (posts.length === 1) return r.fulfill({ status: 422, json: { errors: [{ id: "d2", problem: "The expression does not work: unitPrice is not a field of the order." }] } });
      for (const a of body.answers) { const d = view.decisions.find((x) => x.id === a.id); if (d) Object.assign(d, { answer: a.answer, scope: a.scope, answeredBy: "e2e", answeredAt: new Date().toISOString() }); }
      return r.fulfill({ status: 202, json: { ok: true, applied: body.answers.length, rerun: true } });
    });
    await s.context.route(`**/api/factory/migrations/${id}/docs`, (r) => r.fulfill({ json: { docs: [{ name: "MAPPING.md" }, { name: "analysis.json" }] } }));
    await s.context.route(`**/api/factory/migrations/${id}/documents/edits`, (r) => r.fulfill({ json: { edits: view.edits, names: view.edits.map((e) => e.doc) } }));
    const docCalls = [];
    let source = SOURCE;
    await s.context.route(`**/api/factory/migrations/${id}/documents/MAPPING.md/source`, (r) => {
      const method = r.request().method();
      docCalls.push({ method, body: method === "PUT" ? r.request().postDataJSON() : undefined });
      if (method === "GET") return r.fulfill({ status: 200, body: source, headers: { "content-type": "text/plain; charset=utf-8" } });
      if (method === "PUT") { source = r.request().postDataJSON().text; view.edits = [{ doc: "MAPPING.md", by: "e2e", at: new Date().toISOString(), note: "orderId", size: source.length }]; return r.fulfill({ status: 202, json: { ok: true, doc: "MAPPING.md", rerun: true } }); }
      source = SOURCE; view.edits = [];
      return r.fulfill({ json: { ok: true } });
    });
    s.allow(/422 \(Unprocessable Entity\)/);

    s.step("1. The migration page says how many decisions are open");
    await s.goto(`/migrations/${id}`);
    const badge = page.locator('[data-testid="decisions-badge"]');
    await badge.waitFor();
    s.check(/2 open decisions/.test(await badge.innerText()), "the header shows 2 open decisions", await badge.innerText());
    s.check((await page.locator('[data-testid="decisions-next"]').count()) === 1, "the next steps offer to answer them");
    await s.shot("badge");
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
    await badge.click();
    const panel = page.locator('[data-testid="decisions"]');
    await panel.waitFor();
    s.check(/tab=documents/.test(page.url()), "the badge opens the Documents tab");

    s.step("2. Each open decision says where, what and why");
    s.check(/needs a person's choice/.test(await panel.innerText()), "the panel explains why it is there");
    const cards = panel.locator('[data-testid="decision"]');
    await cards.nth(1).waitFor();
    s.check((await cards.count()) === 2, "the two open decisions are shown", String(await cards.count()));
    const first = await cards.nth(0).innerText();
    s.check(/ProcessOrder/.test(first) && /flow\.xml:42/.test(first) && /Sends the order to SAP/.test(first) && /No SAP connector/.test(first), "where, what it does and why the agent stopped are shown");
    await s.shot("open");
    s.check((await s.overflow()) === 0, "long step names wrap instead of running off the page");

    s.step("3. Refused answers are shown on their card, nothing is saved");
    await cards.nth(0).locator('[data-testid="decision-connector"]').selectOption({ label: "SAP · call an RFC" });
    await cards.nth(1).getByRole("radio", { name: "Write an expression" }).click();
    await cards.nth(1).locator('[data-testid="decision-expression"]').fill("qty * unitPrice");
    await cards.nth(1).locator('[data-testid="decision-scope-workspace"]').check();
    await panel.locator('[data-testid="decisions-save"]').click();
    await panel.locator('[data-testid="decision-error"]').waitFor();
    s.check(posts.length === 1 && posts[0].answers.length === 2, "both changed answers go in one request");
    s.check(posts[0].answers[0].answer.type === "connector" && posts[0].answers[0].answer.connector === "sap" && posts[0].answers[1].scope === "workspace", "the answers carry the choice and the scope");
    s.check(/unitPrice is not a field/.test(await cards.nth(1).locator('[data-testid="decision-error"]').innerText()), "the refusal is shown next to its card");
    s.check(/Nothing was saved/.test(await panel.locator('[data-testid="decisions-error"]').innerText()), "it says nothing was saved");
    await s.shot("refused");
    s.check((await s.overflow()) === 0, "the refusal fits the page");

    s.step("4. Accepted answers: the migration is rebuilt");
    await cards.nth(1).locator('[data-testid="decision-expression"]').fill("qty * price");
    await panel.locator('[data-testid="decisions-save"]').click();
    await panel.locator('[data-testid="decisions-done"]').waitFor();
    s.check(posts.length === 2, "the corrected answers are sent again");
    s.check(/being rebuilt/.test(await panel.locator('[data-testid="decisions-done"]').innerText()), "it says the migration is being rebuilt");
    await panel.getByRole("radio", { name: /Answered/ }).click();
    await page.waitForTimeout(400);
    const answered = await panel.locator('[data-testid="decision-answered"]').allInnerTexts();
    s.check(answered.length === 3 && answered.every((t) => /Answered by e2e/.test(t)), "the answered decisions are collapsed with who answered", answered.join(" | "));
    await s.shot("answered");

    s.step("5. Edit a document and go back to the generated version");
    const item = page.locator('[data-testid="doc-item"][data-doc="MAPPING.md"]');
    s.check((await page.locator('[data-testid="doc-item"][data-doc="analysis.json"] [data-testid="doc-edit"]').count()) === 0, "only Markdown documents can be edited");
    await item.locator('[data-testid="doc-edit"]').click();
    const editor = page.locator('[data-testid="doc-editor"]');
    const box = editor.locator('[data-testid="doc-editor-text"]');
    await page.waitForFunction(() => (document.querySelector('[data-testid="doc-editor-text"]')?.value || "").includes("orderId"));
    s.check(/kept when the migration is rebuilt/.test(await editor.innerText()) && /mapping table/.test(await editor.innerText()), "the editor explains what happens to the change");
    await s.shot("editor");
    s.check((await s.overflow()) === 0, "the editor fits the page");
    await box.fill(SOURCE.replace("$.id", "$.orderNumber"));
    await editor.locator('[data-testid="doc-editor-note"]').fill("orderId comes from orderNumber");
    await editor.locator('[data-testid="doc-editor-save"]').click();
    await editor.locator('[data-testid="doc-editor-done"]').waitFor();
    const put = docCalls.find((c) => c.method === "PUT");
    s.check(!!put && /orderNumber/.test(put.body.text) && put.body.note === "orderId comes from orderNumber", "the new text and the note are sent");
    await item.locator('[data-testid="doc-edited"]').waitFor();
    s.check(/Edited by e2e/.test(await item.locator('[data-testid="doc-edited"]').innerText()), "the document is marked as edited by the person");
    await editor.locator('[data-testid="doc-editor-revert"]').waitFor();
    await editor.locator('[data-testid="doc-editor-revert"]').click();
    await page.getByRole("dialog").getByRole("button", { name: "Revert" }).click();
    await editor.locator('[data-testid="doc-editor-done"]').filter({ hasText: "generated version" }).waitFor();
    s.check(docCalls.some((c) => c.method === "DELETE"), "going back asks the tool to drop the person's version");

    s.step("6. A Boomi project is imported into the saved account");
    view.target = "boomi"; view.targetTech = "boomi";
    view.importResult = { target: "boomi", status: "partial", created: 139, total: 140, folder: "FLT_webMethods_Regression", folderId: "Rjo3", at: new Date().toISOString(),
      failures: [{ component: "Send order to SAP", file: "processes/send-order-to-sap-with-a-long-name.xml", reason: "Connection 'SAP_PROD_CONNECTION_WITH_A_VERY_LONG_NAME' does not exist in the account and could not be referenced." }] };
    await s.context.route("**/api/factory/target-accounts", (r) => r.fulfill({ json: { accounts: [{ target: "boomi", configured: true, hasToken: true, accountId: "****CD12", user: "o***@acme.com" }, { target: "workato", configured: false }] } }));
    const imports = [], options = [];
    await s.context.route(`**/api/factory/migrations/${id}/import`, (r) => { imports.push(1); return r.fulfill({ status: 202, json: { ok: true } }); });
    await s.context.route(`**/api/factory/migrations/${id}/options`, (r) => { options.push(r.request().postDataJSON()); view.autoImport = !!options[options.length - 1].autoImport; return r.fulfill({ json: { ok: true } }); });
    await s.goto(`/migrations/${id}`);
    const imp = page.locator('[data-testid="delivery-import"]');
    await imp.waitFor();
    const impText = await imp.innerText(); s.check(/Import into Boomi/i.test(impText), "the section names the platform");
    s.check(/Imported 139 of 140 components into Boomi folder FLT_webMethods_Regression/.test(await imp.locator('[data-testid="delivery-import-status"]').innerText()), "the last import is said in words");
    s.check(/does not exist in the account/.test(await imp.locator('[data-testid="delivery-import-failures"]').innerText()), "each failure shows the platform's reason");
    s.check(/Nothing is deployed or switched on/.test(await imp.locator('[data-testid="delivery-import-note"]').innerText()), "it says nothing is deployed or switched on");
    await imp.locator('[data-testid="delivery-import-now"]').click();
    await imp.locator('[data-testid="delivery-import-started"]').waitFor();
    s.check(imports.length === 1, "Import now starts the import");
    await imp.locator('[data-testid="delivery-import-auto"]').check();
    await page.waitForTimeout(500);
    s.check(options.length === 1 && options[0].autoImport === true, "automatic import is switched on");
    await s.shot("import");
    s.check((await s.overflow()) === 0, "long failure reasons wrap instead of running off the page");

    s.step("7. The same screens at phone width (390 px)");
    if (opts.width > 400) await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    s.check((await s.overflow()) === 0, "the import section fits a phone");
    view.decisions = DECISIONS.map((d) => ({ ...d }));
    await s.goto(`/migrations/${id}?tab=documents`);
    await panel.waitFor();
    s.check((await s.overflow()) === 0, "the open decisions fit a phone");
    await s.shot("phone-decisions");
    await page.locator('[data-testid="doc-item"][data-doc="MAPPING.md"] [data-testid="doc-edit"]').click();
    await editor.waitFor();
    s.check((await s.overflow()) === 0, "the document editor fits a phone");
    await s.shot("phone-editor");
  }
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
