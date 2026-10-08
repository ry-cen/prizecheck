import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./web/tests",
  outputDir: process.env.TEST_BROWSER_OUTPUT || "test-results",
  workers: 1,
  use: { browserName: "chromium", headless: true },
  reporter: "list",
});
