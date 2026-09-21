import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: false,
    allowOnly: false,
    retry: 0,
    fileParallelism: false,
    reporters: ["default", "json"],
    outputFile: { json: "artifacts/integration-results.json" },
  },
});
