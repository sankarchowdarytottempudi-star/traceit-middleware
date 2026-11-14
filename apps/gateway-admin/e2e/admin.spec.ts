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
  { path: "/apis", name: "apis" },
  { path: "/analytics", name: "analytics" },
  { path: "/analytics/api/reservation-mgr-exp-api", name: "api-analytics" },
  { path: "/gateway-analytics", name: "gateway-analytics" },
  { path: "/gateway-analytics?tab=applications", name: "gateway-applications" },
  { path: "/gateway-analytics?tab=requests", name: "gateway-requests" },
  { path: "/logs", name: "logs" },
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

for (const width of [820, 390]) {
  test(`every screen fits a ${width}px wide window without sideways scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockApi(page);
    for (const r of routes) {
      await page.goto(r.path);
      await expect(page.locator("main h1")).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(350);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${r.path} overflows by ${overflow}px at ${width}px`).toBeLessThanOrEqual(2);
    }
  });
}

test("the menu opens and closes on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "APIs", exact: true }).click();
  await expect(page).toHaveURL(/\/apis$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("APIs lists published and internal services with their status", async ({ page }) => {
  await mockApi(page);
  await page.goto("/apis");
  await expect(page.getByText("cms-proc-api").first()).toBeVisible();
  await expect(page.getByText("loyalty-proc-api").first()).toBeVisible();
  await expect(page.getByText("Internal only").first()).toBeVisible();
});

test("a request in gateway analytics leads to its log lines", async ({ page }) => {
  await mockApi(page);
  await page.goto("/gateway-analytics?tab=requests");
  await page.getByRole("table", { name: "Recent requests" }).getByRole("button").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("link", { name: "Find in logs" }).click();
  await expect(page).toHaveURL(/\/logs\?cid=/);
  await expect(page.getByText("Following one request")).toBeVisible();
});

test("logs show lines and can follow a correlation id", async ({ page }) => {
  await mockApi(page);
  await page.goto("/logs");
  await expect(page.getByRole("log")).toContainText("Started CmsApplication");
  await page.getByRole("button", { name: /^follow / }).first().click();
  await expect(page).toHaveURL(/cid=153486ff/);
});
