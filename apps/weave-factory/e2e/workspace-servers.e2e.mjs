#!/usr/bin/env node
// Factory: a workspace's customer servers (connect, confirm, install), its environments and
// settings, and the releases of an API (make, approve, promote, roll back).
//
//   node e2e/workspace-servers.e2e.mjs [baseUrl] [--shots <dir>] [--width 390 --height 844]
//
// Read-only: every call of these screens goes to stand-in answers laid over the BFF, so nothing
// reaches the migration tool or any server. Write-only values must never show on the page again.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs();
const s = new Session(opts);
const page = await s.start();
const WS = "e2ews01";
const PW = "One-Time-Pw-9";
const SECRET = "Settings-Secret-7";
const json = (r, body, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const sent = {};
const keep = (k, r) => { try { sent[k] = r.request().postDataJSON(); } catch { sent[k] = null; } };

let ws = {
  id: WS, name: "E2E Customer", environments: [{ name: "uat", server: "uat", order: 0, approval: false }, { name: "prod", server: "prod", order: 1, approval: true }],
  servers: {
    uat: { host: "203.0.113.10", port: 22, username: "ops", provisioned: false, hostKey: "", keyInstalled: false, install: null },
    prod: { host: "203.0.113.11", port: 22, username: "ops", provisioned: true, hostKey: "SHA256:prodprodprodprodprodprodprod", keyInstalled: true,
      install: { state: "ready", steps: [{ step: "preflight", state: "ok", message: "4 CPU, 16 GB" }, { step: "apim", state: "ok", message: "WSO2 API Manager 4.5.0" }, { step: "ready", state: "ok", message: "ready" }] } },
  },
};
let jobPolls = 0;
let lanes = [
  { env: "uat", server: "uat", approval: false, release: { id: "rel1", version: "1.0.0" }, since: new Date(Date.now() - 3600e3).toISOString(), lastResult: "ok", canRollback: true },
  { env: "prod", server: "prod", approval: true, approvedFor: false, release: null, since: null, lastResult: null, canRollback: false },
];

async function stubs(ctx) {
  await ctx.route(`**/api/factory/workspace-configs/${WS}`, (r) => json(r, ws));
  await ctx.route(`**/api/factory/workspace-configs/${WS}/servers/*/key`, (r) => json(r, { publicKey: "ssh-ed25519 AAAAC3NzaE2E traceit-weave-e2e" }));
  await ctx.route(`**/api/factory/workspace-configs/${WS}/servers/*/status`, (r) => json(r, { ok: true, status: { apim: "ready", gateway: "https" } }));
  await ctx.route(`**/api/factory/workspace-configs/${WS}/servers/*/scan-host-key`, (r) => json(r, { ok: true, fingerprints: ["SHA256:uatuatuatuatuatuatuatuatuat1", "SHA256:otherotherotherotherother22"] }));
  await ctx.route(`**/api/factory/workspace-configs/${WS}/servers/*/trust-host-key`, (r) => { keep("trust", r); ws = { ...ws, servers: { ...ws.servers, uat: { ...ws.servers.uat, hostKey: sent.trust.fingerprint } } }; return json(r, { ok: true, message: "pinned" }); });
  await ctx.route(`**/api/factory/workspace-configs/${WS}/servers/*/install-key`, (r) => { keep("installKey", r); ws.servers.uat.keyInstalled = true; return json(r, { ok: true, message: "The tool's key is on the server. The password was not kept." }); });
  await ctx.route(`**/api/factory/workspace-configs/${WS}/servers/*/preflight`, (r) => json(r, { ok: true, message: "signed in with the key, sudo works (Ubuntu 24.04)" }));
  await ctx.route(`**/api/factory/workspace-configs/${WS}/servers/*/install`, (r) => { keep("install", r); return json(r, { started: true, job: { id: "job1", kind: "install", state: "running" } }, 202); });
  await ctx.route(`**/api/factory/workspace-configs/${WS}/servers/*/uninstall`, (r) => { keep("uninstall", r); return json(r, { started: true, job: { id: "job2", kind: "uninstall", state: "running" } }, 202); });
  await ctx.route(`**/api/factory/jobs/*`, (r) => {
    jobPolls++;
    const id = r.request().url().split("/").pop();
    return json(r, jobPolls < 2 ? { id, kind: "x", state: "running" } : { id, kind: "x", state: "done", result: { ok: true, steps: [{ step: "k3s", state: "skip", message: "already there" }, { step: "ready", state: "ok", message: "ready" }] } });
  });
  await ctx.route(`**/api/factory/workspace-configs/${WS}/environments`, (r) => { keep("envs", r); return json(r, { ok: true, environments: sent.envs.environments.map((e, i) => ({ ...e, order: i })) }); });
  await ctx.route(`**/api/factory/workspace-configs/${WS}/environments/*/settings/*`, (r) => { keep("settings", r); return json(r, { ok: true, keys: 3, message: "stored" }); });
  await ctx.route(`**/api/factory/workspaces`, (r) => json(r, { workspaces: [{ name: "E2E Customer", total: 1, deployed: 1, failed: 0, inProgress: 0, environments: [], config: { id: WS, name: "E2E Customer" },
    migrations: [{ id: "e2emig1", apiName: "zoho-sys-api", outcome: "Deployed" }] }] }));
  await ctx.route(`**/api/factory/migrations/e2emig1`, (r) => json(r, { id: "e2emig1", apiName: "zoho-sys-api", phases: [], progress: { overallPercent: 100, majorPhase: "Complete", done: true, outcome: "Deployed" },
    trial: { ran: true, passed: true, summary: "started; 3 of 3 operation requests answered" }, parity: { complete: true, summary: "9 of 9 old flows fully found" } }));
  await ctx.route(`**/api/factory/workspace-configs/${WS}/apis/zoho-sys-api/environments`, (r) => json(r, { api: "zoho-sys-api", environments: lanes }));
  await ctx.route(`**/api/factory/releases?api=zoho-sys-api`, (r) => json(r, { releases: [{ id: "rel1", api: "zoho-sys-api", version: "1.0.0", gates: { trialPassed: true, parityComplete: true } }] }));
  await ctx.route(`**/api/factory/audit?api=zoho-sys-api`, (r) => json(r, { audit: [{ at: new Date().toISOString(), who: "ana.lopez", action: "deploy", env: "uat", version: "1.0.0", result: "ok" }] }));
  await ctx.route(`**/api/factory/migrations/e2emig1/releases`, (r) => { keep("release", r); return json(r, { started: true, job: { id: "job3", kind: "release", state: "running" } }, 202); });
  await ctx.route(`**/api/factory/releases/rel1/approve`, (r) => { keep("approve", r); lanes = lanes.map((l) => (l.env === "prod" ? { ...l, approvedFor: true } : l)); return json(r, { ok: true }); });
  await ctx.route(`**/api/factory/workspace-configs/${WS}/promote`, (r) => { keep("promote", r); return json(r, { started: true, job: { id: "job4", kind: "promote", state: "running" } }, 202); });
  await ctx.route(`**/api/factory/workspace-configs/${WS}/rollback`, (r) => { keep("rollback", r); return json(r, { started: true, job: { id: "job5", kind: "rollback", state: "running" } }, 202); });
}

try {
  await stubs(s.context);
  // ------------------------------------------------------------ 1. servers
  s.step("1. Servers of a workspace");
  await s.goto(`/workspaces/${WS}/servers`);
  const uat = page.locator('[data-testid="server-card"][data-tier="uat"]');
  const prod = page.locator('[data-testid="server-card"][data-tier="prod"]');
  await uat.waitFor();
  s.check((await page.locator('[data-testid="server-card"]').count()) === 2, "both servers are shown");
  s.check((await prod.locator('[data-testid="step"]').count()) === 3, "the install steps the server reported are listed");
  await uat.getByRole("button", { name: "Show the public key" }).click();
  await uat.locator('[data-testid="public-key"]').waitFor();
  s.check((await uat.locator('[data-testid="public-key"]').inputValue()).startsWith("ssh-ed25519 "), "the public key is shown to copy");
  await uat.getByRole("button", { name: "Read the server's fingerprint" }).click();
  await uat.locator('[data-testid="fingerprints"]').waitFor();
  const trustBtn = uat.getByRole("button", { name: "This matches what my server shows" });
  s.check(await trustBtn.isDisabled(), "nothing is trusted before a fingerprint is chosen");
  await uat.getByText("SHA256:uatuatuatuatuatuatuatuatuat1").click();
  await trustBtn.click();
  await uat.getByText("Confirmed:").waitFor();
  s.check(sent.trust?.fingerprint === "SHA256:uatuatuatuatuatuatuatuatuat1" && Object.keys(sent.trust).length === 1, "only the chosen fingerprint is sent");
  await s.shot("servers");

  s.step("2. The one-time password is never shown again");
  await uat.getByText("Or put the key on the server with the user's password, once").click();
  await uat.locator('[data-testid="one-time-password"]').fill(PW);
  s.check((await uat.locator('[data-testid="one-time-password"]').getAttribute("type")) === "password", "the password is typed in a hidden field");
  await uat.getByRole("button", { name: "Add the key with this password" }).click();
  await uat.getByText("The password was not kept.").waitFor();
  s.check(sent.installKey?.password === PW && Object.keys(sent.installKey).length === 1, "the password is sent once, alone");
  s.check(!(await page.content()).includes(PW), "the password is not on the page after saving");

  s.step("3. Check and install, steps follow");
  await uat.getByRole("button", { name: "Check the server" }).click();
  await uat.locator('[data-testid="preflight"]').waitFor();
  await uat.getByRole("button", { name: "Install", exact: true }).click();
  await uat.locator('[data-testid="job-result"]').waitFor({ timeout: 20000 });
  s.check(sent.install?.dryRun === false, "the installation is started (not a dry run)");
  s.check((await uat.locator('[data-testid="job-result"] [data-testid="step"]').count()) === 2, "the steps of the finished installation are listed");

  s.step("4. Environments and settings");
  const envs = page.locator('[data-testid="environments"]');
  await envs.getByRole("button", { name: "Move prod up" }).click();
  await envs.getByRole("button", { name: "Save the order" }).click();
  await envs.getByText("Saved.").waitFor();
  s.check(JSON.stringify(sent.envs?.environments?.map((e) => e.name)) === '["prod","uat"]', "the new order is saved");
  await envs.locator('[data-testid="settings-text"]').fill(`[aroya.zoho_sys_api.zoho]\nurl = "https://crm.example.invalid"\nclientSecret = "${SECRET}"\ntimeout = 30`);
  await envs.getByRole("button", { name: /Store on the/ }).click();
  await envs.locator('[data-testid="settings-result"]').waitFor();
  s.check(sent.settings?.text?.includes(SECRET) && Object.keys(sent.settings).length === 1, "the settings text is sent once, alone");
  s.check((await envs.locator('[data-testid="settings-text"]').inputValue()) === "", "the box is emptied after storing");
  s.check(!(await page.content()).includes(SECRET), "the settings are not on the page after storing");
  s.check(/3 settings stored/.test(await envs.locator('[data-testid="settings-result"]').innerText()), "only the number of stored settings comes back");

  s.step("5. Remove WSO2 needs a confirmation");
  await prod.getByRole("button", { name: "Remove WSO2 from this server" }).click();
  await page.locator('[data-testid="purge"]').check();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await prod.locator('[data-testid="job-result"], [data-testid="job-running"]').first().waitFor();
  s.check(sent.uninstall?.confirm === true && sent.uninstall?.purge === true, "removing is confirmed, with the data choice");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the servers page");

  // ------------------------------------------------------------ 2. releases
  s.step("6. Releases: gates, approval, promotion, roll back");
  await s.goto(`/workspaces/${WS}/releases`);
  const rel = page.locator('[data-testid="releases"]');
  await rel.waitFor();
  await rel.locator('[data-testid="lane"]').first().waitFor();
  s.check((await rel.locator('[data-testid="gate"][data-ok="true"]').count()) === 2, "trial and parity show as passed");
  s.check((await rel.locator('[data-testid="lane"]').count()) === 2, "one lane per environment");
  await rel.getByRole("button", { name: "Make release" }).click();
  await rel.locator('[data-testid="job-result"]').waitFor({ timeout: 20000 });
  s.check(sent.release && !("by" in sent.release), "making a release sends no user name from the browser");
  const uatLane = rel.locator('[data-testid="lane"][data-env="uat"]');
  s.check((await uatLane.getByRole("button", { name: /Promote to prod/ }).count()) === 0, "prod cannot be promoted to before an approval");
  await uatLane.getByRole("button", { name: "Approve for prod…" }).click();
  await page.locator('[data-testid="approver"]').fill("Head of IT");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await uatLane.getByRole("button", { name: "Promote to prod" }).waitFor();
  s.check(sent.approve?.approver === "Head of IT" && sent.approve?.env === "prod", "the approval names the person");
  await uatLane.getByRole("button", { name: "Promote to prod" }).click();
  await rel.locator('[data-testid="job-result"]').waitFor({ timeout: 20000 });
  s.check(sent.promote?.from === "uat" && sent.promote?.to === "prod" && sent.promote?.api === "zoho-sys-api" && !("approval" in sent.promote), "promotion sends only the API and the environments");
  await uatLane.getByRole("button", { name: "Roll back" }).click();
  await page.getByRole("button", { name: "Roll back", exact: true }).last().click();
  await page.waitForTimeout(500);
  s.check(sent.rollback?.env === "uat", "roll back asks first, then goes back in uat");
  s.check((await rel.locator('[data-testid="audit"] li').count()) >= 1, "what was done is listed");
  await s.shot("releases");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the releases page");
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
