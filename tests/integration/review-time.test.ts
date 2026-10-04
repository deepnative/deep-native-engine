import { ledgerReconciliationStore } from "../../src/ledger-reconciliation.ts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import {
  sampleFeedbackStore,
  type SampleFeedbackResult,
} from "../../src/sample-feedback.ts";
import { SAMPLE_FEEDBACK_PURPOSE } from "../../src/sample-feedback-values.ts";
const pool = testPool(),
  db = store(pool),
  auth = authorizationStore(pool);
let root = "";
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne-feedback-test-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
afterAll(() => pool.end());
function ready(result: SampleFeedbackResult) {
  if (result.kind !== "ready")
    throw Error("Expected authorized sample feedback");
  return result;
}
function saved(result: SampleFeedbackResult) {
  if (result.kind !== "saved") throw Error("Expected saved sample feedback");
  return result;
}
async function fixture(purpose = SAMPLE_FEEDBACK_PURPOSE, connection = pool) {
  const db = store(connection),
    auth = authorizationStore(connection);
  const ownerToken = randomBytes(32).toString("hex"),
    reviewerToken = randomBytes(32).toString("hex");
  await db.create(ownerToken, { background: "professional", goal: "everyday" });
  const owner = await db.session(ownerToken);
  if (owner.kind !== "active") throw Error("Expected active owner");
  const end = new Date(Date.now() + 3600000);
  const adminToken = randomBytes(32).toString("hex");
  const admin = await auth.provisionStaff(adminToken, "platform_admin", end);
  const reviewer = await auth.provisionStaff(reviewerToken, "reviewer", end);
  const objects = fileObjectStorage(root),
    evidence = evidenceStore(connection, objects, "invented-test-secret"),
    feedback = sampleFeedbackStore(connection, objects, {
      reviewTimeWrites: true,
      mode: "test",
    });
  const source = "An invented team checks 🤖 claims against its sources.";
  const upload = await evidence.upload(ownerToken, {
    name: "Invented feedback sample",
    mediaType: "text/plain",
    data: Buffer.from(source),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (upload.kind !== "created") throw Error("Expected sample upload");
  await evidence.transitionQuarantine(upload.id, "clean");
  await evidence.submitForReview(ownerToken, upload.id);
  const submission = (
    await connection.query(
      "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
      [upload.id],
    )
  ).rows[0].id as string;
  const assignment = await auth.grantAssignment(
    admin,
    reviewer,
    owner.learner.id,
    "reviewer",
    "invented feedback",
    end,
  );
  const exact = await auth.grantEvidenceReview(
    admin,
    reviewer,
    assignment,
    submission,
    purpose,
    end,
  );
  const draft = {
    revision: 0,
    operationId: randomUUID(),
    criteria: [
      {
        label: "Evidence",
        comment: "Explain how the claim was checked.",
        start: 0,
        end: 11,
        quote: "An invented",
      },
    ],
    preparationMinutes: 5,
    reviewMinutes: 10,
  };
  return {
    ownerToken,
    ownerId: owner.learner.id,
    reviewerToken,
    reviewer,
    admin,
    adminToken,
    end,
    objects,
    evidence,
    feedback,
    id: upload.id,
    submission,
    assignment,
    exact,
    draft,
    source,
  };
}

import { syntheticLedger } from "../../src/ledger.ts";
import { reviewTimeStore } from "../../src/review-time-store.ts";
import { reviewTimeGrants } from "../../src/review-time-grants.ts";
const minutes = reviewTimeStore(pool, { enabled: true, mode: "test" });
const paused = reviewTimeStore(pool, { enabled: false, mode: "test" });
const grants = reviewTimeGrants(pool, { enabled: true, mode: "test" });
async function allocatedFixture(ceiling = 20) {
  const f = await fixture();
  await syntheticLedger(pool).grant(
    f.ownerId,
    "review_minutes",
    ceiling,
    randomUUID(),
    {
      startsAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: f.end.toISOString(),
    },
  );
  const key = randomUUID(),
    held = await minutes.allocate(f.ownerToken, f.id, key, ceiling);
  if (held.kind !== "applied") throw Error("Expected allocated minutes");
  const allocationId = held.receipt.allocationId;
  const grant = await grants.grant(
    f.adminToken,
    allocationId,
    f.reviewer,
    new Date(Date.now() - 60000),
    f.end,
    randomUUID(),
  );
  if (grant.kind !== "applied") throw Error("Expected exact time grant");
  return { ...f, key, allocationId, grantId: grant.grantId };
}
it("publishes the exact saved draft and consumes actual minutes once, returning unused units", async () => {
  const f = await allocatedFixture();
  const draft = saved(await f.feedback.save(f.reviewerToken, f.id, f.draft));
  expect(
    await f.feedback.publish(
      f.reviewerToken,
      f.id,
      draft.revision,
      randomUUID(),
    ),
  ).toEqual({ kind: "conflict" });
  const begin = randomUUID();
  expect(
    (
      await f.feedback.beginReview(
        f.ownerToken,
        f.id,
        f.allocationId,
        f.grantId,
        begin,
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await f.feedback.beginReview(
        f.reviewerToken,
        f.id,
        f.allocationId,
        f.grantId,
        begin,
      )
    ).kind,
  ).toBe("applied");
  expect(
    (
      await f.feedback.beginReview(
        f.reviewerToken,
        f.id,
        f.allocationId,
        f.grantId,
        begin,
      )
    ).kind,
  ).toBe("replayed");
  const end = Math.floor(Date.now() / 60000) * 60000 - 60000;
  const input = {
    allocationId: f.allocationId,
    grantId: f.grantId,
    intervals: {
      reviewStart: new Date(end - 600000),
      reviewEnd: new Date(end),
      preparationStart: new Date(end - 900000),
      preparationEnd: new Date(end - 600000),
    },
  };
  const operation = randomUUID();
  saved(
    await f.feedback.publish(
      f.reviewerToken,
      f.id,
      draft.revision,
      operation,
      input,
    ),
  );
  saved(
    await f.feedback.publish(
      f.reviewerToken,
      f.id,
      draft.revision,
      operation,
      input,
    ),
  );
  expect(await minutes.receipt(f.ownerToken, f.allocationId)).toMatchObject({
    kind: "applied",
    receipt: {
      state: "completed",
      held: 0,
      consumed: 15,
      released: 5,
      reviewMinutes: 10,
      preparationMinutes: 5,
    },
  });
  expect(
    ready(await f.feedback.owner(f.ownerToken, f.id)).records,
  ).toHaveLength(1);
});
it("keeps cancellation and erased-source accounting available while new work is paused", async () => {
  const f = await allocatedFixture();
  expect(
    (await paused.allocate(f.ownerToken, f.id, randomUUID(), 1)).kind,
  ).toBe("unavailable");
  expect((await minutes.allocate(f.ownerToken, f.id, f.key, 20)).kind).toBe(
    "replayed",
  );
  expect((await minutes.allocate(f.ownerToken, f.id, f.key, 19)).kind).toBe(
    "conflict",
  );
  expect((await paused.cancel(f.reviewerToken, f.allocationId)).kind).toBe(
    "denied",
  );
  expect((await paused.cancel(f.ownerToken, f.allocationId)).kind).toBe(
    "applied",
  );
  expect((await paused.cancel(f.ownerToken, f.allocationId)).kind).toBe(
    "replayed",
  );
  expect(await f.evidence.remove(f.ownerToken, f.id)).toBe(true);
  expect(await paused.history(f.ownerToken)).toMatchObject({
    kind: "ready",
    receipts: [
      {
        allocationId: f.allocationId,
        sourceAvailable: false,
        held: 0,
        released: 20,
      },
    ],
    next: null,
  });
  expect((await paused.history(f.reviewerToken)).kind).toBe("denied");
  expect((await paused.history(f.ownerToken, randomUUID())).kind).toBe(
    "denied",
  );
});

it("retains begun units for reconciliation when consent is withdrawn, without allowing later publication", async () => {
  const f = await allocatedFixture();
  saved(await f.feedback.save(f.reviewerToken, f.id, f.draft));
  expect(
    (
      await f.feedback.beginReview(
        f.reviewerToken,
        f.id,
        f.allocationId,
        f.grantId,
        randomUUID(),
      )
    ).kind,
  ).toBe("applied");
  expect(await f.evidence.revokePrivateReview(f.ownerToken, f.id)).toBe(true);
  expect(await minutes.receipt(f.ownerToken, f.allocationId)).toMatchObject({
    kind: "applied",
    receipt: {
      state: "needs_reconciliation",
      held: 20,
      consumed: 0,
      released: 0,
    },
  });
  expect((await paused.cancel(f.ownerToken, f.allocationId)).kind).toBe(
    "conflict",
  );
  expect(await f.evidence.remove(f.ownerToken, f.id)).toBe(true);
  expect(await paused.receipt(f.ownerToken, f.allocationId)).toMatchObject({
    kind: "applied",
    receipt: {
      state: "needs_reconciliation",
      sourceAvailable: false,
      held: 20,
    },
  });
  expect((await f.feedback.reviewer(f.reviewerToken, f.id)).kind).toBe(
    "denied",
  );
});
it("serializes competing begin and cancellation without partially settling units", async () => {
  const f = await allocatedFixture();
  const [begin, cancel] = await Promise.all([
    f.feedback.beginReview(
      f.reviewerToken,
      f.id,
      f.allocationId,
      f.grantId,
      randomUUID(),
    ),
    minutes.cancel(f.ownerToken, f.allocationId),
  ]);
  const receipt = await minutes.receipt(f.ownerToken, f.allocationId);
  expect(receipt.kind).toBe("applied");
  if (receipt.kind !== "applied") throw Error("Expected owned receipt");
  if (receipt.receipt.state === "begun") {
    expect(begin.kind).toBe("applied");
    expect(cancel.kind).toBe("conflict");
    expect(receipt.receipt).toMatchObject({
      held: 20,
      consumed: 0,
      released: 0,
    });
  } else {
    expect(receipt.receipt.state).toBe("cancelled");
    expect(cancel.kind).toBe("applied");
    expect(begin.kind).toBe("conflict");
    expect(receipt.receipt).toMatchObject({
      held: 0,
      consumed: 0,
      released: 20,
    });
  }
});
it.each([false, true])(
  "account erasure removes private review accounting after begun=%s",
  async (begun) => {
    const f = await allocatedFixture();
    if (begun)
      expect(
        (
          await f.feedback.beginReview(
            f.reviewerToken,
            f.id,
            f.allocationId,
            f.grantId,
            randomUUID(),
          )
        ).kind,
      ).toBe("applied");
    await db.remove(f.ownerId);
    for (const table of [
      "review_time_allocations",
      "review_time_units",
      "review_time_entries",
      "review_time_grants",
      "review_time_events",
    ]) {
      expect(
        (await pool.query(`SELECT count(*)::integer n FROM ${table}`)).rows[0]
          .n,
      ).toBe(0);
    }
    expect((await minutes.receipt(f.ownerToken, f.allocationId)).kind).toBe(
      "denied",
    );
  },
);

it("withholds publication after the separate time grant is revoked and leaves all units held", async () => {
  const f = await allocatedFixture();
  const row = saved(await f.feedback.save(f.reviewerToken, f.id, f.draft));
  expect(
    (
      await f.feedback.beginReview(
        f.reviewerToken,
        f.id,
        f.allocationId,
        f.grantId,
        randomUUID(),
      )
    ).kind,
  ).toBe("applied");
  expect((await grants.revoke(f.adminToken, f.grantId)).kind).toBe("applied");
  const end = Math.floor(Date.now() / 60000) * 60000 - 60000;
  const result = await f.feedback.publish(
    f.reviewerToken,
    f.id,
    row.revision,
    randomUUID(),
    {
      allocationId: f.allocationId,
      grantId: f.grantId,
      intervals: {
        reviewStart: new Date(end - 600000),
        reviewEnd: new Date(end),
        preparationStart: null,
        preparationEnd: null,
      },
    },
  );
  expect(result.kind).toBe("denied");
  expect(await minutes.receipt(f.ownerToken, f.allocationId)).toMatchObject({
    kind: "applied",
    receipt: { state: "begun", held: 20, consumed: 0, released: 0 },
  });
  expect(
    ready(await f.feedback.owner(f.ownerToken, f.id)).records,
  ).toHaveLength(0);
  expect(
    (await pool.query("SELECT count(*)::integer n FROM review_time_entries"))
      .rows[0].n,
  ).toBe(0);
});
it("serializes concurrent identical publication requests into one effort entry and one debit", async () => {
  const f = await allocatedFixture();
  const row = saved(await f.feedback.save(f.reviewerToken, f.id, f.draft));
  expect(
    (
      await f.feedback.beginReview(
        f.reviewerToken,
        f.id,
        f.allocationId,
        f.grantId,
        randomUUID(),
      )
    ).kind,
  ).toBe("applied");
  const end = Math.floor(Date.now() / 60000) * 60000 - 60000;
  const input = {
    allocationId: f.allocationId,
    grantId: f.grantId,
    intervals: {
      reviewStart: new Date(end - 600000),
      reviewEnd: new Date(end),
      preparationStart: null,
      preparationEnd: null,
    },
  };
  const operation = randomUUID();
  const results = await Promise.all([
    f.feedback.publish(f.reviewerToken, f.id, row.revision, operation, input),
    f.feedback.publish(f.reviewerToken, f.id, row.revision, operation, input),
  ]);
  expect(results.map((r) => r.kind)).toEqual(["saved", "saved"]);
  const report = await ledgerReconciliationStore(pool).snapshot(f.adminToken);
  expect(report.kind).toBe("ready");
  if (report.kind !== "ready") throw Error("Expected reconciliation");
  expect(
    report.value.categories.find((c) => c.category === "review_minutes"),
  ).toMatchObject({
    completion: {
      attachedQuantity: 10,
      deliveredMinutes: 10,
      preparationMinutes: 0,
      consumedWithoutAttachment: 0,
    },
    reconciliation: { status: "consistent" },
  });

  expect(await minutes.receipt(f.ownerToken, f.allocationId)).toMatchObject({
    kind: "applied",
    receipt: { state: "completed", held: 0, consumed: 10, released: 10 },
  });
  expect(
    (await pool.query("SELECT count(*)::integer n FROM review_time_entries"))
      .rows[0].n,
  ).toBe(1);
  expect(
    (
      await f.feedback.publish(f.reviewerToken, f.id, row.revision, operation, {
        ...input,
        intervals: { ...input.intervals, reviewStart: new Date(end - 540000) },
      })
    ).kind,
  ).toBe("conflict");
});

it("reconciles protected held review units without exposing allocation identifiers", async () => {
  const f = await allocatedFixture();
  const report = await ledgerReconciliationStore(pool).snapshot(f.adminToken);
  expect(report.kind).toBe("ready");
  if (report.kind !== "ready") throw Error("Expected reconciliation");
  const review = report.value.categories.find(
    (c) => c.category === "review_minutes",
  )!;
  expect(review.observed.reserved).toBe(20);
  expect(review.reconciliation.status).toBe("consistent");
  expect(JSON.stringify(report)).not.toContain(f.allocationId);
});

it("withholds an allocation response after a delayed successful commit, then reconciles the original key without a second hold", async () => {
  const f = await fixture();
  await syntheticLedger(pool).grant(
    f.ownerId,
    "review_minutes",
    20,
    randomUUID(),
    {
      startsAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: f.end.toISOString(),
    },
  );
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '750 milliseconds' WHERE id=$1",
    [f.ownerId],
  );
  const statements: string[] = [];
  let finish!: () => void;
  const drained = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          statements.push(sql);
          const result = await client.query(sql, values);
          if (sql === "COMMIT")
            try {
              await pool.query(
                "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))+0.1) FROM principals WHERE id=$1",
                [f.ownerId],
              );
            } finally {
              finish();
            }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as import("pg").Pool;
  const key = randomUUID();
  const result = await reviewTimeStore(scoped, {
    enabled: true,
    mode: "test",
  }).allocate(f.ownerToken, f.id, key, 20);
  expect(result.kind).toBe("unavailable");
  await drained;
  expect(statements.filter((s) => s === "COMMIT")).toHaveLength(1);
  expect(statements).not.toContain("ROLLBACK");
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM review_time_allocations",
      )
    ).rows[0].n,
  ).toBe(1);
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
    [f.ownerId],
  );
  const reconciled = await minutes.allocate(f.ownerToken, f.id, key, 20);
  expect(reconciled).toMatchObject({
    kind: "replayed",
    receipt: { held: 20, consumed: 0, released: 0 },
  });
  expect(
    (await pool.query("SELECT count(*)::integer n FROM review_time_units"))
      .rows[0].n,
  ).toBe(20);
});

it("rejects an old writer inserting already-published feedback while review units are held", async () => {
  const f = await allocatedFixture();
  await expect(
    pool.query(
      `INSERT INTO private_sample_feedback(id,submission_id,reviewer_id,source_sha256,source_revision,criteria,draft_operation_id,publication_operation_id,published_at)
 SELECT $1,$2,$3,e.sha256,e.revision_number,$4::jsonb,$5,$6,clock_timestamp() FROM evidence_objects e WHERE e.id=$7`,
      [
        randomUUID(),
        f.submission,
        f.reviewer,
        JSON.stringify(f.draft.criteria),
        randomUUID(),
        randomUUID(),
        f.id,
      ],
    ),
  ).rejects.toThrow();
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_sample_feedback",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(await minutes.receipt(f.ownerToken, f.allocationId)).toMatchObject({
    kind: "applied",
    receipt: { held: 20, consumed: 0, released: 0 },
  });
});

import { supportRequestStore } from "../../src/support-requests.ts";
it.each([
  ["support", false],
  ["review", false],
  ["support", true],
  ["review", true],
] as const)(
  "rejects cross-category overlapping effort after %s with concurrent role transition=%s",
  async (first, concurrent) => {
    const f = await allocatedFixture();
    let pauseNextCommit = false,
      blocker = 0;
    let entered!: () => void, release!: () => void;
    const pausedCommit = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        const pid = (await client.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid as number;
        return {
          query: async (sql: string, values?: unknown[]) => {
            if (sql === "COMMIT" && pauseNextCommit) {
              pauseNextCommit = false;
              blocker = pid;
              entered();
              await resume;
            }
            return client.query(sql, values);
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as import("pg").Pool;
    f.feedback = sampleFeedbackStore(scoped, f.objects, {
      reviewTimeWrites: true,
      mode: "test",
    });
    async function changeDuringCompletion(
      write: () => Promise<{ kind: string }>,
      change: () => Promise<void>,
      expected: string,
    ) {
      const writing = write();
      let changing: Promise<void> | undefined;
      try {
        if (concurrent) {
          await Promise.race([
            pausedCommit,
            writing.then(() => {
              throw Error("Expected paused commit");
            }),
          ]);
          changing = change();
          await waitForBlocker(blocker);
          release();
        }
        expect((await writing).kind).toBe(expected);
        if (changing) await changing;
        else await change();
      } finally {
        release();
        await Promise.allSettled([writing, ...(changing ? [changing] : [])]);
      }
    }
    const draft = saved(await f.feedback.save(f.reviewerToken, f.id, f.draft));
    const end = Math.floor(Date.now() / 60000) * 60000 - 60000;
    const workStart = new Date(end - 600000),
      workEnd = new Date(end);
    const support = supportRequestStore(scoped),
      time = support.time!;
    await syntheticLedger(pool).grant(
      f.ownerId,
      "support_minutes",
      20,
      randomUUID(),
      {
        startsAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: f.end.toISOString(),
      },
    );
    const request = await support.create(f.ownerToken, {
      idempotencyKey: randomUUID(),
      subject: "Invented second category",
      body: "The same actor must not charge overlapping work twice.",
    });
    if (!("receipt" in request)) throw Error("Expected support request");
    const requestId = request.receipt.requestId;
    const held = await time.allocate(f.ownerToken, requestId, randomUUID(), 20);
    if (!("receipt" in held)) throw Error("Expected support allocation");
    const allocationId = held.receipt.allocationId;
    const review = async () => {
      expect(
        (
          await f.feedback.beginReview(
            f.reviewerToken,
            f.id,
            f.allocationId,
            f.grantId,
            randomUUID(),
          )
        ).kind,
      ).toBe("applied");
      pauseNextCommit = concurrent && first === "review";
      return f.feedback.publish(
        f.reviewerToken,
        f.id,
        draft.revision,
        randomUUID(),
        {
          allocationId: f.allocationId,
          grantId: f.grantId,
          intervals: {
            reviewStart: workStart,
            reviewEnd: workEnd,
            preparationStart: null,
            preparationEnd: null,
          },
        },
      );
    };
    const becomeOperator = async () => {
      // Historical entries retain actor identity when current responsibilities change.
      await pool.query("DELETE FROM assignment_grants WHERE staff_id=$1", [
        f.reviewer,
      ]);
      await pool.query(
        "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1",
        [f.reviewer],
      );
    };
    const becomeReviewer = async () => {
      await pool.query(
        "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
        [f.reviewer],
      );
      const assignment = await auth.grantAssignment(
        f.admin,
        f.reviewer,
        f.ownerId,
        "reviewer",
        "Restored invented review",
        f.end,
      );
      await auth.grantEvidenceReview(
        f.admin,
        f.reviewer,
        assignment,
        f.submission,
        SAMPLE_FEEDBACK_PURPOSE,
        f.end,
      );
    };
    const recordSupport = async () => {
      const grant = await time.grant(f.adminToken, {
        requestId,
        allocationId,
        staffId: f.reviewer,
        role: "operator",
        startsAt: new Date(Date.now() - 60000),
        expiresAt: f.end,
        idempotencyKey: randomUUID(),
      });
      if (!("grantId" in grant)) throw Error("Expected support time grant");
      const scope = { requestId, allocationId, grantId: grant.grantId };
      expect(
        (await time.begin(f.reviewerToken, scope, randomUUID())).kind,
      ).toBe("applied");
      pauseNextCommit = concurrent && first === "support";
      return time.record(f.reviewerToken, scope, randomUUID(), {
        supportStart: workStart,
        supportEnd: workEnd,
        preparationStart: null,
        preparationEnd: null,
      });
    };
    if (first === "review") {
      await changeDuringCompletion(review, becomeOperator, "saved");
      expect((await recordSupport()).kind).not.toBe("applied");
    } else {
      await becomeOperator();
      await changeDuringCompletion(recordSupport, becomeReviewer, "applied");
      expect((await review()).kind).not.toBe("saved");
    }
    const counts = await pool.query(
      `
      SELECT (SELECT count(*)::integer FROM support_time_entries WHERE actor_id=$1) AS support,
             (SELECT count(*)::integer FROM review_time_entries WHERE actor_id=$1) AS review`,
      [f.reviewer],
    );
    expect(counts.rows).toEqual([
      {
        support: first === "support" ? 1 : 0,
        review: first === "review" ? 1 : 0,
      },
    ]);
    const balances = await pool.query(
      "SELECT category AS unit,available,reserved,consumed FROM synthetic_entitlement_grants WHERE member_id=$1 ORDER BY unit",
      [f.ownerId],
    );
    expect(balances.rows).toEqual([
      {
        unit: "review_minutes",
        available: first === "review" ? 10 : 0,
        reserved: first === "review" ? 0 : 20,
        consumed: first === "review" ? 10 : 0,
      },
      {
        unit: "support_minutes",
        available: first === "support" ? 10 : 0,
        reserved: first === "support" ? 0 : 20,
        consumed: first === "support" ? 10 : 0,
      },
    ]);
  },
);

it("records allocation-specific grant and revoke audit exactly once without private source content", async () => {
  const f = await allocatedFixture();
  const readEvents = async () =>
    (
      await pool.query(
        "SELECT action,actor_id,member_id FROM review_time_events WHERE allocation_id=$1 AND action IN ('grant-created','grant-revoked') ORDER BY occurred_at,id",
        [f.allocationId],
      )
    ).rows;
  expect(await readEvents()).toEqual([
    { action: "grant-created", actor_id: f.admin, member_id: f.ownerId },
  ]);
  expect((await grants.revoke(f.ownerToken, f.grantId)).kind).toBe("denied");
  expect((await grants.revoke(f.adminToken, f.grantId)).kind).toBe("applied");
  expect((await grants.revoke(f.adminToken, f.grantId)).kind).toBe("replayed");
  expect(await readEvents()).toEqual([
    { action: "grant-created", actor_id: f.admin, member_id: f.ownerId },
    { action: "grant-revoked", actor_id: f.admin, member_id: f.ownerId },
  ]);
});

it("rolls back a partially consumed maximum allocation and permits exact original publication after recovery", async () => {
  const f = await allocatedFixture(120);
  const draft = saved(await f.feedback.save(f.reviewerToken, f.id, f.draft));
  expect(
    (
      await f.feedback.beginReview(
        f.reviewerToken,
        f.id,
        f.allocationId,
        f.grantId,
        randomUUID(),
      )
    ).kind,
  ).toBe("applied");
  const end = Math.floor(Date.now() / 60000) * 60000 - 60000;
  const operation = randomUUID();
  const input = {
    allocationId: f.allocationId,
    grantId: f.grantId,
    intervals: {
      reviewStart: new Date(end - 120 * 60000),
      reviewEnd: new Date(end),
      preparationStart: null,
      preparationEnd: null,
    },
  };
  await pool.query(`
    CREATE FUNCTION test_review_mid_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.category='review_minutes' AND NEW.consumed=60 THEN
        RAISE EXCEPTION 'Invented halfway settlement failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_review_mid_settlement BEFORE UPDATE ON synthetic_entitlement_grants
      FOR EACH ROW EXECUTE FUNCTION test_review_mid_settlement();
  `);
  try {
    expect(
      (
        await f.feedback.publish(
          f.reviewerToken,
          f.id,
          draft.revision,
          operation,
          input,
        )
      ).kind,
    ).toBe("unavailable");
    expect(await minutes.receipt(f.ownerToken, f.allocationId)).toMatchObject({
      receipt: { state: "begun", held: 120, consumed: 0, released: 0 },
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM review_time_entries WHERE allocation_id=$1",
          [f.allocationId],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    expect(
      (
        await pool.query(
          "SELECT published_at FROM private_sample_feedback WHERE submission_id=$1",
          [f.submission],
        )
      ).rows,
    ).toEqual([{ published_at: null }]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM synthetic_entitlement_events e JOIN review_time_units u ON u.reservation_id=e.reservation_id WHERE u.allocation_id=$1 AND e.operation='consume'",
          [f.allocationId],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  } finally {
    await pool.query(
      "DROP TRIGGER test_review_mid_settlement ON synthetic_entitlement_grants; DROP FUNCTION test_review_mid_settlement()",
    );
  }
  expect(
    (
      await f.feedback.publish(
        f.reviewerToken,
        f.id,
        draft.revision,
        operation,
        input,
      )
    ).kind,
  ).toBe("saved");
  expect(await minutes.receipt(f.ownerToken, f.allocationId)).toMatchObject({
    receipt: { state: "completed", held: 0, consumed: 120, released: 0 },
  });
});

import { memberExportStore } from "../../src/member-export.ts";
describe("retained review history beyond one export page", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let ids: string[];
  beforeEach(async () => {
    f = await fixture();
    ids = [];
    await syntheticLedger(pool).grant(
      f.ownerId,
      "review_minutes",
      1,
      randomUUID(),
      {
        startsAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: f.end.toISOString(),
      },
    );
    for (let i = 0; i < 101; i++) {
      const held = await minutes.allocate(f.ownerToken, f.id, randomUUID(), 1);
      if (held.kind !== "applied")
        throw Error("Expected bounded history fixture allocation");
      ids.push(held.receipt.allocationId);
      const cancelled = await minutes.cancel(
        f.ownerToken,
        held.receipt.allocationId,
      );
      if (cancelled.kind !== "applied")
        throw Error("Expected bounded history fixture cancellation");
    }
  }, 30000);
  it("pages every owned receipt and exports all retained allocations/events without duplicates or private reviewer data", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await paused.history(f.ownerToken, cursor);
      if (result.kind !== "ready") throw Error("Expected owned paused history");
      expect(result.receipts.length).toBeLessThanOrEqual(20);
      for (const receipt of result.receipts) {
        expect(receipt).toMatchObject({
          state: "cancelled",
          held: 0,
          consumed: 0,
          released: 1,
        });
        seen.push(receipt.allocationId);
      }
      cursor = result.next ?? undefined;
      expect(seen.length).toBeLessThanOrEqual(101);
    } while (cursor);
    expect(seen).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(101);
    const allocations: Record<string, unknown>[] = [],
      events: Record<string, unknown>[] = [];
    const exports = memberExportStore(pool);
    let pages = 0;
    do {
      const result = await exports.exportOwned(f.ownerToken, cursor);
      if (result.kind !== "ready") throw Error("Expected owned export");
      expect(
        Object.values(result.payload.records).flat().length,
      ).toBeLessThanOrEqual(100);
      allocations.push(...(result.payload.records.reviewTimeAllocations ?? []));
      events.push(...(result.payload.records.reviewTimeEvents ?? []));
      cursor = result.payload.page.nextCursor ?? undefined;
      expect(++pages).toBeLessThan(20);
    } while (cursor);
    expect(allocations.map((row) => row.id).sort()).toEqual([...ids].sort());
    expect(events).toHaveLength(202);
    expect(new Set(events.map((row) => row.id)).size).toBe(202);
    expect(JSON.stringify({ allocations, events })).not.toContain(f.reviewer);
    expect(JSON.stringify({ allocations, events })).not.toContain(f.source);
    expect(await paused.history(f.reviewerToken)).toEqual({ kind: "denied" });
  });
});

it("upgrades populated pre-review-time feedback twice without converting unbilled observations into charges or grants", async () => {
  const schema = "legacy_review_" + randomUUID().replaceAll("-", "");
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const directory = new URL("../../migrations/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter(
        (name) =>
          /^\d{3}-.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 57,
      )
      .sort())
      await client.query(await readFile(new URL(name, directory), "utf8"));
    const scoped = {
      query: client.query.bind(client),
      async connect() {
        return { query: client.query.bind(client), release() {} };
      },
    } as unknown as import("pg").Pool;
    const f = await fixture(SAMPLE_FEEDBACK_PURPOSE, scoped);
    const feedbackId = randomUUID();
    await client.query(
      `
      INSERT INTO private_sample_feedback(id,submission_id,reviewer_id,source_sha256,source_revision,criteria,preparation_minutes,review_minutes,draft_operation_id,publication_operation_id,published_at)
      SELECT $1,$2,$3,e.sha256,e.revision_number,$4::jsonb,5,10,$5,$6,clock_timestamp()
      FROM evidence_objects e WHERE e.id=$7
    `,
      [
        feedbackId,
        f.submission,
        f.reviewer,
        JSON.stringify(f.draft.criteria),
        randomUUID(),
        randomUUID(),
        f.id,
      ],
    );
    const before = (
      await client.query("SELECT * FROM private_sample_feedback WHERE id=$1", [
        feedbackId,
      ])
    ).rows;
    const originalGrants = (
      await client.query("SELECT * FROM reviewer_evidence_grants ORDER BY id")
    ).rows;
    const migration = await readFile(
      new URL("058-private-review-time.sql", directory),
      "utf8",
    );
    await client.query(migration);
    await client.query(migration);
    expect(
      (
        await client.query(
          "SELECT * FROM private_sample_feedback WHERE id=$1",
          [feedbackId],
        )
      ).rows,
    ).toEqual(before);
    expect(
      (await client.query("SELECT * FROM reviewer_evidence_grants ORDER BY id"))
        .rows,
    ).toEqual(originalGrants);
    for (const table of [
      "review_time_allocations",
      "review_time_grants",
      "review_time_entries",
      "review_time_units",
      "review_time_events",
      "synthetic_entitlement_events",
    ])
      expect(
        (await client.query(`SELECT count(*)::integer n FROM ${table}`)).rows,
      ).toEqual([{ n: 0 }]);
    const owner = ready(await f.feedback.owner(f.ownerToken, f.id));
    expect(owner.records).toHaveLength(1);
    expect(owner.records[0]).toMatchObject({
      preparationMinutes: 5,
      reviewMinutes: 10,
    });
  } finally {
    await client.query("ROLLBACK");
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
  }
});

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function waitForBlocker(pid: number) {
  for (let i = 0; i < 200; i++) {
    if (
      (
        await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
          [pid],
        )
      ).rowCount
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected actual PostgreSQL blocker");
}
it.each([
  ["publication", "revocation"],
  ["revocation", "revocation"],
  ["publication", "withdrawal"],
  ["revocation", "withdrawal"],
  ["publication", "deletion"],
  ["revocation", "deletion"],
] as const)(
  "preserves atomic review settlement when %s wins against %s",
  async (winner, stopping) => {
    const f = await allocatedFixture();
    const draft = saved(await f.feedback.save(f.reviewerToken, f.id, f.draft));
    expect(
      (
        await f.feedback.beginReview(
          f.reviewerToken,
          f.id,
          f.allocationId,
          f.grantId,
          randomUUID(),
        )
      ).kind,
    ).toBe("applied");
    const end = Math.floor(Date.now() / 60000) * 60000 - 60000;
    const input = {
      allocationId: f.allocationId,
      grantId: f.grantId,
      intervals: {
        reviewStart: new Date(end - 600000),
        reviewEnd: new Date(end),
        preparationStart: null,
        preparationEnd: null,
      },
    };
    if (winner === "revocation") {
      const holder = await pool.connect();
      let publishing: Promise<SampleFeedbackResult> | undefined;
      try {
        await holder.query("BEGIN");
        const pid = (await holder.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid as number;
        if (stopping === "revocation")
          await holder.query(
            "UPDATE review_time_grants SET revoked_at=clock_timestamp() WHERE id=$1",
            [f.grantId],
          );
        else if (stopping === "withdrawal")
          await holder.query(
            "UPDATE evidence_objects SET private_review_allowed=false,private_review_revoked_at=clock_timestamp() WHERE id=$1",
            [f.id],
          );
        else {
          await holder.query(
            "UPDATE evidence_objects SET quarantine_state='deleting' WHERE id=$1",
            [f.id],
          );
          await holder.query("DELETE FROM evidence_objects WHERE id=$1", [
            f.id,
          ]);
        }
        publishing = f.feedback.publish(
          f.reviewerToken,
          f.id,
          draft.revision,
          randomUUID(),
          input,
        );
        await waitForBlocker(pid);
        await holder.query("COMMIT");
        expect((await publishing).kind).toBe("denied");
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
        await Promise.allSettled(publishing ? [publishing] : []);
      }
    } else {
      const entered = barrier(),
        resume = barrier();
      let pid = 0,
        paused = false;
      const scoped = {
        async connect() {
          const client = await pool.connect();
          pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
            .pid as number;
          return {
            query: async (sql: string, values?: unknown[]) => {
              const result = await client.query(sql, values);
              if (
                !paused &&
                sql.includes(
                  "SELECT g.expires_at AS expires FROM review_time_grants",
                )
              ) {
                paused = true;
                entered.release();
                await resume.wait;
              }
              return result;
            },
            release: client.release.bind(client),
          };
        },
      } as unknown as import("pg").Pool;
      const publishing = sampleFeedbackStore(scoped, f.objects, {
        reviewTimeWrites: true,
        mode: "test",
      }).publish(f.reviewerToken, f.id, draft.revision, randomUUID(), input);
      let revoking: Promise<unknown> | undefined;
      try {
        await Promise.race([
          entered.wait,
          publishing.then(() => {
            throw Error("Publication ended before grant fence");
          }),
        ]);
        revoking =
          stopping === "revocation"
            ? grants.revoke(f.adminToken, f.grantId)
            : stopping === "withdrawal"
              ? f.evidence.revokePrivateReview(f.ownerToken, f.id)
              : f.evidence.remove(f.ownerToken, f.id);
        await waitForBlocker(pid);
        resume.release();
        expect((await publishing).kind).toBe("saved");
        const stopped = await revoking;
        if (stopping === "revocation")
          expect(stopped).toMatchObject({ kind: "applied" });
        else expect(stopped).toBe(true);
      } finally {
        resume.release();
        await Promise.allSettled([publishing, ...(revoking ? [revoking] : [])]);
      }
    }
    const completed = winner === "publication";
    expect(
      (
        await pool.query(
          "SELECT published_at IS NOT NULL AS published FROM private_sample_feedback WHERE submission_id=$1",
          [f.submission],
        )
      ).rows,
    ).toEqual(stopping === "deletion" ? [] : [{ published: completed }]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM review_time_entries WHERE allocation_id=$1",
          [f.allocationId],
        )
      ).rows,
    ).toEqual([{ n: completed ? 1 : 0 }]);
    expect(await minutes.receipt(f.ownerToken, f.allocationId)).toMatchObject({
      receipt: {
        held: completed ? 0 : 20,
        consumed: completed ? 10 : 0,
        released: completed ? 10 : 0,
      },
    });
  },
);
it("serializes two different samples competing for the last review minute without overspending", async () => {
  const f = await fixture();
  await syntheticLedger(pool).grant(
    f.ownerId,
    "review_minutes",
    1,
    randomUUID(),
    {
      startsAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: f.end.toISOString(),
    },
  );
  const second = await f.evidence.upload(f.ownerToken, {
    name: "Second invented last-unit sample",
    mediaType: "text/plain",
    data: Buffer.from("Second invented source."),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (second.kind !== "created") throw Error("Expected second source");
  expect(await f.evidence.transitionQuarantine(second.id, "clean")).toBe(true);
  await f.evidence.submitForReview(f.ownerToken, second.id);
  const sources = [f.id, second.id],
    keys = [randomUUID(), randomUUID()];
  const results = await Promise.all(
    sources.map((source, i) =>
      minutes.allocate(f.ownerToken, source, keys[i]!, 1),
    ),
  );
  expect(results.map((result) => result.kind).sort()).toEqual([
    "applied",
    "insufficient",
  ]);
  const winner = results.findIndex((result) => result.kind === "applied");
  const result = results[winner]!;
  if (result.kind !== "applied") throw Error("Expected one winning allocation");
  expect(
    await minutes.allocate(f.ownerToken, sources[winner]!, keys[winner]!, 1),
  ).toMatchObject({
    kind: "replayed",
    receipt: { allocationId: result.receipt.allocationId, held: 1 },
  });
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE member_id=$1",
        [f.ownerId],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 1, consumed: 0 }]);
  expect(
    (await pool.query("SELECT count(*)::integer n FROM review_time_units"))
      .rows,
  ).toEqual([{ n: 1 }]);
});

it.each(["commit-reply", "native-handback"] as const)(
  "withholds allocated publication after expired %s while preserving one durable settlement",
  async (boundary) => {
    const f = await allocatedFixture();
    const draft = saved(await f.feedback.save(f.reviewerToken, f.id, f.draft));
    expect(
      (
        await f.feedback.beginReview(
          f.reviewerToken,
          f.id,
          f.allocationId,
          f.grantId,
          randomUUID(),
        )
      ).kind,
    ).toBe("applied");
    const end = Math.floor(Date.now() / 60000) * 60000 - 60000;
    const input = {
      allocationId: f.allocationId,
      grantId: f.grantId,
      intervals: {
        reviewStart: new Date(end - 600000),
        reviewEnd: new Date(end),
        preparationStart: new Date(end - 900000),
        preparationEnd: new Date(end - 600000),
      },
    };
    const operation = randomUUID(),
      statements: string[] = [];
    let released = false,
      finish!: () => void;
    const drained = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '750 milliseconds' WHERE id=$1",
      [f.reviewer],
    );
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            statements.push(sql);
            const result = await client.query(sql, values);
            if (sql === "COMMIT" && boundary === "commit-reply") {
              try {
                await pool.query(
                  "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))+0.1) FROM principals WHERE id=$1",
                  [f.reviewer],
                );
              } finally {
                finish();
              }
            }
            return result;
          },
          release: (error?: Error | boolean) => {
            client.release(error);
            released = true;
            if (boundary === "native-handback") {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 850);
              finish();
            }
          },
        };
      },
    } as unknown as import("pg").Pool;
    const feedback = sampleFeedbackStore(scoped, f.objects, {
      reviewTimeWrites: true,
      mode: "test",
    });
    expect(
      await feedback.publish(
        f.reviewerToken,
        f.id,
        draft.revision,
        operation,
        input,
      ),
    ).toEqual({ kind: "unavailable" });
    await drained;
    expect(released).toBe(true);
    expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(statements).not.toContain("ROLLBACK");
    expect(await minutes.receipt(f.ownerToken, f.allocationId)).toMatchObject({
      kind: "applied",
      receipt: { state: "completed", consumed: 15, released: 5, held: 0 },
    });
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
      [f.reviewer],
    );
    saved(
      await f.feedback.publish(
        f.reviewerToken,
        f.id,
        draft.revision,
        operation,
        input,
      ),
    );
    expect(
      (await pool.query("SELECT count(*)::integer n FROM review_time_entries"))
        .rows,
    ).toEqual([{ n: 1 }]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM private_sample_feedback WHERE published_at IS NOT NULL",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
    expect(await minutes.receipt(f.ownerToken, f.allocationId)).toMatchObject({
      kind: "applied",
      receipt: { consumed: 15, released: 5, held: 0 },
    });
  },
);

it("shows the grant pinned at begin even when another valid grant sorts before it", async () => {
  const f = await allocatedFixture();
  const second = await grants.grant(
    f.adminToken,
    f.allocationId,
    f.reviewer,
    new Date(Date.now() - 60000),
    f.end,
    randomUUID(),
  );
  if (second.kind !== "applied") throw Error("Expected another scoped grant");
  const pinned = [f.grantId, second.grantId].sort()[1]!;
  expect(
    (
      await f.feedback.beginReview(
        f.reviewerToken,
        f.id,
        f.allocationId,
        pinned,
        randomUUID(),
      )
    ).kind,
  ).toBe("applied");
  expect(
    ready(await f.feedback.reviewer(f.reviewerToken, f.id)).reviewAllocation,
  ).toMatchObject({
    grantId: pinned,
    receipt: { allocationId: f.allocationId, state: "begun" },
  });
});
