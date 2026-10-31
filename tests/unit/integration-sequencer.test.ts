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
  "tests/integration/program-enrollment-lifetime.test.ts",
];
const priorityIds = [
  resolve(root, "tests/integration/assignment-evidence.test.ts"),
  resolve(root, "tests/integration/program-enrollment-lifetime.test.ts"),
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
const context = (index: number, reversed = false): Vitest =>
  ({
    config: { root, shard: { index, count: 2 } },
    cache: {
      getFileTestResults: (key: string) => {
        const position = names.findIndex((name) => key.endsWith(name));
        return {
          failed: reversed ? position % 2 === 0 : position % 2 !== 0,
          duration: reversed ? position + 1 : names.length - position,
        };
      },
      getFileStats: () => undefined,
    },
  }) as unknown as Vitest;

it("CIBUDGET-ORDER01 prioritizes only the two exact files and preserves inherited order", async () => {
  const files = specs(names);
  const original = ids(files);
  const baseline = await new BaseSequencer(context(1)).sort(files);
  const ordered = await new Sequencer(context(1)).sort(files);
  expect(ids(ordered).slice(0, 2)).toEqual(priorityIds);
  expect(ids(ordered).filter((id) => !priorityIds.includes(id))).toEqual(
    ids(baseline).filter((id) => !priorityIds.includes(id)),
  );
  expect([...ids(ordered)].sort()).toEqual([...original].sort());
  expect(ids(files)).toEqual(original);

  const withoutTargets = specs([
    "tests/integration/alpha.test.ts",
    "tests/integration/other/assignment-evidence.test.ts",
    "tests/integration/other/program-enrollment-lifetime.test.ts",
    "tests/integration/bravo.test.ts",
  ]);
  expect(ids(await new Sequencer(context(1)).sort(withoutTargets))).toEqual(
    ids(await new BaseSequencer(context(1)).sort(withoutTargets)),
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
    const lanePriorities = priorityIds.filter((id) => ids(lane).includes(id));
    expect(ids(sorted).slice(0, lanePriorities.length)).toEqual(lanePriorities);
    expect([...ids(sorted)].sort()).toEqual([...ids(lane)].sort());
  }
  expect(changed[0]?.filter((id) => changed[1]?.includes(id))).toEqual([]);
  expect(changed.flat().sort()).toEqual(ids(files).sort());
  expect(changed).toEqual(base);
});

it("CIBUDGET-ORDER03 keeps priorities and inherited unrelated order across cache states", async () => {
  const files = specs(names);
  const unrelatedOrders: string[][] = [];
  for (const reversed of [false, true]) {
    const ctx = context(1, reversed);
    const baseline = ids(await new BaseSequencer(ctx).sort(files));
    const ordered = ids(await new Sequencer(ctx).sort(files));
    expect(ordered.slice(0, 2)).toEqual(priorityIds);
    expect(ordered.filter((id) => !priorityIds.includes(id))).toEqual(
      baseline.filter((id) => !priorityIds.includes(id)),
    );
    unrelatedOrders.push(baseline.filter((id) => !priorityIds.includes(id)));
  }
  expect(unrelatedOrders[0]).not.toEqual(unrelatedOrders[1]);
});
