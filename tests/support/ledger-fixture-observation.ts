const phases = [
  "retired-member",
  "survivor-fixture",
  "retired-seed",
  "survivor-seed",
  "analyze-before-erasure",
  "counts-before-erasure",
  "ordinary-erasure",
  "counts-after-erasure",
  "analyze-after-erasure",
] as const;
type Phase = (typeof phases)[number];
type Event = {
  phase: Phase;
  startedMs: number;
  state: "pending" | "completed" | "rejected";
  durationMs?: number;
};

// Only code-owned labels and relative timings enter Vitest's original JSON.
// A timed-out hook can keep settling: afterEach seals its diagnostic snapshot
// without cancelling, replacing, or suppressing any original operation/error.
export function ledgerFixtureObservation(meta: object) {
  const started = performance.now();
  const observation: {
    schema: "ledger-fixture-observation-v1";
    capture: "open" | "after-each";
    capturedMs?: number;
    events: Event[];
  } = {
    schema: "ledger-fixture-observation-v1",
    capture: "open",
    events: [],
  };
  Object.assign(meta, { ledgerFixtureObservation: observation });
  let sealed = false;
  return {
    async step<T>(phase: Phase, action: () => Promise<T>): Promise<T> {
      if (!phases.includes(phase)) throw Error("Unknown fixture stage");
      if (sealed) return action();
      const event: Event = {
        phase,
        startedMs: performance.now() - started,
        state: "pending",
      };
      observation.events.push(event);
      try {
        const value = await action();
        if (!sealed) {
          event.durationMs = performance.now() - started - event.startedMs;
          event.state = "completed";
        }
        return value;
      } catch (error) {
        if (!sealed) {
          event.durationMs = performance.now() - started - event.startedMs;
          event.state = "rejected";
        }
        throw error;
      }
    },
    seal() {
      if (sealed) return;
      sealed = true;
      observation.capturedMs = performance.now() - started;
      observation.capture = "after-each";
    },
  };
}
