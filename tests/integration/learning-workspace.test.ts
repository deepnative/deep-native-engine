import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { catalogStore } from "../../src/catalog.ts";
import {
  learningWorkspaceStore,
  type LearningSaved,
} from "../../src/learning-workspace-store.ts";
import {
  emptyLearningSnapshot,
  type LearningDecision,
} from "../../src/learning-workspace-values.ts";
import {
  bundleFixture as bundle,
  identityFixture as identity,
} from "../unit/learning-workspace-fixtures.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  db = store(pool),
  catalog = catalogStore(pool),
  workspace = learningWorkspaceStore(pool, async () => bundle);
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
    other = token(),
    editor = token(),
    reviewer = token();
  await db.create(member, { background: "explorer", goal: "everyday" });
  await db.create(other, { background: "professional", goal: "work" });
  const principal = await db.session(member);
  if (principal.kind !== "active") throw Error("Missing synthetic owner");
  const auth = authorizationStore(pool);
  await auth.provisionStaff(editor, "editor", new Date(Date.now() + 86400000));
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86400000),
  );
  expect(await catalog.createDraft(editor, bundle.publication)).toBe(true);
  expect(await catalog.submit(editor, "LRN-001", 1)).toBe(true);
  expect(await catalog.approve(reviewer, "LRN-001", 1, true)).toBe(true);
  expect(await catalog.publish(editor, "LRN-001", 1)).toBe(true);
  const createInput = { ...identity, operationId: randomUUID() };
  const created = await workspace.create(member, createInput);
  expect(created.kind).toBe("saved");
  return {
    member,
    other,
    editor,
    memberId: principal.learner.id,
    created: created as LearningSaved,
    createInput,
  };
}
const revision = (value: Awaited<ReturnType<typeof workspace.save>>) => {
  expect(["saved", "replayed"]).toContain(value.kind);
  return (value as LearningSaved).revision;
};
function decision(
  sequence = 1,
  text = "A revised invented artifact",
): LearningDecision {
  return {
    id: sequence,
    commentVersion: 1,
    fromVersion: sequence,
    toVersion: sequence + 1,
    decision: "revise",
    text,
    reason: "Invented source evidence",
    question: "",
    proposedText: text,
  };
}

async function waitForBlocked(blocker: PoolClient) {
  const pid = (
    await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
  ).rows[0]!.pid;
  for (let attempt = 0; attempt < 100; attempt++) {
    const blocked = (
      await pool.query<{ blocked: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked",
        [pid],
      )
    ).rows[0]!.blocked;
    if (blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Expected database lock barrier was not observed");
}

it("LWORK-03 / LWORK-04 saves all27 fields exactly, isolates variants/owners and resolves uncertain replay", async () => {
  const f = await fixture(),
    state = emptyLearningSnapshot(bundle, "everyday");
  state.lessons.forEach((lesson, i) => {
    lesson.transfer = `${i}\u0000\ud800`;
    lesson.work = "\udc00".repeat(30000);
  });
  state.final = Array.from({ length: 6 }, (_, i) => `${i} capstone`);
  state.feedback.draft.reason = "Saved feedback draft";
  state.contribution.problem = "Private contribution";
  const input = {
    operationId: randomUUID(),
    expectedRevision: 1,
    basedOnDecisionSequence: 0,
    state,
  };
  expect(
    revision(await workspace.save(f.member, f.created.notebookId, input)),
  ).toBe(2);
  expect(
    (await workspace.save(f.member, f.created.notebookId, input)).kind,
  ).toBe("replayed");
  expect(
    (
      await workspace.save(f.member, f.created.notebookId, {
        ...input,
        state: { ...state, step: 1 },
      })
    ).kind,
  ).toBe("conflict");
  const read = await workspace.read(f.member, f.created.notebookId);
  expect(read.kind).toBe("ok");
  if (read.kind !== "ok") throw Error("Missing saved draft");
  expect(read.value.state).toEqual(state);
  expect(read.value.draftRevision).toBe(2);
  expect(await workspace.read(f.other, f.created.notebookId)).toEqual({
    kind: "not-found",
  });
  expect(await workspace.operation(f.other, input.operationId)).toEqual({
    kind: "not-found",
  });
  expect((await workspace.operation(f.member, input.operationId)).kind).toBe(
    "replayed",
  );
  const otherVariant = await workspace.create(f.member, {
    ...identity,
    variant: "technical",
    operationId: randomUUID(),
  });
  expect(otherVariant.kind).toBe("saved");
  expect((otherVariant as LearningSaved).notebookId).not.toBe(
    f.created.notebookId,
  );
  expect((await workspace.list(f.member)).kind).toBe("ok");
  const found = await workspace.find(f.member, identity);
  expect(found.kind).toBe("ok");
  if (found.kind === "ok") expect(found.value.state).toEqual(state);
  expect(await workspace.find(f.other, identity)).toEqual({
    kind: "not-found",
  });
});

it("LWORK-03 appends private feedback independently of the atomic draft and preserves the exact head", async () => {
  const f = await fixture(),
    id = f.created.notebookId;
  const input = {
    operationId: randomUUID(),
    expectedRevision: 1,
    decision: decision(),
  };
  expect(revision(await workspace.append(f.member, id, input))).toBe(2);
  expect((await workspace.append(f.member, id, input)).kind).toBe("replayed");
  const current = await workspace.read(f.member, id);
  expect(current.kind).toBe("ok");
  if (current.kind !== "ok") throw Error("Missing private feedback");
  expect(current.value.currentArtifact).toEqual({
    id: 2,
    text: input.decision.text,
  });
  expect(current.value.draftRevision).toBe(1);
  expect(current.value.draftBasedOnDecisionSequence).toBe(0);
  const state = current.value.state;
  expect(
    (
      await workspace.save(f.member, id, {
        operationId: randomUUID(),
        expectedRevision: 2,
        basedOnDecisionSequence: 0,
        state,
      })
    ).kind,
  ).toBe("conflict");
  expect(
    revision(
      await workspace.save(f.member, id, {
        operationId: randomUUID(),
        expectedRevision: 2,
        basedOnDecisionSequence: 1,
        state,
      }),
    ),
  ).toBe(3);
  const history = await workspace.history(f.member, id);
  expect(history.kind).toBe("ok");
  if (history.kind === "ok")
    expect(history.value.items[0]).toMatchObject(input.decision);
  await expect(
    pool.query(
      "UPDATE learning_workspace_decisions SET metadata=metadata WHERE notebook_id=$1",
      [id],
    ),
  ).rejects.toThrow("immutable");
});

it("LWORK-04 serializes concurrent draft/decision writes to one accepted revision", async () => {
  const f = await fixture(),
    id = f.created.notebookId;
  const state = emptyLearningSnapshot(bundle, "everyday");
  const results = await Promise.all([
    workspace.save(f.member, id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      basedOnDecisionSequence: 0,
      state,
    }),
    workspace.append(f.member, id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      decision: decision(),
    }),
  ]);
  expect(results.map((result) => result.kind).sort()).toEqual([
    "conflict",
    "saved",
  ]);
  const same = {
    operationId: randomUUID(),
    expectedRevision: 2,
    basedOnDecisionSequence: results[1]!.kind === "saved" ? 1 : 0,
    state,
  };
  expect(
    (
      await Promise.all([
        workspace.save(f.member, id, same),
        workspace.save(f.member, id, same),
      ])
    )
      .map((result) => result.kind)
      .sort(),
  ).toEqual(["replayed", "saved"]);
});

it("LWORK-05 retirement denies new source/writes while preserving private history, receipt and erasure", async () => {
  const f = await fixture(),
    id = f.created.notebookId;
  expect((await workspace.source(f.member, identity)).kind).toBe("ok");
  expect(await catalog.retire(f.editor, identity.contentId)).toBe(true);
  expect((await workspace.source(f.member, identity)).kind).toBe(
    "source-unavailable",
  );
  expect(
    (
      await workspace.create(f.member, {
        ...identity,
        operationId: randomUUID(),
      })
    ).kind,
  ).toBe("source-unavailable");
  expect(
    (
      await workspace.save(f.member, id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        basedOnDecisionSequence: 0,
        state: emptyLearningSnapshot(bundle, "everyday"),
      })
    ).kind,
  ).toBe("source-unavailable");
  const read = await workspace.read(f.member, id);
  expect(read.kind).toBe("ok");
  if (read.kind === "ok")
    expect(read.value.availability).toBe("source-unavailable");
  expect((await workspace.create(f.member, f.createInput)).kind).toBe(
    "replayed",
  );
  const removal = { operationId: randomUUID(), expectedRevision: 1 };
  expect((await workspace.remove(f.member, id, removal)).kind).toBe("saved");
  expect((await workspace.remove(f.member, id, removal)).kind).toBe("replayed");
  expect(await workspace.read(f.member, id)).toEqual({ kind: "deleted" });
  expect(await workspace.history(f.member, id)).toEqual({ kind: "deleted" });
  expect(await workspace.create(f.member, f.createInput)).toEqual({
    kind: "deleted",
  });
  expect(
    (
      await pool.query(
        "SELECT 1 FROM learning_workspace_fields WHERE notebook_id=$1",
        [id],
      )
    ).rowCount,
  ).toBe(0);
});

it("LWORK-06 rejects stale original bearers after a principal lock wait", async () => {
  const f = await fixture(),
    blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
      f.memberId,
    ]);
    const pending = workspace.read(f.member, f.created.notebookId);
    await waitForBlocked(blocker);
    await blocker.query("UPDATE principals SET token_hash=$2 WHERE id=$1", [
      f.memberId,
      randomBytes(32).toString("hex"),
    ]);
    await blocker.query("COMMIT");
    expect(await pending).toEqual({ kind: "denied" });
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

it("LWORK-06 expires authority during a workspace wait and cannot write after deletion", async () => {
  const f = await fixture(),
    blocker = await pool.connect();
  try {
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
      [f.memberId],
    );
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
      f.memberId,
    ]);
    const pending = workspace.append(f.member, f.created.notebookId, {
      operationId: randomUUID(),
      expectedRevision: 1,
      decision: decision(),
    });
    await waitForBlocked(blocker);
    await blocker.query("SELECT pg_sleep(1.05)");
    await blocker.query("COMMIT");
    expect(await pending).toEqual({ kind: "denied" });
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  await pool.query("DELETE FROM principals WHERE id=$1", [f.memberId]);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM learning_workspace_notebooks WHERE id=$1",
        [f.created.notebookId],
      )
    ).rowCount,
  ).toBe(0);
  expect((await workspace.read(f.member, f.created.notebookId)).kind).toBe(
    "denied",
  );
});

it("LWORK-03 paginates feedback without a history cap and validates exact source transitions", async () => {
  const f = await fixture(),
    id = f.created.notebookId;
  for (let sequence = 1; sequence <= 23; sequence++) {
    expect(
      revision(
        await workspace.append(f.member, id, {
          operationId: randomUUID(),
          expectedRevision: sequence,
          decision: decision(sequence, `Artifact ${sequence}\ud800\u0000`),
        }),
      ),
    ).toBe(sequence + 1);
  }
  const first = await workspace.history(f.member, id),
    second = await workspace.history(f.member, id, 20);
  expect(first.kind).toBe("ok");
  expect(second.kind).toBe("ok");
  if (first.kind === "ok" && second.kind === "ok") {
    expect(first.value.items).toHaveLength(20);
    expect(first.value.nextSequence).toBe(20);
    expect(second.value.items).toHaveLength(3);
    expect(second.value.nextSequence).toBeNull();
  }
  expect(
    (
      await workspace.append(f.member, id, {
        operationId: randomUUID(),
        expectedRevision: 24,
        decision: { ...decision(24), commentVersion: 99 },
      })
    ).kind,
  ).toBe("invalid");
});

it("LWORK-05 / LWORK-04 source identity and payload corruption cannot become saved state", async () => {
  const f = await fixture(),
    id = f.created.notebookId;
  const wrong = learningWorkspaceStore(pool, async () => ({
    ...bundle,
    publication: { ...bundle.publication, body: "Different source" },
  }));
  expect((await wrong.source(f.member, identity)).kind).toBe(
    "source-unavailable",
  );
  const state = emptyLearningSnapshot(bundle, "everyday");
  state.final[0] = "x".repeat(30001);
  expect(
    (
      await workspace.save(f.member, id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        basedOnDecisionSequence: 0,
        state,
      })
    ).kind,
  ).toBe("invalid");
  await pool.query(
    "UPDATE learning_workspace_fields SET value_json='null' WHERE notebook_id=$1 AND field_key='final.0'",
    [id],
  );
  expect(await workspace.read(f.member, id)).toEqual({ kind: "unavailable" });
});

it("LWORK-05 observes committed retirement after waiting for the exact source lock", async () => {
  const f = await fixture(),
    blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM content_versions WHERE id='LRN-001' AND version=1 FOR UPDATE",
    );
    const pending = workspace.save(f.member, f.created.notebookId, {
      operationId: randomUUID(),
      expectedRevision: 1,
      basedOnDecisionSequence: 0,
      state: emptyLearningSnapshot(bundle, "everyday"),
    });
    await waitForBlocked(blocker);
    await blocker.query(
      "UPDATE content_versions SET state='retired',retired_at=clock_timestamp() WHERE id='LRN-001' AND version=1",
    );
    await blocker.query("COMMIT");
    expect(await pending).toEqual({ kind: "source-unavailable" });
    expect(
      (
        await pool.query(
          "SELECT revision FROM learning_workspace_notebooks WHERE id=$1",
          [f.created.notebookId],
        )
      ).rows[0].revision,
    ).toBe(1);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

it("LWORK-06 workspace erasure fencing denies a queued save before any writing changes", async () => {
  const f = await fixture(),
    blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
      f.memberId,
    ]);
    const pending = workspace.save(f.member, f.created.notebookId, {
      operationId: randomUUID(),
      expectedRevision: 1,
      basedOnDecisionSequence: 0,
      state: emptyLearningSnapshot(bundle, "everyday"),
    });
    await waitForBlocked(blocker);
    await blocker.query(
      "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
      [f.memberId],
    );
    await blocker.query("COMMIT");
    expect(await pending).toEqual({ kind: "denied" });
    expect(
      (
        await pool.query(
          "SELECT revision FROM learning_workspace_notebooks WHERE id=$1",
          [f.created.notebookId],
        )
      ).rows[0].revision,
    ).toBe(1);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});
