// Branding crawl of the signed-in UI: visits every route of each app (seed list + every same-app link
// found on the way), opens each tab on a page, and scans what a user can see or download for the
// forbidden names: page title, rendered text, full HTML (attributes, alt/aria texts), and every
// text-like response the page loads from its own origin (scripts, styles, JSON answers, SVG).
//
//   node crawl.mjs <config.json>          config is written by acc/branding.py
//
// Safety: only GET/HEAD/OPTIONS requests are allowed to leave the browser for the apps' origins
// (everything else is aborted), and the crawler never clicks buttons, only role=tab elements.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pwPath = process.env.ACC_PLAYWRIGHT_MODULE;
const pw = pwPath ? await import(pathToFileURL(pwPath).href) : await import("playwright");
const chromium = pw.chromium || pw.default?.chromium;

const FORBIDDEN = /traceit-tottech|traceit|tottempudi/gi;
const TEXTY = /(text\/|javascript|json|svg|xml|manifest)/i;
const hits = [];
const seenResp = new Set();
const pages = [];
const downloads = new Set();
const blocked = [];

const counts = {};          // every hit is counted ...
const perKey = new Map();   // ... but only 3 samples per (where, url) are kept
function scan(text, where, url) {
  if (!text) return;
  for (const m of text.matchAll(FORBIDDEN)) {
    counts[where] = (counts[where] || 0) + 1;
    const key = `${where} ${url}`;
    const n = perKey.get(key) || 0;
    if (n >= 3 || hits.length >= 2000) continue;
    perKey.set(key, n + 1);
    const a = Math.max(0, m.index - 40), b = Math.min(text.length, m.index + m[0].length + 40);
    hits.push({ where, url, match: m[0], context: text.slice(a, b).replace(/\s+/g, " ") });
  }
}

const args = [];
const rules = Object.entries(cfg.resolve || {}).map(([h, t]) => `MAP ${h}:443 ${t}`);
if (rules.length) args.push(`--host-resolver-rules=${rules.join(",")}`);
const browser = await chromium.launch({ args });

for (const app of cfg.apps) {
  const base = app.base.replace(/\/+$/, "");
  const origin = new URL(base).origin;
  const basePath = new URL(base).pathname.replace(/\/+$/, "");
  const ctx = await browser.newContext({ ignoreHTTPSErrors: !!cfg.insecure, viewport: { width: 1440, height: 900 } });
  if (app.cookies?.length) await ctx.addCookies(app.cookies.map((c) => ({ ...c, url: origin })));
  await ctx.route("**/*", (route) => {
    const req = route.request();
    const sameOrigin = req.url().startsWith(origin);
    if (sameOrigin && !["GET", "HEAD", "OPTIONS"].includes(req.method())) {
      blocked.push(`${req.method()} ${req.url().replace(origin, "")}`);
      return route.abort();
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on("response", async (resp) => {
    const u = resp.url();
    if (!u.startsWith(origin) || seenResp.has(u)) return;
    const ct = resp.headers()["content-type"] || "";
    if (!TEXTY.test(ct)) return;
    seenResp.add(u);
    try { scan(await resp.text(), `${app.name}: response ${ct.split(";")[0]}`, u); } catch { /* body gone (redirect) */ }
  });

  const queue = [...new Set((app.routes || [""]).map((r) => `${base}/${r.replace(/^\/+/, "")}`.replace(/\/$/, "") || base))];
  const visited = new Set();
  const max = cfg.maxPages || 120;
  const perPattern = new Map();
  while (queue.length && visited.size < max) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    // at most 3 pages per dynamic pattern (e.g. /migrations/<id>) keeps the crawl short
    const pattern = url.replace(origin, "").replace(/\/[0-9a-f]{8,}|\/[a-z0-9-]+-(api|sys|proc|exp)[a-z0-9-]*/gi, "/:x");
    const n = perPattern.get(pattern) || 0;
    if (n >= 3) continue;
    perPattern.set(pattern, n + 1);
    visited.add(url);
    let status = 0;
    try {
      const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      status = r?.status() || 0;
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(600);
    } catch (e) {
      pages.push({ app: app.name, url, status, error: String(e).slice(0, 160) });
      continue;
    }
    const grab = async (label) => {
      const title = await page.title();
      const text = await page.evaluate(() => document.body?.innerText || "");
      const htmlSrc = await page.content();
      scan(title, `${app.name}: page title${label}`, url);
      scan(text, `${app.name}: visible text${label}`, url);
      scan(htmlSrc, `${app.name}: HTML${label}`, url);
      return { title, chars: text.length };
    };
    const info = await grab("");
    // open each tab of the page (tabs only, never buttons)
    const tabs = await page.locator('[role="tab"]').all().catch(() => []);
    let tabCount = 0;
    for (const t of tabs.slice(0, 10)) {
      try {
        if (!(await t.isVisible())) continue;
        await t.click({ timeout: 3000 });
        await page.waitForTimeout(500);
        await grab(` (tab "${((await t.innerText()) || "").trim().slice(0, 30)}")`);
        tabCount++;
      } catch { /* tab not clickable */ }
    }
    pages.push({ app: app.name, url, status, title: info.title, chars: info.chars, tabs: tabCount });
    if (cfg.shots) {
      mkdirSync(cfg.shots, { recursive: true });
      await page.screenshot({ path: `${cfg.shots}/${app.name}-${visited.size}.png` }).catch(() => {});
    }
    const links = await page.$$eval("a[href]", (as) => as.map((a) => ({ href: a.href, download: a.hasAttribute("download") })));
    for (const { href, download } of links) {
      if (!href.startsWith(origin)) continue;
      const path = new URL(href).pathname;
      if (/logout|sign-?out/i.test(path)) continue;
      if (download || path.includes("/api/")) { downloads.add(href); continue; }
      if (basePath && !path.startsWith(basePath)) continue;
      const clean = href.split("#")[0];
      if (!visited.has(clean)) queue.push(clean);
    }
  }
  await ctx.close();
}
await browser.close();
writeFileSync(cfg.out, JSON.stringify({ hits, counts, pages, downloads: [...downloads], responsesScanned: seenResp.size, blocked }, null, 1));
console.log(`crawl: ${pages.length} pages, ${seenResp.size} responses scanned, ${Object.values(counts).reduce((x, y) => x + y, 0)} hits, ${blocked.length} non-GET requests blocked`);
