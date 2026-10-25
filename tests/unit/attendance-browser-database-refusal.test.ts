import type { Pool } from "pg";
import { expect, it } from "vitest";
import { dropAttendanceBrowserDatabase } from "../support/attendance-browser-database.ts";

it("CI-ATTEND-02 refuses deletion when the owned-session read times out", async () => {
  const readTimeout = new Error("Query read timeout");
  const queries: unknown[] = [];
  const control = {
    async query(query: unknown) {
      queries.push(query);
      throw readTimeout;
    },
  } as unknown as Pool;

  await expect(
    dropAttendanceBrowserDatabase(control, `dne_test_${"a".repeat(32)}`),
  ).rejects.toMatchObject({
    message: "Owned browser database still active; no forced deletion",
    cause: readTimeout,
  });
  expect(queries).toHaveLength(1);
  expect(queries[0]).toMatchObject({
    text: expect.stringContaining("pg_stat_activity"),
  });
});
