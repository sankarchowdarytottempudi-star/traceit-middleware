#!/usr/bin/env node
// Gateway rules, end to end, against a REAL API Manager and gateway, on a throw-away API only.
//
//   node e2e/cs-gw-test-api.mjs create orders            # once: makes API cs-gw-test-orders
//   node e2e/api-rules.e2e.mjs http://127.0.0.1:8797 --api cs-gw-test-orders [--shots dir] [--width 390 --height 844]
//        [--gateway https://127.0.0.1:30243] [--token-url https://127.0.0.1:30443/oauth2/token]
//   node e2e/cs-gw-test-api.mjs cleanup                  # removes everything named cs-gw-test-*
//
// Desktop width runs the full operator journey and proves every change on the live gateway with real calls:
// plan + consumer app + keys + subscription -> call passes; block its addresses -> 403; limit 3/min -> 429;
// block the subscription -> 403; roll back; global blocking rule on a documentation address; validation errors.
// Narrow width (390) walks every screen and checks nothing overflows. The console must run with DEV_AUTH_USER
// on 127.0.0.1. The script refuses any API whose name does not start with cs-gw-test-.
import { chromium } from "@playwright/test";
import https from "node:https";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = { base: "http://127.0.0.1:8797", api: "", shots: "", width: 1440, height: 900, gateway: "https://127.0.0.1:30243", tokenUrl: "https://127.0.0.1:30443/oauth2/token" };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--api") opt.api = argv[++i]; else if (a === "--shots") opt.shots = argv[++i]; else if (a === "--width") opt.width = Number(argv[++i]);
  else if (a === "--height") opt.height = Number(argv[++i]); else if (a === "--gateway") opt.gateway = argv[++i]; else if (a === "--token-url") opt.tokenUrl = argv[++i];
  else if (/^https?:\/\//.test(a)) opt.base = a.replace(/\/+$/, "");
}
if (!/^cs-gw-test-[a-z0-9-]+$/.test(opt.api)) { console.error("--api must name a throw-away API (cs-gw-test-...)"); process.exit(2); }
const narrow = opt.width < 700;
const st = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(6, 14);

// ---------------------------------------------------------------- harness
const failures = []; const consoleErrors = []; let shotNo = 0; let oks = 0;
const step = (n) => console.log(`\n== ${n}`);
const check = (cond, msg, detail) => { if (cond) { oks++; console.log(`  ok    ${msg}`); } else { failures.push(detail ? `${msg} (${detail})` : msg); console.log(`  FAIL  ${msg}${detail ? ` (${detail})` : ""}`); } return !!cond; };
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: opt.width, height: opt.height } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const allowed = [/status of 4\d\d/, /status of 50[23]/]; // deliberate validation errors and API Manager refusals show in the UI
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error" && !allowed.some((r) => r.test(m.text()))) consoleErrors.push(m.text()); });
if (opt.shots) mkdirSync(opt.shots, { recursive: true });
async function shot(name) { if (!opt.shots) return; await page.waitForTimeout(400); await page.screenshot({ path: join(opt.shots, `${narrow ? "m" : "d"}${String(++shotNo).padStart(2, "0")}-${name}.png`), fullPage: true }).catch(() => {}); }
const go = (p) => page.goto(opt.base + p, { waitUntil: "domcontentloaded" });
const overflow = () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));

// ---------------------------------------------------------------- the real gateway (test API only)
function raw(url, { method = "GET", headers = {}, body } = {}) {
  const u = new URL(url);
  return new Promise((resolve) => {
    // loopback test endpoints with the cluster's self-signed certificate
    const r = https.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers, rejectUnauthorized: false, timeout: 20000 }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode, text: t }));
    });
    r.on("error", (e) => resolve({ status: 0, text: String(e.message) })); r.on("timeout", () => r.destroy(new Error("timeout")));
    if (body) r.write(body); r.end();
  });
}
let bearer = "";
async function getToken(key, secret) {
  const r = await raw(opt.tokenUrl, { method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${key}:${secret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  try { return JSON.parse(r.text).access_token ?? ""; } catch { return ""; }
}
const callApi = () => raw(`${opt.gateway}/${opt.api}/v1/orders`, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
/** Gateways pick up a new revision within a few seconds; poll until the expected answer shows. */
async function until(pred, ms = 45000) { const t0 = Date.now(); let last; while (Date.now() - t0 < ms) { last = await callApi(); if (pred(last)) return last; await new Promise((r) => setTimeout(r, 2000)); } return last; }

// ---------------------------------------------------------------- UI verbs
const confirmBox = () => page.getByTestId("confirm-change");
async function review(button = "Review change") { await page.getByRole("button", { name: button }).click(); await confirmBox().waitFor(); return (await confirmBox().innerText()); }
async function apply(label = "Apply to the live gateway") { await confirmBox().getByRole("button", { name: label }).click(); await confirmBox().waitFor({ state: "detached" }); }
async function tab(name) { await page.getByRole("tab", { name }).click(); }
async function openApi() {
  await go("/apis");
  await page.locator(`[data-gwapi="${opt.api}"]`).click();
  await page.getByRole("heading", { name: opt.api }).waitFor();
}
async function newLimit(kind, name, requests) {
  const box = page.getByTestId(`new-limit-${kind}`);
  await box.getByLabel("New limit name").fill(name);
  await box.getByLabel("Requests").fill(String(requests));
  await box.getByRole("button", { name: "Create limit" }).click();
  await box.waitFor({ state: "detached" });
}

// API Manager refuses dashes in policy names, so test policies are cs_gw_test_*
const plan = `cs_gw_test_plan_${st}`; const lim = `cs_gw_test_3pm_${st}`; const appName = `cs-gw-test-app-${st}`;
let apiId = "";

try {
  step("0. The console sees the throw-away API");
  const apis = await (await context.request.get(`${opt.base}/api/rules/apis`)).json();
  const mine = (apis.list ?? []).find((a) => a.name === opt.api);
  check(!!mine, `${opt.api} is on the gateway`, JSON.stringify(apis).slice(0, 200));
  apiId = mine?.id ?? "";
  if (!apiId) throw new Error("stop: no test API");
  const det = await (await context.request.get(`${opt.base}/api/rules/apis/${apiId}`)).json();
  check(det.api?.lifeCycleStatus === "PUBLISHED", "the test API is published (new subscriptions possible)", det.api?.lifeCycleStatus);

  if (!narrow) {
    step("1. Overview shows operator signals");
    await go("/");
    await page.getByTestId("overview-cards").waitFor();
    await page.getByLabel("Right now").waitFor();
    for (const t of ["APIs on the gateway", "Open APIs", "Throttled now", "Refused now", "Blocking rules"]) check(await page.getByText(t, { exact: true }).first().isVisible(), `signal "${t}"`);
    await shot("overview");

    step("2. From the APIs list to the API's own page");
    await openApi();
    check((await page.getByRole("tab").allInnerTexts()).join("|") === "Traffic limits|Access|Policies|Consumers|Live status|Change history", "six tabs on the API page");
    check(await page.getByText("Production", { exact: true }).isVisible(), "the page says it is a production gateway");
    await shot("api-traffic");

    step("3. A new plan, created inline, offered to consumers");
    await page.getByRole("button", { name: "New plan" }).click();
    await newLimit("subscription", plan, 5);
    check(await page.getByLabel(new RegExp(`^${plan}: 5 requests per minute per consumer`)).isChecked(), "the new plan is created and ticked");
    let text = await review();
    check(text.includes(`This changes the live gateway for ${opt.api} in Production`), "confirmation names the API and the environment");
    check(new RegExp(`Plans consumers can pick: [^→]+ → [^.]*${plan}\\. Each plan is a limit per consumer application`).test(text) && text.includes(`${plan} (5 requests per minute per consumer application)`), "confirmation lists the plan change in plain words", text.slice(0, 300));
    await shot("confirm-plan");
    await apply();
    const done = await page.getByTestId("change-done").innerText();
    check(/Live now\. Revision \d+ is deployed to Default/.test(done), "saved, new revision deployed", done.slice(0, 160));

    step("4. A consumer application with keys, subscribed with that plan");
    await go("/applications");
    await page.getByRole("button", { name: "New application" }).click();
    await page.getByLabel("Application name").fill(appName);
    await page.getByLabel("Application limit").selectOption("Unlimited");
    await page.getByRole("button", { name: "Create application" }).click();
    await page.getByRole("heading", { name: appName }).waitFor();
    await page.getByRole("button", { name: "Generate production keys" }).click();
    const secretBox = page.getByTestId("secret-once");
    await secretBox.waitFor();
    const key = (await secretBox.locator('[data-field="Consumer key"]').innerText()).trim();
    const secret = (await secretBox.locator('[data-field="Consumer secret"]').innerText()).trim();
    check(key.length > 10 && secret.length > 10, "consumer key and secret are shown once");
    await shot("keys-once");
    await secretBox.getByRole("button", { name: "I have stored it" }).click();
    check(!(await page.getByTestId("secret-once").count()), "the secret is gone after closing");
    await page.getByLabel("API to subscribe to").selectOption({ label: `${opt.api} v1` });
    await page.getByLabel("Plan", { exact: true }).locator(`option[value="${plan}"]`).waitFor({ state: "attached" });
    await page.getByLabel("Plan", { exact: true }).selectOption(plan);
    await page.getByRole("button", { name: "Subscribe" }).click();
    await page.getByText(`plan ${plan}`).waitFor();
    check(true, `${appName} is subscribed to ${opt.api} with ${plan}`);
    await shot("app-subscribed");
    bearer = await getToken(key, secret);
    check(!!bearer, "the new keys get an access token from API Manager");
    const first = await until((r) => r.status !== 401 && r.status !== 403 && r.status !== 0, 30000);
    check(first.status !== 401 && first.status !== 403 && first.status !== 429, "a real call through the gateway is let in (backend is a dead address, so any non-auth answer)", `status ${first.status}`);
    const passStatus = first.status;

    step("5. Access: block caller addresses for this API only");
    await openApi(); await tab("Access");
    await page.getByLabel("Block these addresses").fill("10.0.0.0/8\n127.0.0.0/8\n172.16.0.0/12\n192.168.0.0/16");
    text = await review();
    check(text.includes("Addresses blocked: none → 10.0.0.0/8, 127.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16."), "confirmation lists the blocked addresses");
    await shot("confirm-addresses");
    await apply();
    const blocked = await until((r) => r.status === 403);
    check(blocked?.status === 403 && /not allowed for this API/.test(blocked.text), "the live gateway now answers 403 from this host", `status ${blocked?.status} ${blocked?.text?.slice(0, 120)}`);
    await tab("Access");
    await page.getByLabel("Block these addresses").fill("");
    await review(); await apply();
    const back = await until((r) => r.status === passStatus);
    check(back?.status === passStatus, "removing the rule lets calls in again", `status ${back?.status}`);

    step("6. Server-side validation is explained in the UI");
    await tab("Access");
    await page.getByLabel(/Set CORS for this API/).check();
    await page.getByLabel("Allowed origins").fill("app.example.com/path");
    await page.getByRole("button", { name: "Review change" }).click();
    check(await page.getByText(/is not a web origin/).waitFor().then(() => true, () => false), "a bad origin is refused with a plain reason");
    await page.getByLabel("Allowed origins").fill("*");
    await page.getByLabel(/Allow credentials/).check();
    await page.getByRole("button", { name: "Review change" }).click();
    check(await page.getByText(/Browsers refuse credentials with origin \*/).waitFor().then(() => true, () => false), "credentials with * are refused");
    await page.getByLabel(/None \(open\)/).check();
    check(await page.getByText("This is a production gateway.", { exact: false }).isVisible(), "turning sign-in off warns hard on production");
    check(await page.getByRole("button", { name: "Review change" }).isDisabled(), "and cannot be reviewed until the API name is typed");
    await shot("access-validation");

    step("7. One limit for the whole API: 3 requests per minute");
    await go(`/apis/${apiId}?tab=traffic`);
    await page.getByLabel(/One limit for the whole API/).check();
    await page.getByRole("button", { name: "New limit" }).click();
    await newLimit("advanced", lim, 3);
    await page.getByLabel("Limit for the whole API", { exact: true }).locator(`option[value="${lim}"]`).waitFor({ state: "attached" });
    check((await page.getByLabel("Limit for the whole API", { exact: true }).inputValue()) === lim, "the new limit is selected");
    text = await review();
    check(text.includes(`Limit for the whole API: no limit → ${lim} (3 requests per minute, shared by every caller of this API).`), "plain words: 3 requests per minute, shared by every caller");
    await apply();
    let saw429 = false; const statuses = [];
    for (let i = 0; i < 40 && !saw429; i++) { const r = await callApi(); statuses.push(r.status); if (r.status === 429) saw429 = true; else await new Promise((res) => setTimeout(res, 700)); }
    check(saw429, "the live gateway throttles with 429 after 3 calls a minute", statuses.join(","));

    step("8. Rate limiting shows where each limit is used");
    await go("/rate-limits");
    await page.getByRole("tab", { name: /API & operation limits/ }).click();
    const used = page.locator(`[data-usedby="${lim}"]`);
    await used.getByText(opt.api).waitFor();
    check(await used.getByText("limit for the whole API").isVisible(), `"Used by" shows ${opt.api} (limit for the whole API)`);
    await page.getByRole("row", { name: new RegExp(lim) }).getByRole("button", { name: "Assign to an API" }).click();
    check(await page.getByRole("dialog").getByRole("link", { name: new RegExp(opt.api) }).isVisible(), "Assign lists the APIs to assign it to");
    await shot("ratelimits-usedby");
    await page.keyboard.press("Escape");

    step("9. Consumers: block the subscription, then unblock");
    await go(`/apis/${apiId}?tab=consumers`);
    const row = page.getByRole("row", { name: new RegExp(appName) });
    await row.getByRole("button", { name: "Block", exact: true }).click();
    text = (await confirmBox().innerText());
    check(text.includes(`stops every call this application makes to ${opt.api}`), "confirmation says what blocking does");
    await apply("Block now");
    await row.getByText("Blocked").waitFor();
    const bl = await until((r) => /900907/.test(r.text));
    check(/900907/.test(bl?.text ?? ""), "the blocked application is refused on the live gateway (API Manager code 900907)", `status ${bl?.status}`);
    await shot("consumers-blocked");
    await row.getByRole("button", { name: "Unblock" }).click();
    await apply("Unblock");
    await row.getByText("Active").waitFor();
    check(true, "unblocked");

    step("10. Live status");
    await tab("Live status");
    await page.getByText("Deployed now").waitFor();
    check(await page.getByText(/Revision \d+/).first().isVisible(), "the deployed revision is shown");
    check(await page.getByText("dev-tester").first().isVisible(), "the last change shows who made it");
    await shot("live");

    step("11. Change history and roll back");
    await tab("Change history");
    await page.getByLabel("Audit").waitFor();
    check((await page.getByLabel("Audit").innerText()).includes("traffic limits"), "the audit lists the changes made here");
    const target = page.locator("[data-revision]").filter({ has: page.getByRole("button", { name: "Roll back to this" }) }).last();
    const revName = await target.getAttribute("data-revision");
    await target.getByRole("button", { name: "Roll back to this" }).click();
    text = await confirmBox().innerText();
    check(text.includes(`→ ${revName}`), `confirmation names the revision (${revName})`);
    await shot("rollback-confirm");
    await apply("Roll back the live gateway");
    check(/Live now\./.test(await page.getByTestId("change-done").innerText()), "rolled back and deployed");

    step("11b. Rate limiting: built-in group and safe clean-up of an unused policy");
    await go("/rate-limits");
    await page.getByRole("tab", { name: /API & operation limits/ }).click();
    await page.getByTestId("builtin-group").waitFor();
    check(await page.getByTestId("builtin-group").getByText(/Built-in \(\d+\)/).isVisible(), "built-in policies are grouped and collapsed");
    const pick = page.getByLabel(`Select ${lim} for clean-up`);
    await pick.waitFor();
    await pick.check();
    await page.getByRole("button", { name: /Clean up selected \(1\)/ }).click();
    const cp = await page.getByTestId("cleanup-plan").innerText();
    check(cp.includes(`${lim}: delete (not used anywhere)`), "clean-up re-checks use before deleting", cp.slice(0, 200));
    await page.getByRole("button", { name: "Delete 1 unused" }).click();
    check((await page.getByTestId("cleanup-result").innerText()).includes(`${lim} deleted`), "unused test policy deleted and reported");
    await shot("ratelimits-cleanup");

    step("12. Blocking rules (global) on a documentation address");
    await go("/blocking");
    await page.getByLabel("Value to block").fill("203.0.113.77");
    await page.getByRole("button", { name: "Review rule" }).click();
    check((await confirmBox().innerText()).includes("Block calls from 203.0.113.77."), "rule previewed in plain words");
    await apply("Block now");
    const brow = page.getByRole("row", { name: /Address 203\.0\.113\.77/ });
    await brow.getByText("Enforced").waitFor();
    check(true, "rule added and enforced");
    await shot("blocking");
    await brow.getByRole("button", { name: "Turn off" }).click(); await apply("Apply");
    await brow.getByText("Off", { exact: true }).waitFor();
    check(true, "rule switched off");
    await brow.getByRole("button", { name: "Remove" }).click(); await apply("Remove rule");
    await brow.waitFor({ state: "detached" });
    check(true, "rule removed");
    await page.getByLabel("Value to block").fill("not-an-ip");
    await page.getByRole("button", { name: "Review rule" }).click();
    await confirmBox().getByRole("button", { name: "Block now" }).click();
    await page.getByText(/is not an IP address/).waitFor();
    check(true, "a bad address is refused by the server with a plain reason");
    await confirmBox().getByRole("button", { name: "Cancel" }).click();

    step("13. Overview lists the recent changes with who made them");
    await go("/");
    await page.getByLabel("Recent changes list").waitFor();
    check((await page.getByLabel("Recent changes list").innerText()).includes("dev-tester"), "recent changes name the person");

    step("13b. Policies tab: JSON threat protection, proven with a real call");
    await go(`/apis/${apiId}?tab=policies`);
    for (const f of ["Authentication", "Threat protection", "Traffic management", "AI / LLM gateway"]) check(await page.locator(`[data-family="${f}"]`).isVisible(), `family "${f}" listed with where it is handled`);
    await page.getByLabel(/JSON threat protection: refuse/).check();
    await page.getByLabel("Max depth").fill("5");
    text = await review();
    check(/JSON threat protection: off → on \(depth ≤ 5/.test(text), "confirmation states the JSON limits");
    await apply();
    const deepBody = JSON.stringify({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } });
    const tp = await (async () => { const t0 = Date.now(); let last; while (Date.now() - t0 < 45000) { last = await raw(`${opt.gateway}/${opt.api}/v1/orders`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: deepBody }); if (last.status === 400) break; await new Promise((res) => setTimeout(res, 2000)); } return last; })();
    check(tp?.status === 400 && /Threat Protection-JSON/.test(tp.text), "the live gateway refuses a 7-level JSON body with 400", `status ${tp?.status}`);
    await shot("policies");

    step("13c. Policy coverage matrix");
    await go("/coverage");
    const crow = page.locator(`tr[data-api="${opt.api}"]`);
    await crow.waitFor();
    check(await crow.getByLabel(`${opt.api} Threat protection covered`).isVisible(), "threat protection shows as covered for the test API");
    await page.getByRole("tab", { name: /Open APIs/ }).click();
    check(true, "filters for gaps are offered");
    await shot("coverage");

    step("13d. Policy library: a named set applied with a per-API preview");
    const setName = `cs-gw-test-set-${st}`;
    await go("/policy-library");
    await page.getByRole("button", { name: "New policy set" }).click();
    await page.getByLabel("Set name").fill(setName);
    await page.getByLabel("Set sign-in").selectOption("");
    await page.getByLabel("Set timeout").fill("20000");
    await page.getByRole("button", { name: "Save set" }).click();
    const setRow = page.locator(`[data-set="${setName}"]`);
    await setRow.waitFor();
    await setRow.getByRole("button", { name: "Apply to APIs" }).click();
    await page.getByLabel("APIs to apply to").getByLabel(opt.api, { exact: true }).check();
    await page.getByRole("button", { name: /Preview for 1 API/ }).click();
    const sp = await page.getByTestId("set-preview").innerText();
    check(sp.includes(opt.api) && /Backend timeout: .* → 20 s/.test(sp), "per-API preview lists exactly what changes", sp.slice(0, 200));
    await shot("library-preview");
    await page.getByRole("button", { name: "Apply to the live gateways" }).click();
    const sr = await page.getByTestId("set-results").innerText();
    check(new RegExp(`${opt.api} · done, Revision \\d+`).test(sr), "per-API result: done with a new revision", sr.slice(0, 160));
    await page.getByRole("button", { name: "Close" }).click();
    await setRow.getByRole("button", { name: "Delete set" }).click();
    await setRow.waitFor({ state: "detached" });

    step("13e. Gateway settings");
    await go("/settings");
    await page.getByLabel("Gateway (API traffic) TLS versions").waitFor();
    check((await page.getByLabel("Gateway (API traffic) TLS versions").innerText()).includes("TLS 1.2: accepted"), "TLS versions are probed live");
    check(await page.locator('[data-setting="masking"]').getByText("needs a server change").isVisible(), "log masking is marked as a server change with the exact edit");
    await shot("settings");

    step("14. Remove the keys and the application (typed confirmation)");
    await go("/applications");
    await page.getByRole("button", { name: `Open ${appName}` }).click();
    await page.getByRole("button", { name: "Remove keys" }).click();
    await page.getByLabel("Type the application name").fill(appName);
    await page.getByRole("alert").getByRole("button", { name: "Remove keys" }).click();
    await page.getByRole("button", { name: "Generate production keys" }).waitFor();
    check(true, "keys removed");
    const after = await getToken(key, secret);
    check(!after, "the removed keys no longer get a token");
    await page.getByRole("button", { name: "Delete application" }).click();
    await page.getByLabel("Type the application name").fill(appName);
    await page.getByRole("alert").getByRole("button", { name: "Delete application" }).click();
    await page.getByRole("row", { name: new RegExp(appName) }).waitFor({ state: "detached" });
    check(true, "application deleted");
  } else {
    step("Narrow screen: every screen fits 390 px");
    for (const [path, name, wait] of [["/", "overview", "Signals"], ["/apis", "apis", "APIs on the gateway"], [`/apis/${apiId}`, "api-traffic", "Plans consumers can pick"],
      [`/apis/${apiId}?tab=access`, "api-access", "Sign-in"], [`/apis/${apiId}?tab=consumers`, "api-consumers", "Applications subscribed"], [`/apis/${apiId}?tab=live`, "api-live", null],
      [`/apis/${apiId}?tab=history`, "api-history", "Revisions"], ["/rate-limits", "ratelimits", null], ["/blocking", "blocking", "Blocking rules"], ["/applications", "applications", "Applications"],
      [`/apis/${apiId}?tab=policies`, "api-policies", null], ["/coverage", "coverage", null], ["/policy-library", "library", null], ["/settings", "settings", null]]) {
      await go(path);
      if (wait) await page.getByLabel(wait).first().waitFor().catch(() => {});
      await page.waitForTimeout(800);
      const o = await overflow();
      check(o <= 1, `${name}: no sideways scrolling`, `${o}px`);
      await shot(name);
    }
    await go(`/apis/${apiId}?tab=traffic`);
    await page.getByLabel(/One limit for the whole API/).check();
    await page.getByLabel("Limit for the whole API", { exact: true }).selectOption("");
    check(await page.getByRole("button", { name: "Review change" }).isDisabled(), "Review stays disabled until a limit is chosen");
    await page.getByRole("button", { name: "Open menu" }).click();
    check(await page.getByRole("link", { name: "Blocking rules" }).isVisible() && await page.getByRole("link", { name: "Applications & keys" }).isVisible(), "the menu has Blocking rules and Applications & keys");
    await shot("menu");
  }
} catch (e) {
  failures.push(`stopped: ${e.message.split("\n")[0]}`);
  console.log(`  FAIL  stopped: ${e.message.split("\n")[0]}`);
  await shot("stopped");
}
await browser.close();
console.log("\n== Result");
for (const e of consoleErrors) console.log(`  console error: ${e}`);
if (consoleErrors.length) failures.push(`${consoleErrors.length} console error(s)`);
console.log(`${oks} checks ok`);
if (failures.length) { console.log(`FAILED: ${failures.length} problem(s)`); for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; } else console.log("PASSED");
