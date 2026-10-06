import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { hash, migrate } from "../../src/store.ts";
import { sampleAssignmentStore } from "../../src/sample-assignment.ts";
import { testPool } from "../support/database.ts";
import { waitForSampleAssignmentBlock } from "../support/sample-assignment.ts";
const pool = testPool();
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(() => pool.end());
it("REVADM-07 revalidates the exact current credential after the administrator principal lock wait", async () => {
  const token = randomBytes(32).toString("hex"),
    changed = randomBytes(32).toString("hex");
  const id = await authorizationStore(pool).provisionStaff(
    token,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const holder = await pool.connect(),
    assignments = sampleAssignmentStore(pool, { enabled: true, mode: "test" });
  let pending: ReturnType<typeof assignments.open> | undefined;
  try {
    await holder.query("BEGIN");
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    await holder.query("UPDATE principals SET token_hash=$2 WHERE id=$1", [
      id,
      hash(changed),
    ]);
    pending = assignments.open(token);
    await waitForSampleAssignmentBlock(pool, pid);
    await holder.query("COMMIT");
    expect(await pending).toEqual({ kind: "denied" });
    expect((await assignments.open(changed)).kind).toBe("ready");
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    await Promise.allSettled(pending ? [pending] : []);
  }
});
