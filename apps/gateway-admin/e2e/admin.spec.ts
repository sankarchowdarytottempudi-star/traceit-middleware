import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./mocks";
import { mkdirSync } from "node:fs";

const routes = [
  { path: "/", name: "overview" },
  { path: "/rate-limits", name: "ratelimits" },
  { path: "/compliance", name: "compliance" },
  { path: "/gateways", name: "gateways" },
  { path: "/approvals", name: "approvals" },
  { path: "/apis", name: "migrated-apis" },
];
const themes = ["light", "dark"] as const;
mkdirSync("runs/gateway-admin", { recursive: true });

for (const theme of themes) {
  for (const r of routes) {
    test(`${r.name} renders in ${theme} with no console errors and no axe violations`, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript((t) => { try { localStorage.setItem("theme", t); } catch { /* */ } }, theme);
      await mockApi(page);
      await page.goto(r.path);
      await expect(page.locator("aside")).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(400);
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      await page.screenshot({ path: `runs/gateway-admin/${r.name}-${theme}.png`, fullPage: true });
      expect(errors, errors.join("\n")).toEqual([]);
      expect(serious, JSON.stringify(serious.map((v) => v.id))).toEqual([]);
    });
  }
}

test("sign-in shows when unauthenticated", async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await page.goto("/");
  await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
});

test("rate-limit drawer opens and closes with the keyboard", async ({ page }) => {
  await mockApi(page);
  await page.goto("/rate-limits");
  await page.getByRole("button", { name: "New policy" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
