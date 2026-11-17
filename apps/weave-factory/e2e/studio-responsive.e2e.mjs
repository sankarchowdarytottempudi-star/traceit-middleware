#!/usr/bin/env node
// Weave Studio and the Factory shell at desktop, tablet and phone widths, in the light and the dark theme.
//
//   node e2e/studio-responsive.e2e.mjs [baseUrl] [--estate-from <otherFactoryUrl>] [--fixture] [--shots <dir>]
//                                      [--widths 1440,820,390] [--themes light,dark] [--headed]
//
// For every width and theme it opens every Studio route (and the other Factory screens), and checks:
// no console errors, no sideways scrolling of the page, no button or field cut off by the edge of the
// screen, no text that cannot be read against its background. On tablet and phone it also uses the
// things that change shape there: the navigation drawer, the "Add a step" and "Step settings" sheets,
// the test panel, the mapper, the deploy dialog, the overflow menu, and dragging / pinching the canvas
// with fingers. With --shots every view is saved as <width>-<theme>-<name>.png.
// It creates one flow (named e2e-...) through the UI and deletes it again.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createFlow, deleteFlowFromEditor, parseArgs, runTest, saveFlow, Session, stamp, sweep } from "./studio-lib.mjs";
import { FIXTURE_API, pickEstate, pickService, wireEstate } from "./estate-fixture.mjs";

const opts = parseArgs(["--estate-from", "--widths", "--themes", "--api"]);
const arg = (name) => { const i = opts.rest.indexOf(name); return i >= 0 ? opts.rest[i + 1] : undefined; };
const from = (arg("--estate-from") || process.env.WEAVE_ESTATE_FROM || "").replace(/\/+$/, "");
const HEIGHTS = { 1440: 900, 820: 1180, 390: 844 };
const widths = (arg("--widths") || "1440,820,390").split(",").map(Number).filter(Boolean);
const themes = (arg("--themes") || "light,dark").split(",").filter((t) => t === "light" || t === "dark");
const PREFIX = `e2e-${stamp()}`;

const s = new Session({ ...opts, shots: "" });
await s.start();
let flowId = null;
let current = null; // the page being checked, for a picture when the script itself trips
const problems = [];
const notes = [];
const bad = (where, msg) => { problems.push(`${where}: ${msg}`); console.log(`  FAIL  ${where}: ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);
if (opts.shots) mkdirSync(opts.shots, { recursive: true });

// ---------------------------------------------------------------- checks that run inside the page
/** Buttons, links and fields that stick out of the screen without a scrolling container around them. */
const clippedControls = () => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll("button, a[href], input, select, textarea, [role=tab], [role=button]")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    if (r.right <= vw + 1 && r.left >= -1) continue;
    if (el.closest(".react-flow, .mf-side, .mf-sr, [aria-hidden=true]")) continue; // the canvas pans; the drawer is off-screen until opened
    let scrolls = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") { scrolls = true; break; }
    }
    if (!scrolls) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40)}" at ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  return out.slice(0, 6);
};
/** Text whose colour is too close to what is behind it (WCAG contrast below `min`). */
const lowContrast = (min) => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const backdrop = (el) => {
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null; // a gradient or picture: not judged
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a === 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (const l of layers.reverse()) base = over(l, base);
    return base;
  };
  const seen = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.trim();
    if (text.length < 2) continue;
    const el = n.parentElement;
    if (!el || el.closest("svg, [aria-hidden=true], .mf-sr, option")) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const fg = parse(cs.color); const bg = backdrop(el);
    if (!fg || !bg) continue;
    let dim = 1; for (let p = el; p; p = p.parentElement) dim *= Number(getComputedStyle(p).opacity);
    const shown = over({ ...fg, a: fg.a * dim }, bg);
    const a = lum(shown), b = lum(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio >= min) continue;
    const key = `${el.className || el.tagName}`.slice(0, 60);
    if (!seen.has(key) || seen.get(key).ratio > ratio) seen.set(key, { ratio, text: text.slice(0, 32), disabled: !!el.closest(":disabled, [aria-disabled=true]") });
  }
  return [...seen.entries()].filter(([, v]) => !v.disabled).map(([k, v]) => `${v.ratio.toFixed(2)} "${v.text}" (${k})`).slice(0, 8);
};
const viewportOf = () => {
  const el = document.querySelector(".react-flow__viewport");
  if (!el) return null;
  const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  return { x: m.e, y: m.f, zoom: m.a };
};
/** A point of the canvas with nothing on it, to start a drag from. */
const emptyCanvasPoint = () => {
  const pane = document.querySelector(".react-flow__pane");
  if (!pane) return null;
  const r = pane.getBoundingClientRect();
  for (let fy = 0.8; fy > 0.2; fy -= 0.1) for (let fx = 0.5; fx < 0.9; fx += 0.1) {
    const x = r.left + r.width * fx, y = r.top + r.height * fy;
    if (document.elementFromPoint(x, y) === pane) return { x, y };
  }
  return null;
};

try {
  // -------------------------------------------------------------- data for the views
  console.log("\n== Setting up");
  const estate = await pickEstate(s.context.request, opts.base, from, opts.rest.includes("--fixture"));
  const api = estate.mode === "fixture" ? FIXTURE_API : (arg("--api") || pickService(estate.list));
  console.log(`  migrated service shown: ${api} (${estate.mode === "own" ? "from this Factory" : estate.mode === "borrowed" ? `passed through from ${from}` : "built-in example"})`);
  flowId = await createFlow(s, `${PREFIX}-responsive`, "rest-proxy-map");
  await saveFlow(s);
  ok(`flow created from the "Call a backend and reshape the answer" template (${flowId})`);
  s.allow(/\/api\/studio\/flows\/[^/]+\/test/);
  try { const run = await runTest(s); ok(`one test run made, so the run lists have something to show (${run.execution?.status ?? run.status})`); }
  catch (e) { notes.push(`the test run during set-up did not finish: ${String(e.message).split("\n")[0]}`); }

  const editor = `/studio/flows/${flowId}`;
  const est = `/studio/estate/${encodeURIComponent(api)}`;
  const routes = [
    ["flows", "/studio", '[data-action="new-flow"]'],
    ["editor-canvas", editor, ".ws-node"],
    ["editor-mappings", `${editor}?tab=mappings`],
    ["editor-connections", `${editor}?tab=connections`],
    ["editor-executions", `${editor}?tab=executions`],
    ["editor-logs", `${editor}?tab=logs`],
    ["editor-versions", `${editor}?tab=versions`],
    ["editor-settings", `${editor}?tab=settings`, '[data-action="delete-flow"]'],
    ["connections", "/studio/connections", '[data-testid="connections"]'],
    ["connectors", "/studio/connectors", '[data-testid="connectors"]'],
    ["executions", "/studio/executions"],
    ["estate-canvas", est, ".ws-node"],
    ["estate-connectors", `${est}?tab=connectors`],
    ["estate-mappings", `${est}?tab=mappings`],
    ["estate-logs", `${est}?tab=logs`],
    ["migrations", "/migrations"],
    ["workspaces", "/workspaces"],
    ["playground", "/playground"],
    ["knowledge", "/knowledge"],
  ];

  const browser = s.browser;
  for (const width of widths) for (const theme of themes) {
    const height = HEIGHTS[width] ?? 900;
    const tag = `${width}-${theme}`;
    const small = width <= 1024, phone = width <= 640;
    console.log(`\n== ${width} x ${height}, ${theme} theme`);
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: small, ignoreHTTPSErrors: true });
    await ctx.addInitScript((t) => { try { localStorage.setItem("theme", t); } catch { /* ignore */ } }, theme);
    await wireEstate(ctx, estate.mode, from);
    const page = await ctx.newPage();
    current = { page, tag };
    page.setDefaultTimeout(20_000);
    let here = "";
    const errors = [];
    page.on("pageerror", (e) => errors.push(`${here}: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !/\/api\/factory\/estate|\/api\/studio\/flows\/[^/]+\/test/.test(`${m.text()} ${m.location()?.url ?? ""}`)) errors.push(`${here}: ${m.text()}`); });
    const shot = async (name) => { if (opts.shots) await page.screenshot({ path: join(opts.shots, `${tag}-${name}.png`) }).catch(() => {}); };
    const look = async (name, { contrast = true } = {}) => {
      const where = `${tag} ${name}`;
      const over = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
      if (over > 0) bad(where, `the page scrolls sideways by ${over}px`);
      const clipped = await page.evaluate(clippedControls);
      if (clipped.length) bad(where, `cut off by the edge of the screen: ${clipped.join("; ")}`);
      if (contrast) {
        // measure the settled page: dialogs and panels fade in (opacity), and text measured mid-fade
        // looks faint although its colours are fine — wait for running animations first (at most 3 s)
        await page.evaluate(() => Promise.race([
          Promise.all(document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
          new Promise((r) => setTimeout(r, 3000)),
        ])).catch(() => {});
        const unreadable = await page.evaluate(lowContrast, 2.6);
        if (unreadable.length) bad(where, `hard to read: ${unreadable.join("; ")}`);
      }
      await shot(name);
      return over === 0 && !clipped.length;
    };
    const settle = async (sel) => {
      if (sel) await page.locator(sel).first().waitFor({ timeout: 20_000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
      await page.waitForFunction(() => !document.querySelector(".mf-skeleton, .mf-loading"), null, { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(250);
    };
    const press = (loc) => (small ? loc.tap() : loc.click());
    const inside = async (loc, what, where) => {
      const b = await loc.boundingBox();
      if (!b) return bad(where, `${what} is not on screen`);
      if (b.x < -1 || b.x + b.width > width + 1 || b.y < -1 || b.y + b.height > height + 1) bad(where, `${what} does not fit the screen (${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)})`);
    };

    // ---- every route
    let clean = 0;
    for (const [name, path, sel] of routes) {
      here = name;
      await page.goto(opts.base + path, { waitUntil: "domcontentloaded" });
      await settle(sel);
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) bad(`${tag} ${name}`, "the chosen theme was not applied");
      if (await look(name)) clean++;
    }
    here = "canvas-redirect";
    await page.goto(`${opts.base}/canvas`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/studio$/, { timeout: 10_000 }).catch(() => bad(`${tag} /canvas`, "the old canvas address does not lead to the Studio"));
    ok(`${clean} of ${routes.length} views fit the screen; the old /canvas address leads to the Studio`);

    // ---- navigation drawer
    if (width < 900) {
      here = "nav-drawer";
      await page.goto(`${opts.base}/studio`, { waitUntil: "domcontentloaded" });
      await settle('[data-action="new-flow"]');
      await press(page.getByRole("button", { name: "Open menu" }));
      const side = page.locator('aside[aria-label="Main navigation"]');
      await page.waitForTimeout(350);
      await inside(side, "the navigation drawer", `${tag} nav-drawer`);
      await shot("nav-drawer");
      await press(side.getByRole("link", { name: /Connections/ }).first());
      await page.waitForURL(/\/studio\/connections$/, { timeout: 10_000 }).catch(() => bad(`${tag} nav-drawer`, "choosing an entry in the drawer did not open it"));
      await page.waitForTimeout(350);
      const closed = await side.evaluate((el) => el.getBoundingClientRect().right <= 1).catch(() => false);
      if (!closed) bad(`${tag} nav-drawer`, "the drawer stays open after choosing an entry");
      else ok("the navigation drawer opens, leads somewhere and closes again");
    }

    // ---- the editor: things that change shape on small screens
    here = "editor";
    await page.goto(opts.base + editor, { waitUntil: "domcontentloaded" });
    await settle(".ws-node");
    const dialog = (name) => page.getByRole("dialog", { name });
    if (small) {
      await press(page.getByRole("button", { name: "Add step" }));
      const sheet = dialog("Add a step");
      await sheet.waitFor();
      await page.waitForTimeout(300);
      await inside(sheet, 'the "Add a step" sheet', `${tag} add-step`);
      if ((await sheet.locator(".ws-palette-item").count()) < 5) bad(`${tag} add-step`, "the sheet does not list the steps");
      await look("sheet-add-step");
      await press(sheet.getByRole("button", { name: "Close", exact: true }));
      await sheet.waitFor({ state: "detached" });
    } else if (!(await page.locator('aside[aria-label="Steps you can add"]').isVisible())) bad(`${tag} editor`, "the list of steps is not shown next to the canvas");

    await page.getByRole("button", { name: "Fit the flow on screen" }).click();
    await page.waitForTimeout(400);
    const mapNode = page.locator('.ws-node[data-node-type="transform.map"] .ws-node-name').first();
    const anyNode = page.locator(".ws-node .ws-node-name").nth(1);
    const hasMap = (await mapNode.count()) > 0;
    await press(hasMap ? mapNode : anyNode);
    const panelHost = small ? dialog("Step settings") : page.locator('aside[aria-label="Step settings"]');
    await panelHost.waitFor();
    await page.waitForTimeout(300);
    await inside(panelHost, "the step settings", `${tag} step-settings`);
    await look("step-settings");
    if (hasMap) {
      await press(panelHost.locator('[data-action="open-mapper"]'));
      const mapper = page.locator('[data-testid="mapper"]');
      await mapper.waitFor();
      await page.waitForTimeout(400);
      await inside(page.getByRole("dialog").last(), "the mapper", `${tag} mapper`);
      await look("mapper");
      if (small) {
        // the three columns become tabs: each must be reachable
        const tabs = page.getByRole("dialog").last().getByRole("tab");
        const n = await tabs.count();
        for (let i = 0; i < n; i++) { await press(tabs.nth(i)); await page.waitForTimeout(150); await look(`mapper-tab-${i + 1}`); }
        if (n < 2) notes.push(`${tag}: the mapper shows no tabs for its columns`);
      }
      await press(page.locator('[data-action="close-mapper"]'));
      await mapper.waitFor({ state: "detached" });
    } else notes.push("the template has no mapping step: the mapper was not opened");
    if (small) { await press(panelHost.getByRole("button", { name: "Close", exact: true })); await panelHost.waitFor({ state: "detached" }); }
    else await page.getByRole("button", { name: "Close panel" }).click();

    await press(page.locator('[data-action="test"]'));
    const dock = page.locator('[data-testid="test-panel"]');
    await dock.waitFor();
    await page.waitForTimeout(300);
    await inside(phone ? dialog("Test") : dock, "the test panel", `${tag} test`);
    if (!(await dock.locator('[data-action="run-test"]').isVisible())) bad(`${tag} test`, "the Run button of the test panel is not visible");
    await inside(dock.locator('[data-action="run-test"]'), "the Run button of the test panel", `${tag} test`);
    await look("test-panel");
    if (small) {
      // run it from the small screen too: the result has to be readable where it lands
      await press(dock.locator('[data-action="run-test"]'));
      const result = dock.locator('[data-testid="test-result"]');
      await result.waitFor({ timeout: 60_000 });
      await page.waitForTimeout(300);
      const rb = await result.boundingBox();
      if (!rb || rb.height < 60 || rb.y > height - 60) bad(`${tag} test`, `the result of a test run is not on screen (${rb ? `${Math.round(rb.y)}, ${Math.round(rb.height)} high` : "no box"})`);
      await look("test-result");
    }
    if (phone) { await press(dialog("Test").getByRole("button", { name: "Close", exact: true })); await dock.waitFor({ state: "detached" }); }
    else { await press(page.locator('[data-action="test"]')); await dock.waitFor({ state: "detached" }); }

    await press(page.locator('[data-action="open-deploy"]'));
    const deploy = page.locator('[data-testid="deploy-dialog"]');
    await deploy.waitFor();
    await page.waitForTimeout(300);
    await inside(page.getByRole("dialog").last(), "the deploy dialog", `${tag} deploy`);
    await look("deploy-dialog");
    await press(page.getByRole("dialog").last().getByRole("button", { name: "Close", exact: true }).first());
    await deploy.waitFor({ state: "detached" });

    await press(page.getByRole("button", { name: "More actions" }));
    const menu = page.getByRole("menu", { name: "More actions" });
    await menu.waitFor();
    await inside(menu, "the overflow menu", `${tag} more-actions`);
    if ((await menu.getByRole("menuitem").count()) < 2) bad(`${tag} more-actions`, "the overflow menu is empty");
    await page.waitForTimeout(250);
    await shot("more-actions");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" }).catch(() => bad(`${tag} more-actions`, "Escape does not close the overflow menu"));
    ok("add step, step settings, mapper, test panel, deploy dialog and overflow menu all open inside the screen");

    // ---- fingers on the canvas
    if (small) {
      here = "touch";
      const cdp = await ctx.newCDPSession(page);
      const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x: Math.round(x), y: Math.round(y), id })) });
      const p = await page.evaluate(emptyCanvasPoint);
      if (!p) notes.push(`${tag}: no free spot on the canvas to drag from; touch not exercised`);
      else {
        const before = await page.evaluate(viewportOf);
        await touch("touchStart", [[p.x, p.y]]);
        for (let i = 1; i <= 8; i++) { await touch("touchMove", [[p.x - i * 12, p.y - i * 9]]); await page.waitForTimeout(16); }
        await touch("touchEnd", []);
        await page.waitForTimeout(200);
        const panned = await page.evaluate(viewportOf);
        const moved = Math.hypot(panned.x - before.x, panned.y - before.y);
        if (moved < 40) bad(`${tag} touch`, `dragging with one finger does not move the canvas (${Math.round(moved)}px)`);
        const c = { x: width / 2, y: p.y };
        await touch("touchStart", [[c.x - 30, c.y], [c.x + 30, c.y]]);
        for (let i = 1; i <= 8; i++) { await touch("touchMove", [[c.x - 30 - i * 10, c.y], [c.x + 30 + i * 10, c.y]]); await page.waitForTimeout(16); }
        await touch("touchEnd", []);
        await page.waitForTimeout(250);
        const zoomed = await page.evaluate(viewportOf);
        if (!(zoomed.zoom > panned.zoom * 1.15)) bad(`${tag} touch`, `pinching does not zoom the canvas (${panned.zoom.toFixed(2)} -> ${zoomed.zoom.toFixed(2)})`);
        const scrolled = await page.evaluate(() => window.scrollX !== 0 || window.scrollY !== 0);
        if (scrolled) bad(`${tag} touch`, "dragging the canvas scrolled the page");
        if (moved >= 40 && zoomed.zoom > panned.zoom * 1.15) ok(`one finger moves the canvas (${Math.round(moved)}px), two fingers zoom it (${panned.zoom.toFixed(2)} -> ${zoomed.zoom.toFixed(2)})`);
        await shot("after-touch");
      }
      if ((await page.locator('[data-testid="flow-editor"]').getAttribute("data-dirty")) === "true") bad(`${tag} touch`, "looking around the canvas marked the flow as changed");
    }

    if (errors.length) for (const e of [...new Set(errors)]) bad(tag, `console error in ${e}`);
    else ok("no console errors");
    await ctx.close();
  }
} catch (e) {
  bad("script", String(e?.stack ?? e).split("\n").slice(0, 4).join(" | "));
  if (current && opts.shots) await current.page.screenshot({ path: join(opts.shots, `${current.tag}-where-it-stopped.png`) }).catch(() => {});
} finally {
  console.log("\n== Cleaning up");
  try { if (flowId && !opts.keep) { await deleteFlowFromEditor(s, flowId); ok("the flow made for this check was deleted"); } }
  catch (e) { notes.push(`deleting through the UI failed: ${String(e.message).split("\n")[0]}`); }
  if (!opts.keep) { const left = await sweep(s, PREFIX); if (left.length) notes.push(`removed by the safety net: ${left.join(", ")}`); }
  for (const n of notes) s.warn(n);
  for (const p of problems) s.failures.push(p);
  await s.finish();
}
