#!/usr/bin/env node
// Factory: "Old code, item by item" and "Runtime properties" on a migration's page.
//
//   node e2e/migration-parity.e2e.mjs [baseUrl] --id <migrationId> [--shots <dir>] [--width 390 --height 844]
//
// Read-only: the comparison and the answer to "Apply" are stand-ins laid over those two calls, and
// the migration is shown with a stand-in parity summary, so no setting of any service changes.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs(["--id"]);
const i = opts.rest.indexOf("--id");
const id = i >= 0 ? opts.rest[i + 1] : "";
const s = new Session(opts);
const page = await s.start();

const MAP = {
  ok: true, api: "batch", complete: false, flowCount: 4, flowsWithGaps: 2,
  summary: "2 of 4 old flows fully found in the new service; calls 75%, fields 90%, conditions 100%, tables 100%",
  totals: { calls: { found: 3, of: 4, percent: 75 }, fields: { found: 9, of: 10, percent: 90 }, conditions: { found: 2, of: 2, percent: 100 }, tables: { found: 1, of: 1, percent: 100 } },
  flows: [
    { name: "zohoUpsert_shorex_Sub_Flow", kind: "sub-flow", status: "gaps", missing: ["POST /crm/v6/Shorex/upsert"], calls: [{ what: "POST /crm/v6/Shorex/upsert", found: false }], fields: [{ name: "data", found: true, common: true }], conditions: [], errors: [] },
    { name: "zoho-reservations-UpsertSub_Flow", kind: "sub-flow", status: "gaps", missing: ["field primaryClientId"], calls: [], fields: [{ name: "Account_Name", found: true, where: "steps.bal" }, { name: "primaryClientId", found: false }], conditions: [{ value: "Booked", found: true }], errors: ["continue HTTP:CONNECTIVITY"] },
    { name: "interfaceFlow", kind: "flow", trigger: "scheduler", status: "complete", missing: [], calls: [{ what: "os:store (kept state)", found: null }], fields: [], conditions: [{ value: "delta", found: true }], errors: [] },
    { name: "zohoUpsert_addonsRequest_Sub_Flow", kind: "sub-flow", status: "complete", missing: [], calls: [{ what: "POST /crm/v6/Addons/upsert", found: true }], fields: [], conditions: [], errors: [] },
  ],
  connections: [{ config: "HTTP_Request_configuration_internal", kind: "http", settingsKey: "zohoSys.url", set: true }, { config: "JMS_Config", kind: "jms", settingsKey: "queue.brokerUrl", set: false }],
};
const SECRET = "Stand-In-Secret-77";

try {
  if (!id) s.fail("no migration id was given, so nothing was checked");
  else {
    await s.context.route(`**/api/factory/migrations/${id}`, async (r) => {
      if (r.request().method() !== "GET") return r.continue();
      const res = await r.fetch();
      const m = await res.json();
      return r.fulfill({ response: res, json: { ...m, parity: { complete: false, flowsWithGaps: 2, summary: MAP.summary, totals: MAP.totals }, settingsSource: "file" } });
    });
    await s.context.route(`**/api/factory/migrations/${id}/parity`, (r) => r.fulfill({ json: MAP }));

    // ------------------------------------------------------------ 1. the old code, item by item
    s.step("1. Old code, item by item");
    await s.goto(`/migrations/${id}`);
    const panel = page.locator('[data-testid="parity"]');
    await panel.waitFor();
    s.check((await page.getByText("2 flows with gaps", { exact: true }).count()) >= 2, "the page head and the panel say 2 flows have gaps");
    s.check((await panel.locator('[data-testid="parity-totals"] [role="progressbar"]').count()) === 4, "calls, fields, conditions and tables each have a bar");
    s.check((await panel.locator('[data-testid="parity-flow"]').count()) === 2, "only the flows with gaps are listed at first");
    const shorex = panel.locator('[data-testid="parity-flow"][data-flow="zohoUpsert_shorex_Sub_Flow"]');
    await shorex.locator("summary").click();
    s.check(/POST \/crm\/v6\/Shorex\/upsert/.test(await shorex.locator('[data-testid="parity-missing"]').innerText()), "a missing call is named");
    const res = panel.locator('[data-testid="parity-flow"][data-flow="zoho-reservations-UpsertSub_Flow"]');
    await res.locator("summary").click();
    s.check((await res.getByText("primaryClientId").count()) >= 1 && (await res.getByText("Account_Name").count()) === 1, "found and missing fields are listed");
    await panel.getByRole("button", { name: /All flows/ }).click();
    s.check((await panel.locator('[data-testid="parity-flow"]').count()) === 4, "all flows can be listed");
    const conn = await panel.locator('[data-testid="parity-connections"]').innerText();
    s.check(/zohoSys\.url/.test(conn) && /queue\.brokerUrl/.test(conn) && !/https?:\/\//.test(conn), "connections show the setting names, never values");
    await s.shot("parity");

    // ------------------------------------------------------------ 2. runtime properties
    s.step("2. Runtime properties");
    const rt = page.locator('[data-testid="runtime"]');
    await rt.waitFor();
    s.check((await page.getByText("Settings only from the uploaded file", { exact: true }).count()) === 1, "it says the settings came only from the uploaded file");
    let sent = null;
    await page.route(`**/api/factory/migrations/${id}/runtime-properties`, (r) => { sent = r.request().postDataJSON(); return r.fulfill({ json: { applied: [{ property: "scheduler.mode", setting: "sync.mode" }, { property: "scheduler.frequency", setting: "timer.intervalSeconds" }], unchanged: ["data.seawareNoOfRecords"], unknown: ["zoho.password"] } }); });
    const text = `scheduler.mode=delta\nscheduler.frequency=60\ndata.seawareNoOfRecords=100\nzoho.password=${SECRET}`;
    await rt.locator('[data-testid="runtime-text"]').fill(text);
    await rt.getByRole("button", { name: "Apply", exact: true }).click();
    await rt.locator('[data-testid="runtime-result"]').waitFor();
    s.check(sent && Object.keys(sent).length === 1 && sent.text === text, "only the pasted text is sent");
    const out = await rt.innerText();
    s.check(/scheduler\.mode → sync\.mode/.test(out) && /data\.seawareNoOfRecords/.test(out) && /zoho\.password/.test(out), "applied, unchanged and unused properties are named");
    s.check(!out.includes(SECRET) && !out.includes("delta") && (await rt.locator('[data-testid="runtime-text"]').inputValue()) === "", "no value is shown after applying and the text is cleared");
    s.check((await rt.getByRole("button", { name: "Deploy", exact: true }).count()) === 1, "Deploy is offered");
    await page.unroute(`**/api/factory/migrations/${id}/runtime-properties`);
    await page.route(`**/api/factory/migrations/${id}/runtime-properties`, (r) => r.fulfill({ status: 400, json: { error: "No property was found. Use one property per line: name=value, name: value, or name and value separated by a tab." } }));
    await rt.locator('[data-testid="runtime-text"]').fill("nothing useful");
    await rt.getByRole("button", { name: "Apply", exact: true }).click();
    await rt.getByText("No property was found").waitFor();
    s.check(true, "a refusal is shown in the panel");
    s.consoleErrors = s.consoleErrors.filter((e) => !(/400 \(Bad Request\)/.test(e) && e.includes("runtime-properties")));
    await page.unroute(`**/api/factory/migrations/${id}/runtime-properties`);
    await s.shot("runtime");
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  }
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
