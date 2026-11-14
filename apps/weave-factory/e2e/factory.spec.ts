import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./mocks";
import { mkdirSync } from "node:fs";

const routes = [
  { path: "/", name: "migrations" },
  { path: "/workspaces", name: "workspaces" },
  { path: "/playground", name: "playground" },
  { path: "/knowledge", name: "knowledge" },
  { path: "/canvas", name: "canvas" },
];
const themes = ["light", "dark"] as const;
mkdirSync("runs/weave-factory", { recursive: true });

for (const theme of themes) {
  for (const r of routes) {
    test(`${r.name} renders in ${theme}, no console errors, no axe violations`, async ({ page }) => {
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
      await page.screenshot({ path: `runs/weave-factory/${r.name}-${theme}.png`, fullPage: true });
      expect(errors, errors.join("\n")).toEqual([]);
      expect(serious, JSON.stringify(serious.map((v) => v.id))).toEqual([]);
    });
  }
}

test("sidebar shows Weave with Factory active, and the TraceIT logo", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  const aside = page.locator("aside");
  await expect(aside.getByText("Weave", { exact: true })).toBeVisible();
  await expect(aside.getByText("Factory", { exact: true })).toBeVisible();
  await expect(aside.locator('[data-traceit-logo]')).toBeVisible();
});

test("tab title is 'Migrations · Weave Factory'", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page).toHaveTitle(/Migrations · Weave Factory/);
});

test("playground sends a request and shows the real response", async ({ page }) => {
  await mockApi(page);
  await page.goto("/playground");
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText(/HTTP 200/)).toBeVisible();
  await page.screenshot({ path: "runs/weave-factory/playground-response.png" });
});

test("canvas infers a mapping by example and the live preview matches", async ({ page }) => {
  await mockApi(page);
  await page.goto("/canvas");
  await page.getByRole("button", { name: /Infer mapping by example/ }).click();
  await expect(page.getByText("✓ matches the example")).toBeVisible();
  await expect(page.getByText("ref ← customer.ref")).toBeVisible();
  await page.screenshot({ path: "runs/weave-factory/canvas-mapper.png" });
});

test("sign-in splash when unauthenticated", async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await page.goto("/");
  await expect(page.locator('[data-weave-lockup="primary"]')).toBeVisible();
  await expect(page.getByText("Monitor it. Weave it.")).toBeVisible();
});

test("About dialog", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "About" }).click();
  await expect(page.getByRole("dialog", { name: /About TraceIT Weave/ })).toBeVisible();
});
