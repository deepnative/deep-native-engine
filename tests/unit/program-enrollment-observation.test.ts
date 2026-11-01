import { expect, it } from "vitest";
import { programEnrollmentObservation } from "../support/program-enrollment-observation.ts";

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
  return { meta, observer: programEnrollmentObservation(meta) };
}

it("ENR-OBS01 retains independent pending admissions, exact values and only timing metadata", async () => {
  const { meta, observer } = observe(),
    a = latch<object>(),
    b = latch<object>(),
    first = observer.step("concurrent-admission-a", () => a.wait),
    second = observer.step("concurrent-admission-b", () => b.wait),
    privateValue = {
      sql: "private SQL",
      token: "private token",
      id: "private id",
    };
  expect(meta.programEnrollmentObservation).toMatchObject({
    events: [
      { phase: "concurrent-admission-a", state: "pending" },
      { phase: "concurrent-admission-b", state: "pending" },
    ],
  });
  a.resolve(privateValue);
  expect(await first).toBe(privateValue);
  expect(meta.programEnrollmentObservation).toMatchObject({
    events: [{ state: "completed" }, { state: "pending" }],
  });
  b.resolve(privateValue);
  expect(await second).toBe(privateValue);
  observer.seal();
  expect(meta).toEqual({
    programEnrollmentObservation: {
      schema: "program-enrollment-observation-v1",
      capture: "test-finished",
      capturedMs: expect.any(Number),
      events: ["concurrent-admission-a", "concurrent-admission-b"].map(
        (phase) => ({
          phase,
          startedMs: expect.any(Number),
          state: "completed",
          durationMs: expect.any(Number),
        }),
      ),
    },
  });
  expect(JSON.stringify(meta)).not.toContain("private");
  const value = meta.programEnrollmentObservation as {
    capturedMs: number;
    events: { startedMs: number; durationMs: number }[];
  };
  expect(value.capturedMs).toBeGreaterThanOrEqual(0);
  for (const event of value.events) {
    expect(event.startedMs).toBeGreaterThanOrEqual(0);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(event.startedMs + event.durationMs).toBeLessThanOrEqual(
      value.capturedMs,
    );
  }
});

it("ENR-OBS02 preserves synchronous and asynchronous errors without exposing their contents", async () => {
  const { meta, observer } = observe(),
    original = Error("private SQL, credentials, database name and member data");
  await expect(
    observer.step("open", () => {
      throw original;
    }),
  ).rejects.toBe(original);
  await expect(
    observer.step("publication", () => Promise.reject(original)),
  ).rejects.toBe(original);
  observer.seal();
  expect(meta.programEnrollmentObservation).toMatchObject({
    events: [
      { phase: "open", state: "rejected" },
      { phase: "publication", state: "rejected" },
    ],
  });
  expect(JSON.stringify(meta)).not.toContain("private");
});

it("ENR-OBS03 keeps the sealed timeout snapshot while late operations still settle unchanged", async () => {
  const { meta, observer } = observe(),
    resolved = latch<string>(),
    rejected = latch<string>(),
    original = Error("private late error"),
    first = observer.step("ready", () => resolved.wait),
    second = observer.step("create", () => rejected.wait),
    failure = expect(second).rejects.toBe(original);
  observer.seal();
  const captured = JSON.stringify(meta);
  resolved.resolve("private late value");
  rejected.reject(original);
  expect(await first).toBe("private late value");
  await failure;
  let calls = 0;
  expect(await observer.step("close", async () => ++calls)).toBe(1);
  await expect(
    observer.step("close-admin", () => Promise.reject(original)),
  ).rejects.toBe(original);
  observer.seal();
  expect(calls).toBe(1);
  expect(JSON.stringify(meta)).toBe(captured);
  expect(meta.programEnrollmentObservation).toMatchObject({
    capture: "test-finished",
    events: [{ state: "pending" }, { state: "pending" }],
  });
});

it("ENR-OBS04 permits only fixed phases and bounded loop positions without starting invalid work", async () => {
  const { meta, observer } = observe();
  let calls = 0;
  await expect(
    observer.step("private-runtime-label" as never, async () => ++calls),
  ).rejects.toThrow("Invalid enrollment observation stage");
  for (const phase of ["capacity-member", "capacity-admission"] as const) {
    for (const index of [undefined, -1, 0.5, 19, NaN, Infinity]) {
      await expect(
        observer.step(phase, async () => ++calls, index),
      ).rejects.toThrow("Invalid enrollment observation stage");
    }
  }
  await expect(observer.step("count", async () => ++calls, 0)).rejects.toThrow(
    "Invalid enrollment observation stage",
  );
  expect(calls).toBe(0);
  expect(meta.programEnrollmentObservation).toMatchObject({ events: [] });
  for (const phase of ["capacity-member", "capacity-admission"] as const) {
    for (const index of [0, 18]) {
      expect(await observer.step(phase, async () => ++calls, index)).toBe(
        calls,
      );
    }
  }
  observer.seal();
  expect(calls).toBe(4);
  expect(meta.programEnrollmentObservation).toMatchObject({
    events: [
      { phase: "capacity-member", index: 0, state: "completed" },
      { phase: "capacity-member", index: 18, state: "completed" },
      { phase: "capacity-admission", index: 0, state: "completed" },
      { phase: "capacity-admission", index: 18, state: "completed" },
    ],
  });
  expect(JSON.stringify(meta)).not.toContain("private-runtime-label");
});
