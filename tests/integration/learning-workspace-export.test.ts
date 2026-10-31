import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore } from "../../src/catalog.ts";
import {
  learningWorkspacePack,
  resolveLearningWorkspaceBundle,
} from "../../src/learning-workspace-pack.ts";
import { learningWorkspacePublicationStore } from "../../src/learning-workspace-publication.ts";
import {
  learningWorkspaceStore,
  type LearningSaved,
} from "../../src/learning-workspace-store.ts";
import {
  emptyLearningSnapshot,
  joinLearningSnapshot,
  splitLearningSnapshot,
  type LearningDecision,
  type LearningIdentity,
} from "../../src/learning-workspace-values.ts";
import {
  MAX_MEMBER_EXPORT_BYTES,
  memberExportStore,
  type MemberExport,
  type MemberExportPayload,
} from "../../src/member-export.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  db = store(pool),
  catalog = catalogStore(pool),
  auth = authorizationStore(pool);
const workspace = learningWorkspaceStore(pool, resolveLearningWorkspaceBundle),
  exported = memberExportStore(pool);
const pack = await learningWorkspacePack();
const identity: LearningIdentity = {
  contentId: pack.publication.id,
  contentVersion: pack.publication.version,
  contentHash: pack.contentHash,
  variant: "everyday",
};
const token = () => randomBytes(32).toString("hex");
beforeAll(async () => {
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE adapter_jobs,principals,cohorts,content_versions CASCADE",
  );
});
afterAll(async () => {
  await pool.end();
});
async function fixture() {
  const member = token(),
    outsider = token(),
    editor = token(),
    reviewer = token();
  await db.create(member, { background: "explorer", goal: "everyday" });
  await db.create(outsider, { background: "professional", goal: "work" });
  const owner = await db.session(member);
  if (owner.kind !== "active") throw Error("Missing synthetic owner");
  await auth.provisionStaff(editor, "editor", new Date(Date.now() + 86400000));
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86400000),
  );
  expect(await learningWorkspacePublicationStore(pool).import(editor)).toEqual({
    kind: "imported",
  });
  expect(await catalog.submit(editor, identity.contentId, 1)).toBe(true);
  expect(await catalog.approve(reviewer, identity.contentId, 1, true)).toBe(
    true,
  );
  expect(await catalog.publish(editor, identity.contentId, 1)).toBe(true);
  const created = await workspace.create(member, {
    ...identity,
    operationId: randomUUID(),
  });
  expect(created.kind).toBe("saved");
  return {
    member,
    outsider,
    editor,
    ownerId: owner.learner.id,
    id: (created as LearningSaved).notebookId,
  };
}
async function allPages(credential: string) {
  const records: Record<string, Record<string, unknown>[]> = {},
    pages: MemberExportPayload[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 500; count++) {
    const result = await exported.exportOwned(credential, cursor);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw Error("Owned export unavailable");
    const payload = result.payload;
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(
      MAX_MEMBER_EXPORT_BYTES,
    );
    expect(payload.page.recordCount).toBeLessThanOrEqual(100);
    expect(payload.version).toBe("local-member-records-v28");
    for (const [name, rows] of Object.entries(payload.records))
      (records[name] ??= []).push(...rows);
    pages.push(payload);
    if (payload.page.complete) {
      expect(payload.page.nextCursor).toBeNull();
      return { records, pages };
    }
    expect(payload.page.nextCursor).toBeTypeOf("string");
    cursor = payload.page.nextCursor!;
  }
  throw Error("Owned export did not finish within fixture bounds");
}
function fullState() {
  const split = splitLearningSnapshot(emptyLearningSnapshot(pack, "everyday"));
  const patterns = ["\u0000", "\ud800", "\udc00", "\\u0000", "\u0001", "😀中é"];
  split.fields.forEach((field, index) => {
    field[1] = (
      `${index}:` + patterns[index % patterns.length]!.repeat(30000)
    ).slice(0, 30000);
  });
  return {
    state: joinLearningSnapshot(split.metadata, split.fields),
    fields: split.fields,
  };
}
function decision(sequence: number): LearningDecision {
  const initial = pack.routes.everyday.feedback.initial;
  const text = (`Artifact ${sequence}:` + "\ud800\u0000".repeat(15000)).slice(
    0,
    30000,
  );
  return {
    id: sequence,
    commentVersion: pack.routes.everyday.feedback.commentVersion,
    fromVersion: initial.id + sequence - 1,
    toVersion: initial.id + sequence,
    decision: "revise",
    text,
    proposedText: text,
    reason: "Source:" + "\udc00".repeat(29993),
    question: "\u0000".repeat(30000),
  };
}

it("LWORK-03 / LWORK-05 exports all27 maximum fields and more than20 decisions exactly across bounded pages", async () => {
  const f = await fixture(),
    content = fullState();
  expect(
    (
      await workspace.save(f.member, f.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        basedOnDecisionSequence: 0,
        state: content.state,
      })
    ).kind,
  ).toBe("saved");
  for (let sequence = 1; sequence <= 23; sequence++)
    expect(
      (
        await workspace.append(f.member, f.id, {
          operationId: randomUUID(),
          expectedRevision: sequence + 1,
          decision: decision(sequence),
        })
      ).kind,
    ).toBe("saved");
  expect(await catalog.retire(f.editor, identity.contentId)).toBe(true);
  const result = await allPages(f.member);
  expect(result.pages.length).toBeGreaterThan(20);
  expect(result.records.learningNotebooks).toHaveLength(1);
  const notebook = result.records.learningNotebooks![0]!;
  expect(notebook).toMatchObject({
    id: f.id,
    contentHash: pack.contentHash,
    decisionSequence: 23,
    revision: 25,
  });
  expect(result.records.learningWriting).toHaveLength(27);
  expect(
    Object.fromEntries(
      result.records.learningWriting!.map((row) => [row.field, row.text]),
    ),
  ).toEqual(Object.fromEntries(content.fields));
  expect(result.records.learningFeedbackDecisions).toHaveLength(23);
  expect(result.records.learningFeedbackWriting).toHaveLength(92);
  for (let sequence = 1; sequence <= 23; sequence++) {
    const record = Object.fromEntries(
      result.records
        .learningFeedbackWriting!.filter((row) => row.sequence === sequence)
        .map((row) => [row.field, row.text]),
    );
    const expected = decision(sequence);
    expect(record).toEqual({
      text: expected.text,
      reason: expected.reason,
      question: expected.question,
      proposedText: expected.proposedText,
    });
  }
  const json = JSON.stringify(result);
  for (const forbidden of [
    "_encodedWriting",
    "value_json",
    "request_digest",
    "operation_id",
    "learning_workspace_operations",
  ])
    expect(json).not.toContain(forbidden);
  const foreign = await allPages(f.outsider);
  for (const name of [
    "learningNotebooks",
    "learningWriting",
    "learningFeedbackDecisions",
    "learningFeedbackWriting",
  ])
    expect(foreign.records[name]).toEqual([]);
  expect(
    await exported.exportOwned(f.outsider, result.pages[0]!.page.nextCursor!),
  ).toEqual({ kind: "denied" });
}, 30000);

it("LWORK-06 deletion exports only the notebook tombstone and expired/revoked principals receive no private pages", async () => {
  const f = await fixture(),
    state = emptyLearningSnapshot(pack, "everyday");
  state.final[0] = "Private invented words to erase";
  expect(
    (
      await workspace.save(f.member, f.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        basedOnDecisionSequence: 0,
        state,
      })
    ).kind,
  ).toBe("saved");
  expect(
    (
      await workspace.append(f.member, f.id, {
        operationId: randomUUID(),
        expectedRevision: 2,
        decision: decision(1),
      })
    ).kind,
  ).toBe("saved");
  expect(
    (
      await workspace.remove(f.member, f.id, {
        operationId: randomUUID(),
        expectedRevision: 3,
      })
    ).kind,
  ).toBe("saved");
  const result = await allPages(f.member);
  expect(result.records.learningNotebooks).toHaveLength(1);
  expect(result.records.learningNotebooks![0]).toMatchObject({
    id: f.id,
    metadata: null,
    deletedAt: expect.any(Date),
  });
  for (const name of [
    "learningWriting",
    "learningFeedbackDecisions",
    "learningFeedbackWriting",
  ])
    expect(result.records[name]).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(state.final[0]);
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [f.ownerId],
  );
  expect(await exported.exportOwned(f.member)).toEqual({ kind: "denied" });
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '1 day',revoked_at=clock_timestamp() WHERE id=$1",
    [f.ownerId],
  );
  expect(await exported.exportOwned(f.member)).toEqual({ kind: "denied" });
});

it("LWORK-04 corrupt encoded writing fails closed without returning or advancing a continuation", async () => {
  const f = await fixture(),
    content = fullState();
  expect(
    (
      await workspace.save(f.member, f.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        basedOnDecisionSequence: 0,
        state: content.state,
      })
    ).kind,
  ).toBe("saved");
  const first = await exported.exportOwned(f.member);
  expect(first.kind).toBe("ready");
  if (first.kind !== "ready" || !first.payload.page.nextCursor)
    throw Error("Expected fixture continuation");
  const cursor = first.payload.page.nextCursor;
  const returned = new Set(
    first.payload.records.learningWriting!.map((row) => row.field),
  );
  const target = content.fields
    .filter(([key]) => !returned.has(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))[0]!;
  await pool.query(
    "UPDATE learning_workspace_fields SET value_json='null' WHERE notebook_id=$1 AND field_key=$2",
    [f.id, target[0]],
  );
  const corrupt = await exported.exportOwned(f.member, cursor);
  expect(corrupt.kind).toBe("unavailable");
  expect(Object.keys(corrupt)).toEqual(["kind"]);
  await pool.query(
    "UPDATE learning_workspace_fields SET value_json=$3 WHERE notebook_id=$1 AND field_key=$2",
    [f.id, target[0], JSON.stringify(target[1])],
  );
  const recovered = await exported.exportOwned(f.member, cursor);
  expect(recovered.kind).toBe("ready");
  if (recovered.kind === "ready")
    expect(
      recovered.payload.records.learningWriting!.some(
        (row) => row.field === target[0] && row.text === target[1],
      ),
    ).toBe(true);
});

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function pausedPool(match: (sql: string) => boolean) {
  const reached = gate(),
    resume = gate(),
    state = { pid: 0, paused: false };
  const wrapped = {
    async connect() {
      const client = await pool.connect();
      state.pid = (
        await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (!state.paused && match(sql)) {
            state.paused = true;
            reached.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  return { pool: wrapped, reached, resume, state };
}
async function waitForBlocked(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (
        await pool.query<{ blocked: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked",
          [pid],
        )
      ).rows[0]!.blocked
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Expected deletion/export lock wait was not observed");
}

it("LWORK-06 an export formed first serializes deletion until its private response has committed", async () => {
  const f = await fixture(),
    controlled = pausedPool((sql) =>
      sql.includes("FROM principals p JOIN learners l"),
    );
  const reading = memberExportStore(controlled.pool).exportOwned(f.member);
  let removing: ReturnType<typeof workspace.remove> | undefined;
  try {
    await controlled.reached.wait;
    removing = workspace.remove(f.member, f.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
    });
    await waitForBlocked(controlled.state.pid);
    controlled.resume.release();
    const result = await reading;
    expect(result.kind).toBe("ready");
    if (result.kind === "ready")
      expect(result.payload.records.learningWriting).toHaveLength(27);
    expect((await removing).kind).toBe("saved");
    expect((await allPages(f.member)).records.learningWriting).toEqual([]);
  } finally {
    controlled.resume.release();
    await Promise.allSettled([reading, ...(removing ? [removing] : [])]);
  }
});

it("LWORK-06 an export waiting behind completed deletion never returns the earlier raw writing", async () => {
  const f = await fixture(),
    controlled = pausedPool((sql) =>
      sql.startsWith("SELECT id FROM workspaces"),
    );
  const deleting = learningWorkspaceStore(
    controlled.pool,
    resolveLearningWorkspaceBundle,
  ).remove(f.member, f.id, { operationId: randomUUID(), expectedRevision: 1 });
  let reading: Promise<MemberExport> | undefined;
  try {
    await controlled.reached.wait;
    reading = exported.exportOwned(f.member);
    await waitForBlocked(controlled.state.pid);
    controlled.resume.release();
    expect((await deleting).kind).toBe("saved");
    const result = await reading;
    if (result.kind === "ready") {
      expect(result.payload.records.learningWriting).toEqual([]);
      expect(result.payload.records.learningNotebooks![0]).toMatchObject({
        metadata: null,
        deletedAt: expect.any(Date),
      });
    } else expect(["denied", "unavailable"]).toContain(result.kind);
    expect((await allPages(f.member)).records.learningWriting).toEqual([]);
  } finally {
    controlled.resume.release();
    await Promise.allSettled([deleting, ...(reading ? [reading] : [])]);
  }
});

it.each([48, 50])(
  "LWORK-06 direct writing continuation section %i cannot bypass deletion's parent fence",
  async (sectionIndex) => {
    const f = await fixture(),
      content = fullState();
    expect(
      (
        await workspace.save(f.member, f.id, {
          operationId: randomUUID(),
          expectedRevision: 1,
          basedOnDecisionSequence: 0,
          state: content.state,
        })
      ).kind,
    ).toBe("saved");
    expect(
      (
        await workspace.append(f.member, f.id, {
          operationId: randomUUID(),
          expectedRevision: 2,
          decision: decision(1),
        })
      ).kind,
    ).toBe("saved");
    let continuation: string | undefined;
    for (let page = 0; page < 60; page++) {
      const result = await exported.exportOwned(f.member, continuation);
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready" || !result.payload.page.nextCursor)
        throw Error("Expected direct child-section continuation");
      continuation = result.payload.page.nextCursor;
      const cursor = JSON.parse(
        Buffer.from(continuation.split(".")[0]!, "base64url").toString("utf8"),
      );
      if (cursor[1] === sectionIndex) break;
      if (page === 59) throw Error("Expected writing section was not reached");
    }
    const controlled = pausedPool((sql) =>
      sql.startsWith("SELECT id FROM workspaces"),
    );
    const deleting = learningWorkspaceStore(
      controlled.pool,
      resolveLearningWorkspaceBundle,
    ).remove(f.member, f.id, {
      operationId: randomUUID(),
      expectedRevision: 3,
    });
    let reading: Promise<MemberExport> | undefined;
    try {
      await controlled.reached.wait;
      reading = exported.exportOwned(f.member, continuation);
      await waitForBlocked(controlled.state.pid);
      controlled.resume.release();
      expect((await deleting).kind).toBe("saved");
      const result = await reading;
      if (result.kind === "ready") {
        expect(result.payload.records.learningWriting).toEqual([]);
        expect(result.payload.records.learningFeedbackWriting).toEqual([]);
        expect(result.payload.records.learningFeedbackDecisions).toEqual([]);
      } else expect(["denied", "unavailable"]).toContain(result.kind);
    } finally {
      controlled.resume.release();
      await Promise.allSettled([deleting, ...(reading ? [reading] : [])]);
    }
  },
);
