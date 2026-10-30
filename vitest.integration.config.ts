import { resolve } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { defineConfig } from "vitest/config";
import diagnostics from "./tests/support/integration-diagnostics-reporter.ts";
const assignmentEvidence = "tests/integration/assignment-evidence.test.ts";

class IntegrationSequencer extends BaseSequencer {
  override async sort(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const target = resolve(this.ctx.config.root, assignmentEvidence);
    const index = sorted.findIndex(
      ({ moduleId }) => resolve(moduleId) === target,
    );
    if (index <= 0) return sorted;
    return [
      sorted[index]!,
      ...sorted.slice(0, index),
      ...sorted.slice(index + 1),
    ];
  }
}
const shard = process.env.DNE_INTEGRATION_SHARD;
if (shard !== undefined && shard !== "1" && shard !== "2")
  throw Error("Invalid integration lane");
export default defineConfig({
  ...(shard
    ? { cacheDir: `node_modules/.vite/integration-lane-${shard}` }
    : {}),
  test: {
    include: ["tests/integration/**/*.test.ts"],
    sequence: { sequencer: IntegrationSequencer },
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
