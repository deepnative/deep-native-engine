import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { memberSharingStore } from "../../src/member-sharing.ts";
import { migrate } from "../../src/store.ts";
import { workflowReviewStaffStore } from "../../src/workflow-review-staff.ts";
import { testPool } from "../support/database.ts";
import {
  WORKFLOW_REVIEW_TEST_SECRET,
  workflowReviewFixture,
} from "../support/workflow-review.ts";

const pool = testPool(),
  sharing = memberSharingStore(pool);

beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(() => pool.end());

const staffOver = (over: Pool) =>
  workflowReviewStaffStore(
    over,
    { enabled: true, mode: "test" },
    WORKFLOW_REVIEW_TEST_SECRET,
  );
async function history(token: string, before?: string) {
  const result = await sharing.staffAccess(token, before);
  if (result.kind !== "ready") throw Error(`History was ${result.kind}`);
  return result.value;
}
const noteReads = async (token: string) =>
  (await history(token)).entries.filter((e) => e.source === "workflow");

it("NOTEREAD-01 a moderator opening an assigned note shows on the member's history, with no identity or note text", async () => {
  const f = await workflowReviewFixture(pool);
  expect(await noteReads(f.member)).toEqual([]);

  const read = await f.staff.read(f.moderator, f.grantId);
  expect(read).toMatchObject({ kind: "ready", note: f.note });

  const entries = await noteReads(f.member);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    source: "workflow",
    action: "note_read",
    file: "WF-001, version 3",
  });
  expect(entries[0]!.at).toBeInstanceOf(Date);
  const shown = JSON.stringify(entries);
  for (const secret of [f.note, f.moderatorId, f.adminId, f.grantId])
    expect(shown).not.toContain(secret);

  // The record itself says who and which grant, for staff accountability, and
  // holds nothing of the note.
  const { rows } = await pool.query(
    `SELECT actor_id,grant_id,request_id,workflow_id,workflow_version,revision FROM workflow_review_read_audit`,
  );
  expect(rows).toEqual([
    {
      actor_id: f.moderatorId,
      grant_id: f.grantId,
      request_id: f.requestId,
      workflow_id: "WF-001",
      workflow_version: 3,
      revision: 1,
    },
  ]);
  const whole = JSON.stringify(
    (await pool.query(`SELECT * FROM workflow_review_read_audit`)).rows,
  );
  expect(whole).not.toContain(f.note);
});

it("NOTEREAD-02 each opening is logged once, and paging across kinds of entry neither repeats nor skips", async () => {
  const f = await workflowReviewFixture(pool);
  const opened = 32;
  for (let i = 0; i < opened; i += 1)
    expect((await f.staff.read(f.moderator, f.grantId)).kind).toBe("ready");
  const first = await history(f.member);
  expect(first.entries).toHaveLength(30);
  expect(first.older).toEqual(expect.any(String));
  const second = await history(f.member, first.older!);
  expect(second.older).toBeNull();
  const all = [...first.entries, ...second.entries];
  expect(all.filter((e) => e.source === "workflow")).toHaveLength(opened);
  const times = all.map((e) => +e.at);
  expect(times).toEqual([...times].sort((a, b) => b - a));
});

it("NOTEREAD-03 a refused read logs nothing and shows no note", async () => {
  const f = await workflowReviewFixture(pool);
  const refused = async (token: string) => {
    expect(await f.staff.read(token, f.grantId)).toEqual({ kind: "denied" });
    expect(await noteReads(f.member)).toEqual([]);
  };
  // The administrator who assigned it, and the member, are not the moderator.
  await refused(f.admin);
  await refused(f.member);
  // A moderator it wasn't assigned to.
  const other = await workflowReviewFixture(pool);
  await refused(other.moderator);
  expect(await f.staff.read(f.moderator, randomUUID())).toEqual({
    kind: "denied",
  });
  // The note changed after it was sent: the exact version is no longer there.
  expect(
    await f.feedback.save(f.member, "WF-001", 3, "Invented change", 1),
  ).toBe(true);
  await refused(f.moderator);
});

it("NOTEREAD-03 ended access and withdrawn permission log nothing", async () => {
  const revoked = await workflowReviewFixture(pool);
  expect(
    (
      await revoked.staff.revoke(
        revoked.admin,
        revoked.grantId,
        randomUUID(),
        "yes",
      )
    ).kind,
  ).toBe("applied");
  expect(await revoked.staff.read(revoked.moderator, revoked.grantId)).toEqual({
    kind: "denied",
  });
  expect(await noteReads(revoked.member)).toEqual([]);

  const withdrawn = await workflowReviewFixture(pool);
  await pool.query(
    `UPDATE workflow_review_requests SET withdrawn_at=clock_timestamp() WHERE id=$1`,
    [withdrawn.requestId],
  );
  expect(
    await withdrawn.staff.read(withdrawn.moderator, withdrawn.grantId),
  ).toEqual({ kind: "denied" });
  expect(await noteReads(withdrawn.member)).toEqual([]);

  const scheduled = await workflowReviewFixture(pool);
  await pool.query(
    `UPDATE workflow_review_grants SET starts_at=clock_timestamp()+interval '10 minutes' WHERE id=$1`,
    [scheduled.grantId],
  );
  expect(
    await scheduled.staff.read(scheduled.moderator, scheduled.grantId),
  ).toEqual({ kind: "denied" });
  expect(await noteReads(scheduled.member)).toEqual([]);
});

it("NOTEREAD-04 if the log can't be written the moderator doesn't get the note", async () => {
  const f = await workflowReviewFixture(pool);
  let attempted = 0;
  const failing = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (async (sql: string, values?: unknown[]) => {
          if (sql.includes("INSERT INTO workflow_review_read_audit")) {
            attempted += 1;
            throw Error("Invented log failure");
          }
          return client.query(sql, values);
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const result = await staffOver(failing).read(f.moderator, f.grantId);
  expect(attempted).toBe(1);
  expect(result).toEqual({ kind: "unavailable" });
  expect(JSON.stringify(result)).not.toContain(f.note);
  expect(await noteReads(f.member)).toEqual([]);
});

it("NOTEREAD-05 moderator lists and administrator receipts show no note and log nothing", async () => {
  const f = await workflowReviewFixture(pool);
  const listed = await f.staff.list(f.moderator);
  expect(listed.kind).toBe("ready");
  expect(JSON.stringify(listed)).not.toContain(f.note);
  const receipt = await f.staff.receipt(f.admin, f.grantId);
  expect(receipt.kind).toBe("ready");
  expect(JSON.stringify(receipt)).not.toContain(f.note);
  expect(await noteReads(f.member)).toEqual([]);
});

it("NOTEREAD-06 entries can't be changed and outlast the access, the note and the moderator", async () => {
  const f = await workflowReviewFixture(pool);
  expect((await f.staff.read(f.moderator, f.grantId)).kind).toBe("ready");
  await expect(
    pool.query(
      `UPDATE workflow_review_read_audit SET occurred_at=clock_timestamp()`,
    ),
  ).rejects.toThrow(/immutable/);
  await expect(
    pool.query(`DELETE FROM workflow_review_read_audit`),
  ).rejects.toThrow(/immutable/);

  expect(
    (await f.staff.revoke(f.admin, f.grantId, randomUUID(), "yes")).kind,
  ).toBe("applied");
  expect(
    await f.feedback.save(f.member, "WF-001", 3, "Invented change", 1),
  ).toBe(true);
  await pool.query(`DELETE FROM principals WHERE id=$1`, [f.moderatorId]);
  expect(await noteReads(f.member)).toHaveLength(1);
});

it("NOTEREAD-07 entries go with the member's account, and no other member sees them", async () => {
  const f = await workflowReviewFixture(pool);
  const other = await workflowReviewFixture(pool);
  expect((await f.staff.read(f.moderator, f.grantId)).kind).toBe("ready");
  expect(await noteReads(other.member)).toEqual([]);
  await f.members.remove(f.memberId);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS left FROM workflow_review_read_audit`,
  );
  expect(rows[0].left).toBe(0);
});
