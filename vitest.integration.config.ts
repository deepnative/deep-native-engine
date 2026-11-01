import { resolve } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { defineConfig } from "vitest/config";
import diagnostics from "./tests/support/integration-diagnostics-reporter.ts";
const priorityFiles = [
  "tests/integration/assignment-evidence.test.ts",
  "tests/integration/program-enrollment-lifetime.test.ts",
];

class IntegrationSequencer extends BaseSequencer {
  override async sort(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const priorities = priorityFiles.map((file) =>
      resolve(this.ctx.config.root, file),
    );
    return [
      ...priorities.flatMap((target) =>
        sorted.filter(({ moduleId }) => resolve(moduleId) === target),
      ),
      ...sorted.filter(
        ({ moduleId }) => !priorities.includes(resolve(moduleId)),
      ),
    ];
  }
}
const shard = process.env.DNE_INTEGRATION_SHARD;
if (shard !== undefined && !["1", "2", "3", "4"].includes(shard))
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
