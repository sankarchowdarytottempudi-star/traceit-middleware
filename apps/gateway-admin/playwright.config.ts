import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:4317", viewport: { width: 1440, height: 900 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: { command: "pnpm preview --port 4317 --strictPort", port: 4317, reuseExistingServer: false, timeout: 60000 },
});
