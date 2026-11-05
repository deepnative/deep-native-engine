import { describe, expect, it } from "vitest";
import { deferredCleanup } from "../support/deferred-cleanup.ts";

// #677: DROP DATABASE waits for a forced checkpoint, which can take 30-75s
// under eight integration lanes. Cleanup runs after the test's own budget,
// but it still runs every step and still fails the run on any failure.
describe("deferred cleanup outside a test budget", () => {
  it("CLEANUP-01 waits for the owning test to release its resources, then runs steps in order", async () => {
    const cleanup = deferredCleanup();
    const order: string[] = [];
    cleanup.add("drop databases", async () => {
      order.push("drop");
    });
    cleanup.add("close admin", async () => {
      order.push("close");
    });
    let finished = false;
    const running = cleanup.run().then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    expect(order).toEqual([]);
    cleanup.release();
    await running;
    expect(order).toEqual(["drop", "close"]);
  });

  it("CLEANUP-02 runs every step after a failure and rejects naming each failed step", async () => {
    const cleanup = deferredCleanup();
    const ran: string[] = [];
    cleanup.add("drop databases", async () => {
      ran.push("drop");
      throw new Error("drop refused");
    });
    cleanup.add("close admin", async () => {
      ran.push("close");
    });
    cleanup.add("remove files", () => {
      ran.push("remove");
      throw new Error("remove refused");
    });
    cleanup.release();
    const failure = await cleanup.run().catch((error: unknown) => error);
    expect(ran).toEqual(["drop", "close", "remove"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      "Deferred cleanup failed: drop databases; remove files",
    );
    expect((failure as AggregateError).errors).toHaveLength(2);
  });

  it("CLEANUP-03 does nothing when the test registered no resources", async () => {
    await expect(deferredCleanup().run()).resolves.toBeUndefined();
  });

  it("CLEANUP-04 runs each step once, even if run is called again", async () => {
    const cleanup = deferredCleanup();
    let drops = 0;
    cleanup.add("drop databases", async () => {
      drops += 1;
    });
    cleanup.release();
    await cleanup.run();
    await cleanup.run();
    expect(drops).toBe(1);
  });
});
