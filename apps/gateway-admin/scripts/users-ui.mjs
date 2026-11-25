// Signed-in UI check of Users and access against the real Gateway BFF (local accounts, temp users file).
// usage: node ui-run.mjs <base> <outDir>
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const [base, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const b = await chromium.launch();
let fails = 0;
const ok = (c, m) => { console.log(`${c ? "  ok " : "  FAIL"} ${m}`); if (!c) fails++; };
async function signIn(page, email, pw) {
  await page.goto(`${base}/api/auth/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle").catch(() => {});
}
for (const [name, w, h] of [["desktop", 1440, 900], ["phone", 390, 844]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`${base}/api/auth/login`);
  await page.screenshot({ path: `${out}/${name}-signin.png`, fullPage: true });
  ok(await page.locator("text=Sign in with Microsoft").count() === 1, `${name}: sign-in page offers Microsoft`);
  await signIn(page, "ops@cruisesaudi.example", "bootstrap password 2026");
  await page.goto(`${base}/users`); await page.waitForTimeout(1500);
  ok(await page.locator("h1", { hasText: "Users and access" }).count() === 1, `${name}: Users and access opens`);
  if (name === "desktop") {
    await page.getByRole("button", { name: "Add person" }).click();
    await page.selectOption("#add-kind", "local");
    await page.fill("#add-email", "mig.user@cruisesaudi.example"); await page.fill("#add-name", "Migration User");
    await page.fill("#add-password", "migration only 2026");
    await page.uncheck("#add-migration").catch(() => {}); await page.check("#add-migration");
    await page.screenshot({ path: `${out}/${name}-add-person.png` });
    await page.getByRole("button", { name: "Add person", exact: true }).last().click();
    await page.waitForTimeout(1000);
    ok(await page.locator("text=mig.user@cruisesaudi.example").count() >= 1, "added a Weave account");
    await page.getByRole("button", { name: "Add person" }).first().click();
    await page.fill("#add-email", "ana.q@cruisesaudi.example"); await page.check("#add-gateway");
    await page.getByRole("button", { name: "Invite" }).click(); await page.waitForTimeout(1000);
    ok(await page.locator("text=ana.q@cruisesaudi.example").count() >= 1, "invited a Microsoft account");
  }
  await page.screenshot({ path: `${out}/${name}-people.png`, fullPage: true });
  if (name === "desktop") {
    await page.locator("tr", { hasText: "mig.user@cruisesaudi.example" }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${out}/${name}-edit-person.png` });
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: /Directory groups/ }).click();
    await page.getByRole("button", { name: "Add group" }).click();
    await page.locator('input[placeholder^="00000000"]').fill("3f1c2a7e-0b5d-4d61-9a0e-6c2f8e1b7d42");
    await page.locator('input[placeholder="Weave Gateway users"]').fill("Weave - Gateway");
    await page.locator('[role="group"] label', { hasText: "Gateway" }).locator("input").check();
    await page.getByRole("button", { name: "Save groups" }).click(); await page.waitForTimeout(800);
    ok(await page.locator("text=Saved.").count() === 1, "saved a group mapping");
    await page.screenshot({ path: `${out}/${name}-groups.png`, fullPage: true });
    await page.getByRole("tab", { name: /Audit log/ }).click(); await page.waitForTimeout(1200);
    ok(await page.locator("text=user.invite").count() >= 1, "audit log shows the invite");
    await page.screenshot({ path: `${out}/${name}-audit.png`, fullPage: true });
  }
  ok(errs.length === 0, `${name}: no page errors ${errs.join(" | ")}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 2, `${name}: no sideways scroll (${overflow}px)`);
  await ctx.close();
}
// The Migration-only person: no Gateway nav, no Users item.
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await signIn(page, "mig.user@cruisesaudi.example", "migration only 2026");
await page.goto(`${base}/`); await page.waitForTimeout(1500);
ok(await page.locator("text=No access to the Gateway console").count() >= 1, "migration-only: Gateway says no access");
ok(await page.locator("a", { hasText: "Rate limiting" }).count() === 0, "migration-only: Gateway nav hidden");
ok(await page.locator("a", { hasText: "Users and access" }).count() === 0, "migration-only: Users item hidden");
const r = await page.evaluate(async () => (await fetch("/api/ratelimits/subscription")).status);
ok(r === 403, `migration-only: server refuses a Gateway call (${r})`);
await page.screenshot({ path: `${out}/desktop-migration-only.png`, fullPage: true });
await ctx.close();
await b.close();
console.log(fails ? `FAILED: ${fails}` : "ALL OK");
