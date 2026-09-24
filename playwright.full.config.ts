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
  use: { baseURL: "http://127.0.0.1:4317", trace: "on" },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node dist/main.js",
    url: "http://127.0.0.1:4317",
    timeout: 30000,
    reuseExistingServer: false,
    env: {
      DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL!,
      DNE_PORT: "4317",
      DNE_APP_MODE: "test",
      DNE_PRIVATE_STORAGE_ROOT: process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!,
    },
  },
});
