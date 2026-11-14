// Screenshots and layout checks for the Gateway console.
// usage: node scripts/shots.mjs <baseUrl> <outDir> <path1,path2,...> [light|dark] [sizes: desktop,tablet,phone]
// Reports per page: crash text, console errors, sideways overflow and the elements that cause it.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const [base, out, paths, theme = "light", only = "desktop,tablet,phone"] = process.argv.slice(2);
const sizes = { desktop: [1440, 900], tablet: [820, 1180], phone: [390, 844] };
mkdirSync(out, { recursive: true });
const b = await chromium.launch();
let bad = 0;
for (const name of only.split(",")) {
  const [w, h] = sizes[name];
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("theme", t); } catch { /* storage blocked */ } }, theme);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200)); });
  for (const p of paths.split(",")) {
    errs.length = 0;
    await page.goto(base + p, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => errs.push("nav: " + e.message));
    await page.waitForTimeout(3500);
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const crashed = /hit an error|could not load/i.test(text);
    const info = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const wide = [];
      for (const el of document.querySelectorAll("main *")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 2) {
          // ignore content inside a box that scrolls on its own
          let p = el.parentElement, scrolls = false;
          while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") { scrolls = true; break; } p = p.parentElement; }
          if (!scrolls) wide.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} right=${Math.round(r.right)}`);
        }
      }
      return { overflow: document.documentElement.scrollWidth - vw, wide: wide.slice(0, 6), h1: document.querySelector("main h1")?.textContent ?? "" };
    });
    const f = `${out}/${theme}-${name}${p.replace(/[/?=&:,%]/g, "_") || "_root"}.png`;
    await page.screenshot({ path: f, fullPage: true });
    if (crashed || errs.length || info.overflow > 2 || info.wide.length) bad++;
    console.log(JSON.stringify({ size: name, path: p, crashed, hOverflowPx: info.overflow, wide: info.wide, h1: info.h1, chars: text.length, errs }));
  }
  await ctx.close();
}
await b.close();
console.log(bad ? `PROBLEMS: ${bad}` : "ALL CLEAN");
