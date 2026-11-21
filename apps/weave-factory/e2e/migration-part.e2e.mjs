#!/usr/bin/env node
// Factory: "Which part of the project" for a Node.js migration, and the optional part on the
// new-migration form.
//
//   node e2e/migration-part.e2e.mjs [baseUrl] --id <nodeMigrationId> [--shots <dir>] [--width 390 --height 844]
//
// Read-only: the migration is shown as a Node.js migration with a stand-in part; the routes list,
// the part change and the upload go to stand-in answers, so nothing reaches the migration tool.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs(["--id"]);
const i = opts.rest.indexOf("--id");
const id = i >= 0 ? opts.rest[i + 1] : "";
const s = new Session(opts);
const page = await s.start();
const ROUTES = [
  { method: "POST", path: "/api/mobile/check-in", file: "src/modules/mobile/routes/index.route.js" },
  { method: "POST", path: "/api/mobile/check-in/submit", file: "src/modules/mobile/routes/index.route.js" },
  { method: "GET", path: "/api/mobile/check-in/status", file: "src/modules/mobile/routes/index.route.js" },
  { method: "GET", path: "/api/mobile/voyages", file: "src/modules/mobile/routes/index.route.js" },
  { method: "GET", path: "/api/admin/users", file: "src/modules/admin/routes/user.route.js" },
];

try {
  if (!id) s.fail("no migration id was given, so nothing was checked");
  else {
    await s.context.route(`**/api/factory/migrations/${id}`, async (r) => {
      if (r.request().method() !== "GET") return r.continue();
      const res = await r.fetch();
      const m = await res.json();
      const phases = (m.phases || []).map((p) => (p.key === "deploy" ? { ...p, status: "done" } : p));
      return r.fulfill({ response: res, json: { ...m, technology: "node", serviceDir: m.serviceDir || "services/stand-in", phases,
        scope: { spec: { prefix: "/api/mobile/check-in" }, routes: ["POST /api/mobile/check-in", "POST /api/mobile/check-in/submit", "GET /api/mobile/check-in/status"],
                 routesInProject: 5, files: 40, filesInProject: 120, functionsInPart: 37, relatedWorkers: ["server.js:sweep"] } } });
    });
    await s.context.route(`**/api/factory/migrations/${id}/routes`, (r) => r.fulfill({ json: { routes: ROUTES } }));
    let sent = null;
    await s.context.route(`**/api/factory/migrations/${id}/scope`, (r) => { sent = r.request().postDataJSON(); return r.fulfill({ json: { ok: true, message: "The part is changed. The service was not generated again." } }); });

    s.step("1. The part a Node.js migration covers");
    await s.goto(`/migrations/${id}`);
    const panel = page.locator('[data-testid="part"]');
    await panel.waitFor();
    const text = await panel.innerText();
    s.check(/\/api\/mobile\/check-in/.test(text) && /40 of 120 files/.test(text) && /37 functions used/.test(text), "the current part is described: prefix, files and functions used");
    s.check(/1 background job of the same feature/.test(text), "the background job that belongs to the feature is mentioned");
    s.check((await page.getByText("3 of 5 routes", { exact: true }).count()) === 1, "the head says how many routes the part has");
    await s.shot("part");

    s.step("2. Choosing routes and keeping the service");
    await panel.getByTestId("part-open").click();
    await panel.getByText("Choose routes", { exact: true }).click();
    await panel.getByTestId("part-routes").waitFor();
    s.check((await panel.locator('[data-testid="part-routes"] input').count()) === 5, "every route of the project can be picked");
    await panel.getByTestId("part-find").fill("check-in");
    s.check((await panel.locator('[data-testid="part-routes"] input').count()) === 3, "the list can be searched");
    for (const k of ["POST /api/mobile/check-in/submit", "GET /api/mobile/check-in/status"]) await panel.locator("label", { hasText: k }).locator("input").check();
    s.check(/2 of 5 routes are in this part/.test(await panel.getByTestId("part-preview").innerText()), "the preview counts the routes in the part");
    s.check(await panel.getByTestId("part-keep").isChecked(), "keeping the service as it is is the default for an existing service");
    await panel.getByTestId("part-apply").click();
    await panel.getByText("The service was not generated again").waitFor();
    s.check(JSON.stringify(sent) === JSON.stringify({ routes: ["GET /api/mobile/check-in/status", "POST /api/mobile/check-in/submit"], keepService: true }), "only the chosen routes and keep-the-service are sent");

    s.step("3. Generating an installed service again asks first");
    await panel.getByTestId("part-regen").check();
    await panel.getByTestId("part-installed").waitFor();
    s.check(await panel.getByTestId("part-apply").isDisabled(), "it can't be generated again before the confirmation");
    await panel.getByTestId("part-sure").check();
    s.check(!(await panel.getByTestId("part-apply").isDisabled()), "after the confirmation it can");
    await panel.getByText("Module folder", { exact: true }).click();
    s.check((await panel.locator('[data-testid="part-module"] option', { hasText: "src/modules/mobile (4 routes)" }).count()) === 1, "module folders are offered with their route counts");
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
    await s.shot("chooser");

    s.step("4. A part chosen while starting a migration");
    let uploadUrl = "";
    await s.context.route("**/api/factory/migrations?**", (r) => { uploadUrl = r.request().url(); return r.fulfill({ status: 400, json: { error: "Stand-in: upload not sent to the tool." } }); });
    await s.goto("/migrations/new");
    await page.getByRole("radiogroup", { name: "Source technology" }).getByRole("radio", { name: /Node\.js/ }).click();
    const np = page.getByTestId("new-part");
    await np.waitFor();
    await np.getByTestId("new-part-on").check();
    await np.getByTestId("new-part-text").fill("/api/mobile/check-in");
    const nameBox = page.getByLabel(/name/i).first();
    if (await nameBox.count()) await nameBox.fill("Part check");
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({ name: "app.zip", mimeType: "application/zip", buffer: Buffer.from("PK stand-in") });
    const startBtn = page.getByRole("button", { name: /Upload|Start/ }).last();
    await startBtn.click();
    await page.getByText("Stand-in: upload not sent to the tool.").waitFor({ timeout: 15000 }).catch(() => {});
    const scope = uploadUrl ? new URL(uploadUrl).searchParams.get("scope") : null;
    s.check(scope === JSON.stringify({ prefix: "/api/mobile/check-in" }), "the part travels with the upload");
    s.consoleErrors = s.consoleErrors.filter((e) => !/400 \(Bad Request\)/.test(e));
    s.check((await s.overflow()) === 0, "nothing runs off the side of the new-migration page");
  }
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
