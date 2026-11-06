import { setImmediate } from "node:timers";

// Without a listener, a stopped verifier exits at once and never reaches the
// `finally` that removes its test database. The steps run through spawnSync,
// which holds up the listener until the current step ends, so a signal sent to
// the whole process group ends that step straight away, and one sent only to
// this process takes effect when it finishes.
const SIGNALS = ["SIGTERM", "SIGINT"];

export function watchInterruption() {
  let received;
  const note = (signal) => {
    received ??= signal;
  };
  for (const signal of SIGNALS) process.on(signal, note);
  return {
    /** Lets a pending signal arrive, then fails if there was one. */
    async check() {
      await new Promise((resolve) => setImmediate(resolve));
      if (received) throw Error(`Verification stopped by ${received}`);
    },
    release() {
      for (const signal of SIGNALS) process.removeListener(signal, note);
    },
  };
}
