#!/usr/bin/env node
// Manual Review Workbench (the CRM Web Tab page): sign-in window, queue with SLA badges, side-by-side
// comparison, a decision that meets changed data, role limits, and no call to anything but the
// Workbench's own /api/review. The review API is stubbed; nothing real is read or changed.
//   node e2e/review-workbench.e2e.mjs [baseUrl] [--shots <dir>] [--width 390 --height 844]
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs([]);
const s = new Session(opts);
const page = await s.start();
const origin = new URL(opts.base).origin;
const phone = opts.width < 700;

// ---- stubbed review API -------------------------------------------------------------------------
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const TOKENS = {
  "tok-reviewer-0123456789abcdefghijklmnop": { zuid: "z-rev", name: "Rana Reviewer", roles: ["IDENTITY_REVIEWER"] },
  "tok-audit-0123456789abcdefghijklmnopqrs": { zuid: "z-aud", name: "Adel Audit", roles: ["AUDIT_REPORTING"] },
  "tok-supervisor-0123456789abcdefghijklmn": { zuid: "z-sup", name: "Sara Supervisor", roles: ["IDENTITY_SUPERVISOR"] },
};
let nextToken = "tok-reviewer-0123456789abcdefghijklmnop";
let expireNext = false;
const sla = (state) => ({ dueAt: iso(now + (state === "OVERDUE" ? -3600e3 : state === "DUE_SOON" ? 3 * 3600e3 : 40 * 3600e3)), state, escalate: state === "OVERDUE", days: 1 });
const rows = [
  { caseId: "RC-1", kind: "MULTIPLE_IDENTITY_CONFLICT", priority: "HIGH", caseStatus: "REVIEW_OPEN", createdAt: iso(now - 30 * 3600e3), assignee: null, candidateCount: 3, ruleVersion: "1.0", title: "Ali Khan", sla: sla("OVERDUE") },
  { caseId: "RC-2", kind: "FOUR_FIELD_REVIEW", priority: "NORMAL", caseStatus: "REVIEW_OPEN", createdAt: iso(now - 20 * 3600e3), assignee: "z-rev", candidateCount: 1, ruleVersion: "1.0", title: "Mona Saleh", sla: sla("DUE_SOON") },
  { caseId: "RC-3", kind: "PAIR_REPAIR", priority: "NORMAL", caseStatus: "REVIEW_COMMITTED", createdAt: iso(now - 2 * 3600e3), assignee: "z-sup", candidateCount: 1, ruleVersion: "1.0", title: "Omar Fahd", sla: sla("ON_TIME") },
];
const g = (id, ident, t, d, fr = {}, extra = {}) => ({ crmGuestRecordId: id, crmIdentityRecordId: ident, crmModifiedTime: t, display: d, normalized: { email_key: d.email ?? null, phone_e164: d.phone ? `+966${d.phone.slice(1)}` : null }, fieldResults: fr, reasonCodes: extra.reasonCodes ?? [], crmLink: `https://crm.zoho.example/crm/org1/tab/Contacts/${id}` });
let version = 1;
function case1() {
  return {
    caseId: "RC-1", caseStatus: "REVIEW_OPEN", kind: "MULTIPLE_IDENTITY_CONFLICT", priority: "HIGH", ruleVersion: "1.0", createdAt: rows[0].createdAt,
    reasonCodes: ["MULTIPLE_DISTINCT_IDENTITIES"], assignee: null, shadow: { label: "SHADOW_REVIEW_CANDIDATE", score: 0.71, modelVersion: "shadow-0.3" },
    incoming: g("R100", null, "2026-11-16T10:00:00Z", { firstName: "Ali", lastName: "Khan", dob: "1990-05-10", phone: "0551234567", email: "ali@example.com" }),
    candidates: [
      g("R200", "I-1", "2026-11-16T09:40:00Z", { firstName: "Ali", lastName: "Khan", dob: "1990-05-10", phone: "0551234567", email: "ali@example.com" }, { firstName: "EXACT", lastName: "EXACT", dob: "EXACT", phone: "EXACT", email: "EXACT" }),
      g("R300", "I-2", version === 1 ? "2026-11-15T08:00:00Z" : "2026-11-16T10:05:00Z", { firstName: "Ali", lastName: "Khan", dob: version === 1 ? "1991-01-01" : "1990-05-10", phone: "0551234567", email: "" }, { firstName: "EXACT", lastName: "EXACT", dob: version === 1 ? "CONFLICT" : "EXACT", phone: "SUPPRESSED", email: "MISSING" }, { reasonCodes: ["PHONE_OVER_SHARED"] }),
      g("R400", "I-1", "2026-11-14T08:00:00Z", { firstName: "A.", lastName: "Khan", dob: "", phone: "0551234567", email: "ali@example.com" }, { firstName: "LOW_CONFIDENCE", lastName: "EXACT", dob: "MISSING", phone: "EXACT", email: "EXACT" }),
    ],
    provisionalIdentity: "I-1",
    pairs: { current: [{ crmGuestRecordId: "R200", crmIdentityRecordId: "I-1" }, { crmGuestRecordId: "R300", crmIdentityRecordId: "I-2" }], provisional: [{ crmGuestRecordId: "R100", crmIdentityRecordId: "I-1" }] },
  };
}
const MASK = { firstName: "A•••", lastName: "K•••", dob: "••••-••-••", phone: "•••67", email: "a•••@•••" };
function shaped(c, who) {
  const prot = who.roles.includes("IDENTITY_REVIEWER") || who.roles.includes("IDENTITY_SUPERVISOR");
  const mask = (v) => (prot ? v : { ...v, display: Object.fromEntries(Object.keys(v.display).map((k) => [k, v.display[k] ? MASK[k] : ""])), normalized: {}, masked: true });
  const decider = prot;
  const allowed = c.caseStatus === "REVIEW_COMMITTED" ? (who.roles.includes("IDENTITY_SUPERVISOR") ? ["REVERSE_DECISION"] : []) : decider ? ["CONFIRM_SAME_PERSON", "CONFIRM_DIFFERENT_PEOPLE", "CONFIRM_HOUSEHOLD", "DEFER"] : [];
  return { ...c, incoming: mask(c.incoming), candidates: c.candidates.map(mask), sla: rows.find((r) => r.caseId === c.caseId)?.sla ?? null, allowedActions: allowed, canAssign: who.roles.includes("IDENTITY_SUPERVISOR"), protectedShown: prot };
}
function case3() {
  return { caseId: "RC-3", caseStatus: "REVIEW_COMMITTED", kind: "PAIR_REPAIR", priority: "NORMAL", ruleVersion: "1.0", createdAt: rows[2].createdAt, reasonCodes: ["PAIR_MISMATCH"], assignee: "z-sup",
    incoming: g("R500", "I-9", "2026-11-16T07:00:00Z", { firstName: "Omar", lastName: "Fahd", dob: "1985-02-02", phone: "0509999999", email: "omar@example.com" }),
    candidates: [g("R600", "I-7", "2026-11-16T06:00:00Z", { firstName: "Omar", lastName: "Fahd", dob: "1985-02-02", phone: "0509999999", email: "omar@example.com" }, { firstName: "EXACT", lastName: "EXACT", dob: "EXACT", phone: "EXACT", email: "EXACT" })],
    pairs: { surviving: [{ crmGuestRecordId: "R500", crmIdentityRecordId: "I-7" }] } };
}

const decisions = [];
let decisionReply = "changed";
const requests = [];
page.on("request", (r) => requests.push(r.url()));

await s.context.route("**/api/review/**", async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  const path = u.pathname.replace(/^.*\/api\/review/, "");
  const auth = req.headers()["authorization"] ?? "";
  const who = TOKENS[auth.replace(/^Bearer /, "")];
  const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (path === "/info") return json(200, { enabled: true, signIn: true, connected: true });
  if (path === "/auth/start") {
    const tok = nextToken;
    return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><script>const n=new URL(location.href).searchParams.get("nonce");window.opener.postMessage({type:"weave-review-session",ok:true,nonce:n,token:${JSON.stringify(tok)},idleMinutes:30},location.origin);setTimeout(()=>window.close(),50);</script>` });
  }
  if (path === "/auth/claim") return route.fulfill({ status: 204, body: "" });
  if (path === "/auth/logout") return route.fulfill({ status: 204, body: "" });
  if (!who || expireNext) { expireNext = false; return json(401, { code: "UNAUTHORIZED", message: "Sign in again." }); }
  if (path === "/session") return json(200, { user: { zuid: who.zuid, name: who.name, email: "x•••@•••" }, roles: who.roles, connected: true, idleMinutes: 30, expiresAt: iso(now + 8 * 3600e3), slaDays: {}, crmLinks: true });
  if (path === "/cases") return json(200, { cases: rows.map((r) => ({ ...r, title: who.roles.includes("AUDIT_REPORTING") ? null : r.title })) });
  if (path === "/cases/RC-1") return json(200, shaped(case1(), who));
  if (path === "/cases/RC-3") return json(200, shaped(case3(), who));
  if (/\/history$/.test(path)) return json(200, { history: [{ at: iso(now - 3600e3), what: "Case opened", by: "integration" }] });
  if (path === "/cases/RC-1/decisions" && req.method() === "POST") {
    const body = req.postDataJSON();
    decisions.push(body);
    if (decisionReply === "changed") { decisionReply = "ok"; version = 2; return json(409, { code: "REVIEW_DATA_CHANGED", message: "The guest data changed." }); }
    return json(200, { caseStatus: "REVIEW_CRM_UPDATE_PENDING" });
  }
  if (/\/assignment$/.test(path)) return json(200, { ok: true });
  if (/\/comments$/.test(path)) return json(201, {});
  return json(404, { code: "NOT_FOUND", message: "unknown" });
});
s.allow(/status of 40[19]/); // the deliberate 401 and 409 answers

async function signInAs(token) {
  nextToken = token;
  await page.locator('[data-testid="rv-signin"]').waitFor();
  const popup = page.waitForEvent("popup");
  await page.locator('[data-testid="rv-signin-btn"]').click();
  await popup;
  await page.locator('[data-testid="rv-queue"]').waitFor();
}
const signOut = async () => { await page.getByRole("button", { name: "Sign out" }).click(); await page.locator('[data-testid="rv-signin"]').waitFor(); };
const openCase = async (id) => { await page.locator(`[data-testid="rv-case-item"][data-case="${id}"]`).click(); await page.locator(`[data-testid="rv-case"][data-case="${id}"]`).waitFor(); };
// which elements stick out past the screen (named in a failed width check)
const wide = () => page.evaluate(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > W + 1 && !e.closest(".rv-compare-wrap") || (e.classList.contains("rv-compare-wrap") && e.getBoundingClientRect().right > W + 1)).slice(0, 5).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(" ")[0]}[${Math.round(e.getBoundingClientRect().right)}]`).join(" "); });
const fits = async (msg) => { const o = await s.overflow(); s.check(o === 0, msg, o ? `${o}px: ${await wide()}` : undefined); };
const checked = () => page.locator('input[name="rv-action"]:checked').count();

try {
  s.step("1. The Web Tab page and its sign-in");
  await s.goto("/review");
  await page.locator('[data-testid="rv-signin"]').waitFor();
  s.check(!(await page.locator("nav a[href$='/migrations']").count()), "the Workbench stands alone, without the Factory navigation");
  s.check((await s.overflow()) === 0, "the sign-in screen fits the width");
  await s.shot("signin");
  await signInAs("tok-reviewer-0123456789abcdefghijklmnop");
  s.check(/Rana Reviewer · Identity reviewer/.test(await page.locator('[data-testid="rv-user"]').innerText()), "the reviewer is signed in through the sign-in window");

  s.step("2. The queue");
  s.check((await page.locator('[data-testid="rv-case-item"]').count()) === 3, "every case is listed");
  const states = await page.locator('[data-testid="rv-sla"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
  s.check(states.join(",") === "OVERDUE,DUE_SOON,ON_TIME", "SLA badges show overdue, due soon and on time", states.join(","));
  const first = await page.locator('[data-testid="rv-case-item"]').first().innerText();
  s.check(/Overdue/.test(first) && /supervisor told/.test(first) && /High priority/.test(first) && /Waiting/.test(first), "an overdue case says so in words, with the escalation, priority and age");
  s.check((await s.overflow()) === 0, "the queue fits the width");
  const spill = await page.evaluate(() => { const q = document.querySelector('[data-testid="rv-queue"]').getBoundingClientRect(); return [...document.querySelectorAll('[data-testid="rv-queue"] *')].filter((e) => e.getBoundingClientRect().right > q.right + 1).length; });
  s.check(spill === 0, "nothing in the queue runs past its column", `${spill} element(s)`);
  await s.shot("queue");

  s.step("3. Opening a case reads only the Workbench API");
  const before = requests.length;
  await openCase("RC-1");
  await page.locator('[data-testid="rv-history"]').waitFor();
  const opened = requests.slice(before);
  const foreign = opened.filter((u) => new URL(u).origin !== origin);
  const apiCalls = opened.filter((u) => /\/api\//.test(u));
  s.check(foreign.length === 0, "no request leaves the Workbench's own address (no CRM call)", foreign.join(" "));
  s.check(apiCalls.length > 0 && apiCalls.every((u) => /\/api\/review\//.test(u)), "every API call goes to /api/review", apiCalls.filter((u) => !/\/api\/review\//.test(u)).join(" "));
  const table = page.locator('[data-testid="rv-compare"]');
  s.check((await table.locator("thead th").count()) === 5, "the incoming guest and all three possible matches sit side by side");
  s.check(/2 different people/.test(await page.locator('[data-testid="rv-distinct"]').innerText()), "the two distinct people are called out");
  s.check(/Different/.test(await table.locator('td[data-field="dob"][data-result="CONFLICT"]').innerText()), "a conflicting date of birth is marked in words");
  s.check(/Shared by many/.test(await table.locator('td[data-field="phone"][data-result="SUPPRESSED"]').innerText()), "an over-shared phone is marked");
  s.check(/Not sure/.test(await table.locator('td[data-result="LOW_CONFIDENCE"]').innerText()), "a low-confidence value is marked");
  s.check(/Missing/.test(await table.locator('td[data-field="email"][data-result="MISSING"]').innerText()), "a missing value is marked");
  await page.locator('[data-testid="rv-show-norm"]').check();
  s.check(/\+966551234567/.test(await table.innerText()), "cleaned-up values can be shown next to the originals");
  const caseText = await page.locator('[data-testid="rv-case"]').innerText();
  s.check(/MULTIPLE_DISTINCT_IDENTITIES/.test(caseText) && /Rule version/.test(caseText), "the rule version and reason codes are shown");
  s.check(/SHADOW_REVIEW_CANDIDATE · score 0\.71/.test(await page.locator('[data-testid="rv-shadow"]').innerText()), "the trial matcher's label and score are shown");
  const pairsText = await page.locator('[data-testid="rv-pairs"]').textContent();
  s.check(/Linked now/i.test(pairsText) && /Linked for now/i.test(pairsText) && /R100.*I-1/.test(pairsText), "current and provisional links are shown");
  const link = page.locator('[data-testid="rv-crm-link"]').first();
  s.check((await link.getAttribute("target")) === "_blank" && /noopener/.test((await link.getAttribute("rel")) ?? ""), "CRM links only open CRM in a new tab");
  await fits("the case fits the width (the comparison scrolls inside its own box)");
  if (phone) s.check(!(await page.locator('[data-testid="rv-queue"]').isVisible()), "at phone width the case takes the whole screen");
  await s.shot("case");

  s.step("4. A decision meets changed data");
  s.check(await page.locator('[data-testid="rv-submit"]').isDisabled(), "nothing can be saved before a decision is chosen");
  await page.locator('[data-testid="rv-act-CONFIRM_SAME_PERSON"]').check();
  s.check(await page.locator('[data-testid="rv-submit"]').isDisabled(), "same person needs the person chosen");
  await page.locator('[data-testid="rv-pick"]').selectOption("I-1");
  await page.locator('[data-testid="rv-comment"]').fill("Same passport seen at check-in");
  await page.locator('[data-testid="rv-submit"]').click();
  await page.locator('[data-testid="rv-changed"]').waitFor();
  const sent = decisions[0] ?? {};
  s.check(sent.action === "CONFIRM_SAME_PERSON" && sent.selectedIdentityId === "I-1", "the decision and the chosen person were sent");
  s.check(Array.isArray(sent.versionsShown) && sent.versionsShown.length === 4 && sent.versionsShown.some((v) => v.crmGuestRecordId === "R300" && v.crmModifiedTime === "2026-11-15T08:00:00Z"), "the versions shown were sent with it");
  s.check(typeof sent.idempotencyKey === "string" && sent.idempotencyKey.length >= 6, "a repeat-safe key was sent");
  const changed = await page.locator('[data-testid="rv-changed"]').innerText();
  s.check(/not saved/.test(changed) && /R300: Date of birth — was 1991-01-01, now 1990-05-10/.test(changed), "the page says the decision was not saved and what changed", changed);
  s.check((await checked()) === 0 && (await page.locator('[data-testid="rv-submit"]').isDisabled()), "a new decision is required");
  s.check(!(await page.locator('td[data-field="dob"][data-result="CONFLICT"]').count()), "the comparison now shows the latest data");
  await s.shot("data-changed");
  await page.locator('[data-testid="rv-act-CONFIRM_DIFFERENT_PEOPLE"]').check();
  await page.locator('[data-testid="rv-submit"]').click();
  await page.locator('[data-testid="rv-saved"]').waitFor();
  const second = decisions[1] ?? {};
  s.check(second.action === "CONFIRM_DIFFERENT_PEOPLE" && second.versionsShown?.some((v) => v.crmGuestRecordId === "R300" && v.crmModifiedTime === "2026-11-16T10:05:00Z"), "the new decision carries the new versions");
  s.check(second.idempotencyKey !== sent.idempotencyKey, "the new decision has its own key");
  s.check(!(await page.locator('[data-testid="rv-changed"]').count()), "the changed-data notice is gone once saved");

  s.step("5. Decide later needs a reason and a date");
  await page.locator('[data-testid="rv-act-DEFER"]').check();
  s.check(await page.locator('[data-testid="rv-submit"]').isDisabled(), "decide later cannot be saved without a reason and a date");
  await page.locator('[data-testid="rv-comment"]').fill("Waiting for the guest's passport copy");
  await page.locator('[data-testid="rv-follow"]').fill(new Date(now + 3 * 86400e3).toISOString().slice(0, 10));
  s.check(await page.locator('[data-testid="rv-submit"]').isEnabled(), "with both it can be saved");
  s.check(!(await page.locator('[data-testid="rv-act-REVERSE_DECISION"]').count()), "a reviewer cannot reverse decisions");
  await page.locator('[data-testid="rv-take"]').click();
  await page.getByText("The case is yours.").waitFor();
  s.ok("a reviewer can take the case");
  s.check(!(await page.locator('[data-testid="rv-assign-to"]').count()), "a reviewer cannot give cases to others");

  s.step("6. Audit sees masked values and cannot act");
  if (phone) await page.locator('[data-testid="rv-back"]').click();
  await signOut();
  await signInAs("tok-audit-0123456789abcdefghijklmnopqrs");
  s.check(!/Ali Khan|Mona Saleh/.test(await page.locator('[data-testid="rv-queue"]').innerText()), "the queue shows no names to audit users");
  await openCase("RC-1");
  const audit = await page.locator('[data-testid="rv-case"]').innerText();
  s.check(!/Ali|Khan|example\.com|0551234567|1990-05-10/.test(audit), "no personal detail reaches the page for audit users");
  s.check(await page.locator('[data-testid="rv-masked"]').isVisible(), "the page says details are hidden for this role");
  s.check(/cannot|not decide/.test(await page.locator('[data-testid="rv-no-actions"]').innerText()) && !(await page.locator('[data-testid="rv-decide"]').count()), "audit users have no decision buttons");
  s.check(!(await page.locator('[data-testid="rv-comment-form"]').count()) && !(await page.locator('[data-testid="rv-take"]').count()), "audit users cannot comment or take cases");
  s.check(!(await page.locator('[data-testid="rv-show-norm"]').count()), "cleaned-up values are not offered to audit users");
  await s.shot("audit");

  s.step("7. A supervisor can reverse a decided case and hand cases over");
  if (phone) await page.locator('[data-testid="rv-back"]').click();
  await signOut();
  await signInAs("tok-supervisor-0123456789abcdefghijklmn");
  await openCase("RC-3");
  const acts = await page.locator('input[name="rv-action"]').evaluateAll((els) => els.map((e) => e.value));
  s.check(acts.join(",") === "REVERSE_DECISION", "on a decided case the supervisor sees only reverse", acts.join(","));
  s.check(/Will stay linked/i.test(await page.locator('[data-testid="rv-pairs"]').textContent()), "the surviving link is shown");
  s.check(await page.locator('[data-testid="rv-assign-to"]').isVisible(), "a supervisor can give the case to a reviewer");
  await page.getByRole("button", { name: "Dark" }).click();
  const dark = await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark", null, { timeout: 5000 }).then(() => true, () => false);
  s.check(dark && (await page.evaluate(() => getComputedStyle(document.querySelector(".rv")).backgroundColor)) !== "rgb(255, 255, 255)", "the dark theme applies");
  await fits("the supervisor's view fits the width");
  await s.shot("supervisor-dark");
  await page.getByRole("button", { name: "Light" }).click();

  s.step("8. An ended session returns to sign-in");
  if (phone) await page.locator('[data-testid="rv-back"]').click();
  expireNext = true;
  await page.getByRole("button", { name: "Refresh the cases" }).click();
  await page.locator('[data-testid="rv-signin"]').waitFor();
  s.check(/session ended/.test(await page.locator('[data-testid="rv-signin"]').innerText()), "the page says the session ended");
  s.check(requests.every((u) => new URL(u).origin === origin), "the whole run never called another address");
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
