import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, seedDraftPack } from "../../src/catalog.ts";
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
  type LearningIdentity,
} from "../../src/learning-workspace-values.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  db = store(pool),
  auth = authorizationStore(pool),
  catalog = catalogStore(pool);
const publication = learningWorkspacePublicationStore(pool),
  workspace = learningWorkspaceStore(pool, resolveLearningWorkspaceBundle);
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
async function actors() {
  const member = token(),
    editor = token(),
    reviewer = token(),
    operator = token();
  await db.create(member, { background: "explorer", goal: "everyday" });
  const expiry = new Date(Date.now() + 86400000);
  const editorId = await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  await auth.provisionStaff(operator, "operator", expiry);
  return { member, editor, editorId, reviewer, operator };
}
async function blockedBy(client: PoolClient) {
  const pid = (
    await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
  ).rows[0]!.pid;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = (
      await pool.query<{ blocked: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked",
        [pid],
      )
    ).rows[0]!;
    if (result.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Publication authority wait was not observed");
}

it("LWORK-05 actual registered pack requires explicit draft import, distinct rights review and publication", async () => {
  const a = await actors();
  await seedDraftPack(pool);
  expect(
    (await pool.query("SELECT 1 FROM content_versions WHERE id='LRN-001'"))
      .rowCount,
  ).toBe(0);
  const before = await publication.preview(a.reviewer);
  expect(before.kind).toBe("ready");
  if (before.kind === "ready") {
    expect(before.state).toBe("not-imported");
    expect(before.pack.course.lessons).toHaveLength(6);
    expect(before.pack.module).toContain(pack.contentHash);
  }
  expect(await workspace.source(a.member, identity)).toEqual({
    kind: "source-unavailable",
  });
  expect(await publication.import(a.editor)).toEqual({ kind: "imported" });
  const draft = await catalog.preview(a.editor, identity.contentId, 1);
  expect(draft).toMatchObject({
    state: "draft",
    requiresQualifiedSignoff: false,
    reviewedAt: null,
    publishedAt: null,
  });
  expect(await workspace.source(a.member, identity)).toEqual({
    kind: "source-unavailable",
  });
  expect(
    await workspace.create(a.member, {
      ...identity,
      operationId: randomUUID(),
    }),
  ).toEqual({ kind: "source-unavailable" });
  expect(await catalog.publish(a.editor, identity.contentId, 1)).toBe(false);
  expect(await catalog.submit(a.editor, identity.contentId, 1)).toBe(true);
  expect(await catalog.approve(a.reviewer, identity.contentId, 1, false)).toBe(
    false,
  );
  await pool.query(
    "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
    [a.editorId],
  );
  expect(await catalog.approve(a.editor, identity.contentId, 1, true)).toBe(
    false,
  );
  await pool.query(
    "UPDATE staff_profiles SET role='editor' WHERE principal_id=$1",
    [a.editorId],
  );
  expect(await catalog.approve(a.reviewer, identity.contentId, 1, true)).toBe(
    true,
  );
  expect(await workspace.source(a.member, identity)).toEqual({
    kind: "source-unavailable",
  });
  expect(await catalog.publish(a.editor, identity.contentId, 1)).toBe(true);
  for (const variant of ["everyday", "work", "technical"] as const) {
    const exact = { ...identity, variant };
    const source = await workspace.source(a.member, exact);
    expect(source.kind).toBe("ok");
    if (source.kind === "ok") expect(source.value).toEqual(pack);
    const created = await workspace.create(a.member, {
      ...exact,
      operationId: randomUUID(),
    });
    expect(created.kind).toBe("saved");
    const read = await workspace.read(
      a.member,
      (created as LearningSaved).notebookId,
    );
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") {
      expect(read.value.state).toEqual(emptyLearningSnapshot(pack, variant));
      expect(read.value.currentArtifact).toEqual(
        pack.routes[variant].feedback.initial,
      );
      expect(read.value.availability).toBe("available");
    }
  }
});

it("LWORK-05 / LWORK-06 publication roles do not grant member or unreviewed source access", async () => {
  const a = await actors();
  for (const credential of [a.member, a.reviewer, a.operator])
    expect(await publication.import(credential)).toEqual({ kind: "denied" });
  for (const credential of [a.member, a.operator])
    expect(await publication.preview(credential)).toEqual({ kind: "denied" });
  expect(await workspace.source(a.editor, identity)).toEqual({
    kind: "denied",
  });
  expect(await catalog.submit(a.member, identity.contentId, 1)).toBe(false);
  expect(await publication.import(a.editor)).toEqual({ kind: "imported" });
  expect(await catalog.approve(a.member, identity.contentId, 1, true)).toBe(
    false,
  );
  expect(await catalog.publish(a.reviewer, identity.contentId, 1)).toBe(false);
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [a.editorId],
  );
  expect(await publication.import(a.editor)).toEqual({ kind: "denied" });
  expect(await publication.preview(a.editor)).toEqual({ kind: "denied" });
});

it("LWORK-05 exact registry/catalog mismatch is a conflict and never resets an existing draft", async () => {
  const a = await actors();
  expect(
    await catalog.createDraft(a.editor, {
      ...pack.publication,
      body: "A different draft under the registered identity",
    }),
  ).toBe(true);
  expect(await publication.import(a.editor)).toEqual({ kind: "conflict" });
  expect(await publication.preview(a.reviewer)).toEqual({ kind: "conflict" });
  expect((await catalog.preview(a.editor, identity.contentId, 1))?.body).toBe(
    "A different draft under the registered identity",
  );
  expect(
    await workspace.source(a.member, {
      ...identity,
      contentHash: "b".repeat(64),
    }),
  ).toEqual({ kind: "source-unavailable" });
  expect(
    await workspace.source(a.member, { ...identity, contentVersion: 2 }),
  ).toEqual({ kind: "source-unavailable" });
  const failed = learningWorkspacePublicationStore(pool, async () => {
    throw Error("Unavailable pinned teaching bytes");
  });
  expect(await failed.import(a.editor)).toEqual({ kind: "unavailable" });
  expect(await failed.preview(a.reviewer)).toEqual({ kind: "unavailable" });
});

it("LWORK-04 / LWORK-05 concurrent imports are idempotent and retired content is not republished", async () => {
  const a = await actors();
  expect(
    (
      await Promise.all([
        publication.import(a.editor),
        publication.import(a.editor),
      ])
    )
      .map((result) => result.kind)
      .sort(),
  ).toEqual(["existing", "imported"]);
  expect(await catalog.submit(a.editor, identity.contentId, 1)).toBe(true);
  expect(await catalog.approve(a.reviewer, identity.contentId, 1, true)).toBe(
    true,
  );
  expect(await catalog.publish(a.editor, identity.contentId, 1)).toBe(true);
  const created = await workspace.create(a.member, {
    ...identity,
    operationId: randomUUID(),
  });
  expect(created.kind).toBe("saved");
  expect(await catalog.retire(a.editor, identity.contentId)).toBe(true);
  expect(await publication.import(a.editor)).toEqual({ kind: "existing" });
  const preview = await publication.preview(a.reviewer);
  expect(preview.kind).toBe("ready");
  if (preview.kind === "ready") expect(preview.state).toBe("retired");
  expect(await workspace.source(a.member, identity)).toEqual({
    kind: "source-unavailable",
  });
  const read = await workspace.read(
    a.member,
    (created as LearningSaved).notebookId,
  );
  expect(read.kind).toBe("ok");
  if (read.kind === "ok")
    expect(read.value.availability).toBe("source-unavailable");
});

it("LWORK-06 expired importer and preview authority cannot cross the observed publication lock wait", async () => {
  for (const operation of ["import", "preview"] as const) {
    const a = await actors(),
      blocker = await pool.connect();
    try {
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
        [a.editorId],
      );
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(34,20261029)");
      const pending = publication[operation](a.editor);
      await blockedBy(blocker);
      await blocker.query("SELECT pg_sleep(1.05)");
      await blocker.query("COMMIT");
      expect(await pending).toEqual({ kind: "denied" });
      expect(
        (await pool.query("SELECT 1 FROM content_versions WHERE id='LRN-001'"))
          .rowCount,
      ).toBe(0);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  }
});
