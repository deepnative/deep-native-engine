import { defineConfig } from "vitest/config";
import diagnostics from "./tests/support/integration-diagnostics-reporter.ts";
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: false,
    allowOnly: false,
    retry: 0,
    fileParallelism: false,
    reporters: ["default", "json", diagnostics],
    outputFile: { json: "artifacts/integration-results.json" },
  },
});
