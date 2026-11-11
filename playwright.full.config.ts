import { browserOrigin } from "./tests/support/browser-origin.js";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/full-e2e",
  forbidOnly: true,
  failOnFlakyTests: true,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  reporter: [
    ["list"],
    ["json", { outputFile: "artifacts/e2e-full-results.json" }],
  ],
  outputDir: "artifacts/browser-full-results",
  metadata: {
    release: {
      runId: process.env.DNE_FULL_RELEASE_RUN_ID,
      commit: process.env.DNE_FULL_RELEASE_COMMIT,
      tree: process.env.DNE_FULL_RELEASE_TREE,
      dirty: false,
    },
  },
  use: { baseURL: browserOrigin, trace: "on" },
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
      // The same test clock the provisional run uses: F-BUILD-02-D and
      // F-ROADMAP-02-C set the time a signed evidence link is issued at.
      DNE_TEST_EVIDENCE_CLOCK: "1",
      // HOLD06D: marked invented text only; refused on hosted sites.
      DNE_TEST_AI_FAULTS: "enabled",
      DNE_PRIVATE_STORAGE_ROOT: process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!,
    },
  },
});
