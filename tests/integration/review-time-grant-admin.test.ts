import { bindSyntheticAdministrator } from "../support/administrator-fixture.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Pool } from "pg";
import { testPool } from "../support/database.ts";
import {
  sampleAssignmentFixture,
  sampleAssignmentToken,
  waitForSampleAssignmentBlock,
} from "../support/sample-assignment.ts";
import { migrate } from "../../src/store.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { reviewTimeStore } from "../../src/review-time-store.ts";
import { reviewTimeGrants } from "../../src/review-time-grants.ts";
import { reviewTimeGrantAdminStore } from "../../src/review-time-grant-admin.ts";
import { sampleFeedbackStore } from "../../src/sample-feedback.ts";
import { memberExportStore } from "../../src/member-export.ts";
const pool = testPool();
let root = "";
const admin = reviewTimeGrantAdminStore(pool, {
  mode: "test",
  administration: "enabled",
});
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne501-grants-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
afterAll(() => pool.end());
async function fixture(connection = pool, legacy = false) {
  const f = await sampleAssignmentFixture(connection, root, legacy),
    minutes = reviewTimeStore(connection, { mode: "test", enabled: true });
  const startsAt = (
    (
      await connection.query(
        "SELECT clock_timestamp()-interval '1 minute' AS starts",
      )
    ).rows[0].starts as Date
  ).toISOString();
  await syntheticLedger(connection).grant(
    f.ownerId,
    "review_minutes",
    20,
    randomUUID(),
    {
      startsAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: f.end.toISOString(),
    },
  );
  const allocated = await minutes.allocate(
    f.ownerToken,
    f.input.evidenceId,
    randomUUID(),
    20,
  );
  if (allocated.kind !== "applied") throw Error("allocation required");
  const input = {
    allocationId: allocated.receipt.allocationId,
    reviewerId: f.reviewerId,
    operationId: randomUUID(),
    startsAt,
    expiresAt: f.input.expiresAt,
  };
  return {
    ...f,
    minutes,
    input,
    sourceInput: { ...f.input, startsAt },
    allocationId: input.allocationId,
    feedback: sampleFeedbackStore(connection, f.objects, {
      mode: "test",
      reviewTimeWrites: true,
    }),
  };
}
function granted(result: Awaited<ReturnType<typeof admin.grant>>) {
  if (result.kind !== "applied" && result.kind !== "replayed")
    throw Error(`grant expected: ${result.kind}`);
  return result.row;
}
const counts = async () =>
  (
    await pool.query(
      `SELECT (SELECT count(*)::int FROM review_time_grants) grants,(SELECT count(*)::int FROM review_time_events WHERE action='grant-created') created,(SELECT count(*)::int FROM review_time_events WHERE action='grant-revoked') revoked,(SELECT count(*)::int FROM review_time_grant_revocations) operations`,
    )
  ).rows[0];
it("REVIEW-GRANT-01/02/03 check creates nothing; browser permission preserves independent feedback permissions and allowance", async () => {
  const f = await fixture(),
    before = await counts();
  expect(await admin.selfReference(f.reviewerToken)).toMatchObject({
    kind: "ready",
    reference: { reviewerId: f.reviewerId },
  });
  expect(
    await admin.check(f.administratorToken, {
      allocationId: f.allocationId,
      reviewerId: f.reviewerId,
    }),
  ).toMatchObject({
    kind: "ready",
    check: { sourceRevision: 1, ceiling: 20, allocationState: "allocated" },
  });
  expect(await counts()).toEqual(before);
  const row = granted(await admin.grant(f.administratorToken, f.input));
  expect(row).toMatchObject({ state: "active", sourceAvailable: true });
  expect(
    (
      await f.feedback.beginReview(
        f.reviewerToken,
        f.sourceInput.evidenceId,
        f.allocationId,
        row.grantId,
        randomUUID(),
      )
    ).kind,
  ).toBe("denied");
  expect(
    (await f.assignments.assign(f.administratorToken, f.sourceInput)).kind,
  ).toBe("applied");
  expect(
    (
      await f.feedback.beginReview(
        f.reviewerToken,
        f.sourceInput.evidenceId,
        f.allocationId,
        row.grantId,
        randomUUID(),
      )
    ).kind,
  ).toBe("applied");
  expect(await f.minutes.receipt(f.ownerToken, f.allocationId)).toMatchObject({
    kind: "applied",
    receipt: { state: "begun", held: 20, consumed: 0, released: 0 },
  });
  expect(await counts()).toEqual({
    grants: 1,
    created: 1,
    revoked: 0,
    operations: 0,
  });
});
it("REVIEW-GRANT-02 finite window is bounded by both current credentials; future schedule remains finite", async () => {
  const f = await fixture();
  for (const id of [f.administratorId, f.reviewerId]) {
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1",
      [id],
    );
    expect((await admin.grant(f.administratorToken, f.input)).kind).toBe(
      "denied",
    );
    await pool.query("UPDATE principals SET expires_at=$2 WHERE id=$1", [
      id,
      f.end,
    ]);
  }
  const input = {
    ...f.input,
    startsAt: new Date(Date.now() + 60000).toISOString(),
  };
  expect(granted(await admin.grant(f.administratorToken, input)).state).toBe(
    "scheduled",
  );
  expect(await counts()).toMatchObject({ created: 1 });
});
it("REVIEW-GRANT-06 concurrent exact create is idempotent and changed payload conflicts without additional audits", async () => {
  const f = await fixture();
  const results = await Promise.all([
    admin.grant(f.administratorToken, f.input),
    admin.grant(f.administratorToken, f.input),
  ]);
  expect(results.map((r) => r.kind).sort()).toEqual(["applied", "replayed"]);
  for (const changed of [
    { reviewerId: randomUUID() },
    { allocationId: randomUUID() },
    { startsAt: new Date(Date.parse(f.input.startsAt) - 1000).toISOString() },
    { expiresAt: new Date(Date.parse(f.input.expiresAt) - 1000).toISOString() },
  ])
    expect(
      (await admin.grant(f.administratorToken, { ...f.input, ...changed }))
        .kind,
    ).toBe("conflict");
  expect(await counts()).toMatchObject({ grants: 1, created: 1 });
});
it("REVIEW-GRANT-04/06 exact revoke preserves overlap, stores original outcome and unchanged operation, rejects changed payload", async () => {
  const f = await fixture();
  await f.assignments.assign(f.administratorToken, f.sourceInput);
  const first = granted(await admin.grant(f.administratorToken, f.input)),
    second = granted(
      await admin.grant(f.administratorToken, {
        ...f.input,
        operationId: randomUUID(),
      }),
    ),
    operationId = randomUUID();
  const results = await Promise.all([
    admin.revoke(f.administratorToken, { grantId: first.grantId, operationId }),
    admin.revoke(f.administratorToken, { grantId: first.grantId, operationId }),
  ]);
  expect(results.map((r) => r.kind).sort()).toEqual(["replayed", "revoked"]);
  const original = results.find((r) => r.kind === "revoked")!;
  expect(
    await admin.recoverRevoke(f.administratorToken, operationId),
  ).toMatchObject({
    kind: "ready",
    outcome: "revoked",
    revocationReceiptId:
      "revocationReceiptId" in original ? original.revocationReceiptId : "",
    row: { state: "revoked" },
  });
  expect(
    (
      await admin.revoke(f.administratorToken, {
        grantId: second.grantId,
        operationId,
      })
    ).kind,
  ).toBe("conflict");
  expect(
    await admin.revoke(f.administratorToken, {
      grantId: first.grantId,
      operationId: randomUUID(),
    }),
  ).toMatchObject({ kind: "unchanged", outcome: "unchanged" });
  expect(
    (
      await f.feedback.beginReview(
        f.reviewerToken,
        f.sourceInput.evidenceId,
        f.allocationId,
        first.grantId,
        randomUUID(),
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await f.feedback.beginReview(
        f.reviewerToken,
        f.sourceInput.evidenceId,
        f.allocationId,
        second.grantId,
        randomUUID(),
      )
    ).kind,
  ).toBe("applied");
  expect(await counts()).toEqual({
    grants: 2,
    created: 2,
    revoked: 1,
    operations: 2,
  });
  expect(await f.minutes.receipt(f.ownerToken, f.allocationId)).toMatchObject({
    kind: "applied",
    receipt: { held: 20, consumed: 0, released: 0 },
  });
});
it("REVIEW-GRANT-07 own history has20 rows, no duplicates, actor-bound cursors and outsider operation denial", async () => {
  const f = await fixture(),
    other = sampleAssignmentToken();
  await f.auth.provisionStaff(other, "platform_admin", f.end);
  for (let i = 0; i < 23; i++)
    granted(
      await admin.grant(f.administratorToken, {
        ...f.input,
        operationId: randomUUID(),
      }),
    );
  const outsider = granted(await admin.grant(other, f.input));
  const first = await admin.history(f.administratorToken);
  if (first.kind !== "ready") throw Error("history expected");
  expect(first.history.rows).toHaveLength(20);
  expect(first.history.next).not.toBeNull();
  const second = await admin.history(f.administratorToken, first.history.next!);
  if (second.kind !== "ready") throw Error("continuation expected");
  expect(second.history.rows).toHaveLength(3);
  expect(second.history.next).toBeNull();
  expect(
    new Set(
      [...first.history.rows, ...second.history.rows].map((r) => r.grantId),
    ).size,
  ).toBe(23);
  expect((await admin.history(other, first.history.next!)).kind).toBe(
    "invalid",
  );
  expect(
    (await admin.receipt(f.administratorToken, outsider.grantId)).kind,
  ).toBe("absent");
  expect(
    (await admin.recover(f.administratorToken, f.input.operationId)).kind,
  ).toBe("absent");
  expect(
    (
      await admin.revoke(f.administratorToken, {
        grantId: outsider.grantId,
        operationId: randomUUID(),
      })
    ).kind,
  ).toBe("denied");
  const json = JSON.stringify(first);
  for (const secret of [
    f.ownerId,
    f.sourceInput.evidenceId,
    "Invented source",
    f.administratorToken,
    f.input.operationId,
    outsider.grantId,
  ])
    expect(json).not.toContain(secret);
});
it.each(["disabled", "live", "recovery-only"] as const)(
  "REVIEW-GRANT-05/06 %s retains only its authorized operations",
  async (mode) => {
    const f = await fixture(),
      row = granted(await admin.grant(f.administratorToken, f.input));
    const s = reviewTimeGrantAdminStore(pool, {
      mode: mode === "live" ? "live" : "test",
      administration: mode === "live" ? "enabled" : mode,
    });
    expect(
      (
        await s.check(f.administratorToken, {
          allocationId: f.allocationId,
          reviewerId: f.reviewerId,
        })
      ).kind,
    ).toBe("unavailable");
    expect(
      (
        await s.grant(f.administratorToken, {
          ...f.input,
          operationId: randomUUID(),
        })
      ).kind,
    ).toBe("unavailable");
    if (mode === "recovery-only") {
      expect((await s.receipt(f.administratorToken, row.grantId)).kind).toBe(
        "ready",
      );
      expect(
        (await s.recover(f.administratorToken, f.input.operationId)).kind,
      ).toBe("ready");
      expect(
        (
          await s.revoke(f.administratorToken, {
            grantId: row.grantId,
            operationId: randomUUID(),
          })
        ).kind,
      ).toBe("revoked");
    } else {
      expect((await s.history(f.administratorToken)).kind).toBe("unavailable");
      expect(
        (
          await s.revoke(f.administratorToken, {
            grantId: row.grantId,
            operationId: randomUUID(),
          })
        ).kind,
      ).toBe("unavailable");
    }
  },
);
it.each([
  "admin-expired",
  "admin-revoked",
  "admin-role",
  "reviewer-expired",
  "reviewer-revoked",
  "reviewer-role",
  "owner-expired",
  "owner-revoked",
  "unsafe",
  "withdrawn",
  "removed",
  "cancelled",
] as const)(
  "REVIEW-GRANT-05 %s prevents new check/create and causes no grant or allowance mutation",
  async (change) => {
    const f = await fixture();
    if (change.includes("-")) {
      const [actor, action] = change.split("-");
      const id =
        actor === "admin"
          ? f.administratorId
          : actor === "reviewer"
            ? f.reviewerId
            : f.ownerId;
      if (action === "role")
        await pool.query(
          "UPDATE staff_profiles SET role='coach' WHERE principal_id=$1",
          [id],
        );
      else
        await pool.query(
          `UPDATE principals SET ${action === "expired" ? "expires_at=clock_timestamp()-interval '1 second'" : "revoked_at=clock_timestamp()"} WHERE id=$1`,
          [id],
        );
    } else if (change === "unsafe")
      await pool.query(
        "UPDATE evidence_objects SET quarantine_state='rejected' WHERE id=$1",
        [f.sourceInput.evidenceId],
      );
    else if (change === "withdrawn")
      await f.evidence.revokePrivateReview(
        f.ownerToken,
        f.sourceInput.evidenceId,
      );
    else if (change === "removed")
      await f.evidence.remove(f.ownerToken, f.sourceInput.evidenceId);
    else await f.minutes.cancel(f.ownerToken, f.allocationId);
    const before = await counts();
    expect(
      (
        await admin.check(f.administratorToken, {
          allocationId: f.allocationId,
          reviewerId: f.reviewerId,
        })
      ).kind,
    ).toBe("denied");
    expect((await admin.grant(f.administratorToken, f.input)).kind).toBe(
      "denied",
    );
    expect(await counts()).toEqual(before);
  },
);
it("REVIEW-GRANT-05 rejects wrong/anonymous roles and mismatched exact references without disclosure", async () => {
  const f = await fixture();
  for (const token of [
    "",
    sampleAssignmentToken(),
    f.ownerToken,
    f.reviewerToken,
  ])
    expect((await admin.open(token)).kind).toBe("denied");
  expect((await admin.selfReference(f.administratorToken)).kind).toBe("denied");
  expect(
    (
      await admin.check(f.administratorToken, {
        allocationId: randomUUID(),
        reviewerId: f.reviewerId,
      })
    ).kind,
  ).toBe("denied");
  expect(
    (
      await admin.check(f.administratorToken, {
        allocationId: f.allocationId,
        reviewerId: f.administratorId,
      })
    ).kind,
  ).toBe("denied");
  expect(
    (
      await admin.check(f.administratorToken, {
        allocationId: f.allocationId,
        reviewerId: randomUUID(),
      })
    ).kind,
  ).toBe("denied");
});
it("REVIEW-GRANT-06/07 erased source retains safe operation metadata; own account erasure removes grant operations; export excludes replay identities", async () => {
  const f = await fixture(),
    row = granted(await admin.grant(f.administratorToken, f.input)),
    operationId = randomUUID();
  await admin.revoke(f.administratorToken, {
    grantId: row.grantId,
    operationId,
  });
  await f.evidence.remove(f.ownerToken, f.sourceInput.evidenceId);
  expect(
    await admin.recover(f.administratorToken, f.input.operationId),
  ).toMatchObject({
    kind: "ready",
    row: { sourceAvailable: false, state: "revoked" },
  });
  expect(
    (await admin.recoverRevoke(f.administratorToken, operationId)).kind,
  ).toBe("ready");
  const exported = await memberExportStore(pool).exportOwned(f.ownerToken);
  expect(exported.kind).toBe("ready");
  for (const privateValue of [
    f.input.operationId,
    operationId,
    f.administratorToken,
    f.reviewerToken,
  ])
    expect(JSON.stringify(exported)).not.toContain(privateValue);
  await f.members.remove(f.ownerId);
  expect(await counts()).toEqual({
    grants: 0,
    created: 0,
    revoked: 0,
    operations: 0,
  });
  expect(
    (await admin.recoverRevoke(f.administratorToken, operationId)).kind,
  ).toBe("absent");
});
it("REVIEW-GRANT-06/07 normal member deletion erases three revoked browser permissions through workspace cleanup", async () => {
  const f = await fixture();
  for (let index = 0; index < 3; index++) {
    const row = granted(
      await admin.grant(f.administratorToken, {
        ...f.input,
        operationId: randomUUID(),
      }),
    );
    expect(
      (
        await admin.revoke(f.administratorToken, {
          grantId: row.grantId,
          operationId: randomUUID(),
        })
      ).kind,
    ).toBe("revoked");
  }
  expect(await counts()).toEqual({
    grants: 3,
    created: 3,
    revoked: 3,
    operations: 3,
  });
  await f.evidence.removeWorkspace(f.ownerToken);
  await f.members.remove(f.ownerId);
  expect(await counts()).toEqual({
    grants: 0,
    created: 0,
    revoked: 0,
    operations: 0,
  });
});
it.each(["allocated", "begun", "completed"] as const)(
  "REVIEW-GRANT-06/07 owner erasure of %s permits a retry without settling units or inventing accounting events",
  async (state) => {
    const f = await fixture(),
      row = granted(await admin.grant(f.administratorToken, f.input));
    if (state !== "allocated") {
      expect(
        (await f.assignments.assign(f.administratorToken, f.sourceInput)).kind,
      ).toBe("applied");
      expect(
        (
          await f.feedback.beginReview(
            f.reviewerToken,
            f.sourceInput.evidenceId,
            f.allocationId,
            row.grantId,
            randomUUID(),
          )
        ).kind,
      ).toBe("applied");
      if (state === "completed") {
        const draft = await f.feedback.save(
          f.reviewerToken,
          f.sourceInput.evidenceId,
          {
            revision: 0,
            operationId: randomUUID(),
            criteria: [
              {
                label: "Clarity",
                comment: "Useful invented explanation.",
                start: 0,
                end: 8,
                quote: "Invented",
              },
            ],
            preparationMinutes: 0,
            reviewMinutes: 1,
          },
        );
        if (draft.kind !== "saved") throw Error("Saved draft required");
        const end = +(
          await pool.query(
            "SELECT date_trunc('minute',clock_timestamp())-interval '1 minute' AS ending",
          )
        ).rows[0].ending;
        expect(
          (
            await f.feedback.publish(
              f.reviewerToken,
              f.sourceInput.evidenceId,
              draft.revision,
              randomUUID(),
              {
                allocationId: f.allocationId,
                grantId: row.grantId,
                intervals: {
                  reviewStart: new Date(end - 60000),
                  reviewEnd: new Date(end),
                  preparationStart: null,
                  preparationEnd: null,
                },
              },
            )
          ).kind,
        ).toBe("saved");
      }
    }
    expect(
      (
        await admin.revoke(f.administratorToken, {
          grantId: row.grantId,
          operationId: randomUUID(),
        })
      ).kind,
    ).toBe("revoked");
    const accounting = async () =>
      Promise.all(
        [
          "SELECT * FROM synthetic_entitlement_grants ORDER BY id",
          "SELECT * FROM synthetic_entitlement_reservations ORDER BY id",
          "SELECT * FROM synthetic_entitlement_events ORDER BY id",
          "SELECT * FROM review_time_events ORDER BY id",
        ].map(async (sql) => (await pool.query(sql)).rows),
      );
    const before = await accounting();
    await f.evidence.removeWorkspace(f.ownerToken);
    expect(await accounting()).toEqual(before);
    const marker = (
      await pool.query(
        "SELECT state,source_unavailable_at,evidence_id,submission_id FROM review_time_allocations WHERE id=$1",
        [f.allocationId],
      )
    ).rows[0];
    expect(marker).toEqual({
      state,
      source_unavailable_at: expect.any(Date),
      evidence_id: null,
      submission_id: null,
    });
    // This is the same retry the browser can make if principal deletion failed
    // after private object/source cleanup had already completed.
    await f.evidence.removeWorkspace(f.ownerToken);
    expect(
      (
        await pool.query(
          "SELECT source_unavailable_at FROM review_time_allocations WHERE id=$1",
          [f.allocationId],
        )
      ).rows[0].source_unavailable_at,
    ).toEqual(marker.source_unavailable_at);
    expect(await accounting()).toEqual(before);
    await f.members.remove(f.ownerId);
    expect(await counts()).toEqual({
      grants: 0,
      created: 0,
      revoked: 0,
      operations: 0,
    });
    expect(
      (await pool.query("SELECT count(*)::int n FROM review_time_entries"))
        .rows,
    ).toEqual([{ n: 0 }]);
  },
);
it.each(["grant", "revoke"] as const)(
  "REVIEW-GRANT-06 lost %s COMMIT acknowledgement retains exactly one recoverable original operation",
  async (action) => {
    const f = await fixture(),
      row =
        action === "revoke"
          ? granted(await admin.grant(f.administratorToken, f.input))
          : null,
      operationId = randomUUID();
    let commits = 0,
      rollbacks = 0;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            if (sql === "ROLLBACK") rollbacks++;
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              commits++;
              throw Error("Invented lost acknowledgement");
            }
            return result;
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    const s = reviewTimeGrantAdminStore(scoped, {
      mode: "test",
      administration: "enabled",
    });
    expect(
      (action === "grant"
        ? await s.grant(f.administratorToken, f.input)
        : await s.revoke(f.administratorToken, {
            grantId: row!.grantId,
            operationId,
          })
      ).kind,
    ).toBe("unavailable");
    expect(commits).toBe(1);
    expect(rollbacks).toBe(0);
    expect(
      (action === "grant"
        ? await admin.recover(f.administratorToken, f.input.operationId)
        : await admin.recoverRevoke(f.administratorToken, operationId)
      ).kind,
    ).toBe("ready");
    expect(
      (action === "grant"
        ? await admin.grant(f.administratorToken, f.input)
        : await admin.revoke(f.administratorToken, {
            grantId: row!.grantId,
            operationId,
          })
      ).kind,
    ).toBe("replayed");
    expect(await counts()).toMatchObject({
      created: 1,
      revoked: action === "revoke" ? 1 : 0,
      operations: action === "revoke" ? 1 : 0,
    });
  },
);
it.each(["workspace-deleting", "admin-role", "reviewer-revoked"] as const)(
  "REVIEW-GRANT-05/06 %s wins a real lock race before create; no stale grant is accepted",
  async (change) => {
    const f = await fixture(),
      holder = await pool.connect();
    let pending: ReturnType<typeof admin.grant> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      if (change === "workspace-deleting")
        await holder.query(
          "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
          [f.ownerId],
        );
      else if (change === "admin-role")
        await holder.query(
          "UPDATE staff_profiles SET role='coach' WHERE principal_id=$1",
          [f.administratorId],
        );
      else
        await holder.query(
          "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [f.reviewerId],
        );
      pending = admin.grant(f.administratorToken, f.input);
      await waitForSampleAssignmentBlock(pool, pid);
      await holder.query("COMMIT");
      expect((await pending).kind).toBe("denied");
      expect(await counts()).toMatchObject({ created: 0, grants: 0 });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending;
    }
  },
);
it.each([
  ["grant", "commit"],
  ["grant", "handback"],
  ["revoke", "commit"],
  ["revoke", "handback"],
] as const)(
  "REVIEW-GRANT-05/06 %s expiry through %s withholds an original write acknowledgement",
  async (action, phase) => {
    const f = await fixture();
    const row =
      action === "revoke"
        ? granted(await admin.grant(f.administratorToken, f.input))
        : undefined;
    const operationId = randomUUID();
    const expires = (
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '800 milliseconds' WHERE id=$1 RETURNING expires_at",
        [f.administratorId],
      )
    ).rows[0].expires_at as Date;
    const input = {
      ...f.input,
      expiresAt: new Date(+expires - 10).toISOString(),
    };
    let commits = 0,
      deadline = 0;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              commits++;
              const remaining = Number(
                (
                  await pool.query(
                    "SELECT EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000 remaining",
                    [expires],
                  )
                ).rows[0].remaining,
              );
              if (phase === "commit")
                await pool.query(
                  "SELECT pg_sleep(GREATEST(0,$1::float8)/1000+0.04)",
                  [remaining],
                );
              else deadline = performance.now() + Math.max(0, remaining) + 40;
            }
            return result;
          },
          release: (error?: Error) => {
            while (performance.now() < deadline) {
              /* Deliberately delayed native handback. */
            }
            client.release(error);
          },
        };
      },
    } as unknown as Pool;
    const target = reviewTimeGrantAdminStore(scoped, {
      mode: "test",
      administration: "enabled",
    });
    expect(
      (action === "grant"
        ? await target.grant(f.administratorToken, input)
        : await target.revoke(f.administratorToken, {
            grantId: row!.grantId,
            operationId,
          })
      ).kind,
    ).toBe("unavailable");
    expect(commits).toBe(1);
    expect(await counts()).toMatchObject({
      grants: 1,
      created: 1,
      revoked: action === "revoke" ? 1 : 0,
      operations: action === "revoke" ? 1 : 0,
    });
    await pool.query("UPDATE principals SET expires_at=$2 WHERE id=$1", [
      f.administratorId,
      f.end,
    ]);
    expect(
      (action === "grant"
        ? await admin.recover(f.administratorToken, f.input.operationId)
        : await admin.recoverRevoke(f.administratorToken, operationId)
      ).kind,
    ).toBe("ready");
  },
);
it.each([
  "open",
  "check",
  "history",
  "receipt",
  "recover",
  "recoverRevoke",
  "selfReference",
] as const)(
  "REVIEW-GRANT-05 %s withholds private metadata when current authority expires during native handback",
  async (action) => {
    const f = await fixture(),
      row = granted(await admin.grant(f.administratorToken, f.input)),
      operationId = randomUUID();
    await admin.revoke(f.administratorToken, {
      grantId: row.grantId,
      operationId,
    });
    const expires = (
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '600 milliseconds' WHERE id=$1 RETURNING expires_at",
        [action === "selfReference" ? f.reviewerId : f.administratorId],
      )
    ).rows[0].expires_at as Date;
    let deadline = 0,
      commits = 0;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              commits++;
              const remaining = Number(
                (
                  await pool.query(
                    "SELECT EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000 remaining",
                    [expires],
                  )
                ).rows[0].remaining,
              );
              deadline = performance.now() + Math.max(0, remaining) + 30;
            }
            return result;
          },
          release: (error?: Error) => {
            while (performance.now() < deadline) {
              /* Expire before native return. */
            }
            client.release(error);
          },
        };
      },
    } as unknown as Pool;
    const s = reviewTimeGrantAdminStore(scoped, {
      mode: "test",
      administration: "enabled",
    });
    const result =
      action === "open"
        ? await s.open(f.administratorToken)
        : action === "check"
          ? await s.check(f.administratorToken, {
              allocationId: f.allocationId,
              reviewerId: f.reviewerId,
            })
          : action === "history"
            ? await s.history(f.administratorToken)
            : action === "receipt"
              ? await s.receipt(f.administratorToken, row.grantId)
              : action === "recover"
                ? await s.recover(f.administratorToken, f.input.operationId)
                : action === "recoverRevoke"
                  ? await s.recoverRevoke(f.administratorToken, operationId)
                  : await s.selfReference(f.reviewerToken);
    expect(result).toEqual({ kind: "denied" });
    expect(commits).toBe(1);
    expect(await counts()).toEqual({
      grants: 1,
      created: 1,
      revoked: 1,
      operations: 1,
    });
  },
);
it.each([
  "admin-role",
  "admin-revoked",
  "workspace-deleting",
  "source-unsafe",
] as const)(
  "REVIEW-GRANT-05 retained history rechecks %s after a real source/actor lock wait",
  async (change) => {
    const f = await fixture(),
      row = granted(await admin.grant(f.administratorToken, f.input)),
      holder = await pool.connect();
    let pending: ReturnType<typeof admin.receipt> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      if (change === "admin-role")
        await holder.query(
          "UPDATE staff_profiles SET role='coach' WHERE principal_id=$1",
          [f.administratorId],
        );
      else if (change === "admin-revoked")
        await holder.query(
          "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [f.administratorId],
        );
      else if (change === "workspace-deleting")
        await holder.query(
          "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
          [f.ownerId],
        );
      else
        await holder.query(
          "UPDATE evidence_objects SET quarantine_state='rejected' WHERE id=$1",
          [f.sourceInput.evidenceId],
        );
      pending = admin.receipt(f.administratorToken, row.grantId);
      await waitForSampleAssignmentBlock(pool, pid);
      await holder.query("COMMIT");
      expect(await pending).toMatchObject(
        change === "source-unsafe"
          ? {
              kind: "ready",
              row: { state: "ineffective", sourceAvailable: false },
            }
          : { kind: "denied" },
      );
      expect(await counts()).toMatchObject({
        created: 1,
        revoked: 0,
        operations: 0,
      });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending;
    }
  },
);
it("REVIEW-GRANT-06 upgrade067 preserves legacy grants, repeats safely, immutable revoke metadata follows only owner erasure", async () => {
  const schema = `review_${randomUUID().replaceAll("-", "")}`,
    client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const directory = new URL("../../migrations/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter(
        (n) => /^\d{3}-[a-z0-9-]+\.sql$/.test(n) && Number(n.slice(0, 3)) <= 67,
      )
      .sort())
      await client.query(await readFile(new URL(name, directory), "utf8"));
    // Historical pre-identity source, confined to this isolated legacy schema.
    await client.query(
      "CREATE VIEW authorized_staff_profiles AS SELECT * FROM staff_profiles",
    );
    const connection = {
        query: client.query.bind(client),
        connect: async () => ({
          query: client.query.bind(client),
          release() {},
        }),
      } as unknown as Pool,
      f = await fixture(connection, true);
    const legacy = await reviewTimeGrants(connection, {
      mode: "test",
      enabled: true,
    }).grant(
      f.administratorToken,
      f.allocationId,
      f.reviewerId,
      new Date(f.input.startsAt),
      new Date(f.input.expiresAt),
      f.input.operationId,
    );
    if (legacy.kind !== "applied") throw Error("legacy required");
    const legacyErasure = await fixture(connection, true);
    await expect(
      legacyErasure.evidence.removeWorkspace(legacyErasure.ownerToken),
    ).rejects.toThrow("Review source links permit only source erasure");
    const before = (await client.query("SELECT * FROM review_time_grants"))
      .rows;
    await migrate(connection);
    await migrate(connection);
    expect(
      (await client.query("SELECT * FROM review_time_grants")).rows,
    ).toEqual(before);
    expect(
      (await client.query("SELECT * FROM review_time_grant_revocations")).rows,
    ).toEqual([]);
    // The failed legacy deletion already fenced the workspace and source.
    // Upgrading must make that original operation retryable without a backfill.
    await legacyErasure.evidence.removeWorkspace(legacyErasure.ownerToken);
    await legacyErasure.members.remove(legacyErasure.ownerId);
    const s = reviewTimeGrantAdminStore(connection, {
        mode: "test",
        administration: "recovery-only",
      }),
      operationId = randomUUID();
    expect((await s.receipt(f.administratorToken, legacy.grantId)).kind).toBe(
      "denied",
    );
    await bindSyntheticAdministrator(connection, f.administratorId, f.end);
    expect((await s.receipt(f.administratorToken, legacy.grantId)).kind).toBe(
      "ready",
    );
    expect(
      (
        await s.revoke(f.administratorToken, {
          grantId: legacy.grantId,
          operationId,
        })
      ).kind,
    ).toBe("revoked");
    await migrate(connection);
    await expect(
      client.query(
        "UPDATE review_time_grant_revocations SET outcome='unchanged'",
      ),
    ).rejects.toThrow();
    await expect(
      client.query("DELETE FROM review_time_grant_revocations"),
    ).rejects.toThrow();
    await f.members.remove(f.ownerId);
    expect(
      (await client.query("SELECT * FROM review_time_grant_revocations")).rows,
    ).toEqual([]);
  } finally {
    await client.query("ROLLBACK");
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
  }
});
