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
import { memberExportStore } from "../../src/member-export.ts";
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
async function publish(f: Awaited<ReturnType<typeof fixture>>) {
  const row = saved(await f.feedback.save(f.reviewerToken, f.id, f.draft));
  saved(
    await f.feedback.publish(f.reviewerToken, f.id, row.revision, randomUUID()),
  );
  return row;
}
it("keeps drafts private, publishes exact saved content, exchanges one clarification and exports only owner-visible data", async () => {
  const f = await fixture(),
    exporter = memberExportStore(pool);
  const row = saved(await f.feedback.save(f.reviewerToken, f.id, f.draft));
  expect(ready(await f.feedback.owner(f.ownerToken, f.id)).records).toEqual([]);
  const draftExport = await exporter.exportOwned(f.ownerToken);
  if (draftExport.kind !== "ready") throw Error("Export unavailable");
  expect(draftExport.payload.records.sampleFeedback).toEqual([]);
  const key = randomUUID();
  expect(await f.feedback.publish(f.reviewerToken, f.id, 1, key)).toEqual(row);
  expect(await f.feedback.publish(f.reviewerToken, f.id, 1, key)).toEqual(row);
  expect(
    await f.feedback.publish(f.reviewerToken, f.id, 1, randomUUID()),
  ).toEqual({ kind: "conflict" });
  const published = ready(await f.feedback.owner(f.ownerToken, f.id))
    .records[0]!;
  expect(published.criteria).toEqual(f.draft.criteria);
  expect(published.authorId).toBe(f.reviewer);
  const question = randomUUID(),
    answer = randomUUID();
  expect(
    await f.feedback.clarify(
      f.ownerToken,
      f.id,
      row.id,
      "Which source comes first?",
      question,
    ),
  ).toEqual(row);
  expect(
    await f.feedback.clarify(
      f.ownerToken,
      f.id,
      row.id,
      "Which source comes first?",
      question,
    ),
  ).toEqual(row);
  expect(
    await f.feedback.clarify(
      f.ownerToken,
      f.id,
      row.id,
      "A different question",
      randomUUID(),
    ),
  ).toEqual({ kind: "conflict" });
  expect(
    await f.feedback.answer(
      f.reviewerToken,
      f.id,
      row.id,
      "Use the original source.",
      answer,
    ),
  ).toEqual(row);
  expect(
    await f.feedback.answer(
      f.reviewerToken,
      f.id,
      row.id,
      "Use the original source.",
      answer,
    ),
  ).toEqual(row);
  expect(
    await f.feedback.answer(
      f.reviewerToken,
      f.id,
      row.id,
      "Different answer",
      randomUUID(),
    ),
  ).toEqual({ kind: "conflict" });
  const result = await exporter.exportOwned(f.ownerToken);
  if (result.kind !== "ready") throw Error("Export unavailable");
  expect(result.payload.records.sampleFeedback).toEqual([
    expect.objectContaining({
      id: row.id,
      evidenceId: f.id,
      authorId: f.reviewer,
      criteria: f.draft.criteria,
      clarification: "Which source comes first?",
      answer: "Use the original source.",
      consentActive: true,
    }),
  ]);
  for (const key of [
    "draftOperationId",
    "publicationOperationId",
    "clarificationOperationId",
    "answerOperationId",
    "token",
    "profile",
  ])
    expect(result.payload.records.sampleFeedback![0]).not.toHaveProperty(key);
  const audit = (
    await pool.query(
      "SELECT action FROM private_sample_feedback_audit ORDER BY occurred_at",
    )
  ).rows;
  expect(audit.map((x) => x.action)).toContain("draft-saved");
  expect(audit.map((x) => x.action)).toContain("published");
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM synthetic_entitlement_events",
      )
    ).rows[0].n,
  ).toBe(0);
});
it.each([
  "read-only",
  "private_sample_feedback_v0",
  "private_sample_feedback_v1 extra",
])(
  "does not turn arbitrary grant purpose %s into publication authority",
  async (purpose) => {
    const f = await fixture(purpose);
    expect((await f.evidence.issueDownload(f.reviewerToken, f.id)).kind).toBe(
      "issued",
    );
    expect(await f.feedback.reviewer(f.reviewerToken, f.id)).toEqual({
      kind: "denied",
    });
    expect(await f.feedback.save(f.reviewerToken, f.id, f.draft)).toEqual({
      kind: "denied",
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM private_sample_feedback",
        )
      ).rows[0].n,
    ).toBe(0);
  },
);
it("rejects stale or reused draft operations without replacing the latest draft", async () => {
  const f = await fixture(),
    first = saved(await f.feedback.save(f.reviewerToken, f.id, f.draft));
  expect(await f.feedback.save(f.reviewerToken, f.id, f.draft)).toEqual(first);
  const secondInput = {
    ...f.draft,
    revision: 1,
    operationId: randomUUID(),
    criteria: [{ ...f.draft.criteria[0]!, comment: "Second draft" }],
  };
  const second = saved(
    await f.feedback.save(f.reviewerToken, f.id, secondInput),
  );
  expect(second.revision).toBe(2);
  expect(await f.feedback.save(f.reviewerToken, f.id, f.draft)).toEqual({
    kind: "conflict",
  });
  expect(
    await f.feedback.save(f.reviewerToken, f.id, {
      ...secondInput,
      revision: 2,
      operationId: f.draft.operationId,
    }),
  ).toEqual({ kind: "conflict" });
  expect(
    await f.feedback.publish(f.reviewerToken, f.id, 1, randomUUID()),
  ).toEqual({ kind: "conflict" });
  expect(
    ready(await f.feedback.reviewer(f.reviewerToken, f.id)).records[0]!
      .criteria[0]!.comment,
  ).toBe("Second draft");
});
it.each(["quote", "offset", "empty", "too many", "minutes", "surrogate"])(
  "rejects invalid %s criteria against the immutable source",
  async (reason) => {
    const f = await fixture();
    const input = structuredClone(f.draft);
    if (reason === "quote") input.criteria[0]!.quote = "Another source";
    if (reason === "offset") input.criteria[0]!.start = 1;
    if (reason === "empty") input.criteria[0]!.comment = "   ";
    if (reason === "too many")
      input.criteria = Array.from({ length: 6 }, () => ({
        ...f.draft.criteria[0]!,
      }));
    if (reason === "minutes") input.reviewMinutes = 481;
    if (reason === "surrogate") {
      const at = f.source.indexOf("🤖");
      input.criteria[0] = {
        ...input.criteria[0]!,
        start: at,
        end: at + 1,
        quote: "\ud83e",
      };
    }
    expect(await f.feedback.save(f.reviewerToken, f.id, input)).toEqual({
      kind: "invalid",
    });
    expect(
      ready(await f.feedback.reviewer(f.reviewerToken, f.id)).records,
    ).toEqual([]);
  },
);
it.each(["principal", "assignment", "exact", "consent", "source", "workspace"])(
  "denies current reviewer reads and writes after %s revocation or deletion",
  async (boundary) => {
    const f = await fixture();
    await publish(f);
    if (boundary === "principal")
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [f.reviewer],
      );
    if (boundary === "assignment")
      await auth.revokeAssignment(f.admin, f.assignment);
    if (boundary === "exact") await auth.revokeEvidenceReview(f.admin, f.exact);
    if (boundary === "consent")
      await f.evidence.revokePrivateReview(f.ownerToken, f.id);
    if (boundary === "source") await f.evidence.remove(f.ownerToken, f.id);
    if (boundary === "workspace")
      await f.evidence.removeWorkspace(f.ownerToken);
    expect(await f.feedback.reviewer(f.reviewerToken, f.id)).toEqual({
      kind: "denied",
    });
    expect(
      await f.feedback.save(f.reviewerToken, f.id, {
        ...f.draft,
        revision: 1,
        operationId: randomUUID(),
      }),
    ).toEqual({ kind: "denied" });
  },
);
it("preserves owner feedback after withdrawal and removes it and draft operations on source deletion", async () => {
  const f = await fixture(),
    row = await publish(f);
  await f.evidence.revokePrivateReview(f.ownerToken, f.id);
  expect(ready(await f.feedback.owner(f.ownerToken, f.id)).records[0]!.id).toBe(
    row.id,
  );
  expect(
    await f.feedback.clarify(
      f.ownerToken,
      f.id,
      row.id,
      "Too late",
      randomUUID(),
    ),
  ).toEqual({ kind: "denied" });
  expect(
    (
      await pool.query(
        "SELECT status FROM evidence_review_submissions WHERE id=$1",
        [f.submission],
      )
    ).rows[0].status,
  ).toBe("reviewed");
  await f.evidence.remove(f.ownerToken, f.id);
  for (const table of [
    "private_sample_feedback",
    "private_sample_feedback_draft_operations",
  ])
    expect(
      (await pool.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0]
        .n,
    ).toBe(0);
  expect(await f.feedback.owner(f.ownerToken, f.id)).toEqual({
    kind: "denied",
  });
});
it("isolates other members and reviewers and never copies grants into a separately consented source revision", async () => {
  const f = await fixture(),
    other = await fixture(),
    row = await publish(f);
  expect(await f.feedback.owner(other.ownerToken, f.id)).toEqual({
    kind: "denied",
  });
  expect(await f.feedback.reviewer(other.reviewerToken, f.id)).toEqual({
    kind: "denied",
  });
  expect(
    await f.feedback.answer(
      other.reviewerToken,
      f.id,
      row.id,
      "Foreign answer",
      randomUUID(),
    ),
  ).toEqual({ kind: "denied" });
  const revised = await f.evidence.upload(f.ownerToken, {
    name: "New sample revision",
    mediaType: "text/plain",
    data: Buffer.from("New invented source"),
    revisesId: f.id,
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (revised.kind !== "created") throw Error("Revision denied");
  await f.evidence.transitionQuarantine(revised.id, "clean");
  await f.evidence.submitForReview(f.ownerToken, revised.id);
  expect(await f.feedback.reviewer(f.reviewerToken, revised.id)).toEqual({
    kind: "denied",
  });
  expect(
    ready(await f.feedback.owner(f.ownerToken, f.id)).records[0]!.criteria,
  ).toEqual(f.draft.criteria);
});
it("serializes competing publication and rejects edits to the published database snapshot", async () => {
  const f = await fixture();
  await f.feedback.save(f.reviewerToken, f.id, f.draft);
  const results = await Promise.all([
    f.feedback.publish(f.reviewerToken, f.id, 1, randomUUID()),
    f.feedback.publish(f.reviewerToken, f.id, 1, randomUUID()),
  ]);
  expect(results.map((x) => x.kind).sort()).toEqual(["conflict", "saved"]);
  const row = ready(await f.feedback.owner(f.ownerToken, f.id)).records[0]!;
  await expect(
    pool.query("UPDATE private_sample_feedback SET criteria=$2 WHERE id=$1", [
      row.id,
      JSON.stringify([
        { ...f.draft.criteria[0], comment: "Changed after publication" },
      ]),
    ]),
  ).rejects.toThrow("Published sample feedback is immutable");
  expect(
    await f.feedback.save(f.reviewerToken, f.id, {
      ...f.draft,
      revision: 1,
      operationId: randomUUID(),
    }),
  ).toEqual({ kind: "conflict" });
});
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
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
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected actual PostgreSQL blocker was not observed");
}
it("withdrawal winning the evidence fence prevents a waiting draft from being stored", async () => {
  const f = await fixture(),
    holder = await pool.connect();
  let saving: Promise<SampleFeedbackResult> | undefined;
  try {
    await holder.query("BEGIN");
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    await holder.query(
      "UPDATE evidence_objects SET private_review_allowed=false,private_review_revoked_at=clock_timestamp() WHERE id=$1",
      [f.id],
    );
    saving = f.feedback.save(f.reviewerToken, f.id, f.draft);
    await blockedBy(pid);
    await holder.query("COMMIT");
    expect(await saving).toEqual({ kind: "denied" });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM private_sample_feedback",
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    await Promise.allSettled(saving ? [saving] : []);
  }
});
it("publication winning its fence commits before withdrawal and preserves the owner snapshot", async () => {
  const f = await fixture();
  await f.feedback.save(f.reviewerToken, f.id, f.draft);
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
          if (sql.includes("INSERT INTO private_sample_feedback_audit")) {
            entered.release();
            await resume.wait;
          }
          return client.query(sql, values);
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const publishing = sampleFeedbackStore(scoped, f.objects).publish(
    f.reviewerToken,
    f.id,
    1,
    randomUUID(),
  );
  let withdrawal: Promise<boolean> | undefined;
  try {
    await Promise.race([
      entered.wait,
      publishing.then(() => {
        throw Error("Publication ended before audit fence");
      }),
    ]);
    withdrawal = f.evidence.revokePrivateReview(f.ownerToken, f.id);
    await blockedBy(pid);
    resume.release();
    expect((await publishing).kind).toBe("saved");
    expect(await withdrawal).toBe(true);
    expect(
      ready(await f.feedback.owner(f.ownerToken, f.id)).records,
    ).toHaveLength(1);
    expect(await f.feedback.reviewer(f.reviewerToken, f.id)).toEqual({
      kind: "denied",
    });
  } finally {
    resume.release();
    await Promise.allSettled([publishing, ...(withdrawal ? [withdrawal] : [])]);
  }
});
it.each(["read", "draft"] as const)(
  "withholds a delayed successful %s COMMIT reply after DB expiry without replay or rollback",
  async (operation) => {
    const f = await fixture(),
      late = gate(),
      statements: string[] = [];
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '750 milliseconds' WHERE id=$1",
      [f.reviewer],
    );
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            statements.push(sql);
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              try {
                await pool.query(
                  `SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))+0.1) FROM principals WHERE id=$1`,
                  [f.reviewer],
                );
              } finally {
                late.release();
              }
            }
            return result;
          }) as PoolClient["query"],
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    const feedback = sampleFeedbackStore(scoped, f.objects);
    try {
      const result =
        operation === "read"
          ? await feedback.reviewer(f.reviewerToken, f.id)
          : await feedback.save(f.reviewerToken, f.id, f.draft);
      expect(result).toEqual({
        kind: operation === "read" ? "denied" : "unavailable",
      });
      await late.wait;
      expect(statements.filter((x) => x === "COMMIT")).toHaveLength(1);
      expect(statements).not.toContain("ROLLBACK");
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer AS n FROM private_sample_feedback",
          )
        ).rows[0].n,
      ).toBe(operation === "draft" ? 1 : 0);
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [f.reviewer],
      );
      expect(
        ready(await f.feedback.reviewer(f.reviewerToken, f.id)).records,
      ).toHaveLength(operation === "draft" ? 1 : 0);
    } finally {
      await late.wait;
    }
  },
);
const boundaries = [
  "principal",
  "assignment",
  "exact",
  "source deletion",
  "workspace deletion",
] as const;
function mutation(
  f: Awaited<ReturnType<typeof fixture>>,
  boundary: (typeof boundaries)[number],
): [string, string] {
  if (boundary === "principal")
    return [
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      f.reviewer,
    ];
  if (boundary === "assignment")
    return [
      "UPDATE assignment_grants SET revoked_at=clock_timestamp() WHERE id=$1",
      f.assignment,
    ];
  if (boundary === "exact")
    return [
      "UPDATE reviewer_evidence_grants SET revoked_at=clock_timestamp() WHERE id=$1",
      f.exact,
    ];
  if (boundary === "source deletion")
    return ["DELETE FROM evidence_objects WHERE id=$1", f.id];
  return ["DELETE FROM workspaces WHERE id=$1", f.ownerId];
}
it.each(boundaries)(
  "%s winning its fence denies a waiting publication",
  async (boundary) => {
    const f = await fixture();
    await f.feedback.save(f.reviewerToken, f.id, f.draft);
    const holder = await pool.connect();
    let publishing: Promise<SampleFeedbackResult> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      const [sql, id] = mutation(f, boundary);
      await holder.query(sql, [id]);
      publishing = f.feedback.publish(f.reviewerToken, f.id, 1, randomUUID());
      await blockedBy(pid);
      await holder.query("COMMIT");
      expect(await publishing).toEqual({ kind: "denied" });
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer AS n FROM private_sample_feedback WHERE published_at IS NOT NULL",
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled(publishing ? [publishing] : []);
    }
  },
);
it.each(boundaries)(
  "publication winning its fences finishes before competing %s",
  async (boundary) => {
    const f = await fixture();
    await f.feedback.save(f.reviewerToken, f.id, f.draft);
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
            if (sql.includes("INSERT INTO private_sample_feedback_audit")) {
              entered.release();
              await resume.wait;
            }
            return client.query(sql, values);
          }) as PoolClient["query"],
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    const publishing = sampleFeedbackStore(scoped, f.objects).publish(
      f.reviewerToken,
      f.id,
      1,
      randomUUID(),
    );
    let changing: Promise<unknown> | undefined;
    try {
      await Promise.race([
        entered.wait,
        publishing.then(() => {
          throw Error("Publication ended before fence");
        }),
      ]);
      const [sql, id] = mutation(f, boundary);
      changing = pool.query(sql, [id]);
      await blockedBy(pid);
      resume.release();
      expect((await publishing).kind).toBe("saved");
      await changing;
      expect(await f.feedback.reviewer(f.reviewerToken, f.id)).toEqual({
        kind: "denied",
      });
      if (boundary.includes("deletion"))
        expect(await f.feedback.owner(f.ownerToken, f.id)).toEqual({
          kind: "denied",
        });
      else
        expect(
          ready(await f.feedback.owner(f.ownerToken, f.id)).records,
        ).toHaveLength(1);
    } finally {
      resume.release();
      await Promise.allSettled([publishing, ...(changing ? [changing] : [])]);
    }
  },
);
it.each(["read", "draft"] as const)(
  "withholds %s after actual native release returns beyond authority lifetime",
  async (operation) => {
    const f = await fixture(),
      statements: string[] = [];
    let nativeReleased = false;
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '600 milliseconds' WHERE id=$1",
      [f.reviewer],
    );
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            statements.push(sql);
            return client.query(sql, values);
          }) as PoolClient["query"],
          release: (error?: Error | boolean) => {
            client.release(error);
            nativeReleased = true;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
          },
        };
      },
    } as unknown as Pool;
    const feedback = sampleFeedbackStore(scoped, f.objects);
    const result =
      operation === "read"
        ? await feedback.reviewer(f.reviewerToken, f.id)
        : await feedback.save(f.reviewerToken, f.id, f.draft);
    expect(result).toEqual({
      kind: operation === "read" ? "denied" : "unavailable",
    });
    expect(nativeReleased).toBe(true);
    expect(statements.filter((x) => x === "COMMIT")).toHaveLength(1);
    expect(statements).not.toContain("ROLLBACK");
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM private_sample_feedback",
        )
      ).rows[0].n,
    ).toBe(operation === "draft" ? 1 : 0);
    expect(
      (
        await pool.query(
          "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
          [f.reviewer],
        )
      ).rows[0].expired,
    ).toBe(true);
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
      [f.reviewer],
    );
    expect(
      ready(await f.feedback.reviewer(f.reviewerToken, f.id)).records,
    ).toHaveLength(operation === "draft" ? 1 : 0);
  },
);
it("paginates every published feedback record and never includes another actor draft in owner export", async () => {
  const f = await fixture();
  await f.feedback.save(f.reviewerToken, f.id, f.draft);
  const source = (
    await pool.query(
      "SELECT sha256,revision_number FROM evidence_objects WHERE id=$1",
      [f.id],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO private_sample_feedback(id,submission_id,reviewer_id,source_sha256,source_revision,criteria,draft_operation_id,publication_operation_id,published_at)
  SELECT gen_random_uuid(),$1,gen_random_uuid(),$2,$3,$4,gen_random_uuid(),gen_random_uuid(),clock_timestamp() FROM generate_series(1,121)`,
    [
      f.submission,
      source.sha256,
      source.revision_number,
      JSON.stringify(f.draft.criteria),
    ],
  );
  const ids: string[] = [];
  let after: string | undefined;
  do {
    const result = ready(await f.feedback.owner(f.ownerToken, f.id, after));
    expect(result.records.length).toBeLessThanOrEqual(20);
    ids.push(...result.records.map((x) => x.id));
    after = result.next ?? undefined;
  } while (after);
  expect(ids).toHaveLength(121);
  expect(new Set(ids).size).toBe(121);
  const exported: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await memberExportStore(
      pool,
      Buffer.from("stable-invented-export-secret"),
    ).exportOwned(f.ownerToken, cursor);
    if (result.kind !== "ready") throw Error("Complete export unavailable");
    expect(result.payload.page.recordCount).toBeLessThanOrEqual(100);
    exported.push(
      ...result.payload.records.sampleFeedback!.map((x) => x.id as string),
    );
    cursor = result.payload.page.nextCursor ?? undefined;
  } while (cursor);
  expect(exported.sort()).toEqual(ids.sort());
});
it("owner export winning its source fence completes before source deletion", async () => {
  const f = await fixture(),
    row = await publish(f),
    entered = gate(),
    resume = gate();
  let pid = 0,
    paused = false;
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      return {
        query: (async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (!paused && sql.includes("SELECT e.id FROM evidence_objects e")) {
            paused = true;
            entered.release();
            await resume.wait;
          }
          return result;
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const exporting = memberExportStore(scoped).exportOwned(f.ownerToken);
  let deleting: Promise<unknown> | undefined;
  try {
    await Promise.race([
      entered.wait,
      exporting.then(() => {
        throw Error("Export ended before source fence");
      }),
    ]);
    deleting = pool.query("DELETE FROM evidence_objects WHERE id=$1", [f.id]);
    await blockedBy(pid);
    resume.release();
    const result = await exporting;
    if (result.kind !== "ready") throw Error("Fenced export unavailable");
    expect(result.payload.records.sampleFeedback![0]!.id).toBe(row.id);
    await deleting;
    const fresh = await memberExportStore(pool).exportOwned(f.ownerToken);
    if (fresh.kind !== "ready") throw Error("Fresh export unavailable");
    expect(fresh.payload.records.sampleFeedback).toEqual([]);
  } finally {
    resume.release();
    await Promise.allSettled([exporting, ...(deleting ? [deleting] : [])]);
  }
});
it("source deletion winning its fence yields no feedback export from the waiting snapshot", async () => {
  const f = await fixture();
  await publish(f);
  const holder = await pool.connect();
  let exporting:
    ReturnType<ReturnType<typeof memberExportStore>["exportOwned"]> | undefined;
  try {
    await holder.query("BEGIN");
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    await holder.query("DELETE FROM evidence_objects WHERE id=$1", [f.id]);
    exporting = memberExportStore(pool).exportOwned(f.ownerToken);
    await blockedBy(pid);
    await holder.query("COMMIT");
    // REPEATABLE READ cannot silently mix the deleted source into the prior
    // snapshot: PostgreSQL serialization failure is conservatively unavailable.
    expect(await exporting).toEqual({ kind: "unavailable" });
    const fresh = await memberExportStore(pool).exportOwned(f.ownerToken);
    if (fresh.kind !== "ready") throw Error("Fresh export unavailable");
    expect(fresh.payload.records.sampleFeedback).toEqual([]);
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    await Promise.allSettled(exporting ? [exporting] : []);
  }
});
it.each(["clarify", "answer"] as const)(
  "source deletion winning denies waiting %s without orphaned text",
  async (operation) => {
    const f = await fixture();
    const row = await publish(f);
    if (operation === "answer")
      saved(
        await f.feedback.clarify(
          f.ownerToken,
          f.id,
          row.id,
          "Question",
          randomUUID(),
        ),
      );
    const holder = await pool.connect();
    let writing: Promise<SampleFeedbackResult> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      await holder.query("DELETE FROM evidence_objects WHERE id=$1", [f.id]);
      writing = f.feedback[operation](
        operation === "answer" ? f.reviewerToken : f.ownerToken,
        f.id,
        row.id,
        "New private text",
        randomUUID(),
      );
      await blockedBy(pid);
      await holder.query("COMMIT");
      expect(await writing).toEqual({ kind: "denied" });
      expect(
        (
          await pool.query(
            "SELECT id FROM private_sample_feedback WHERE id=$1",
            [row.id],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled(writing ? [writing] : []);
    }
  },
);
it.each(["clarify", "answer"] as const)(
  "%s winning its source fence commits before deletion removes all private text",
  async (operation) => {
    const f = await fixture();
    const row = await publish(f);
    if (operation === "answer")
      saved(
        await f.feedback.clarify(
          f.ownerToken,
          f.id,
          row.id,
          "Question",
          randomUUID(),
        ),
      );
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
            const result = await client.query(sql, values);
            if (
              sql.startsWith(
                `UPDATE private_sample_feedback SET ${operation === "answer" ? "answer" : "clarification"}=`,
              )
            ) {
              entered.release();
              await resume.wait;
            }
            return result;
          }) as PoolClient["query"],
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    const writing = sampleFeedbackStore(scoped, f.objects)[operation](
      operation === "answer" ? f.reviewerToken : f.ownerToken,
      f.id,
      row.id,
      "New private text",
      randomUUID(),
    );
    let deleting: Promise<unknown> | undefined;
    try {
      await Promise.race([
        entered.wait,
        writing.then(() => {
          throw Error("Exchange ended before fence");
        }),
      ]);
      deleting = pool.query("DELETE FROM evidence_objects WHERE id=$1", [f.id]);
      await blockedBy(pid);
      resume.release();
      expect((await writing).kind).toBe("saved");
      await deleting;
      expect(
        (
          await pool.query(
            "SELECT id FROM private_sample_feedback WHERE id=$1",
            [row.id],
          )
        ).rows,
      ).toHaveLength(0);
      expect(await f.feedback.owner(f.ownerToken, f.id)).toEqual({
        kind: "denied",
      });
    } finally {
      resume.release();
      await Promise.allSettled([writing, ...(deleting ? [deleting] : [])]);
    }
  },
);
it("account removal erases published feedback, clarification and draft journals through existing deletion paths", async () => {
  const f = await fixture();
  const row = await publish(f);
  saved(
    await f.feedback.clarify(
      f.ownerToken,
      f.id,
      row.id,
      "Private question",
      randomUUID(),
    ),
  );
  saved(
    await f.feedback.answer(
      f.reviewerToken,
      f.id,
      row.id,
      "Private answer",
      randomUUID(),
    ),
  );
  await f.evidence.removeWorkspace(f.ownerToken);
  await db.remove(f.ownerId);
  expect(
    (
      await pool.query("SELECT id FROM private_sample_feedback WHERE id=$1", [
        row.id,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await pool.query(
        "SELECT feedback_id FROM private_sample_feedback_draft_operations WHERE feedback_id=$1",
        [row.id],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await pool.query(
        "SELECT id FROM private_sample_feedback_audit WHERE workspace_id=$1",
        [f.ownerId],
      )
    ).rows,
  ).toHaveLength(0);
  expect(await f.feedback.owner(f.ownerToken, f.id)).toEqual({
    kind: "denied",
  });
  expect(await f.feedback.reviewer(f.reviewerToken, f.id)).toEqual({
    kind: "denied",
  });
});
it("reapplying migrations preserves published feedback and immutable source identity", async () => {
  const f = await fixture();
  const row = await publish(f);
  const before = ready(await f.feedback.owner(f.ownerToken, f.id));
  await migrate(pool);
  expect(ready(await f.feedback.owner(f.ownerToken, f.id))).toEqual(before);
  await expect(
    pool.query(
      "UPDATE private_sample_feedback SET source_revision=source_revision+1 WHERE id=$1",
      [row.id],
    ),
  ).rejects.toThrow("Sample feedback identity is immutable");
});
it("revoking one exact sample grant leaves an unrelated authorized sample usable", async () => {
  const first = await fixture(),
    second = await fixture();
  await publish(first);
  await publish(second);
  await auth.revokeEvidenceReview(first.admin, first.exact);
  expect(await first.feedback.reviewer(first.reviewerToken, first.id)).toEqual({
    kind: "denied",
  });
  expect(
    ready(await second.feedback.reviewer(second.reviewerToken, second.id))
      .records,
  ).toHaveLength(1);
});
