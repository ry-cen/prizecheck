import { defineConfig } from "@playwright/test";
import { applyBrowserStack } from "./web/tests/support/browser-stack";
import { sandboxedLaunchOptions } from "./web/tests/support/launch-options";

// In the verification gate each worker gets its own stack; see web/tests/support/browser-stack.ts.
applyBrowserStack();

export default defineConfig({
  testDir: "./web/tests",
  outputDir: process.env.TEST_BROWSER_OUTPUT || "test-results",
  // scripts/run_playwright.py passes --workers; tests in one file always run in order in one worker.
  workers: 1,
  fullyParallel: false,
  // A failure keeps its trace and screenshot under TEST_BROWSER_OUTPUT/<pass>/ for diagnosis.
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: sandboxedLaunchOptions(),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: process.env.VERIFY_PLAYWRIGHT_JSON
    ? [["list"], ["json", { outputFile: process.env.VERIFY_PLAYWRIGHT_JSON }]]
    : "list",
});
