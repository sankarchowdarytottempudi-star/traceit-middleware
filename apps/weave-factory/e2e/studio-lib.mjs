// Shared helpers for the Weave Studio end-to-end scripts.
//
// These are plain node scripts (not @playwright/test specs) so they can be pointed at any
// running Factory:  node e2e/studio.e2e.mjs http://127.0.0.1:8798
// They drive the real UI against the real flow engine. Everything they create is named
// "e2e-<stamp>-..." and removed again at the end.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { base: process.env.WEAVE_BASE_URL || "http://127.0.0.1:8798", keep: false, headed: false, shots: process.env.WEAVE_E2E_SHOTS || "", width: 1440, height: 900, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") out.keep = true;
    else if (a === "--headed") out.headed = true;
    else if (a === "--shots") out.shots = argv[++i] ?? "";
    else if (a === "--width") out.width = Number(argv[++i]);
    else if (a === "--height") out.height = Number(argv[++i]);
    else if (/^https?:\/\//.test(a)) out.base = a;
    else out.rest.push(a);
  }
  out.base = out.base.replace(/\/+$/, "");
  return out;
}

export const stamp = () => new Date().toISOString().replace(/[-:TZ.]/g, "").slice(4, 14);

/** One browser session with step logging, soft checks and console-error tracking. */
export class Session {
  constructor(opts) {
    this.opts = opts;
    this.failures = [];
    this.warnings = [];
    this.consoleErrors = [];
    this.allowed = [/\/api\/factory\/estate/]; // 404 on a build without the migrated-API endpoints: shown as a note in the UI
    this.shotNo = 0;
  }
  async start() {
    this.browser = await chromium.launch({ headless: !this.opts.headed });
    this.context = await this.browser.newContext({ viewport: { width: this.opts.width, height: this.opts.height }, ignoreHTTPSErrors: true });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(20_000);
    this.page.on("pageerror", (e) => this.consoleErrors.push(`pageerror: ${e.message}`));
    this.page.on("console", (m) => {
      if (m.type() !== "error") return;
      const where = m.location()?.url ?? "";
      const text = `${m.text()} ${where}`;
      if (this.allowed.some((r) => r.test(text))) return;
      this.consoleErrors.push(text.trim());
    });
    if (this.opts.shots) mkdirSync(this.opts.shots, { recursive: true });
    return this.page;
  }
  /** Console errors matching this pattern are expected from here on (a deliberately failing call). */
  allow(re) { this.allowed.push(re); }
  log(msg) { console.log(msg); }
  step(name) { console.log(`\n== ${name}`); }
  ok(msg) { console.log(`  ok    ${msg}`); }
  warn(msg) { this.warnings.push(msg); console.log(`  WARN  ${msg}`); }
  fail(msg) { this.failures.push(msg); console.log(`  FAIL  ${msg}`); }
  check(cond, msg, detail) { if (cond) this.ok(msg); else this.fail(detail ? `${msg} (${detail})` : msg); return !!cond; }
  async shot(name) {
    if (!this.opts.shots) return;
    const file = join(this.opts.shots, `${String(++this.shotNo).padStart(2, "0")}-${name}.png`);
    await this.page.screenshot({ path: file }).catch(() => {});
  }
  async goto(path) {
    await this.page.goto(this.opts.base + path, { waitUntil: "domcontentloaded" });
  }
  /** Page-level horizontal overflow in px (0 is the bar). */
  async overflow() {
    return this.page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  }
  async finish() {
    await this.browser?.close();
    console.log("\n== Result");
    for (const e of this.consoleErrors) console.log(`  console error: ${e}`);
    if (this.consoleErrors.length) this.failures.push(`${this.consoleErrors.length} console error(s)`);
    for (const w of this.warnings) console.log(`  warning: ${w}`);
    if (this.failures.length) { console.log(`FAILED: ${this.failures.length} problem(s)`); for (const f of this.failures) console.log(`  - ${f}`); process.exitCode = 1; }
    else console.log(this.warnings.length ? `PASSED with ${this.warnings.length} warning(s)` : "PASSED");
  }
}

// ------------------------------------------------------------------ small UI verbs
export const field = (scope, key) => scope.locator(`[data-field="${key}"]`);
export async function setField(scope, key, value) {
  const box = field(scope, key).locator("input:not([type=checkbox]), textarea").first();
  await box.fill(value);
}
export async function selectField(scope, key, value) {
  await field(scope, key).locator("select").first().selectOption(value);
}
export async function openGroup(scope, title) {
  const head = scope.locator(".mf-collapse-head", { hasText: title }).first();
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
}
/** Answers the product's own confirm dialog. */
export async function confirm(page, label) {
  await page.getByRole("dialog").last().getByRole("button", { name: label, exact: true }).click();
}
export async function toastText(page) {
  return (await page.locator(".mf-toast").allInnerTexts()).join(" | ");
}

// ------------------------------------------------------------------ flows
export async function createFlow(s, name, template = "blank") {
  const page = s.page;
  await s.goto("/studio");
  await page.locator('[data-action="new-flow"]').click();
  await page.locator("#ws-new-name").fill(name);
  await page.locator("#ws-new-desc").fill("Created by the end-to-end check. Safe to delete.");
  await page.locator(`[data-template="${template}"]`).click();
  await page.locator('[data-action="create-flow"]').click();
  await page.waitForURL(/\/studio\/flows\/[^/]+$/);
  const editor = page.locator('[data-testid="flow-editor"]');
  await editor.waitFor();
  return editor.getAttribute("data-flow-id");
}
export const nodeOf = (page, type) => page.locator(`.ws-node[data-node-type="${type}"]`);
/** Clicks a step in the palette: it is added after the selected step, connected, and its settings open. */
export async function addStep(page, type) {
  const before = await page.locator(".ws-node").count();
  await page.locator(`.ws-palette-item[data-node-type="${type}"]`).first().click();
  await page.waitForFunction((n) => document.querySelectorAll(".ws-node").length === n + 1, before);
  const panel = page.locator(".ws-panel");
  await panel.waitFor();
  return panel;
}
export async function selectNode(page, type) {
  await page.getByRole("button", { name: "Fit the flow on screen" }).click();
  await page.waitForTimeout(350);
  await nodeOf(page, type).first().locator(".ws-node-name").click();
  const panel = page.locator(".ws-panel");
  await panel.waitFor();
  return panel;
}
export async function saveFlow(s) {
  const page = s.page;
  const editor = page.locator('[data-testid="flow-editor"]');
  if ((await editor.getAttribute("data-dirty")) === "true") await page.locator('[data-action="save"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="flow-editor"]')?.getAttribute("data-dirty") === "false", null, { timeout: 20_000 });
}
/** Runs the flow from the Test dock and returns the execution the engine answered with. */
export async function runTest(s, { query } = {}) {
  const page = s.page;
  const dock = page.locator('[data-testid="test-panel"]');
  if (!(await dock.isVisible().catch(() => false))) await page.locator('[data-action="test"]').click();
  await dock.waitFor();
  if (query) {
    for (const [i, [k, v]] of Object.entries(query).entries()) {
      if (!(await dock.getByLabel(`Name ${i + 1}`, { exact: true }).first().isVisible().catch(() => false))) await dock.getByRole("button", { name: "Add query value" }).click();
      await dock.getByLabel(`Name ${i + 1}`, { exact: true }).first().fill(k);
      await dock.getByLabel(`Value ${i + 1}`, { exact: true }).first().fill(v);
    }
  }
  const [res] = await Promise.all([
    page.waitForResponse((r) => /\/api\/studio\/flows\/[^/]+\/test$/.test(new URL(r.url()).pathname) && r.request().method() === "POST", { timeout: 60_000 }),
    dock.locator('[data-action="run-test"]').click(),
  ]);
  const execution = await res.json().catch(() => null);
  await dock.locator('[data-testid="test-result"]').waitFor({ timeout: 30_000 });
  return { execution, status: res.status(), dock };
}
export async function deleteFlowFromEditor(s, flowId) {
  const page = s.page;
  await s.goto(`/studio/flows/${flowId}?tab=settings`);
  await page.locator('[data-action="delete-flow"]').click();
  await confirm(page, "Delete");
  await page.waitForURL(/\/studio$/);
}

// ------------------------------------------------------------------ last-resort cleanup (only if the UI path failed)
export async function sweep(s, prefix) {
  const api = s.context.request;
  const base = s.opts.base + "/api/studio";
  const left = [];
  const list = async (path, key) => { try { const r = await api.get(base + path); return r.ok() ? ((await r.json())[key] ?? []) : []; } catch { return []; } };
  for (const f of await list("/flows", "flows")) if (String(f.name).startsWith(prefix)) { left.push(`flow ${f.name}`); await api.post(`${base}/flows/${f.id}/undeploy`).catch(() => {}); await api.delete(`${base}/flows/${f.id}`).catch(() => {}); }
  for (const c of await list("/connectors", "connectors")) if (String(c.name).startsWith(prefix)) { left.push(`connector ${c.name}`); await api.delete(`${base}/connectors/${c.id}`).catch(() => {}); }
  for (const c of await list("/connections", "connections")) if (String(c.name).startsWith(prefix)) { left.push(`connection ${c.name}`); await api.delete(`${base}/connections/${c.id}`).catch(() => {}); }
  return left;
}
