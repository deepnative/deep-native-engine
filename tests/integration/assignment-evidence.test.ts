import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import { attemptStore } from "../../src/attempts.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore } from "../../src/catalog.ts";
import { assignmentEvidenceStore } from "../../src/assignment-evidence.ts";
import { assignmentObjectStorage } from "../../src/assignment-evidence-storage.ts";
import {
  assignmentPayloadDigest,
  type AssignmentEvidenceInstruction,
} from "../../src/assignment-evidence-values.ts";
import { evidenceStore } from "../../src/evidence.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { sampleFeedbackStore } from "../../src/sample-feedback.ts";
import { SAMPLE_FEEDBACK_PURPOSE } from "../../src/sample-feedback-values.ts";
import { dropAttendanceBrowserDatabase } from "../support/attendance-browser-database.ts";

const pool = testPool(),
  db = store(pool),
  attempts = attemptStore(pool),
  auth = authorizationStore(pool),
  copies = assignmentEvidenceStore(pool, { enabled: true });
const response =
  "An invented reading group compares three activities — 中文 🤖.\r\nWe check every assumption before deciding.\n";
const digest = createHash("sha256").update(response).digest("hex");
const files = {
  put: vi.fn(async () => {}),
  get: vi.fn(async () => Buffer.from("unexpected physical fallback")),
  remove: vi.fn(async () => {}),
};
const objects = assignmentObjectStorage(pool, files),
  evidence = evidenceStore(pool, objects, "invented-test-secret");
let observerDatabase:
  | {
      name: string;
      marker: string;
      oid: string | null;
      marked: boolean;
      foreign: Pool | null;
    }
  | undefined;
beforeAll(async () => {
  await migrate(pool);
  await pool.query(
    await readFile(
      new URL("../../migrations/074-assignment-evidence.sql", import.meta.url),
      "utf8",
    ),
  );
  const url = new URL(process.env.DNE_TEST_DATABASE_URL!);
  if (!/^\/dne_test_[a-f0-9]{32}$/.test(url.pathname))
    throw Error("Generated control database required");
  const name = `dne_test_${randomBytes(16).toString("hex")}`;
  const marker = `CIBUDGET-OBS01-${randomUUID()}`;
  observerDatabase = { name, marker, oid: null, marked: false, foreign: null };
  const existing = await pool.query<{ n: number }>(
    "SELECT count(*)::integer n FROM pg_database WHERE datname=$1",
    [name],
  );
  if (existing.rows[0]!.n !== 0)
    throw Error("Observer database already exists; setup refused");
  await pool.query(`CREATE DATABASE "${name}"`);
  observerDatabase.oid = (
    await pool.query<{ oid: string }>(
      "SELECT oid::text oid FROM pg_database WHERE datname=$1",
      [name],
    )
  ).rows[0]!.oid;
  await pool.query(`COMMENT ON DATABASE "${name}" IS '${marker}'`);
  observerDatabase.marked = true;
  url.pathname = `/${name}`;
  observerDatabase.foreign = new Pool({ connectionString: url.toString() });
  // The foreign observer control needs only a real table lock.
  await observerDatabase.foreign.query(
    "CREATE TABLE assignment_attempts (id uuid)",
  );
}, 30000);
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  vi.clearAllMocks();
});
// Administrative DROP waits for a cluster checkpoint.
afterAll(async () => {
  try {
    if (observerDatabase) {
      await observerDatabase.foreign?.end();
      if (!observerDatabase.marked || !observerDatabase.oid)
        throw Error("Observer ownership unavailable; database preserved");
      await dropOwnedObserverDatabase(
        observerDatabase.name,
        observerDatabase.oid,
        observerDatabase.marker,
      );
    }
  } finally {
    await pool.end();
  }
}, 90000);
async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw Error("Invented member missing");
  return { token, id: session.learner.id };
}
async function fixture() {
  const owner = await member(),
    outsider = await member(),
    editor = randomBytes(32).toString("hex"),
    reviewer = randomBytes(32).toString("hex");
  const end = new Date(Date.now() + 3600000);
  await auth.provisionStaff(editor, "editor", end);
  const reviewerId = await auth.provisionStaff(reviewer, "reviewer", end);
  const catalog = catalogStore(pool),
    draft = {
      id: "SYN-545",
      version: 1,
      kind: "assignment" as const,
      origin: "curated" as const,
      title: "Invented exact submission",
      body: "Compare invented choices.",
      owner: "Synthetic editor",
      sources: "Original invented example",
      rights: "Owned sample",
      goals: ["everyday"],
      backgrounds: ["explorer"],
      domains: [],
      prerequisites: "None",
      rubric: "Explain the options and check one assumption.",
      rubricVersion: 4,
    };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, draft.id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, draft.id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, draft.id, 1)).toBe(true);
  expect(await db.chooseAssignment(owner.token, draft.id, 1)).toBe(true);
  const attemptId = await attempts.start(owner.token);
  if (!attemptId) throw Error("Invented attempt missing");
  expect(await attempts.save(owner.token, attemptId, 1, response)).toBe(true);
  expect(await attempts.submit(owner.token, attemptId, 2)).toBe(true);
  const input: AssignmentEvidenceInstruction = {
    operationId: randomUUID(),
    attemptId,
    sequence: 1,
    contentId: draft.id,
    contentVersion: 1,
    rubricVersion: 4,
    sourceSha256: digest,
    privateReview: true,
  };
  return {
    owner,
    outsider,
    editor,
    reviewer,
    reviewerId,
    end,
    catalog,
    draft,
    attemptId,
    input,
  };
}
async function copied(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await copies.create(f.owner.token, f.input);
  expect(result.kind).toBe("created");
  if (result.kind !== "created" || !result.receipt.evidenceId)
    throw Error(JSON.stringify(result));
  return result.receipt;
}
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { wait, release };
}
async function blocked(pid: number) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (
      (
        await pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) blocked",
          [pid],
        )
      ).rows[0].blocked
    )
      return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Expected actual database lock wait");
}
async function observesAttemptRemovalWait() {
  return (
    await pool.query<{ waiting: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE 'DELETE FROM assignment_attempts%') waiting",
    )
  ).rows[0]!.waiting;
}
async function dropOwnedObserverDatabase(
  name: string,
  oid: string,
  marker: string,
) {
  const current = (
    await pool.query<{ oid: string; marker: string }>(
      "SELECT oid::text oid,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=$1",
      [name],
    )
  ).rows[0];
  if (!current || current.oid !== oid || current.marker !== marker)
    throw Error("Owned observer database changed; cleanup refused");
  await dropAttendanceBrowserDatabase(pool, name);
}
it("CIBUDGET-OBS01 ignores an actual attempt-delete wait in another generated database", async () => {
  const foreign = observerDatabase?.foreign;
  if (!foreign) throw Error("Observer fixture unavailable");
  const holder = await foreign.connect();
  const waiter = await foreign.connect();
  let deleting: Promise<unknown> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "LOCK TABLE assignment_attempts IN ACCESS EXCLUSIVE MODE",
    );
    const heldPid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0]
      .pid;
    const waitingPid = (await waiter.query("SELECT pg_backend_pid() pid"))
      .rows[0].pid;
    deleting = waiter.query("DELETE FROM assignment_attempts WHERE false");
    void deleting.catch(() => {});
    const deadline = performance.now() + 3000;
    let reached = false;
    while (performance.now() < deadline) {
      reached = (
        await pool.query<{ blocked: boolean }>(
          "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) blocked",
          [heldPid, waitingPid],
        )
      ).rows[0]!.blocked;
      if (reached) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(reached).toBe(true);
    expect(await observesAttemptRemovalWait()).toBe(false);
  } finally {
    await holder.query("ROLLBACK");
    if (deleting) await deleting;
    holder.release();
    waiter.release();
  }
});

it("AHO-01/02 preserves exact old bytes and pinned rubric while a newer draft exists, without implicitly granting review", async () => {
  const f = await fixture();
  expect(await attempts.revise(f.owner.token, f.attemptId)).toBe(true);
  const detail = await attempts.detail(f.owner.token, f.attemptId);
  expect(
    await attempts.save(
      f.owner.token,
      f.attemptId,
      detail!.revision,
      "A separate newer draft must not replace original submitted work.",
    ),
  ).toBe(true);
  expect(await copies.open(f.owner.token, f.attemptId, 1)).toMatchObject({
    kind: "ready",
    source: {
      response,
      sourceSha256: digest,
      contentVersion: 1,
      rubricVersion: 4,
      rubric: f.draft.rubric,
    },
  });
  const receipt = await copied(f),
    id = receipt.evidenceId!;
  const key = (
    await pool.query("SELECT storage_key FROM evidence_objects WHERE id=$1", [
      id,
    ])
  ).rows[0].storage_key;
  expect((await objects.get(key)).equals(Buffer.from(response))).toBe(true);
  expect(receipt.assignmentOrigin).toMatchObject({
    kind: "member-assignment-submission",
    attemptId: f.attemptId,
    sequence: 1,
    sourceSha256: digest,
    rubricVersion: 4,
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM evidence_review_submissions",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (await pool.query("SELECT count(*)::int n FROM assignment_grants")).rows[0]
      .n,
  ).toBe(0);
  expect(files.put).not.toHaveBeenCalled();
  expect(files.get).not.toHaveBeenCalled();
});
it("AHO-03 serializes exact concurrent replay, rejects changed payload and prevents resurrection after copy-only deletion", async () => {
  const f = await fixture();
  const results = await Promise.all([
    copies.create(f.owner.token, f.input),
    copies.create(f.owner.token, f.input),
  ]);
  expect(results.map((r) => r.kind).sort()).toEqual(["created", "replayed"]);
  const first = results[0];
  if (first.kind !== "created" && first.kind !== "replayed")
    throw Error("Receipt absent");
  expect(
    await copies.create(f.owner.token, {
      ...f.input,
      sourceSha256: "a".repeat(64),
    }),
  ).toEqual({ kind: "conflict" });
  expect(await copies.inspect(f.outsider.token, f.input.operationId)).toEqual({
    kind: "denied",
  });
  expect(await evidence.remove(f.owner.token, first.receipt.evidenceId!)).toBe(
    true,
  );
  expect(await attempts.detail(f.owner.token, f.attemptId)).not.toBeNull();
  expect(await copies.create(f.owner.token, f.input)).toMatchObject({
    kind: "replayed",
    receipt: {
      receiptId: first.receipt.receiptId,
      evidenceId: null,
      state: "removed",
      assignmentOrigin: null,
    },
  });
  expect(
    (await pool.query("SELECT count(*)::int n FROM evidence_objects")).rows[0]
      .n,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT payload_digest FROM assignment_evidence_operations",
      )
    ).rows[0].payload_digest,
  ).toBe(assignmentPayloadDigest(f.input));
});
it("AHO-03 lost committed response remains unconfirmed until explicit canonical inspection", async () => {
  const f = await fixture();
  let lost = false;
  const uncertain = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (sql === "COMMIT" && !lost) {
            lost = true;
            throw Error("Lost committed reply");
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  expect(
    await assignmentEvidenceStore(uncertain, { enabled: true }).create(
      f.owner.token,
      f.input,
    ),
  ).toEqual({ kind: "unavailable" });
  const inspected = await copies.inspect(f.owner.token, f.input.operationId);
  expect(inspected).toMatchObject({
    kind: "ready",
    receipt: { state: "available" },
  });
  const recovered = await copies.create(f.owner.token, f.input);
  expect(recovered.kind).toBe("replayed");
  expect(
    (await pool.query("SELECT count(*)::int n FROM evidence_objects")).rows[0]
      .n,
  ).toBe(1);
});
it("AHO-04 denies foreign owners, staff, nonexistent submissions, missing confirmation and stale exact provenance", async () => {
  const f = await fixture();
  expect(await copies.open(f.outsider.token, f.attemptId, 1)).toEqual({
    kind: "denied",
  });
  expect(await copies.open(f.reviewer, f.attemptId, 1)).toEqual({
    kind: "denied",
  });
  expect(await copies.open(f.owner.token, f.attemptId, 2)).toEqual({
    kind: "denied",
  });
  expect(
    await copies.create(f.owner.token, { ...f.input, privateReview: false }),
  ).toEqual({ kind: "invalid" });
  expect(
    await copies.create(f.owner.token, { ...f.input, rubricVersion: 5 }),
  ).toEqual({ kind: "conflict" });
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [f.owner.id],
  );
  expect(await copies.create(f.owner.token, f.input)).toEqual({
    kind: "denied",
  });
  expect(
    (await pool.query("SELECT count(*)::int n FROM evidence_objects")).rows[0]
      .n,
  ).toBe(0);
});
it("AHO-04 authority expiring during a real snapshot lock wait cannot create a copy", async () => {
  const f = await fixture(),
    locker = await pool.connect();
  await locker.query("BEGIN");
  await locker.query(
    "SELECT 1 FROM assignment_submission_snapshots WHERE attempt_id=$1 FOR UPDATE",
    [f.attemptId],
  );
  const pid = (await locker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '600 milliseconds' WHERE id=$1",
    [f.owner.id],
  );
  const pending = copies.create(f.owner.token, f.input);
  try {
    await blocked(pid);
    await new Promise((r) => setTimeout(r, 650));
    await locker.query("COMMIT");
    expect(await pending).toEqual({ kind: "denied" });
  } finally {
    await locker.query("ROLLBACK");
    locker.release();
  }
  expect(
    (await pool.query("SELECT count(*)::int n FROM evidence_objects")).rows[0]
      .n,
  ).toBe(0);
});
it("AHO-05/08 uses separate exact reviewer permission and retains published owner feedback through withdrawal", async () => {
  const f = await fixture(),
    receipt = await copied(f),
    id = receipt.evidenceId!,
    feedback = sampleFeedbackStore(pool, objects);
  expect(await feedback.reviewer(f.reviewer, id)).toEqual({ kind: "denied" });
  expect(await evidence.submitForReview(f.owner.token, id)).toBe(true);
  expect(await feedback.reviewer(f.reviewer, id)).toEqual({ kind: "denied" });
  const admin = await auth.provisionStaff(
    randomBytes(32).toString("hex"),
    "platform_admin",
    f.end,
  );
  const submission = (
    await pool.query(
      "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
      [id],
    )
  ).rows[0].id;
  const assignment = await auth.grantAssignment(
    admin,
    f.reviewerId,
    f.owner.id,
    "reviewer",
    "Invented feedback",
    f.end,
  );
  await auth.grantEvidenceReview(
    admin,
    f.reviewerId,
    assignment,
    submission,
    SAMPLE_FEEDBACK_PURPOSE,
    f.end,
  );
  expect(await feedback.reviewer(f.reviewer, id)).toMatchObject({
    kind: "ready",
    source: response,
    sourceSha256: digest,
  });
  expect(await copies.open(f.reviewer, f.attemptId, 1)).toEqual({
    kind: "denied",
  });
  const saved = await feedback.save(f.reviewer, id, {
    revision: 0,
    operationId: randomUUID(),
    criteria: [
      {
        label: "Evidence",
        comment: "Check the invented source before choosing.",
        start: 0,
        end: 11,
        quote: "An invented",
      },
    ],
    preparationMinutes: null,
    reviewMinutes: null,
  });
  expect(saved.kind).toBe("saved");
  if (saved.kind !== "saved") throw Error("Feedback draft missing");
  expect(
    (await feedback.publish(f.reviewer, id, saved.revision, randomUUID())).kind,
  ).toBe("saved");
  expect(await evidence.revokePrivateReview(f.owner.token, id)).toBe(true);
  expect(await feedback.reviewer(f.reviewer, id)).toEqual({ kind: "denied" });
  const owner = await feedback.owner(f.owner.token, id);
  expect(owner.kind).toBe("ready");
  if (owner.kind === "ready")
    expect(owner.records[0]?.publishedAt).toBeInstanceOf(Date);
  expect(
    await copies.inspect(f.owner.token, f.input.operationId),
  ).toMatchObject({ kind: "ready", receipt: { state: "withdrawn" } });
  expect(await attempts.remove(f.owner.token, f.attemptId)).toBe(true);
  expect(await feedback.owner(f.owner.token, id)).toEqual({ kind: "denied" });
  for (const table of [
    "evidence_objects",
    "assignment_evidence_origins",
    "evidence_review_submissions",
    "reviewer_evidence_grants",
    "private_sample_feedback",
  ])
    expect(
      (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
    ).toBe(0);
});
it("AHO-06 source deletion removes every copy atomically, rollback restores them and a waiting copy cannot revive deletion", async () => {
  const f = await fixture(),
    first = await copied(f);
  await copies.create(f.owner.token, { ...f.input, operationId: randomUUID() });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM assignment_submission_snapshots WHERE attempt_id=$1",
      [f.attemptId],
    );
    expect(
      (await client.query("SELECT count(*)::int n FROM evidence_objects"))
        .rows[0].n,
    ).toBe(0);
    await client.query("ROLLBACK");
    expect(
      (await pool.query("SELECT count(*)::int n FROM evidence_objects")).rows[0]
        .n,
    ).toBe(2);
    await client.query("BEGIN");
    await client.query("DELETE FROM assignment_attempts WHERE id=$1", [
      f.attemptId,
    ]);
    const pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const pending = copies.create(f.owner.token, {
      ...f.input,
      operationId: randomUUID(),
    });
    await blocked(pid);
    await client.query("COMMIT");
    expect(await pending).toEqual({ kind: "denied" });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  expect(
    await copies.inspect(f.owner.token, f.input.operationId),
  ).toMatchObject({
    kind: "ready",
    receipt: {
      receiptId: first.receiptId,
      state: "removed",
      assignmentOrigin: null,
    },
  });
  expect(
    (await pool.query("SELECT count(*)::int n FROM evidence_objects")).rows[0]
      .n,
  ).toBe(0);
});
it("AHO-06 export holds the copied source until bytes are observed, then source deletion removes it", async () => {
  const f = await fixture();
  await copied(f);
  const reached = gate(),
    resume = gate();
  const exporter = evidenceStore(
    pool,
    {
      ...objects,
      async get(key) {
        reached.release();
        await resume.wait;
        return objects.get(key);
      },
    },
    "invented-secret",
  );
  const exporting = exporter.exportOwned(f.owner.token);
  await reached.wait;
  const removing = attempts.remove(f.owner.token, f.attemptId);
  try {
    const deadline = performance.now() + 3000;
    let waiting = false;
    while (performance.now() < deadline) {
      waiting = await observesAttemptRemovalWait();
      if (waiting) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(waiting).toBe(true);
    resume.release();
    const page = await exporting;
    expect(page.kind).toBe("ready");
    if (page.kind === "ready")
      expect(
        Buffer.from(page.items[0]!.sourceBase64!, "base64").toString(),
      ).toBe(response);
    expect(await removing).toBe(true);
  } finally {
    resume.release();
    await Promise.allSettled([exporting, removing]);
  }
  expect(
    await copies.inspect(f.owner.token, f.input.operationId),
  ).toMatchObject({ kind: "ready", receipt: { state: "removed" } });
});
it("AHO-07 refuses independent revisions and derivatives before physical writes and at the database boundary", async () => {
  const f = await fixture(),
    receipt = await copied(f),
    id = receipt.evidenceId!;
  await evidence.submitForReview(f.owner.token, id);
  expect(
    await evidence.upload(f.owner.token, {
      name: "Changed.txt",
      mediaType: "text/plain",
      data: Buffer.from("Independent changed private text."),
      revisesId: id,
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    }),
  ).toEqual({ kind: "denied" });
  await expect(
    evidence.addDerivative(id, "text-extract", Buffer.from("Derivative")),
  ).rejects.toThrow("could not be stored");
  expect(files.put).not.toHaveBeenCalled();
  await expect(
    pool.query(
      "INSERT INTO evidence_derivatives(id,evidence_id,kind,storage_key,byte_size,sha256) VALUES($1,$2,'text-extract',$3,1,$4)",
      [randomUUID(), id, randomUUID(), digest],
    ),
  ).rejects.toThrow("no independent physical derivative");
  await expect(
    pool.query(
      "UPDATE assignment_evidence_origins SET sequence=2 WHERE evidence_id=$1",
      [id],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query(
      "UPDATE assignment_submission_snapshots SET response=$2 WHERE attempt_id=$1",
      [f.attemptId, response + "changed"],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("UPDATE assignment_attempts SET member_id=$2 WHERE id=$1", [
      f.attemptId,
      f.outsider.id,
    ]),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query(
      "UPDATE evidence_objects SET assignment_bound=false WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("DELETE FROM assignment_evidence_origins WHERE evidence_id=$1", [
      id,
    ]),
  ).rejects.toThrow("requires a retained origin");
});
it("AHO-09 exports exact owned provenance and bytes plus safe receipts, without operation keys or filesystem paths", async () => {
  const f = await fixture(),
    receipt = await copied(f),
    id = receipt.evidenceId!;
  const page = await evidence.exportOwned(f.owner.token);
  expect(page.kind).toBe("ready");
  if (page.kind !== "ready") throw Error("Export unavailable");
  expect(page.items[0]?.assignmentOrigin).toMatchObject({
    attemptId: f.attemptId,
    sourceSha256: digest,
  });
  expect(Buffer.from(page.items[0]!.sourceBase64!, "base64").toString()).toBe(
    response,
  );
  const exported = await memberExportStore(pool).exportOwned(f.owner.token);
  expect(exported.kind).toBe("ready");
  if (exported.kind !== "ready") throw Error("Member export unavailable");
  expect(exported.payload.records.assignmentEvidenceOrigins).toMatchObject([
    {
      evidenceId: id,
      assignmentOrigin: { attemptId: f.attemptId, sourceSha256: digest },
    },
  ]);
  expect(exported.payload.records.assignmentCopyReceipts).toMatchObject([
    { receiptId: receipt.receiptId, evidenceId: id, state: "available" },
  ]);
  expect(JSON.stringify(exported)).not.toContain(f.input.operationId);
  expect(JSON.stringify(exported)).not.toContain("payload_digest");
  expect(JSON.stringify(exported)).not.toContain("storage_key");
  const other = await memberExportStore(pool).exportOwned(f.outsider.token);
  if (other.kind !== "ready") throw Error("Other export missing");
  expect(other.payload.records.assignmentEvidenceOrigins).toEqual([]);
});
it("AHO-10 creation-off preserves current-owner reads, canonical inspection and erasure, and migration reapplication preserves bindings", async () => {
  const f = await fixture(),
    receipt = await copied(f),
    paused = assignmentEvidenceStore(pool, { enabled: false });
  await pool.query(
    await readFile(
      new URL("../../migrations/074-assignment-evidence.sql", import.meta.url),
      "utf8",
    ),
  );
  expect(await paused.open(f.owner.token, f.attemptId, 1)).toEqual({
    kind: "disabled",
  });
  expect(await paused.create(f.owner.token, f.input)).toEqual({
    kind: "disabled",
  });
  expect(
    await paused.inspect(f.owner.token, f.input.operationId),
  ).toMatchObject({
    kind: "ready",
    receipt: { receiptId: receipt.receiptId, state: "available" },
  });
  expect((await evidence.exportOwned(f.owner.token)).kind).toBe("ready");
  await evidence.removeWorkspace(f.owner.token);
  await db.remove(f.owner.id);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM assignment_evidence_operations",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM assignment_evidence_origins",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(await paused.inspect(f.owner.token, f.input.operationId)).toEqual({
    kind: "denied",
  });
});

it("AHO-06 a handoff that owns the source fence commits before deletion and is then fully erased", async () => {
  const f = await fixture(),
    reached = gate(),
    resume = gate();
  let pid = 0;
  const paused = {
    async connect() {
      const client = await pool.connect();
      pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (sql.includes("INSERT INTO assignment_evidence_operations")) {
            reached.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const creating = assignmentEvidenceStore(paused, { enabled: true }).create(
    f.owner.token,
    f.input,
  );
  await reached.wait;
  const deleting = attempts.remove(f.owner.token, f.attemptId);
  try {
    await blocked(pid);
    resume.release();
    expect((await creating).kind).toBe("created");
    expect(await deleting).toBe(true);
  } finally {
    resume.release();
    await Promise.allSettled([creating, deleting]);
  }
  expect(
    await copies.inspect(f.owner.token, f.input.operationId),
  ).toMatchObject({
    kind: "ready",
    receipt: { state: "removed", assignmentOrigin: null },
  });
  expect(
    (await pool.query("SELECT count(*)::int n FROM evidence_objects")).rows[0]
      .n,
  ).toBe(0);
});
it("AHO-01/03 a retired original and later submission keep separate deliberately confirmed exact copies", async () => {
  const f = await fixture(),
    first = await copied(f);
  expect(await attempts.revise(f.owner.token, f.attemptId)).toBe(true);
  const current = await attempts.detail(f.owner.token, f.attemptId),
    later =
      "A second invented submitted response checks a different assumption.";
  expect(
    await attempts.save(f.owner.token, f.attemptId, current!.revision, later),
  ).toBe(true);
  expect(
    await attempts.submit(f.owner.token, f.attemptId, current!.revision + 1),
  ).toBe(true);
  expect(await f.catalog.retire(f.editor, f.draft.id)).toBe(true);
  expect(await copies.open(f.owner.token, f.attemptId, 1)).toMatchObject({
    kind: "ready",
    source: { response, rubricVersion: 4 },
  });
  const second = await copies.create(f.owner.token, {
    ...f.input,
    operationId: randomUUID(),
    sequence: 2,
    sourceSha256: createHash("sha256").update(later).digest("hex"),
  });
  expect(second.kind).toBe("created");
  if (second.kind === "created")
    expect(second.receipt.evidenceId).not.toBe(first.evidenceId);
  expect(
    await copies.create(f.owner.token, {
      ...f.input,
      attemptId: f.input.attemptId.toUpperCase(),
      operationId: f.input.operationId.toUpperCase(),
    }),
  ).toMatchObject({
    kind: "replayed",
    receipt: { receiptId: first.receiptId },
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM evidence_review_submissions",
      )
    ).rows[0].n,
  ).toBe(0);
});
it("AHO-09 actual damaged binding and quarantine withhold private bytes and canonical available claims", async () => {
  const f = await fixture(),
    receipt = await copied(f),
    id = receipt.evidenceId!;
  await pool.query(
    "UPDATE evidence_objects SET quarantine_state='infected' WHERE id=$1",
    [id],
  );
  expect(await copies.inspect(f.owner.token, f.input.operationId)).toEqual({
    kind: "unavailable",
  });
  const quarantined = await evidence.exportOwned(f.owner.token);
  expect(quarantined.kind).toBe("ready");
  if (quarantined.kind === "ready")
    expect(quarantined.items[0]!.sourceBase64).toBeNull();
  await pool.query(
    "UPDATE evidence_objects SET quarantine_state='clean' WHERE id=$1",
    [id],
  );
  // Deliberate corruption in this isolated test database proves the explicit
  // source marker never falls back to an unrelated physical provider object.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE assignment_evidence_origins DISABLE TRIGGER assignment_origin_removal_guard",
    );
    await client.query(
      "DELETE FROM assignment_evidence_origins WHERE evidence_id=$1",
      [id],
    );
    await client.query(
      "ALTER TABLE assignment_evidence_origins ENABLE TRIGGER assignment_origin_removal_guard",
    );
    await client.query("COMMIT");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  expect(await copies.inspect(f.owner.token, f.input.operationId)).toEqual({
    kind: "unavailable",
  });
  expect(await evidence.exportOwned(f.owner.token)).toEqual({
    kind: "unavailable",
  });
  expect(files.get).not.toHaveBeenCalled();
  const granted = await evidence.issueDownload(f.owner.token, id);
  expect(granted.kind).toBe("issued");
  if (granted.kind === "issued")
    await expect(
      evidence.download(f.owner.token, id, granted.capability),
    ).rejects.toThrow("unavailable");
});
it("AHO-09 bounded owner exports traverse every exact origin and safe receipt without replay keys or duplicate sources", async () => {
  const f = await fixture(),
    ids = new Set<string>(),
    operations: string[] = [];
  for (let index = 0; index < 55; index++) {
    const operationId = randomUUID();
    operations.push(operationId);
    const result = await copies.create(f.owner.token, {
      ...f.input,
      operationId,
    });
    if (result.kind !== "created") throw Error(JSON.stringify(result));
    ids.add(result.receipt.evidenceId!);
  }
  const exportStore = memberExportStore(pool),
    originIds: string[] = [],
    receiptIds: string[] = [];
  let cursor: string | undefined,
    pages = 0;
  do {
    const result = await exportStore.exportOwned(f.owner.token, cursor);
    if (result.kind !== "ready") throw Error(JSON.stringify(result));
    expect(result.payload.page.recordCount).toBeLessThanOrEqual(100);
    expect(
      Buffer.byteLength(JSON.stringify(result.payload)),
    ).toBeLessThanOrEqual(256 * 1024);
    originIds.push(
      ...result.payload.records.assignmentEvidenceOrigins!.map(
        (r) => r.evidenceId as string,
      ),
    );
    receiptIds.push(
      ...result.payload.records.assignmentCopyReceipts!.map(
        (r) => r.evidenceId as string,
      ),
    );
    for (const key of operations)
      expect(JSON.stringify(result)).not.toContain(key);
    cursor = result.payload.page.nextCursor ?? undefined;
    if (cursor)
      expect(await exportStore.exportOwned(f.outsider.token, cursor)).toEqual({
        kind: "denied",
      });
    expect(++pages).toBeLessThan(10);
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  expect(originIds).toHaveLength(55);
  expect(receiptIds).toHaveLength(55);
  expect(new Set(originIds)).toEqual(ids);
  expect(new Set(receiptIds)).toEqual(ids);
  const evidenceIds: string[] = [];
  pages = 0;
  do {
    const result = await evidence.exportOwned(f.owner.token, cursor);
    if (result.kind !== "ready") throw Error(JSON.stringify(result));
    for (const item of result.items) {
      evidenceIds.push(item.id);
      expect(Buffer.from(item.sourceBase64!, "base64").toString()).toBe(
        response,
      );
    }
    cursor = result.page.nextCursor ?? undefined;
    expect(++pages).toBeLessThan(10);
  } while (cursor);
  expect(pages).toBe(3);
  expect(evidenceIds).toHaveLength(55);
  expect(new Set(evidenceIds)).toEqual(ids);
}, 30000);
