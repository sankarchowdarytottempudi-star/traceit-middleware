#!/usr/bin/env node
// Factory: the trial run and the parts that start by themselves, on a migration's page.
//
//   node e2e/migration-starts.e2e.mjs [baseUrl] --id <migrationId> [--shots <dir>] [--width 390 --height 844]
//
// Read-only: the trial and the parts are read from the real migration; switching and saving a
// value go to a stand-in answer laid over the save call, so no setting of any service changes.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs(["--id"]);
const i = opts.rest.indexOf("--id");
const id = i >= 0 ? opts.rest[i + 1] : "";
const s = new Session(opts);
const page = await s.start();
const api = `${opts.base}/api/factory/migrations`;
const get = async (u) => (await s.context.request.get(u)).json();

try {
  const raw = await get(`${api}/${id}`);
  const m = raw?.migration ?? raw;
  const open = await get(`${api}/${id}/open-items`);
  const parts = open?.starts ?? [];
  if (!m?.trial || !parts.length) s.fail("this migration has no trial run or no part that starts by itself, so nothing was checked");
  else {
    // ------------------------------------------------------------ 1. the trial run
    s.step(`1. Trial run of ${m.apiName}`);
    await s.goto(`/migrations/${id}`);
    const trial = page.locator('[data-testid="trial"]');
    await trial.waitFor();
    const text = await trial.innerText();
    s.check(/closed network/.test(text) && /made-up data/.test(text), "the page says how the trial was run");
    s.check((await page.locator('[data-testid="trial-op"]').count()) === (m.trial.operations ?? []).length, "every operation of the trial is listed");
    s.check((await page.locator('[data-testid="trial-part"]').count()) === (m.trial.parts ?? []).length, "every part of the trial is listed");
    s.check(!/https?:\/\//.test(text), "no address is shown");
    const pill = m.trial.ran ? (m.trial.passed ? "Passed" : "Found faults") : "Not run";
    s.check((await trial.locator("..").locator("..").getByText(pill, { exact: true }).count()) >= 1, `the result is shown as "${pill}"`);
    await s.shot("trial");

    // ------------------------------------------------------------ 2. the parts and their switches
    s.step("2. Parts that start by themselves");
    const panel = page.locator('[data-testid="starts"]');
    await panel.waitFor();
    s.check((await panel.locator('[data-testid="start-part"]').count()) === parts.length, `${parts.length} part(s) are listed`);
    const off = parts.filter((p) => p.on === false).length;
    if (off) s.check((await page.getByText(`${off} part${off === 1 ? "" : "s"} switched off`, { exact: true }).count()) >= 1, "the page head says how many are switched off");
    const timer = parts.find((p) => p.switch && p.on === false);
    if (timer) {
      const card = panel.locator(`[data-testid="start-part"][data-part=${JSON.stringify(timer.name)}]`);
      let sent = null;
      const after = { ...open, pending: [`${timer.name} is switched on in the service's settings. Run Deployment: the installed service follows the settings from then on.`],
        starts: parts.map((p) => (p.name === timer.name ? { ...p, on: true } : p)) };
      await page.route(`**/api/factory/migrations/${id}/resolve`, (r) => { sent = r.request().postDataJSON(); return r.fulfill({ json: { ok: true, changed: true, message: after.pending[0], openItems: after } }); });
      await card.getByRole("button", { name: "Switch on…" }).click();
      const ask = card.locator('[data-testid="start-confirm"]');
      await ask.waitFor();
      s.check(/done twice/.test(await ask.innerText()), "switching on warns that the work is done twice while both run");
      s.check(await card.getByRole("button", { name: "Switch it on", exact: true }).isDisabled(), "it cannot be switched on before the tick");
      await card.locator('[data-testid="start-sure"]').check();
      await card.getByRole("button", { name: "Switch it on", exact: true }).click();
      await panel.getByText("Deploy to put the change in use", { exact: false }).waitFor();
      s.check(sent?.id === `start:${timer.name}` && sent?.action === "switch" && sent?.on === true && sent?.confirm === true && Object.keys(sent).length === 4, "only the part, the switch and the confirmation are sent");
      s.check((await card.getByText("On", { exact: true }).count()) === 1 && (await card.getByText("Not deployed yet").count()) === 1, "the part shows as on, not deployed yet");
      s.check((await panel.getByRole("button", { name: "Deploy", exact: true }).count()) === 1, "Deploy is offered");
      await page.unroute(`**/api/factory/migrations/${id}/resolve`);
      await s.shot("switched");
    }
    const withEmpty = parts.find((p) => (p.empty ?? []).length);
    if (withEmpty) {
      await s.goto(`/migrations/${id}`);
      await panel.waitFor();
      const card = panel.locator(`[data-testid="start-part"][data-part=${JSON.stringify(withEmpty.name)}]`);
      const key = ((withEmpty.empty ?? []).find((e) => e.secret || e.secretSet) ?? withEmpty.empty[0]).key;
      let sent = null;
      await page.route(`**/api/factory/migrations/${id}/resolve`, (r) => { sent = r.request().postDataJSON(); return r.fulfill({ json: { ok: true, changed: true, message: `${key} of ${withEmpty.name} is set in the service's settings.`, openItems: open } }); });
      await card.locator("summary").click();
      await card.locator('[data-testid="start-key"]').selectOption(key);
      const input = card.locator('[data-testid="start-value"]');
      if ((withEmpty.empty ?? []).some((e) => e.key === key && (e.secret || e.secretSet))) s.check((await input.getAttribute("type")) === "password", "a secret setting is typed in a hidden field");
      await input.fill("stand-in-value-7");
      await card.getByRole("button", { name: "Save the value" }).click();
      await panel.getByText(`${key} of ${withEmpty.name} is set`).waitFor();
      s.check(sent?.id === `start:${withEmpty.name}` && sent?.action === "setting" && sent?.key === key && sent?.value === "stand-in-value-7", "the setting and its value are sent once");
      s.check(!(await panel.innerText()).includes("stand-in-value-7") && (await input.count()) === 0, "the value is not shown after saving");
      await page.unroute(`**/api/factory/migrations/${id}/resolve`);
    }
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  }
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
