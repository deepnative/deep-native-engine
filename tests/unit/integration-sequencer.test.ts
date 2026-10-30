import { expect, it } from "vitest";
import { resolve } from "node:path";
import {
  BaseSequencer,
  type TestSpecification,
  type Vitest,
} from "vitest/node";
import config from "../../vitest.integration.config.ts";

const Sequencer = config.test?.sequence?.sequencer ?? BaseSequencer;

const root = resolve("/synthetic/integration-sequence");
const names = [
  "tests/integration/alpha.test.ts",
  "tests/integration/assignment-evidence.test.ts",
  "tests/integration/bravo.test.ts",
  "tests/integration/charlie.test.ts",
  "tests/integration/delta.test.ts",
  "tests/integration/echo.test.ts",
];
const project = {
  name: "integration",
  config: { isolate: true, sequence: { groupOrder: 0 } },
};
const specs = (files: string[]): TestSpecification[] =>
  files.map((name) => ({
    moduleId: resolve(root, name),
    project,
  })) as unknown as TestSpecification[];
const ids = (files: TestSpecification[]) => files.map((file) => file.moduleId);
const context = (index: number): Vitest =>
  ({
    config: { root, shard: { index, count: 2 } },
    cache: {
      getFileTestResults: (key: string) => ({
        failed: false,
        duration: names.length - names.findIndex((name) => key.endsWith(name)),
      }),
      getFileStats: () => undefined,
    },
  }) as unknown as Vitest;

it("CIBUDGET-ORDER01 prioritizes only the exact selected file and preserves the inherited order", async () => {
  const files = specs(names);
  const original = ids(files);
  const baseline = await new BaseSequencer(context(1)).sort(files);
  const ordered = await new Sequencer(context(1)).sort(files);
  const target = resolve(root, "tests/integration/assignment-evidence.test.ts");
  expect(ordered[0]?.moduleId).toBe(target);
  expect(ids(ordered).filter((id) => id !== target)).toEqual(
    ids(baseline).filter((id) => id !== target),
  );
  expect([...ids(ordered)].sort()).toEqual([...original].sort());
  expect(ids(files)).toEqual(original);

  const withoutTarget = specs([
    "tests/integration/alpha.test.ts",
    "tests/integration/other/assignment-evidence.test.ts",
    "tests/integration/bravo.test.ts",
  ]);
  expect(ids(await new Sequencer(context(1)).sort(withoutTarget))).toEqual(
    ids(await new BaseSequencer(context(1)).sort(withoutTarget)),
  );
});

it("CIBUDGET-ORDER02 keeps BaseSequencer's two hash shard memberships", async () => {
  const files = specs(names);
  const base: string[][] = [];
  const changed: string[][] = [];
  for (const index of [1, 2]) {
    const ctx = context(index);
    base.push(ids(await new BaseSequencer(ctx).shard(files)));
    const lane = await new Sequencer(ctx).shard(files);
    changed.push(ids(lane));
    expect(ids(lane)).toEqual(base[index - 1]);
    const sorted = await new Sequencer(ctx).sort(lane);
    if (
      ids(lane).includes(
        resolve(root, "tests/integration/assignment-evidence.test.ts"),
      )
    )
      expect(sorted[0]?.moduleId).toBe(
        resolve(root, "tests/integration/assignment-evidence.test.ts"),
      );
    expect([...ids(sorted)].sort()).toEqual([...ids(lane)].sort());
  }
  expect(changed[0]?.filter((id) => changed[1]?.includes(id))).toEqual([]);
  expect(changed.flat().sort()).toEqual(ids(files).sort());
  expect(changed).toEqual(base);
});
