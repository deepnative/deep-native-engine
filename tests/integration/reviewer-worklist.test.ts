import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
import {
  reviewerWorklistStore,
  type ReviewerWorklistResult,
} from "../../src/reviewer-worklist.ts";
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
function saved(result: SampleFeedbackResult) {
  if (result.kind !== "saved") throw Error("Expected saved sample feedback");
  return result;
}
async function fixture(purpose = SAMPLE_FEEDBACK_PURPOSE) {
  const ownerToken = randomBytes(32).toString("hex"),
    reviewerToken = randomBytes(32).toString("hex");
  await db.create(ownerToken, { background: "professional", goal: "everyday" });
  const owner = await db.session(ownerToken);
  if (owner.kind !== "active") throw Error("Expected active owner");
  const end = new Date(Date.now() + 3600000);
  const admin = await auth.provisionStaff(
    randomBytes(32).toString("hex"),
    "platform_admin",
    end,
  );
  const reviewer = await auth.provisionStaff(reviewerToken, "reviewer", end);
  const objects = fileObjectStorage(root),
    evidence = evidenceStore(pool, objects, "invented-test-secret"),
    feedback = sampleFeedbackStore(pool, objects);
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
    await pool.query(
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
function listed(result: ReviewerWorklistResult) {
  if (result.kind !== "ready") throw Error("Expected authorized worklist");
  return result;
}
it("discovers only own exact-granted metadata and moves feedback through active/completed states", async () => {
  const f = await fixture(),
    list = reviewerWorklistStore(pool);
  const first = listed(await list.list(f.reviewerToken, "active"));
  expect(first.items).toHaveLength(1);
  expect(first.items[0]).toMatchObject({
    evidenceId: f.id,
    title: "Invented feedback sample",
    version: 1,
    state: "not-started",
  });
  expect(JSON.stringify(first)).not.toContain(f.source);
  expect(listed(await list.list(f.reviewerToken, "completed")).items).toEqual(
    [],
  );
  const row = saved(await f.feedback.save(f.reviewerToken, f.id, f.draft));
  expect(
    listed(await list.list(f.reviewerToken, "active")).items[0]?.state,
  ).toBe("draft");
  expect(
    JSON.stringify(await list.list(f.reviewerToken, "active")),
  ).not.toContain(f.draft.criteria[0]!.comment);
  saved(
    await f.feedback.publish(f.reviewerToken, f.id, row.revision, randomUUID()),
  );
  expect(listed(await list.list(f.reviewerToken, "active")).items).toEqual([]);
  expect(
    listed(await list.list(f.reviewerToken, "completed")).items[0]?.state,
  ).toBe("published");
  saved(
    await f.feedback.clarify(
      f.ownerToken,
      f.id,
      row.id,
      "Which claim?",
      randomUUID(),
    ),
  );
  expect(
    listed(await list.list(f.reviewerToken, "active")).items[0]?.state,
  ).toBe("clarification-needed");
  expect(listed(await list.list(f.reviewerToken, "completed")).items).toEqual(
    [],
  );
  saved(
    await f.feedback.answer(
      f.reviewerToken,
      f.id,
      row.id,
      "The first.",
      randomUUID(),
    ),
  );
  expect(
    listed(await list.list(f.reviewerToken, "completed")).items[0]?.state,
  ).toBe("published");
  expect(await list.list(f.ownerToken, "active")).toEqual({ kind: "denied" });
  expect(await list.list(randomBytes(32).toString("hex"), "active")).toEqual({
    kind: "denied",
  });
});
it("does not duplicate a source with several valid grants", async () => {
  const f = await fixture();
  await auth.grantEvidenceReview(
    f.admin,
    f.reviewer,
    f.assignment,
    f.submission,
    SAMPLE_FEEDBACK_PURPOSE,
    f.end,
  );
  expect(
    listed(await reviewerWorklistStore(pool).list(f.reviewerToken, "active"))
      .items,
  ).toHaveLength(1);
});
it("excludes different-purpose grants and respects read pause", async () => {
  const f = await fixture("unrelated-purpose");
  expect(
    listed(await reviewerWorklistStore(pool).list(f.reviewerToken, "active"))
      .items,
  ).toEqual([]);
  expect(
    await reviewerWorklistStore(pool, Buffer.alloc(32), false).list(
      f.reviewerToken,
      "active",
    ),
  ).toEqual({ kind: "unavailable" });
});
it.each(["exact", "assignment", "consent", "quarantine", "source"])(
  "excludes %s withdrawn authority",
  async (kind) => {
    const f = await fixture(),
      list = reviewerWorklistStore(pool);
    expect(
      listed(await list.list(f.reviewerToken, "active")).items,
    ).toHaveLength(1);
    if (kind === "exact") await auth.revokeEvidenceReview(f.admin, f.exact);
    if (kind === "assignment")
      await auth.revokeAssignment(f.admin, f.assignment);
    if (kind === "consent")
      await f.evidence.revokePrivateReview(f.ownerToken, f.id);
    if (kind === "quarantine")
      await pool.query(
        "UPDATE evidence_objects SET quarantine_state='pending' WHERE id=$1",
        [f.id],
      );
    if (kind === "source")
      await pool.query("DELETE FROM evidence_objects WHERE id=$1", [f.id]);
    expect(listed(await list.list(f.reviewerToken, "active")).items).toEqual(
      [],
    );
  },
);
it("paginates 105 same-time samples across owners without duplicates or omissions", async () => {
  const observed: { sql: string; values?: unknown[] }[] = [];
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (async (sql: string, values?: unknown[]) => {
          observed.push({ sql, values });
          return client.query(sql, values);
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const f = await fixture(),
    list = reviewerWorklistStore(scoped),
    members = [
      { token: f.ownerToken, id: f.ownerId, assignment: f.assignment },
    ];
  for (let index = 0; index < 2; index++) {
    const token = randomBytes(32).toString("hex");
    await db.create(token, {
      background: index === 0 ? "technical" : "explorer",
      goal: "everyday",
    });
    const session = await db.session(token);
    if (session.kind !== "active") throw Error("Expected member");
    const assignment = await auth.grantAssignment(
      f.admin,
      f.reviewer,
      session.learner.id,
      "reviewer",
      "invented feedback",
      f.end,
    );
    members.push({ token, id: session.learner.id, assignment });
  }
  for (let index = 1; index < 105; index++) {
    const owner = members[index % 3]!;
    const result = await f.evidence.upload(owner.token, {
      name: `Invented queue ${index}`,
      mediaType: "text/plain",
      data: Buffer.from("Invented queue sample."),
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    });
    if (result.kind !== "created") throw Error("Expected uploaded fixture");
    await f.evidence.transitionQuarantine(result.id, "clean");
    await f.evidence.submitForReview(owner.token, result.id);
    const submission = (
      await pool.query(
        "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
        [result.id],
      )
    ).rows[0].id as string;
    await auth.grantEvidenceReview(
      f.admin,
      f.reviewer,
      owner.assignment,
      submission,
      SAMPLE_FEEDBACK_PURPOSE,
      f.end,
    );
  }
  await pool.query(
    "UPDATE evidence_review_submissions SET created_at='2026-01-01T12:00:00.123456Z'",
  );
  const expected = (
    await pool.query(
      "SELECT evidence_id FROM evidence_review_submissions ORDER BY created_at,id",
    )
  ).rows.map((r) => r.evidence_id);
  const seen: string[] = [];
  let after: string | undefined;
  let pages = 0;
  let firstCursor: string | undefined;
  do {
    const before = observed.length;
    const result = listed(await list.list(f.reviewerToken, "active", after));
    const queries = observed.slice(before);
    expect(queries.length).toBeLessThanOrEqual(30);
    for (const query of queries) {
      for (const value of query.values ?? []) {
        if (Array.isArray(value)) expect(value.length).toBeLessThanOrEqual(21);
      }
    }
    expect(result.items.length).toBeLessThanOrEqual(20);
    expect(
      result.items.every(
        (i) =>
          i.submittedAt === "2026-01-01T12:00:00.123456Z" && i.ageMinutes > 0,
      ),
    ).toBe(true);
    seen.push(...result.items.map((i) => i.evidenceId));
    after = result.next ?? undefined;
    firstCursor ??= after;
    pages++;
    expect(pages).toBeLessThanOrEqual(6);
  } while (after);
  expect(pages).toBe(6);
  expect(seen).toEqual(expected);
  const discovery = observed.find(
    (q) => q.sql.startsWith("SELECT s.id") && q.sql.includes("$4::timestamptz"),
  );
  expect(discovery).toBeDefined();
  const explained = await pool.query(
    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + discovery!.sql,
    discovery!.values,
  );
  const plan = explained.rows[0]["QUERY PLAN"][0];
  expect(plan.Plan["Actual Rows"]).toBe(21);
  expect(plan["Execution Time"]).toBeLessThan(5000);
  // A local fixture measurement, not a production benchmark or a SQL scan bound.
  console.info("Reviewer worklist fixture bounds", {
    samples: expected.length,
    pages,
    firstPageRows: plan.Plan["Actual Rows"],
    executionMs: plan["Execution Time"],
    totalPageQueries: observed.length,
  });
  expect(new Set(seen).size).toBe(105);
  expect(await list.list(f.reviewerToken, "completed", firstCursor)).toEqual({
    kind: "invalid",
  });
  expect(await list.list(f.ownerToken, "active", firstCursor)).toEqual({
    kind: "invalid",
  });
  expect(await list.list(f.reviewerToken, "active", firstCursor + "x")).toEqual(
    { kind: "invalid" },
  );
}, 30000);
it.each(["role", "session"])(
  "denies a changed %s on the next read",
  async (kind) => {
    const f = await fixture(),
      list = reviewerWorklistStore(pool);
    expect(
      listed(await list.list(f.reviewerToken, "active")).items,
    ).toHaveLength(1);
    if (kind === "role") {
      // The existing role FK requires removing incompatible assignments first.
      await pool.query("DELETE FROM assignment_grants WHERE staff_id=$1", [
        f.reviewer,
      ]);
      await pool.query(
        "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1",
        [f.reviewer],
      );
    } else
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [f.reviewer],
      );
    expect(await list.list(f.reviewerToken, "active")).toEqual({
      kind: "denied",
    });
  },
);
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { release, wait };
}
async function blockedBy(pid: number) {
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
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Expected actual PostgreSQL blocker");
}
const changes = {
  exact:
    "UPDATE reviewer_evidence_grants SET revoked_at=clock_timestamp() WHERE id=$1",
  assignment:
    "UPDATE assignment_grants SET revoked_at=clock_timestamp() WHERE id=$1",
  consent:
    "UPDATE evidence_objects SET private_review_allowed=false,private_review_revoked_at=clock_timestamp() WHERE id=$1",
  source: "DELETE FROM evidence_objects WHERE id=$1",
} as const;
it.each(Object.keys(changes) as (keyof typeof changes)[])(
  "withholds a waiting page when %s change wins",
  async (kind) => {
    const f = await fixture(),
      holder = await pool.connect();
    let reading: Promise<ReviewerWorklistResult> | undefined;
    const id =
      kind === "exact" ? f.exact : kind === "assignment" ? f.assignment : f.id;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      await holder.query(changes[kind], [id]);
      reading = reviewerWorklistStore(pool).list(f.reviewerToken, "active");
      await blockedBy(pid);
      await holder.query("COMMIT");
      expect(await reading).toEqual({ kind: "denied" });
      expect(
        listed(
          await reviewerWorklistStore(pool).list(f.reviewerToken, "active"),
        ).items,
      ).toEqual([]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled(reading ? [reading] : []);
    }
  },
);
it.each(Object.keys(changes) as (keyof typeof changes)[])(
  "serializes %s change behind an already authorized page",
  async (kind) => {
    const f = await fixture(),
      entered = gate(),
      resume = gate();
    let pid = 0;
    let changing: Promise<unknown> | undefined;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid;
        return {
          query: (async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.startsWith("INSERT INTO private_sample_feedback_audit")) {
              entered.release();
              await resume.wait;
            }
            return result;
          }) as PoolClient["query"],
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    const reading = reviewerWorklistStore(scoped).list(
      f.reviewerToken,
      "active",
    );
    try {
      await Promise.race([
        entered.wait,
        reading.then(() => {
          throw Error("Read completed before expected fence");
        }),
      ]);
      changing = pool.query(changes[kind], [
        kind === "exact"
          ? f.exact
          : kind === "assignment"
            ? f.assignment
            : f.id,
      ]);
      await blockedBy(pid);
      resume.release();
      expect(listed(await reading).items).toHaveLength(1);
      await changing;
      expect(
        listed(
          await reviewerWorklistStore(pool).list(f.reviewerToken, "active"),
        ).items,
      ).toEqual([]);
    } finally {
      resume.release();
      await Promise.allSettled([reading, ...(changing ? [changing] : [])]);
    }
  },
);
it.each(["commit", "handback"])(
  "withholds private metadata after expiry during %s",
  async (phase) => {
    const f = await fixture(),
      late = gate(),
      statements: string[] = [];
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '600 milliseconds' WHERE id=$1",
      [f.reviewer],
    );
    let released = false;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            statements.push(sql);
            const result = await client.query(sql, values);
            if (sql === "COMMIT" && phase === "commit") {
              try {
                await pool.query(
                  "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))+0.1) FROM principals WHERE id=$1",
                  [f.reviewer],
                );
              } finally {
                late.release();
              }
            }
            return result;
          }) as PoolClient["query"],
          release: (error?: Error | boolean) => {
            client.release(error);
            released = true;
            if (phase === "handback")
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
          },
        };
      },
    } as unknown as Pool;
    expect(
      await reviewerWorklistStore(scoped).list(f.reviewerToken, "active"),
    ).toEqual({ kind: "denied" });
    if (phase === "commit") await late.wait;
    expect(released).toBe(true);
    expect(statements.filter((s) => s === "COMMIT")).toHaveLength(1);
    expect(statements).not.toContain("ROLLBACK");
  },
);

it.each([
  ["assignment_grants", "expired"],
  ["assignment_grants", "future"],
  ["reviewer_evidence_grants", "expired"],
  ["reviewer_evidence_grants", "future"],
] as const)("excludes %s with a %s authority window", async (table, phase) => {
  const f = await fixture();
  await pool.query(
    phase === "expired"
      ? `UPDATE ${table} SET starts_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1`
      : `UPDATE ${table} SET starts_at=clock_timestamp()+interval '1 hour',expires_at=clock_timestamp()+interval '2 hours' WHERE id=$1`,
    [table === "assignment_grants" ? f.assignment : f.exact],
  );
  expect(
    listed(await reviewerWorklistStore(pool).list(f.reviewerToken, "active"))
      .items,
  ).toEqual([]);
});
it("does not expose or classify another reviewer's private draft", async () => {
  const f = await fixture();
  saved(await f.feedback.save(f.reviewerToken, f.id, f.draft));
  const token = randomBytes(32).toString("hex");
  const reviewer = await auth.provisionStaff(token, "reviewer", f.end);
  const assignment = await auth.grantAssignment(
    f.admin,
    reviewer,
    f.ownerId,
    "reviewer",
    "Separate invented review",
    f.end,
  );
  await auth.grantEvidenceReview(
    f.admin,
    reviewer,
    assignment,
    f.submission,
    SAMPLE_FEEDBACK_PURPOSE,
    f.end,
  );
  const result = listed(
    await reviewerWorklistStore(pool).list(token, "active"),
  );
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.state).toBe("not-started");
  expect(JSON.stringify(result)).not.toContain(f.draft.criteria[0]!.comment);
  expect(
    listed(await reviewerWorklistStore(pool).list(token, "completed")).items,
  ).toEqual([]);
});
it("discovers metadata without opening private object files", async () => {
  const f = await fixture();
  await rm(root, { recursive: true, force: true });
  expect(
    listed(await reviewerWorklistStore(pool).list(f.reviewerToken, "active"))
      .items[0]?.evidenceId,
  ).toBe(f.id);
});
