#!/usr/bin/env node
// Factory: uploading the old application's archive again for an existing migration, from the
// "Old code, item by item" panel.
//
//   node e2e/migration-oldcode.e2e.mjs [baseUrl] --id <migrationId> [--shots <dir>] [--width 390 --height 844]
//
// Read-only: the migration is shown without a parity summary, and the upload goes to stand-in
// answers laid over the upload call, so nothing reaches the migration tool.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs(["--id"]);
const i = opts.rest.indexOf("--id");
const id = i >= 0 ? opts.rest[i + 1] : "";
const s = new Session(opts);
const page = await s.start();
const MAP = {
  ok: true, api: "stand-in", complete: true, flowCount: 3, flowsWithGaps: 0, summary: "3 of 3 old flows fully found in the new service",
  totals: { calls: { found: 2, of: 2, percent: 100 }, fields: { found: 5, of: 5, percent: 100 }, conditions: { found: 1, of: 1, percent: 100 }, tables: { found: 0, of: 0, percent: 100 } },
  flows: [{ name: "get-guest", kind: "flow", status: "complete", missing: [], calls: [], fields: [], conditions: [], errors: [] }], connections: [],
};

try {
  if (!id) s.fail("no migration id was given, so nothing was checked");
  else {
    let attached = false;
    await s.context.route(`**/api/factory/migrations/${id}`, async (r) => {
      if (r.request().method() !== "GET") return r.continue();
      const res = await r.fetch();
      const m = await res.json();
      const { parity, ...rest } = m;
      return r.fulfill({ response: res, json: attached ? { ...rest, parity: { complete: true, flowsWithGaps: 0, summary: MAP.summary, totals: MAP.totals } } : rest });
    });
    await s.context.route(`**/api/factory/migrations/${id}/parity`, (r) => r.fulfill({ json: MAP }));
    const sent = [];
    await s.context.route(`**/api/factory/migrations/${id}/source**`, (r) => {
      const u = new URL(r.request().url());
      sent.push({ filename: u.searchParams.get("filename"), force: u.searchParams.get("force"), type: r.request().headers()["content-type"], size: (r.request().postDataBuffer() || Buffer.alloc(0)).length });
      if (!u.searchParams.get("force")) return r.fulfill({ status: 409, json: { error: "This archive does not look like this API: its name does not mention it. If it is the right one, upload it again and confirm.", needsForce: true } });
      attached = true;
      return r.fulfill({ json: { ok: true, summary: MAP.summary, parity: { ok: true, complete: true, summary: MAP.summary } } });
    });

    s.step("1. The panel offers the upload when the old code is missing");
    await s.goto(`/migrations/${id}`);
    const up = page.locator('[data-testid="oldcode-upload"]');
    await up.waitFor();
    s.check(/not generated again/.test(await up.innerText()), "it says the service is not generated again");
    const btn = up.getByRole("button", { name: "Upload the old application (.zip or .jar)" });
    s.check(await btn.isDisabled(), "the upload waits for a file");
    s.check((await up.locator('[data-testid="oldcode-file"]').getAttribute("accept")) === ".zip,.jar", "only .zip and .jar are offered");
    await s.shot("missing");

    s.step("2. Upload, confirmation, then the comparison");
    await up.locator('[data-testid="oldcode-file"]').setInputFiles({ name: "legacy-export.zip", mimeType: "application/zip", buffer: Buffer.from("PK stand-in archive") });
    await btn.click();
    await up.locator('[data-testid="oldcode-error"]').waitFor();
    s.check(sent.length === 1 && sent[0].filename === "legacy-export.zip" && !sent[0].force && sent[0].type === "application/octet-stream" && sent[0].size === 19, "the file is sent as it is, without confirmation first");
    s.check(/does not look like/.test(await up.innerText()), "the tool's doubt is shown");
    await up.getByRole("button", { name: "It is the right application, upload it" }).click();
    await page.locator('[data-testid="parity"]').waitFor();
    s.check(sent.length === 2 && sent[1].force === "1", "the confirmation is sent only when asked for");
    s.check((await page.locator('[data-testid="parity-summary"]').innerText()).includes("3 of 3 old flows"), "the comparison with the old code is shown after the upload");
    s.check((await page.locator('[data-testid="oldcode-again"]').count()) === 1, "a newer archive can be uploaded again later");
    s.consoleErrors = s.consoleErrors.filter((e) => !(/409 \(Conflict\)/.test(e) && e.includes("/source")));
    await s.shot("attached");
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  }
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
