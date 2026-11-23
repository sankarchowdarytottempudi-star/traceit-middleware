#!/usr/bin/env node
// Factory: "Check and correct what the agent produced" on the Progress tab, and "This API name is already
// in use" with a choice to give this migration's API its own name instead of replacing the other one.
//
//   node e2e/migration-rename.e2e.mjs [baseUrl] --id <migrationId> [--shots <dir>] [--width 390 --height 844]
//
// Read-only: the migration is read from the real tool (any migration with documents); generate and rename
// go to stand-in answers, so nothing is renamed or generated.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs(["--id"]);
const i = opts.rest.indexOf("--id");
const id = i >= 0 ? opts.rest[i + 1] : "";
const s = new Session(opts);
const page = await s.start();
try {
  if (!id) s.fail("no migration id was given, so nothing was checked");
  else {
    const view = { apiName: "" };
    await s.context.route(`**/api/factory/migrations/${id}`, async (r) => {
      if (r.request().method() !== "GET") return r.continue();
      const res = await r.fetch();
      const m = await res.json();
      return r.fulfill({ response: res, json: { ...m, apiName: view.apiName || m.apiName || "stand-in-api", busy: false, queued: 0, checkOnly: false, sourceType: undefined,
        sourceFile: m.sourceFile || "/u/stand-in.zip", phases: (m.phases || []).map((p) => (p.key === "document" ? { ...p, status: "done" } : p)) } });
    });
    await s.context.route(`**/api/factory/migrations/${id}/run/*`, (r) => r.fulfill({ status: 409, json: { ok: false, needsConfirm: true, apiName: "X",
      otherMigration: { id: "other", name: "boomi" }, error: 'The migration "boomi" already produced an API called this name. Continuing would replace it.' } }));
    const renamed = [];
    await s.context.route(`**/api/factory/migrations/${id}/rename`, (r) => {
      const body = JSON.parse(r.request().postData() || "{}");
      renamed.push(body.name);
      view.apiName = body.name;
      return r.fulfill({ status: 202, json: { ok: true, apiName: body.name, message: `Renamed to ${body.name}. The documents and the project are being generated again under this name.` } });
    });
    s.allow(/409 \(Conflict\)/);

    s.step("1. Progress tab shows how to correct the agent's work");
    await s.goto(`/migrations/${id}`);
    const cc = page.locator('[data-testid="check-correct"]');
    await cc.waitFor({ timeout: 15000 });
    for (const t of ["cc-mapping", "cc-workbook", "cc-documents"]) if (!(await cc.locator(`[data-testid="${t}"]`).isVisible())) s.fail(`${t} is not visible`);
    await s.shot("check-correct");

    s.step("2. 'Edit the mapping' opens the editor of MAPPING.md on the Documents tab");
    await cc.locator('[data-testid="cc-mapping"]').click();
    await page.waitForURL(/tab=documents/);
    await page.getByRole("tab", { name: "Documents and corrections" }).waitFor();
    await page.locator("textarea").first().waitFor({ timeout: 15000 });
    if (!new URL(page.url()).searchParams.get("edit")) s.fail("edit= was not in the address");
    await s.shot("mapping-editor");

    s.step("3. 'Correct with the workbook' brings the upload panel into view");
    await s.goto(`/migrations/${id}`);
    await cc.locator('[data-testid="cc-workbook"]').click();
    const corr = page.locator('[data-testid="corrections"]');
    await corr.waitFor();
    await page.waitForTimeout(900);
    if (!(await corr.isVisible())) s.fail("the corrections panel is not visible");
    if (!(await page.getByText("Upload the corrections").first().isVisible())) s.fail("the upload button is not visible");
    await s.shot("workbook");

    s.step("4. The name conflict offers its own name next to Replace it");
    await s.goto(`/migrations/${id}`);
    const gen = page.getByRole("button", { name: /Generate the service/ }).first();
    await gen.waitFor({ timeout: 15000 }).catch(() => {});
    if (await gen.count()) {
      await gen.click();
      const confirm = page.getByRole("dialog").getByRole("button", { name: /Generate the service/ });
      if (await confirm.count()) await confirm.click();
      const dlg = page.locator('[data-testid="name-in-use"]');
      await dlg.waitFor({ timeout: 10000 });
      if (!(await page.locator('[data-testid="replace-it"]').isVisible())) s.fail("Replace it is missing");
      const input = page.locator('[data-testid="rename-input"]');
      const suggested = await input.inputValue();
      if (!suggested) s.fail("no name was suggested");
      await s.shot("name-in-use");
      await input.fill("bad name");
      await page.locator('[data-testid="rename-submit"]').click();
      await page.getByText(/no spaces or slashes/).first().waitFor();
      if (renamed.length) s.fail("a bad name was sent");
      await input.fill("my_own_api_name");
      await page.locator('[data-testid="rename-submit"]').click();
      await page.getByText(/Renamed to my_own_api_name/).first().waitFor({ timeout: 10000 });
      if (renamed[0] !== "my_own_api_name") s.fail(`rename sent ${renamed[0]}`);
      if (await dlg.count()) s.fail("the dialog stayed open");
      await s.shot("renamed");
    } else s.note?.("no Generate button on this migration; conflict dialog not checked");

    s.step("5. Rename the API from the header");
    const open = page.locator('[data-testid="rename-open"]');
    await open.waitFor();
    await open.click();
    await page.locator('[data-testid="rename-dialog"]').waitFor();
    await s.shot("rename-dialog");
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  }
} catch (e) {
  s.fail(String(e && e.stack || e));
}
await s.finish();
