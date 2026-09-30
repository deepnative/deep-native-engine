import { defineConfig } from "@playwright/test";

const engines = ["chromium", "firefox", "webkit"] as const;
const viewports = [
  { name: "desktop", viewport: { width: 1280, height: 720 } },
  { name: "narrow", viewport: { width: 390, height: 844 } },
] as const;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/accessibility.spec.ts",
  forbidOnly: true,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  reporter: [
    ["list"],
    ["json", { outputFile: "artifacts/e2e-cross-browser-results.json" }],
  ],
  outputDir: "artifacts/browser-cross-browser-results",
  use: { baseURL: "http://127.0.0.1:4317", trace: "retain-on-failure" },
  projects: engines.flatMap((browserName) =>
    viewports.map(({ name, viewport }) => ({
      name: `${name}-${browserName}`,
      use: { browserName, viewport },
    })),
  ),
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
