// usage: node shots.mjs <baseUrl> <outDir> <path1,path2,...>
import { chromium } from "@playwright/test";
const [base, out, paths] = process.argv.slice(2);
const sizes = { desktop: [1440, 900], tablet: [820, 1180], phone: [390, 844] };
const b = await chromium.launch();
let bad = 0;
for (const [name, [w, h]] of Object.entries(sizes)) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200)); });
  for (const p of paths.split(",")) {
    errs.length = 0;
    await page.goto(base + p, { waitUntil: "networkidle", timeout: 30000 }).catch((e) => errs.push("nav: " + e.message));
    await page.waitForTimeout(1200);
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const crashed = /hit an error|could not load/i.test(text);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const f = `${out}/${name}${p.replace(/\//g, "_") || "_root"}.png`;
    await page.screenshot({ path: f, fullPage: false });
    if (crashed || errs.length || overflow > 2) bad++;
    console.log(JSON.stringify({ size: name, path: p, crashed, hOverflowPx: overflow, chars: text.length, head: text.slice(0, 110), errs }));
  }
  await ctx.close();
}
await b.close();
console.log(bad ? `PROBLEMS: ${bad}` : "ALL CLEAN");
