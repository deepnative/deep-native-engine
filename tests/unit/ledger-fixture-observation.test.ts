import { expect, it } from "vitest";
import { ledgerFixtureObservation } from "../support/ledger-fixture-observation.ts";

function latch<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const wait = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { wait, resolve, reject };
}
function observe() {
  const meta: Record<string, unknown> = {};
  return { meta, observer: ledgerFixtureObservation(meta) };
}

it("STAGE01 retains both independently pending seeds and unchanged action values", async () => {
  const { meta, observer } = observe(),
    retired = latch<string>(),
    survivor = latch<string>(),
    first = observer.step("retired-seed", () => retired.wait),
    second = observer.step("survivor-seed", () => survivor.wait);
  expect(meta.ledgerFixtureObservation).toMatchObject({
    capture: "open",
    events: [
      { phase: "retired-seed", state: "pending" },
      { phase: "survivor-seed", state: "pending" },
    ],
  });
  retired.resolve("private-retired-result");
  expect(await first).toBe("private-retired-result");
  expect(meta.ledgerFixtureObservation).toMatchObject({
    events: [{ state: "completed" }, { state: "pending" }],
  });
  survivor.resolve("private-survivor-result");
  expect(await second).toBe("private-survivor-result");
  observer.seal();
  expect(JSON.stringify(meta)).not.toContain("private-");
  const value = meta.ledgerFixtureObservation as {
    capturedMs: number;
    events: { startedMs: number; durationMs: number }[];
  };
  expect(value.capturedMs).toBeGreaterThanOrEqual(0);
  for (const event of value.events) {
    expect(event.startedMs).toBeGreaterThanOrEqual(0);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  }
});

it("STAGE02 rethrows the exact original rejection without serializing its contents", async () => {
  const { meta, observer } = observe(),
    original = Error("private connection or member value");
  await expect(
    observer.step("ordinary-erasure", async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  observer.seal();
  expect(meta.ledgerFixtureObservation).toMatchObject({
    events: [{ phase: "ordinary-erasure", state: "rejected" }],
  });
  expect(JSON.stringify(meta)).not.toContain("private");
});

it("STAGE03 preserves the sealed pending snapshot when late work resolves or rejects", async () => {
  const { meta, observer } = observe(),
    resolved = latch<string>(),
    rejected = latch<string>(),
    original = Error("private late error"),
    first = observer.step("retired-seed", () => resolved.wait),
    second = observer.step("survivor-seed", () => rejected.wait),
    failure = expect(second).rejects.toBe(original);
  observer.seal();
  const captured = JSON.stringify(meta);
  resolved.resolve("private late value");
  rejected.reject(original);
  expect(await first).toBe("private late value");
  await failure;
  let calls = 0;
  expect(
    await observer.step("analyze-after-erasure", async () => ++calls),
  ).toBe(1);
  observer.seal();
  expect(calls).toBe(1);
  expect(JSON.stringify(meta)).toBe(captured);
  expect(meta.ledgerFixtureObservation).toMatchObject({
    capture: "after-each",
    events: [{ state: "pending" }, { state: "pending" }],
  });
});

it("STAGE04 refuses unknown runtime labels without starting work or exposing values", async () => {
  const { meta, observer } = observe();
  let calls = 0;
  await expect(
    observer.step("private-runtime-label" as never, async () => ++calls),
  ).rejects.toThrow("Unknown fixture stage");
  expect(calls).toBe(0);
  expect(JSON.stringify(meta)).not.toContain("private-runtime-label");
  expect(meta.ledgerFixtureObservation).toMatchObject({ events: [] });
});
