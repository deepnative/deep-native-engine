import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate } from "../../src/store.ts";
import { sampleAssignmentStore } from "../../src/sample-assignment.ts";
import type {
  SampleAssignmentInput,
  SampleAssignmentWriteResult,
} from "../../src/sample-assignment-values.ts";
import { SAMPLE_FEEDBACK_PURPOSE } from "../../src/sample-feedback-values.ts";
import { testPool } from "../support/database.ts";
import {
  sampleAssignmentFixture,
  sampleAssignmentToken,
  waitForSampleAssignmentBlock,
} from "../support/sample-assignment.ts";

const pool = testPool();
let root = "";
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne480-store-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
afterAll(() => pool.end());
const refs = (input: SampleAssignmentInput) => ({
  evidenceId: input.evidenceId,
  sourceRevision: input.sourceRevision,
  reviewerId: input.reviewerId,
});
const source = (input: SampleAssignmentInput) => ({
  evidenceId: input.evidenceId,
  sourceRevision: input.sourceRevision,
});
function written(value: SampleAssignmentWriteResult) {
  if (value.kind !== "applied" && value.kind !== "replayed")
    throw Error("Expected committed assignment: " + value.kind);
  return value.row;
}
async function counts() {
  return (
    await pool.query(`SELECT (SELECT count(*)::int FROM assignment_grants) AS assignments,
   (SELECT count(*)::int FROM reviewer_evidence_grants) AS exact,
   (SELECT count(*)::int FROM authorization_audit) AS audits,
   (SELECT count(*)::int FROM private_sample_assignment_operations) AS receipts`)
  ).rows[0];
}

it("REVADM-01/02 creates the exact paired task without content inspection or raw workspace access", async () => {
  const f = await sampleAssignmentFixture(pool, root);
  expect(await f.assignments.selfReference(f.reviewerToken)).toMatchObject({
    kind: "ready",
    reference: { reviewerId: f.reviewerId },
  });
  const checked = await f.assignments.check(
    f.administratorToken,
    refs(f.input),
  );
  expect(checked).toMatchObject({
    kind: "ready",
    check: { ...refs(f.input), sourceStatus: "eligible" },
  });
  expect(await counts()).toEqual({
    assignments: 0,
    exact: 0,
    audits: 0,
    receipts: 0,
  });
  const row = written(
    await f.assignments.assign(f.administratorToken, f.input),
  );
  expect(row).toMatchObject({
    ...refs(f.input),
    state: "active",
    canRevoke: true,
    startsAt: f.input.startsAt,
    expiresAt: f.input.expiresAt,
  });
  expect(Object.keys(row).sort()).toEqual(
    [
      "canRevoke",
      "createdAt",
      "evidenceId",
      "exactGrantId",
      "expiresAt",
      "receiptId",
      "reviewerId",
      "revokedAt",
      "sourceRevision",
      "startsAt",
      "state",
    ].sort(),
  );
  expect(await counts()).toEqual({
    assignments: 1,
    exact: 1,
    audits: 2,
    receipts: 1,
  });
  const audit = (
    await pool.query(
      "SELECT grant_type,action,evidence_id,assignment_grant_id FROM authorization_audit ORDER BY id",
    )
  ).rows;
  expect(audit).toEqual(
    ["assignment", "evidence_review"].map((grant_type) => ({
      grant_type,
      action: "grant_created",
      evidence_id: null,
      assignment_grant_id: null,
    })),
  );
  const work = await f.worklist.list(f.reviewerToken, "active");
  expect(work).toMatchObject({
    kind: "ready",
    items: [{ evidenceId: f.input.evidenceId, version: 1 }],
  });
  expect(
    await f.auth.readWorkspace(
      f.reviewerToken,
      f.ownerId,
      SAMPLE_FEEDBACK_PURPOSE,
    ),
  ).toEqual({ kind: "denied" });
  expect(JSON.stringify(checked) + JSON.stringify(row)).not.toMatch(
    /Invented|ownerId|workspace|submission|assignmentId|token|sourceSha/,
  );
});

it("REVADM-04 overlapping exact grants preserve the other grant and published owner feedback", async () => {
  const f = await sampleAssignmentFixture(pool, root);
  const first = written(
    await f.assignments.assign(f.administratorToken, f.input),
  );
  const second = written(
    await f.assignments.assign(f.administratorToken, {
      ...f.input,
      operationId: randomUUID(),
    }),
  );
  const draft = await f.feedback.save(f.reviewerToken, f.input.evidenceId, {
    revision: 0,
    operationId: randomUUID(),
    criteria: [
      {
        label: "Evidence",
        comment: "Explain the check.",
        start: 0,
        end: 8,
        quote: "Invented",
      },
    ],
    preparationMinutes: 3,
    reviewMinutes: 4,
  });
  expect(draft.kind).toBe("saved");
  if (draft.kind !== "saved") throw Error("Expected saved draft");
  expect(
    (
      await f.feedback.publish(
        f.reviewerToken,
        f.input.evidenceId,
        draft.revision,
        randomUUID(),
      )
    ).kind,
  ).toBe("saved");
  expect(
    (
      await f.assignments.revoke(
        f.administratorToken,
        source(f.input),
        first.exactGrantId,
      )
    ).kind,
  ).toBe("revoked");
  expect(
    (await f.feedback.reviewer(f.reviewerToken, f.input.evidenceId)).kind,
  ).toBe("ready");
  expect(
    (
      await f.assignments.revoke(
        f.administratorToken,
        source(f.input),
        first.exactGrantId,
      )
    ).kind,
  ).toBe("unchanged");
  expect(
    (
      await f.assignments.revoke(
        f.administratorToken,
        source(f.input),
        second.exactGrantId,
      )
    ).kind,
  ).toBe("revoked");
  expect(
    (await f.feedback.reviewer(f.reviewerToken, f.input.evidenceId)).kind,
  ).toBe("denied");
  expect(await f.worklist.list(f.reviewerToken, "completed")).toMatchObject({
    kind: "ready",
    items: [],
  });
  expect(
    await f.feedback.owner(f.ownerToken, f.input.evidenceId),
  ).toMatchObject({
    kind: "ready",
    consent: true,
    records: [{ preparationMinutes: 3, reviewMinutes: 4 }],
  });
  expect(
    (await pool.query("SELECT revoked_at FROM assignment_grants")).rows.every(
      (row) => row.revoked_at === null,
    ),
  ).toBe(true);
  expect(await counts()).toEqual({
    assignments: 2,
    exact: 2,
    audits: 6,
    receipts: 2,
  });
});

it("REVADM-04 exact revocation leaves a different sample on the same legacy workspace assignment untouched", async () => {
  const f = await sampleAssignmentFixture(pool, root),
    first = written(await f.assignments.assign(f.administratorToken, f.input));
  const uploaded = await f.evidence.upload(f.ownerToken, {
    name: "Other invented sample",
    mediaType: "text/plain",
    data: Buffer.from("Other invented source."),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (uploaded.kind !== "created") throw Error("Other sample unavailable");
  await f.evidence.transitionQuarantine(uploaded.id, "clean");
  await f.evidence.submitForReview(f.ownerToken, uploaded.id);
  const assignment = (
    await pool.query(
      "SELECT assignment_id FROM reviewer_evidence_grants WHERE id=$1",
      [first.exactGrantId],
    )
  ).rows[0].assignment_id as string;
  const submission = (
    await pool.query(
      "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
      [uploaded.id],
    )
  ).rows[0].id as string;
  const other = await f.auth.grantEvidenceReview(
    f.administratorId,
    f.reviewerId,
    assignment,
    submission,
    SAMPLE_FEEDBACK_PURPOSE,
    new Date(f.input.expiresAt),
  );
  expect(
    (
      await f.assignments.revoke(
        f.administratorToken,
        source(f.input),
        first.exactGrantId,
      )
    ).kind,
  ).toBe("revoked");
  expect(
    (await f.feedback.reviewer(f.reviewerToken, f.input.evidenceId)).kind,
  ).toBe("denied");
  expect((await f.feedback.reviewer(f.reviewerToken, uploaded.id)).kind).toBe(
    "ready",
  );
  expect(
    (
      await pool.query(
        "SELECT g.revoked_at,a.revoked_at AS assignment_revoked FROM reviewer_evidence_grants g JOIN assignment_grants a ON a.id=g.assignment_id WHERE g.id=$1",
        [other],
      )
    ).rows[0],
  ).toEqual({ revoked_at: null, assignment_revoked: null });
  expect(
    (
      await pool.query(
        "SELECT e.private_review_allowed,s.status FROM evidence_objects e JOIN evidence_review_submissions s ON s.evidence_id=e.id WHERE e.id=$1",
        [uploaded.id],
      )
    ).rows[0],
  ).toEqual({ private_review_allowed: true, status: "queued" });
});

it.each([
  [
    "pending",
    "UPDATE evidence_objects SET quarantine_state='pending' WHERE id=$1",
    "source",
  ],
  [
    "blocked",
    "UPDATE evidence_objects SET quarantine_state='rejected' WHERE id=$1",
    "source",
  ],
  [
    "withdrawn",
    "UPDATE evidence_objects SET private_review_allowed=false, private_review_revoked_at=clock_timestamp() WHERE id=$1",
    "source",
  ],
  [
    "wrong media",
    "UPDATE evidence_objects SET media_type='application/pdf' WHERE id=$1",
    "source",
  ],
  [
    "deleting",
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
    "owner",
  ],
  [
    "reviewer expired",
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    "reviewer",
  ],
  [
    "reviewer revoked",
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    "reviewer",
  ],
  [
    "reviewer role changed",
    "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1",
    "reviewer",
  ],
  [
    "member revoked",
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    "owner",
  ],
  [
    "member expired",
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    "owner",
  ],
] as const)(
  "REVADM-03 rejects %s without partial grants or eligibility content",
  async (_name, sql, target) => {
    const f = await sampleAssignmentFixture(pool, root);
    await pool.query(sql, [
      target === "source"
        ? f.input.evidenceId
        : target === "reviewer"
          ? f.reviewerId
          : f.ownerId,
    ]);
    expect(
      await f.assignments.check(f.administratorToken, refs(f.input)),
    ).toEqual({ kind: "denied" });
    expect(await f.assignments.assign(f.administratorToken, f.input)).toEqual({
      kind: "denied",
    });
    expect(await counts()).toEqual({
      assignments: 0,
      exact: 0,
      audits: 0,
      receipts: 0,
    });
  },
);

it("REVADM-03 rejects missing/version/admin target and excess window; a new revision gets no inherited task", async () => {
  const f = await sampleAssignmentFixture(pool, root);
  for (const input of [
    { ...f.input, evidenceId: randomUUID() },
    { ...f.input, sourceRevision: 2 },
    { ...f.input, reviewerId: f.administratorId },
    { ...f.input, expiresAt: new Date(+f.end + 1).toISOString() },
  ])
    expect(await f.assignments.assign(f.administratorToken, input)).toEqual({
      kind: "denied",
    });
  written(await f.assignments.assign(f.administratorToken, f.input));
  const revision = await f.evidence.upload(f.ownerToken, {
    name: "Invented next revision",
    mediaType: "text/plain",
    data: Buffer.from("Another invented revision."),
    revisesId: f.input.evidenceId,
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  expect(revision.kind).toBe("created");
  if (revision.kind !== "created") throw Error("Expected revision");
  expect((await f.feedback.reviewer(f.reviewerToken, revision.id)).kind).toBe(
    "denied",
  );
  const next = {
    ...f.input,
    evidenceId: revision.id,
    sourceRevision: 2,
    operationId: randomUUID(),
  };
  expect((await f.assignments.assign(f.administratorToken, next)).kind).toBe(
    "denied",
  );
  await f.evidence.transitionQuarantine(revision.id, "clean");
  expect((await f.assignments.assign(f.administratorToken, next)).kind).toBe(
    "denied",
  );
  await f.evidence.submitForReview(f.ownerToken, revision.id);
  expect((await f.assignments.assign(f.administratorToken, next)).kind).toBe(
    "applied",
  );
});

it.each([
  "wrong submitting owner",
  "withdrawn submission",
  "missing submission",
])(
  "REVADM-03 denies %s rather than deriving a usable exact task",
  async (state) => {
    const f = await sampleAssignmentFixture(pool, root);
    if (state === "wrong submitting owner") {
      const otherToken = sampleAssignmentToken();
      await f.members.create(otherToken, {
        background: "professional",
        goal: "work",
      });
      const other = await f.members.session(otherToken);
      if (other.kind !== "active")
        throw Error("Second invented member unavailable");
      await pool.query(
        "UPDATE evidence_review_submissions SET submitted_by=$2 WHERE evidence_id=$1",
        [f.input.evidenceId, other.learner.id],
      );
    } else if (state === "withdrawn submission")
      await pool.query(
        "UPDATE evidence_review_submissions SET status='withdrawn' WHERE evidence_id=$1",
        [f.input.evidenceId],
      );
    else
      await pool.query(
        "DELETE FROM evidence_review_submissions WHERE evidence_id=$1",
        [f.input.evidenceId],
      );
    expect(
      await f.assignments.check(f.administratorToken, refs(f.input)),
    ).toEqual({ kind: "denied" });
    expect(await f.assignments.assign(f.administratorToken, f.input)).toEqual({
      kind: "denied",
    });
    expect(await counts()).toEqual({
      assignments: 0,
      exact: 0,
      audits: 0,
      receipts: 0,
    });
  },
);

it("REVADM-05 same key returns one pair and changed payload conflicts without winning metadata", async () => {
  const f = await sampleAssignmentFixture(pool, root);
  const first = written(
    await f.assignments.assign(f.administratorToken, f.input),
  );
  expect(
    await f.assignments.assign(f.administratorToken, f.input),
  ).toMatchObject({ kind: "replayed", row: first });
  for (const changed of [
    { evidenceId: randomUUID() },
    { reviewerId: randomUUID() },
    { sourceRevision: 2 },
    { expiresAt: new Date(+f.end - 2000).toISOString() },
    { startsAt: new Date(Date.parse(f.input.startsAt) - 1000).toISOString() },
  ])
    expect(
      await f.assignments.assign(f.administratorToken, {
        ...f.input,
        ...changed,
      }),
    ).toMatchObject({ kind: "conflict" });
  expect(await counts()).toEqual({
    assignments: 1,
    exact: 1,
    audits: 2,
    receipts: 1,
  });
  const other = sampleAssignmentToken();
  await f.auth.provisionStaff(other, "platform_admin", f.end);
  expect((await f.assignments.recover(other, f.input.operationId)).kind).toBe(
    "absent",
  );
});

it.each([
  "reviewer_evidence_grants",
  "authorization_audit",
  "private_sample_assignment_operations",
])(
  "REVADM-05 failure inserting %s rolls back the entire pair and receipt",
  async (table) => {
    const f = await sampleAssignmentFixture(pool, root);
    await pool.query(
      "CREATE FUNCTION fail_sample_assignment_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'invented private failure'; END $$",
    );
    await pool.query(
      `CREATE TRIGGER fail_assignment_fixture BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_sample_assignment_fixture()`,
    );
    try {
      expect(await f.assignments.assign(f.administratorToken, f.input)).toEqual(
        { kind: "unavailable" },
      );
      expect(await counts()).toEqual({
        assignments: 0,
        exact: 0,
        audits: 0,
        receipts: 0,
      });
    } finally {
      await pool.query(`DROP TRIGGER fail_assignment_fixture ON ${table}`);
      await pool.query("DROP FUNCTION fail_sample_assignment_fixture()");
    }
  },
);

it("REVADM-05 concurrent identical confirmation waits on real admin lock and creates one pair", async () => {
  const f = await sampleAssignmentFixture(pool, root),
    holder = await pool.connect();
  let pending: Promise<SampleAssignmentWriteResult[]> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
      f.administratorId,
    ]);
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    pending = Promise.all([
      f.assignments.assign(f.administratorToken, f.input),
      f.assignments.assign(f.administratorToken, f.input),
    ]);
    await waitForSampleAssignmentBlock(pool, pid, 2);
    await holder.query("COMMIT");
    const result = await pending;
    expect(result.map((value) => value.kind).sort()).toEqual([
      "applied",
      "replayed",
    ]);
    expect(written(result[0]!)).toEqual(written(result[1]!));
    expect(await counts()).toEqual({
      assignments: 1,
      exact: 1,
      audits: 2,
      receipts: 1,
    });
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    await pending;
  }
});

it("REVADM-08 historical expiry, source deletion and local disablement preserve current-admin recovery without renewed grants", async () => {
  const f = await sampleAssignmentFixture(pool, root),
    row = written(await f.assignments.assign(f.administratorToken, f.input));
  const disabled = sampleAssignmentStore(pool, {
    enabled: false,
    mode: "test",
  });
  expect(
    await disabled.assign(f.administratorToken, {
      ...f.input,
      operationId: randomUUID(),
    }),
  ).toEqual({ kind: "unavailable" });
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [f.reviewerId],
  );
  expect(
    await disabled.recover(f.administratorToken, f.input.operationId),
  ).toMatchObject({ kind: "ready", row: { ...row, state: "ineffective" } });
  expect(
    (
      await disabled.revoke(
        f.administratorToken,
        source(f.input),
        row.exactGrantId,
      )
    ).kind,
  ).toBe("revoked");
  expect(await f.evidence.remove(f.ownerToken, f.input.evidenceId)).toBe(true);
  expect(
    await disabled.recover(f.administratorToken, f.input.operationId),
  ).toMatchObject({
    kind: "ready",
    row: { receiptId: row.receiptId, state: "removed", canRevoke: false },
  });
  expect(
    await f.assignments.assign(f.administratorToken, f.input),
  ).toMatchObject({ kind: "replayed", row: { state: "removed" } });
  expect(
    await disabled.history(f.administratorToken, source(f.input)),
  ).toMatchObject({
    kind: "ready",
    history: { rows: [{ receiptId: row.receiptId, state: "removed" }] },
  });
  expect(await counts()).toEqual({
    assignments: 1,
    exact: 0,
    audits: 3,
    receipts: 1,
  });
  await expect(
    pool.query(
      "UPDATE private_sample_assignment_operations SET source_revision=2",
    ),
  ).rejects.toThrow(/immutable/);
  await expect(
    pool.query("DELETE FROM private_sample_assignment_operations"),
  ).rejects.toThrow(/immutable/);
  await pool.query("DELETE FROM principals WHERE id=$1", [f.ownerId]);
  expect(
    (await disabled.recover(f.administratorToken, f.input.operationId)).kind,
  ).toBe("absent");
  expect(await counts()).toEqual({
    assignments: 0,
    exact: 0,
    audits: 0,
    receipts: 0,
  });
});
