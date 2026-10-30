import { defineConfig } from "vitest/config";
import diagnostics from "./tests/support/integration-diagnostics-reporter.ts";
const shard = process.env.DNE_INTEGRATION_SHARD;
if (shard !== undefined && shard !== "1" && shard !== "2")
  throw Error("Invalid integration lane");
export default defineConfig({
  ...(shard
    ? { cacheDir: `node_modules/.vite/integration-lane-${shard}` }
    : {}),
  test: {
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: false,
    allowOnly: false,
    retry: 0,
    fileParallelism: false,
    reporters: ["default", "json", diagnostics],
    outputFile: {
      json: shard
        ? `artifacts/integration-shards/${shard}/results.json`
        : "artifacts/integration-results.json",
    },
  },
});
