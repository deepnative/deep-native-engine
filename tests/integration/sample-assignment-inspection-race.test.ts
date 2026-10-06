import type { Pool, PoolClient } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate } from "../../src/store.ts";
import { sampleAssignmentStore } from "../../src/sample-assignment.ts";
import type { SampleAssignmentStore } from "../../src/sample-assignment-values.ts";
import { testPool } from "../support/database.ts";
import {
  sampleAssignmentFixture,
  waitForSampleAssignmentBlock,
} from "../support/sample-assignment.ts";

const pool = testPool();
let root = "";
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne480-inspection-race-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
afterAll(() => pool.end());
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
const changes = [
  {
    name: "administrator revocation",
    target: "administratorId",
    table: "principals",
    column: "id",
    sql: "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
  },
  {
    name: "administrator role",
    target: "administratorId",
    table: "staff_profiles",
    column: "principal_id",
    sql: "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1",
  },
  {
    name: "reviewer revocation",
    target: "reviewerId",
    table: "principals",
    column: "id",
    sql: "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
  },
  {
    name: "reviewer role",
    target: "reviewerId",
    table: "staff_profiles",
    column: "principal_id",
    sql: "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1",
  },
  {
    name: "member revocation",
    target: "ownerId",
    table: "principals",
    column: "id",
    sql: "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
  },
  {
    name: "consent withdrawal",
    target: "evidenceId",
    table: "evidence_objects",
    column: "id",
    sql: "UPDATE evidence_objects SET private_review_allowed=false,private_review_revoked_at=clock_timestamp() WHERE id=$1",
  },
  {
    name: "source deletion",
    target: "evidenceId",
    table: "evidence_objects",
    column: "id",
    sql: "DELETE FROM evidence_objects WHERE id=$1",
  },
  {
    name: "workspace deletion",
    target: "ownerId",
    table: "workspaces",
    column: "id",
    sql: "DELETE FROM workspaces WHERE id=$1",
  },
] as const;
for (const method of ["check", "history", "revoke"] as const) {
  for (const order of ["change first", "operation first"] as const) {
    it.each(changes)(
      `REVADM-07 ${method}, ${order}, serializes $name using actual PostgreSQL fences`,
      async (change) => {
        const f = await sampleAssignmentFixture(pool, root);
        const assigned = await f.assignments.assign(
          f.administratorToken,
          f.input,
        );
        if (assigned.kind !== "applied")
          throw Error("Invented assignment unavailable");
        const source = { evidenceId: f.input.evidenceId, sourceRevision: 1 };
        const target =
          change.target === "evidenceId"
            ? f.input.evidenceId
            : f[change.target];
        const invoke = (store: SampleAssignmentStore) =>
          method === "check"
            ? store.check(f.administratorToken, {
                ...source,
                reviewerId: f.reviewerId,
              })
            : method === "history"
              ? store.history(f.administratorToken, source)
              : store.revoke(
                  f.administratorToken,
                  source,
                  assigned.row.exactGrantId,
                );
        type Result = Awaited<ReturnType<typeof invoke>>;
        let result: Result;
        if (order === "change first") {
          const holder = await pool.connect();
          let pending: Promise<Result> | undefined;
          try {
            await holder.query("BEGIN");
            await holder.query(
              `SELECT ${change.column} FROM ${change.table} WHERE ${change.column}=$1 FOR UPDATE`,
              [target],
            );
            const pid = (await holder.query("SELECT pg_backend_pid() AS pid"))
              .rows[0].pid as number;
            pending = invoke(f.assignments);
            await waitForSampleAssignmentBlock(pool, pid);
            if (change.name === "reviewer role") {
              await expect(
                holder.query(change.sql, [target]),
              ).rejects.toMatchObject({ code: "23503" });
              await holder.query("ROLLBACK");
            } else {
              await holder.query(change.sql, [target]);
              await holder.query("COMMIT");
            }
            result = await pending;
          } finally {
            await holder.query("ROLLBACK");
            holder.release();
            await Promise.allSettled(pending ? [pending] : []);
          }
        } else {
          const entered = gate(),
            resume = gate();
          let pid = 0;
          const scoped = {
            connect: async () => {
              const client = await pool.connect();
              pid = (await client.query("SELECT pg_backend_pid() AS pid"))
                .rows[0].pid as number;
              return {
                query: (async (sql: string, values?: unknown[]) => {
                  if (sql === "COMMIT") {
                    entered.release();
                    await resume.wait;
                  }
                  return client.query(sql, values);
                }) as PoolClient["query"],
                release: client.release.bind(client),
              };
            },
          } as unknown as Pool;
          const pending = invoke(
            sampleAssignmentStore(scoped, { enabled: true, mode: "test" }),
          );
          let changing: Promise<unknown> | undefined;
          try {
            await entered.wait;
            changing = pool.query(change.sql, [target]).then(
              () => "changed",
              (error) => error,
            );
            await waitForSampleAssignmentBlock(pool, pid);
            resume.release();
            result = await pending;
            if (change.name === "reviewer role")
              expect(await changing).toMatchObject({ code: "23503" });
            else expect(await changing).toBe("changed");
          } finally {
            resume.release();
            await Promise.allSettled([
              pending,
              ...(changing ? [changing] : []),
            ]);
          }
        }
        const authorityLost =
          change.name.startsWith("administrator") ||
          change.name === "workspace deletion";
        const checkedSourceLost = change.name !== "reviewer role";
        if (
          order === "change first" &&
          (authorityLost || (method === "check" && checkedSourceLost))
        ) {
          expect(result).toEqual({ kind: "denied" });
        } else if (method === "check")
          expect(result).toMatchObject({
            kind: "ready",
            check: { ...source, reviewerId: f.reviewerId },
          });
        else if (method === "history") {
          const state =
            order === "operation first" ||
            change.name === "reviewer role" ||
            change.name === "member revocation"
              ? "active"
              : change.name === "source deletion"
                ? "removed"
                : "ineffective";
          expect(result).toMatchObject({
            kind: "ready",
            history: {
              rows: [{ receiptId: assigned.row.receiptId, state }],
              next: null,
            },
          });
        } else
          expect(result).toMatchObject({
            kind:
              order === "change first" && change.name === "source deletion"
                ? "unchanged"
                : "revoked",
            row: {
              state:
                order === "change first" && change.name === "source deletion"
                  ? "removed"
                  : "revoked",
            },
          });
        if (
          change.name === "reviewer revocation" ||
          change.name === "consent withdrawal" ||
          change.name === "source deletion" ||
          change.name === "workspace deletion"
        )
          expect(
            (await f.feedback.reviewer(f.reviewerToken, f.input.evidenceId))
              .kind,
          ).toBe("denied");
        const events = (
          await pool.query("SELECT action FROM authorization_audit ORDER BY id")
        ).rows;
        expect(
          events.filter((row) => row.action === "grant_created"),
        ).toHaveLength(change.name === "workspace deletion" ? 0 : 2);
        expect(
          events.filter((row) => row.action === "grant_revoked"),
        ).toHaveLength(
          change.name === "workspace deletion"
            ? 0
            : method === "revoke" && result.kind === "revoked"
              ? 1
              : 0,
        );
      },
    );
  }
}
