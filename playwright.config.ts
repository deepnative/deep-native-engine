import { browserOrigin } from "./tests/support/browser-origin.js";
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  forbidOnly: true,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  reporter: [["list"], ["json", { outputFile: "artifacts/e2e-results.json" }]],
  outputDir: "artifacts/browser-results",
  use: { baseURL: browserOrigin, trace: "retain-on-failure" },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node dist/main.js",
    url: browserOrigin,
    timeout: 30000,
    reuseExistingServer: false,
    env: {
      DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL!,
      DNE_PORT: new URL(browserOrigin).port,
      DNE_APP_MODE: "test",
      DNE_LOCAL_STAFF_ENTRY: "enabled",
      DNE_PREPARED_REVIEW_SAMPLES: "enabled",
      DNE_LOCAL_SUPPORT_ASSIGNMENT: "enabled",
      DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION: "enabled",
      DNE_REVIEW_TIME_WRITES: "enabled",
      DNE_REVIEW_TIME_GRANT_ADMINISTRATION: "enabled",
      DNE_SUPPORT_TIME_GRANT_ADMINISTRATION: "enabled",
      DNE_LOCAL_AI_HOLD_INSPECTION: "enabled",
      DNE_PRIVATE_STORAGE_ROOT: process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!,
    },
  },
});
