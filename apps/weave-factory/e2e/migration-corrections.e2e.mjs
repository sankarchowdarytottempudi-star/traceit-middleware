#!/usr/bin/env node
// Factory: "Correct the analysis", and the download panel of a project for another platform.
// The analysis of one API is downloaded as an Excel workbook,
// corrected and uploaded again; the documents and the project are generated again with it.
//
//   node e2e/migration-corrections.e2e.mjs [baseUrl] --id <migrationId> [--shots <dir>] [--width 390 --height 844]
//
// Read-only: the migration is read from the real tool (any migration with documents), but the
// workbook download and the upload go to stand-in answers laid over those calls, so nothing is
// stored and nothing is generated again. Step 6 shows the migration as a Workato project and checks
// that the import package is the first, primary download (the package call is a stand-in too).
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs(["--id"]);
const i = opts.rest.indexOf("--id");
const id = i >= 0 ? opts.rest[i + 1] : "";
const s = new Session(opts);
const page = await s.start();
// a stand-in workbook: the zip signature and some bytes are all the page needs to see
const WORKBOOK = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("stand-in corrections workbook")]);
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CHANGES = [
  { sheet: "Operations", id: "op-3", action: "change", summary: "GET /orders/{id} reads table ORDERS_V2, not ORDERS" },
  { sheet: "Flows", id: "fl-2", action: "dead", summary: "nightly-purge is not used any more" },
];
const ROW_ERRORS = [
  { sheet: "Fields", row: 7, problem: "Action must be change, delete, add, live or dead" },
  { sheet: "Backends", row: 3, problem: "a new row needs a name" },
];

try {
  if (!id) s.fail("no migration id was given, so nothing was checked");
  else {
    const view = { checkOnly: false, history: [], target: "" };
    await s.context.route(`**/api/factory/migrations/${id}`, async (r) => {
      if (r.request().method() !== "GET") return r.continue();
      const res = await r.fetch();
      const m = await res.json();
      return r.fulfill({ response: res, json: { ...m, apiName: m.apiName || "stand-in-api", busy: false, queued: 0, checkOnly: view.checkOnly, corrections: view.history,
        ...(view.target ? { targetTech: view.target, serviceDir: m.serviceDir || "services/stand-in-api", packageFile: "stand-in-api-workato-package.zip" } : {}) } });
    });
    let downloads = 0;
    await s.context.route(`**/api/factory/migrations/${id}/corrections.xlsx`, (r) => {
      downloads++;
      return r.fulfill({ status: 200, body: WORKBOOK, headers: { "content-type": XLSX, "content-disposition": 'attachment; filename="stand-in-api-corrections.xlsx"' } });
    });
    const sent = [];
    await s.context.route(`**/api/factory/migrations/${id}/corrections`, (r) => {
      const body = r.request().postDataBuffer() || Buffer.alloc(0);
      sent.push({ type: r.request().headers()["content-type"], size: body.length });
      if (sent.length === 1) return r.fulfill({ status: 400, json: { ok: false, error: "2 rows of the workbook need fixing. Nothing was changed: fix the rows listed below and upload the workbook again.", errors: ROW_ERRORS } });
      const applied = { changed: 1, added: 0, deleted: 0, marked: 1 };
      view.history = [{ at: new Date().toISOString(), by: "e2e", applied, total: 2, changes: CHANGES }];
      return r.fulfill({ status: 202, json: { ok: true, rerun: true, applied, changes: CHANGES, message: "Corrections kept (1 changed, 1 marked). The documents and the project are being generated again with them." } });
    });
    s.allow(/400 \(Bad Request\)/);

    s.step("1. The panel explains the three steps");
    await s.goto(`/migrations/${id}?tab=documents`);
    const panel = page.locator('[data-testid="corrections"]');
    await panel.waitFor();
    const how = await panel.locator('[data-testid="corrections-how"]').innerText();
    s.check(/Download the workbook/.test(how) && /Action/.test(how) && /live/.test(how) && /dead/.test(how) && /note/.test(how), "it says how to correct a row (Action, live/dead, a note)");
    s.check(/generated again/.test(how) && /listed in the documents/.test(how), "it says the documents and the project are generated again and every correction is listed");
    const upload = panel.locator('[data-testid="corrections-upload"]');
    s.check(await upload.isDisabled(), "the upload waits for a file");
    s.check(/\.xlsx/.test((await panel.locator('[data-testid="corrections-file"]').getAttribute("accept")) || ""), "only .xlsx workbooks are offered");
    s.check((await panel.locator('[data-testid="corrections-history"]').count()) === 0, "no history before the first correction");
    await s.shot("panel");
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");

    s.step("2. Download the workbook");
    const [dl] = await Promise.all([page.waitForEvent("download"), panel.locator('[data-testid="corrections-download"]').click()]);
    s.check(dl.suggestedFilename() === "stand-in-api-corrections.xlsx", "the workbook is saved under the API's name", dl.suggestedFilename());
    s.check(downloads === 1, "the workbook comes from the corrections call");

    s.step("3. Rows that need fixing are listed, nothing is changed");
    await panel.locator('[data-testid="corrections-file"]').setInputFiles({ name: "stand-in-api-corrections.xlsx", mimeType: XLSX, buffer: WORKBOOK });
    await upload.click();
    await panel.locator('[data-testid="corrections-errors"]').waitFor();
    s.check(sent.length === 1 && sent[0].type === "application/octet-stream" && sent[0].size === WORKBOOK.length, "the workbook is sent as it is");
    const errs = await panel.locator('[data-testid="corrections-errors"] li').allInnerTexts();
    s.check(errs.length === 2 && /Fields/.test(errs[0]) && /row 7/.test(errs[0]) && /Action must be/.test(errs[0]), "each row that needs fixing is shown with its sheet, row and problem", errs.join(" | "));
    s.check(/Nothing was changed/.test(await panel.locator('[data-testid="corrections-error"]').innerText()), "it says nothing was changed");
    await s.shot("row-errors");
    s.check((await s.overflow()) === 0, "the row errors fit the page");

    s.step("4. Accepted corrections: counts, changes and history");
    await panel.locator('[data-testid="corrections-file"]').setInputFiles({ name: "fixed.xlsx", mimeType: XLSX, buffer: WORKBOOK });
    await upload.click();
    await panel.locator('[data-testid="corrections-done"]').waitFor();
    s.check(sent.length === 2, "the corrected workbook is sent again");
    s.check(/1 changed, 1 marked/.test(await panel.locator('[data-testid="corrections-counts"]').innerText()), "the counts are shown");
    const ch = await panel.locator('[data-testid="corrections-changes"] li').allInnerTexts();
    s.check(ch.length === 2 && /ORDERS_V2/.test(ch[0]) && /dead/.test(ch[1]), "every change is listed", ch.join(" | "));
    await panel.locator('[data-testid="corrections-history"]').waitFor();
    s.check(/1 changed, 1 marked/.test(await panel.locator('[data-testid="corrections-history"]').innerText()), "the correction appears in the history with its counts");
    await s.shot("accepted");
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");

    s.step("5. A package generated by Weave has nothing to correct");
    view.checkOnly = true;
    await s.goto(`/migrations/${id}?tab=documents`);
    await page.getByRole("tab", { name: "Documents" }).waitFor();
    await page.waitForTimeout(800);
    s.check((await page.locator('[data-testid="corrections"]').count()) === 0, "the panel is hidden for a checked-only package");

    s.step("6. A Workato project: the import package first, the project download marked as not for importing");
    view.checkOnly = false;
    view.target = "workato";
    let packages = 0;
    await s.context.route(`**/api/factory/migrations/${id}/package`, (r) => {
      packages++;
      return r.fulfill({ status: 200, body: Buffer.from("PK\x03\x04 stand-in package"), headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="stand-in-api-workato-package.zip"' } });
    });
    await s.goto(`/migrations/${id}`);
    const delivery = page.locator('[data-testid="delivery"]');
    await delivery.waitFor();
    const pkg = delivery.locator('[data-testid="delivery-package"]');
    s.check((await pkg.innerText()).trim() === "Workato import package (.zip) — import this file in Workato", "the package button names the file to import in Workato", await pkg.innerText());
    s.check(/mf-mg-btn-pri/.test((await pkg.getAttribute("class")) || ""), "the package is the primary button");
    const order = await delivery.evaluate((el) => {
      const a = el.querySelector('[data-testid="delivery-package"]'), b = el.querySelector('[data-testid="delivery-project"]');
      return !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    s.check(order, "the package comes before the project download");
    s.check((await delivery.locator('[data-testid="delivery-project-note"]').innerText()).includes("not for importing"), "the project download says it is not for importing");
    const [pd] = await Promise.all([page.waitForEvent("download"), pkg.click()]);
    s.check(pd.suggestedFilename() === "stand-in-api-workato-package.zip" && packages === 1, "the package is saved under its own name", pd.suggestedFilename());
    await s.shot("delivery");
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  }
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
