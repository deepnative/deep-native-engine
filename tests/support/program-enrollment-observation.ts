const phases = [
  "ready",
  "create",
  "migrate",
  "seed",
  "listener",
  "publication",
  "admin",
  "open",
  "capacity-member",
  "capacity-admission",
  "final-member-a",
  "final-member-b",
  "concurrent-admission-a",
  "concurrent-admission-b",
  "count",
  "overview",
  "member",
  "receipt",
  "immutable-update",
  "retained-delete",
  "lock-connect",
  "lock-begin",
  "closure-update",
  "admission",
  "blocked",
  "closure-commit",
  "rollback",
  "close",
  "close-listener",
  "close-pool",
  "close-drain-and-drop",
  "close-admin",
] as const;
type Phase = (typeof phases)[number];
type Event = {
  phase: Phase;
  index?: number;
  startedMs: number;
  state: "pending" | "completed" | "rejected";
  durationMs?: number;
};

// Test completion seals pending work; late settlement still returns or throws
// unchanged, but cannot overwrite the original timeout's diagnostic snapshot.
export function programEnrollmentObservation(meta: object) {
  const started = performance.now();
  const observation: {
    schema: "program-enrollment-observation-v1";
    capture: "open" | "test-finished";
    capturedMs?: number;
    events: Event[];
  } = {
    schema: "program-enrollment-observation-v1",
    capture: "open",
    events: [],
  };
  Object.assign(meta, { programEnrollmentObservation: observation });
  let sealed = false;
  return {
    async step<T>(
      phase: Phase,
      action: () => Promise<T>,
      index?: number,
    ): Promise<T> {
      const indexed =
        phase === "capacity-member" || phase === "capacity-admission";
      if (
        !phases.includes(phase) ||
        (indexed
          ? !Number.isInteger(index) || index! < 0 || index! > 18
          : index !== undefined)
      )
        throw Error("Invalid enrollment observation stage");
      if (sealed) return action();
      const event: Event = {
        phase,
        ...(indexed ? { index } : {}),
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
      observation.capture = "test-finished";
    },
  };
}
export type ProgramEnrollmentObservation = ReturnType<
  typeof programEnrollmentObservation
>;
