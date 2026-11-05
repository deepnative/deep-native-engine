/** Cleanup that runs after a test's own budget (#677).
 *
 * DROP DATABASE waits for a forced checkpoint, which under eight integration
 * lanes can take 30-75s. A test adds its cleanup steps and calls release()
 * once it has stopped using them (for example after closing its pools). An
 * afterAll hook then awaits run(): it waits for release, even when the test
 * timed out and is still finishing, runs every step in order and rejects if
 * any step failed. */
export function deferredCleanup() {
  const steps: Array<{ label: string; step: () => unknown }> = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    add(label: string, step: () => unknown) {
      steps.push({ label, step });
    },
    release() {
      release();
    },
    async run() {
      if (steps.length === 0) return;
      await released;
      const failed: Array<{ label: string; error: unknown }> = [];
      for (const { label, step } of steps.splice(0)) {
        try {
          await step();
        } catch (error) {
          failed.push({ label, error });
        }
      }
      if (failed.length)
        throw new AggregateError(
          failed.map(({ error }) => error),
          `Deferred cleanup failed: ${failed.map(({ label }) => label).join("; ")}`,
        );
    },
  };
}
