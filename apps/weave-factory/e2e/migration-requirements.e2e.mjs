#!/usr/bin/env node
// Factory: "New from requirements". A requirement document is uploaded, read on this server into items that cite
// their sentence and open questions; the review workbook goes down and comes back; the service is generated for the
// chosen target (Workato) and delivered for download, package first.
//
//   node e2e/migration-requirements.e2e.mjs [baseUrl] [--shots <dir>] [--width 390 --height 844]
//
// Nothing is stored: the migration tool's answers are stand-ins laid over the calls (create, read, workbook,
// review, generate, package), like migration-corrections.e2e.mjs. Only the page itself and the options come from
// the server.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs();
const s = new Session(opts);
const page = await s.start();
const ID = "req0e2e00001";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const WORKBOOK = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("stand-in review workbook")]);
const TEMPLATE = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("stand-in template")]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("stand-in requirement document")]);
const HONEST = "built from requirements: 2 operations/triggers, 3 of 7 rules implemented as steps, 4 rules kept as TODO, 1 open question not answered";
const READ_MD = "# Requirements read: order-intake-api\n\nThis is a **draft for review**, not a migration.\n\n## Coverage\n\n| Requirement statements read | Turned into items |\n|---|---|\n| 22 | 21 |\n";
const ROW_ERRORS = [
  { sheet: "Rules", row: 3, problem: "Action \"maybe\" is not one of: (empty), change, delete, add" },
  { sheet: "Operations", row: 4, problem: "unknown ID OP99" },
];

// ---- the stand-in migration, moved on by the calls below
const KEYS = { upload: ["receive", "detect"], document: ["ingest", "parse", "model", "technical", "mapping_doc", "functional", "estimate", "portfolio"],
  mapping: ["spec", "decisions"], scaffold: ["generate", "compile_check"], implement: ["core", "wiring", "unit"], test: ["build", "ready", "parity", "unit_run", "e2e", "coverage"],
  deploy: ["image", "import", "helm", "verify"] };
const TITLES = { upload: "Requirement document", document: "Requirements", mapping: "Review", scaffold: "Generate", implement: "Finish by hand", test: "Check", deploy: "Delivery" };
const st = { stage: "new", oq: 3, reviews: [], generated: null };
function migration() {
  const read = st.stage !== "new", gen = st.stage === "generated";
  const status = (ph) => (ph === "upload" || ph === "document" ? (read ? "done" : "pending") : ph === "mapping" ? (gen ? "done" : read ? "action_required" : "pending")
    : gen && ph !== "implement" ? "done" : gen ? "action_required" : "pending");
  const detail = { "mapping/spec": `review the requirements workbook (${st.oq} open questions)`, "document/parse": "21 of 22 requirement sentences turned into items",
    "test/ready": `${HONEST}; what is left is listed in REQUIREMENTS-TODO.md`, "deploy/image": "ready to download (order_intake_api-workato-package.zip, with README, TODO, tests and settings)" };
  return {
    id: ID, name: "Order intake (e2e)", workspace: "E2E", sourceType: "requirements", technology: "requirements", targetTech: "workato",
    sourceFile: "/data/uploads/ab12cd34-order-intake.docx", apiName: gen ? "order-intake-api" : null, serviceDir: gen ? "services/order-intake-api" : null,
    packageFile: gen ? "order_intake_api-workato-package.zip" : undefined, busy: false, queued: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    phases: Object.entries(KEYS).map(([key, steps]) => ({ key, title: TITLES[key], status: status(key), mode: key === "mapping" || key === "implement" ? "manual" : "auto", percent: 0,
      steps: steps.map((k) => ({ key: k, title: k, status: status(key) === "action_required" && key === "mapping" ? "action_required" : status(key), detail: detail[`${key}/${k}`] || "" })) })),
    progress: { overallPercent: gen ? 90 : read ? 40 : 0, majorPhase: gen ? "Finish by hand" : read ? "Review" : "Requirement document", done: false,
      outcome: gen ? "Ready to download" : read ? "In progress" : "Not started", failure: null },
    requirements: read ? { name: "order-intake-api", document: "order-intake.docx", readAt: new Date().toISOString(), openQuestions: st.oq,
      counts: { operations: 2, triggers: 0, systems: 3, fields: 6, rules: 7, errors: 1, nonFunctional: 3 },
      coverage: { requirementStatements: 22, turnedIntoItems: 21, leftAsOpenQuestions: 1, contextOnly: 0 }, reviews: st.reviews, generated: st.generated } : null,
    log: [{ t: new Date().toISOString(), level: "info", line: read ? "requirements read: 21 of 22 requirement sentences turned into items" : "created" }],
  };
}

const sent = { create: [], run: [], review: [], downloads: 0, templates: 0, packages: 0 };
try {
  const json = (r, status, body) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await s.context.route(/\/api\/factory\/migrations(\?.*)?$/, (r) => {
    if (r.request().method() !== "POST") return r.continue();
    const u = new URL(r.request().url());
    sent.create.push({ sourceType: u.searchParams.get("sourceType"), target: u.searchParams.get("target"), filename: u.searchParams.get("filename"),
      type: r.request().headers()["content-type"], size: (r.request().postDataBuffer() || Buffer.alloc(0)).length });
    return json(r, 201, migration());
  });
  await s.context.route(`**/api/factory/migrations/${ID}`, (r) => json(r, 200, migration()));
  await s.context.route(`**/api/factory/migrations/${ID}/run/*`, (r) => {
    const phase = r.request().url().split("/run/")[1];
    sent.run.push(phase);
    if (phase === "document") st.stage = "read";
    if (phase === "generate") { st.stage = "generated"; st.generated = { at: new Date().toISOString(), target: "workato", service: "order-intake-api", line: HONEST, openQuestions: st.oq }; }
    return json(r, 202, { ok: true, message: "started", ran: phase });
  });
  await s.context.route(`**/api/factory/migrations/${ID}/docs`, (r) => json(r, 200, { docs: st.stage === "new" ? [] : [{ name: "REQUIREMENTS-READ.md" }] }));
  await s.context.route(`**/api/factory/migrations/${ID}/docs/*`, (r) => r.fulfill({ status: 200, contentType: "text/markdown", body: READ_MD,
    headers: { "content-disposition": 'attachment; filename="order-intake-api-REQUIREMENTS-READ.md"' } }));
  await s.context.route(`**/api/factory/migrations/${ID}/feedback`, (r) => json(r, 200, { feedback: [] }));
  await s.context.route(`**/api/factory/migrations/${ID}/open-items`, (r) => json(r, 200, { api: "order-intake-api", exists: true, ready: true, items: [], closed: [], backends: [] }));
  await s.context.route("**/api/factory/changes/apis/**", (r) => json(r, 200, { ok: true, changes: [] }));
  await s.context.route(`**/api/factory/migrations/${ID}/requirements.xlsx`, (r) => { sent.downloads++;
    return r.fulfill({ status: 200, body: WORKBOOK, headers: { "content-type": XLSX, "content-disposition": 'attachment; filename="order-intake-api-requirements-review.xlsx"' } }); });
  const tpl = (r) => { sent.templates++; return r.fulfill({ status: 200, body: TEMPLATE, headers: { "content-type": XLSX, "content-disposition": 'attachment; filename="requirements-template.xlsx"' } }); };
  await s.context.route("**/api/factory/requirements/template.xlsx", tpl);
  await s.context.route(`**/api/factory/migrations/${ID}/requirements-template.xlsx`, tpl);
  await s.context.route(`**/api/factory/migrations/${ID}/requirements`, (r) => {
    const body = r.request().postDataBuffer() || Buffer.alloc(0);
    sent.review.push({ type: r.request().headers()["content-type"], size: body.length });
    if (sent.review.length === 1) return json(r, 400, { ok: false, error: "2 rows of the workbook need fixing. Nothing was changed: fix the rows listed below and upload the workbook again.", errors: ROW_ERRORS });
    st.oq = 1;
    const review = { at: new Date().toISOString(), by: "e2e", changes: 3, openQuestions: 1 };
    st.reviews = [review];
    return json(r, 200, { ok: true, changes: [{ action: "change", id: "RU2", sheet: "Rules", row: 3, fields: ["Values"] }, { action: "answer", id: "Q1", answer: "ZB2B" }, { action: "resolved", id: "Q2" }],
      openQuestions: 1, review, message: "Review kept: 3 changes, 1 open question left." });
  });
  await s.context.route(`**/api/factory/migrations/${ID}/package`, (r) => { sent.packages++;
    return r.fulfill({ status: 200, body: Buffer.from("PK\x03\x04 stand-in package"), headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="order_intake_api-workato-package.zip"' } }); });
  s.allow(/400 \(Bad Request\)/);

  s.step("1. A fourth way to start: from requirements");
  await s.goto("/migrations/new");
  const ways = page.getByRole("navigation", { name: "Where the source comes from" });
  await ways.waitFor();
  s.check((await ways.getByRole("link").count()) === 4, "four ways to start are offered");
  await ways.locator('[data-testid="way-requirements"]').click();
  const form = page.locator('[data-testid="requirements-new"]');
  await form.waitFor();
  s.check(/\/migrations\/from-requirements$/.test(new URL(page.url()).pathname), "it opens its own screen");
  const explain = await form.locator('[data-testid="requirements-explain"]').innerText();
  s.check(/on this server/.test(explain) && /cites the sentence/.test(explain) && /question for you/.test(explain) && /Nothing is invented/.test(explain) && /review/.test(explain),
    "it says plainly what happens (read here, every item cited, questions for you, nothing invented, reviewed first)", explain);
  s.check(((await form.locator('[data-testid="requirements-file"]').getAttribute("accept")) || "") === ".docx,.xlsx,.md,.txt,.pdf", "only requirement documents are offered");
  s.check((await page.getByRole("radio", { name: /Workato/ }).getAttribute("aria-checked")) === "true", "Workato is the target chosen first");
  const [tdl] = await Promise.all([page.waitForEvent("download"), form.locator('[data-testid="requirements-template"]').click()]);
  s.check(tdl.suggestedFilename() === "requirements-template.xlsx" && sent.templates === 1, "the blank template can be downloaded", tdl.suggestedFilename());
  await s.shot("new");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");

  s.step("2. A wrong file is refused before anything is sent");
  await form.locator('[data-testid="requirements-name"]').fill("Order intake (e2e)");
  if (await form.locator('[data-testid="requirements-workspace"]').count()) await form.locator('[data-testid="requirements-workspace"]').fill("E2E");
  await form.locator('[data-testid="requirements-file"]').setInputFiles({ name: "orders.zip", mimeType: "application/zip", buffer: DOCX });
  await form.locator('[data-testid="requirements-create"]').click();
  await form.locator('[data-testid="requirements-file-error"]').waitFor();
  s.check(/\.docx/.test(await form.locator('[data-testid="requirements-file-error"]').innerText()) && sent.create.length === 0, "a .zip is refused with the accepted types named");

  s.step("3. Upload the document: created as a requirements migration and read");
  await form.locator('[data-testid="requirements-file"]').setInputFiles({ name: "order-intake.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: DOCX });
  await form.locator('[data-testid="requirements-create"]').click();
  await page.waitForURL(new RegExp(`/migrations/${ID}`));
  s.check(sent.create.length === 1 && sent.create[0].sourceType === "requirements" && sent.create[0].target === "workato" && sent.create[0].filename === "order-intake.docx"
    && sent.create[0].type === "application/octet-stream" && sent.create[0].size === DOCX.length, "the document is sent as it is, marked as requirements, for Workato", JSON.stringify(sent.create[0]));
  s.check(sent.run[0] === "document", "reading the document starts at once");
  const panel = page.locator('[data-testid="requirements"]');
  await panel.locator('[data-testid="requirements-coverage"]').waitFor();
  s.check(/21 of 22 requirement sentences turned into items/.test(await panel.locator('[data-testid="requirements-coverage"]').innerText()), "it says how many requirement sentences became items");
  s.check(/3 open questions/.test(await panel.locator('[data-testid="requirements-open"]').innerText()), "it says how many questions are open");
  s.check(/REQUIREMENTS-READ\.md/.test((await panel.locator('[data-testid="requirements-read-md"]').getAttribute("href")) || ""), "REQUIREMENTS-READ.md is linked");
  s.check(/3 open questions not answered/.test(await panel.locator('[data-testid="requirements-generate-note"]').innerText()), "the generate button says how many questions are unanswered");
  s.check((await page.locator('[data-testid="delivery"]').count()) === 0, "no delivery before the service is generated");
  const titles = await page.locator(".mf-mg-phase-title").allInnerTexts();
  s.check(titles.includes("Requirements") && titles.includes("Review") && titles.includes("Generate") && titles.includes("Delivery"), "the phases are named for what happens", titles.join(" | "));
  s.check(!/migrated/i.test(await panel.innerText()), "the panel never says migrated");
  await s.shot("read");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");

  s.step("4. Download the review workbook");
  const [dl] = await Promise.all([page.waitForEvent("download"), panel.locator('[data-testid="requirements-download"]').click()]);
  s.check(dl.suggestedFilename() === "order-intake-api-requirements-review.xlsx" && sent.downloads === 1, "the workbook is saved under the service's name", dl.suggestedFilename());

  s.step("5. Rows that need fixing are listed, nothing is changed");
  const upload = panel.locator('[data-testid="requirements-upload"]');
  s.check(await upload.isDisabled(), "the upload waits for a file");
  await panel.locator('[data-testid="requirements-review-file"]').setInputFiles({ name: "reviewed.xlsx", mimeType: XLSX, buffer: WORKBOOK });
  await upload.click();
  await panel.locator('[data-testid="requirements-errors"]').waitFor();
  s.check(sent.review.length === 1 && sent.review[0].type === "application/octet-stream" && sent.review[0].size === WORKBOOK.length, "the workbook is sent as it is");
  const errs = await panel.locator('[data-testid="requirements-errors"] li').allInnerTexts();
  s.check(errs.length === 2 && /Rules/.test(errs[0]) && /row 3/.test(errs[0]) && /OP99/.test(errs[1]), "each row is shown with its sheet, row and problem", errs.join(" | "));
  s.check(/Nothing was changed/.test(await panel.locator('[data-testid="requirements-error"]').innerText()), "it says nothing was changed");
  await s.shot("row-errors");
  s.check((await s.overflow()) === 0, "the row errors fit the page");

  s.step("6. The fixed workbook: changes, open questions left, history");
  await panel.locator('[data-testid="requirements-review-file"]').setInputFiles({ name: "fixed.xlsx", mimeType: XLSX, buffer: WORKBOOK });
  await upload.click();
  await panel.locator('[data-testid="requirements-done"]').waitFor();
  const ch = await panel.locator('[data-testid="requirements-changes"] li').allInnerTexts();
  s.check(ch.length === 3 && /RU2/.test(ch[0]) && /ZB2B/.test(ch[1]), "every change is listed", ch.join(" | "));
  await panel.locator('[data-testid="requirements-history"]').waitFor();
  s.check(/3 changes/.test(await panel.locator('[data-testid="requirements-history"]').innerText()), "the review appears in the history");
  await page.waitForFunction(() => /1 open question not answered/.test(document.querySelector('[data-testid="requirements-generate-note"]')?.textContent || ""), null, { timeout: 20000 });
  s.ok("the generate note now says 1 open question is unanswered");
  await s.shot("reviewed");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");

  s.step("7. Generate the Workato service");
  const gen = panel.locator('[data-testid="requirements-generate"]');
  s.check((await gen.innerText()).trim() === "Generate the Workato service", "the button names the target", await gen.innerText());
  await gen.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  s.check(/stay listed in the project/.test(await dialog.innerText()), "the confirmation says unanswered questions stay listed");
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
  await page.locator('[data-testid="delivery"]').waitFor();
  s.check(sent.run.includes("generate"), "the generate step is asked of the tool");
  s.check(/3 of 7 rules implemented as steps/.test(await panel.locator('[data-testid="requirements-generated"]').innerText()), "the honest line of what was built is shown");

  s.step("8. Delivered like any other project: the package first");
  const delivery = page.locator('[data-testid="delivery"]');
  const dtext = await delivery.innerText();
  s.check(/built from requirements/.test(dtext) && !/old steps generated exactly/.test(dtext), "the delivery shows the honest line, not an old-steps count");
  s.check(/REQUIREMENTS-TODO\.md/.test(dtext), "it points at REQUIREMENTS-TODO.md");
  const pkg = delivery.locator('[data-testid="delivery-package"]');
  s.check((await pkg.innerText()).trim() === "Workato import package (.zip)", "the package button names the file to import");
  const order = await delivery.evaluate((el) => {
    const a = el.querySelector('[data-testid="delivery-package"]'), b = el.querySelector('[data-testid="delivery-project"]');
    return !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  s.check(order, "the package comes before the project download");
  const [pd] = await Promise.all([page.waitForEvent("download"), pkg.click()]);
  s.check(pd.suggestedFilename() === "order_intake_api-workato-package.zip" && sent.packages === 1, "the package is saved under its own name", pd.suggestedFilename());
  await s.shot("delivered");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");

  s.step("9. The document is on the Documents tab; no analysis corrections for it");
  await s.goto(`/migrations/${ID}?tab=documents`);
  await page.getByText("REQUIREMENTS-READ.md").first().waitFor();
  s.check((await page.locator('[data-testid="corrections"]').count()) === 0, "the analysis workbook is not offered for a requirements build");
  await s.shot("documents");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
