import type { Pool, PoolClient } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate } from "../../src/store.ts";
import { sampleAssignmentStore } from "../../src/sample-assignment.ts";
import type { SampleAssignmentWriteResult } from "../../src/sample-assignment-values.ts";
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
  root = await mkdtemp(join(tmpdir(), "dne480-race-"));
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
it.each([
  [0, "commit"],
  [1, "commit"],
  [0, "rollback"],
  [1, "rollback"],
] as const)(
  "REVADM-05 changed payload %s owns the key first and %s decides the sole durable winner",
  async (firstIndex, completion) => {
    const firstMember = await sampleAssignmentFixture(pool, root);
    const secondMember = await sampleAssignmentFixture(pool, root);
    const inputs = [
      firstMember.input,
      { ...secondMember.input, operationId: firstMember.input.operationId },
    ];
    const entered = gate(),
      resume = gate();
    let pid = 0;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid as number;
        return {
          query: (async (sql: string, values?: unknown[]) => {
            if (
              sql.includes("INSERT INTO private_sample_assignment_operations")
            ) {
              entered.release();
              await resume.wait;
              if (completion === "rollback")
                throw Error("Invented receipt insertion failure");
            }
            return client.query(sql, values);
          }) as PoolClient["query"],
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    const first = sampleAssignmentStore(scoped, {
      enabled: true,
      mode: "test",
    }).assign(firstMember.administratorToken, inputs[firstIndex]!);
    let second: Promise<SampleAssignmentWriteResult> | undefined;
    try {
      await entered.wait;
      second = firstMember.assignments.assign(
        firstMember.administratorToken,
        inputs[1 - firstIndex]!,
      );
      await waitForSampleAssignmentBlock(pool, pid);
      resume.release();
      const a = await first,
        b = await second;
      expect(a.kind).toBe(completion === "commit" ? "applied" : "unavailable");
      expect(b.kind).toBe(completion === "commit" ? "conflict" : "applied");
      const winning =
        inputs[completion === "commit" ? firstIndex : 1 - firstIndex]!;
      const recovered = await firstMember.assignments.recover(
        firstMember.administratorToken,
        winning.operationId,
      );
      expect(recovered).toMatchObject({
        kind: "ready",
        row: {
          evidenceId: winning.evidenceId,
          reviewerId: winning.reviewerId,
          startsAt: winning.startsAt,
          expiresAt: winning.expiresAt,
        },
      });
      if (completion === "commit")
        expect(b).toMatchObject({ kind: "conflict" });
      expect(
        (
          await pool.query(`SELECT
      (SELECT count(*)::int FROM assignment_grants) AS assignments,
      (SELECT count(*)::int FROM reviewer_evidence_grants) AS exact,
      (SELECT count(*)::int FROM authorization_audit) AS audits,
      (SELECT count(*)::int FROM private_sample_assignment_operations) AS receipts`)
        ).rows[0],
      ).toEqual({ assignments: 1, exact: 1, audits: 2, receipts: 1 });
    } finally {
      resume.release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  },
);
const changes = [
  {
    name: "administrator revocation",
    sql: "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    target: "administratorId",
  },
  {
    name: "administrator role change",
    sql: "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1",
    target: "administratorId",
  },
  {
    name: "reviewer revocation",
    sql: "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    target: "reviewerId",
  },
  {
    name: "reviewer role change",
    sql: "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1",
    target: "reviewerId",
  },
  {
    name: "member revocation",
    sql: "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    target: "ownerId",
  },
  {
    name: "withdrawal",
    sql: "UPDATE evidence_objects SET private_review_allowed=false, private_review_revoked_at=clock_timestamp() WHERE id=$1",
    target: "evidenceId",
  },
  {
    name: "source deletion",
    sql: "DELETE FROM evidence_objects WHERE id=$1",
    target: "evidenceId",
  },
  {
    name: "workspace deletion",
    sql: "DELETE FROM workspaces WHERE id=$1",
    target: "ownerId",
  },
] as const;
it.each(changes)(
  "REVADM-07 $name winning its actual row fence denies a waiting pair",
  async (change) => {
    const f = await sampleAssignmentFixture(pool, root),
      holder = await pool.connect();
    let assigning: Promise<SampleAssignmentWriteResult> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      await holder.query(change.sql, [
        change.target === "evidenceId" ? f.input.evidenceId : f[change.target],
      ]);
      assigning = f.assignments.assign(f.administratorToken, f.input);
      await waitForSampleAssignmentBlock(pool, pid);
      await holder.query("COMMIT");
      expect(await assigning).toEqual({ kind: "denied" });
      expect(
        (
          await pool.query(
            "SELECT (SELECT count(*) FROM assignment_grants)::int AS grants,(SELECT count(*) FROM private_sample_assignment_operations)::int AS receipts",
          )
        ).rows[0],
      ).toEqual({ grants: 0, receipts: 0 });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled(assigning ? [assigning] : []);
    }
  },
);
it.each(changes)(
  "REVADM-07 a pair owning its source-first fences commits before $name",
  async (change) => {
    const f = await sampleAssignmentFixture(pool, root),
      entered = gate(),
      resume = gate();
    let pid = 0;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid as number;
        return {
          query: (async (sql: string, values?: unknown[]) => {
            if (
              sql.includes("INSERT INTO private_sample_assignment_operations")
            ) {
              entered.release();
              await resume.wait;
            }
            return client.query(sql, values);
          }) as PoolClient["query"],
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    const assigning = sampleAssignmentStore(scoped, {
      enabled: true,
      mode: "test",
    }).assign(f.administratorToken, f.input);
    let changing: Promise<unknown> | undefined;
    try {
      await entered.wait;
      changing = pool
        .query(change.sql, [
          change.target === "evidenceId"
            ? f.input.evidenceId
            : f[change.target],
        ])
        .then(
          () => "changed",
          (error) => error,
        );
      await waitForSampleAssignmentBlock(pool, pid);
      resume.release();
      expect((await assigning).kind).toBe("applied");
      const changed = await changing;
      if (change.name === "reviewer role change")
        expect(changed).toMatchObject({ code: "23503" });
      else expect(changed).toBe("changed");
    } finally {
      resume.release();
      await Promise.allSettled([assigning, ...(changing ? [changing] : [])]);
    }
  },
);
it("REVADM-05 a lost actual COMMIT reply keeps the one durable pair recoverable with its original key", async () => {
  const f = await sampleAssignmentFixture(pool, root),
    statements: string[] = [];
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (async (sql: string, values?: unknown[]) => {
          statements.push(sql);
          const result = await client.query(sql, values);
          if (sql === "COMMIT") throw Error("Invented lost commit response");
          return result;
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  expect(
    await sampleAssignmentStore(scoped, { enabled: true, mode: "test" }).assign(
      f.administratorToken,
      f.input,
    ),
  ).toEqual({ kind: "unavailable" });
  expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
  expect(statements).not.toContain("ROLLBACK");
  const recovered = await f.assignments.recover(
    f.administratorToken,
    f.input.operationId,
  );
  expect(recovered.kind).toBe("ready");
  if (recovered.kind !== "ready") throw Error("Retained receipt expected");
  expect(
    await f.assignments.assign(f.administratorToken, f.input),
  ).toMatchObject({ kind: "replayed", row: recovered.row });
  expect(
    (
      await pool.query(
        "SELECT (SELECT count(*) FROM assignment_grants)::int AS grants,(SELECT count(*) FROM authorization_audit)::int AS audits",
      )
    ).rows[0],
  ).toEqual({ grants: 1, audits: 2 });
});
it.each(["commit", "native"] as const)(
  "REVADM-07 withholds an actual committed pair when %s return crosses administrator expiry",
  async (boundary) => {
    const f = await sampleAssignmentFixture(pool, root),
      statements: string[] = [],
      late = gate();
    const expires = (
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '900 milliseconds' WHERE id=$1 RETURNING expires_at",
        [f.administratorId],
      )
    ).rows[0].expires_at as Date;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            statements.push(sql);
            const result = await client.query(sql, values);
            if (sql === "COMMIT" && boundary === "commit") {
              try {
                await pool.query(
                  "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM($1::timestamptz-clock_timestamp())))+0.05)",
                  [expires],
                );
              } finally {
                late.release();
              }
            }
            return result;
          }) as PoolClient["query"],
          release: (error?: Error) => {
            client.release(error);
            if (boundary === "native") {
              Atomics.wait(
                new Int32Array(new SharedArrayBuffer(4)),
                0,
                0,
                Math.max(0, +expires - Date.now()) + 75,
              );
              late.release();
            }
          },
        };
      },
    } as unknown as Pool;
    expect(
      await sampleAssignmentStore(scoped, {
        enabled: true,
        mode: "test",
      }).assign(f.administratorToken, f.input),
    ).toEqual({ kind: "unavailable" });
    await late.wait;
    expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(statements).not.toContain("ROLLBACK");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM private_sample_assignment_operations",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      await f.assignments.recover(f.administratorToken, f.input.operationId),
    ).toEqual({ kind: "denied" });
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
      [f.administratorId],
    );
    expect(
      (await f.assignments.recover(f.administratorToken, f.input.operationId))
        .kind,
    ).toBe("ready");
  },
);
