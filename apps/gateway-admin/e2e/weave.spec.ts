import { test, expect } from "@playwright/test";
import { mockApi } from "./mocks";
import { mkdirSync } from "node:fs";
mkdirSync("runs/weave-rebrand", { recursive: true });

test("sidebar shows the Weave section with the NEW badge and gateway nav", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  const aside = page.locator("aside");
  await expect(aside.getByText("Weave", { exact: true })).toBeVisible();
  await expect(aside.getByText("NEW")).toBeVisible();
  await expect(aside.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(aside.locator('[data-traceit-logo]')).toBeVisible(); // official TraceIT logo at top
  await page.screenshot({ path: "runs/weave-rebrand/sidebar-light.png" });
});

test("tab title is '<Page> · Weave Gateway'", async ({ page }) => {
  await mockApi(page);
  await page.goto("/rate-limits");
  await expect(page).toHaveTitle(/Rate limiting · Weave Gateway/);
});

test("sign-in splash shows the Weave lockup and tagline", async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await page.goto("/");
  await expect(page.locator("[data-weave-lockup='primary']")).toBeVisible();
  await expect(page.getByText("Monitor it. Weave it.")).toBeVisible();
  await page.screenshot({ path: "runs/weave-rebrand/splash-light.png" });
});

test("dark theme sidebar screenshot", async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem("theme", "dark"); } catch { /* */ } });
  await mockApi(page);
  await page.goto("/");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "runs/weave-rebrand/sidebar-dark.png" });
});

test("favicon and manifest are linked", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
  expect(await page.locator('link[rel="icon"]').first().getAttribute("href")).toContain("favicon");
});

test("About dialog shows the lockup, tagline and company line (light + dark)", async ({ page }) => {
  for (const theme of ["light", "dark"] as const) {
    await page.addInitScript((t) => { try { localStorage.setItem("theme", t); } catch { /* */ } }, theme);
    await mockApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "About" }).click();
    const dlg = page.getByRole("dialog", { name: /About TraceIT Weave/ });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByText("Monitor it. Weave it.")).toBeVisible();
    await expect(dlg.getByText(/Tottempudi Software Solutions/)).toBeVisible();
    await page.screenshot({ path: `runs/weave-rebrand/about-${theme}.png` });
  }
});

test("splash dark screenshot", async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem("theme", "dark"); } catch { /* */ } });
  await mockApi(page, { signedIn: false });
  await page.goto("/");
  await expect(page.getByText("Monitor it. Weave it.")).toBeVisible();
  await page.screenshot({ path: "runs/weave-rebrand/splash-dark.png" });
});
