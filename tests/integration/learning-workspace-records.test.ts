import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore } from "../../src/catalog.ts";
import {
  learningWorkspaceStore,
  type LearningSaved,
} from "../../src/learning-workspace-store.ts";
import { mountLearningWorkspaceRecords } from "../../src/learning-workspace-records.ts";
import { csrf } from "../../src/session.ts";
import {
  emptyLearningSnapshot,
  splitLearningSnapshot,
  joinLearningSnapshot,
  type LearningDecision,
} from "../../src/learning-workspace-values.ts";
import {
  bundleFixture as bundle,
  identityFixture as identity,
} from "../unit/learning-workspace-fixtures.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  db = store(pool),
  catalog = catalogStore(pool);
const loader = vi.fn(async () => bundle);
const workspace = learningWorkspaceStore(pool, loader);
const origin = "http://localhost",
  secret = "synthetic-records-secret",
  base = "/learn/notebooks";
const app = express();
app.use((req, res, next) => {
  res.locals.token = req.get("x-test-member");
  next();
});
mountLearningWorkspaceRecords(app, workspace, { origin, secret });
const token = () => randomBytes(32).toString("hex");
beforeAll(async () => {
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE adapter_jobs,principals,cohorts,content_versions CASCADE",
  );
  loader.mockReset().mockResolvedValue(bundle);
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
  const owner = await db.session(member);
  if (owner.kind !== "active") throw Error("Missing synthetic owner");
  const auth = authorizationStore(pool);
  await auth.provisionStaff(editor, "editor", new Date(Date.now() + 86400000));
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86400000),
  );
  expect(await catalog.createDraft(editor, bundle.publication)).toBe(true);
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
    other,
    editor,
    reviewer,
    ownerId: owner.learner.id,
    id: (created as LearningSaved).notebookId,
  };
}
function decision(id: number): LearningDecision {
  return {
    id,
    commentVersion: 1,
    fromVersion: id,
    toVersion: id + 1,
    decision: "revise",
    text: `Saved artifact ${id}\u0000\ud800`,
    reason: `Reason ${id}`,
    question: `Question ${id}`,
    proposedText: `Saved artifact ${id}\u0000\ud800`,
  };
}
function get(member: string, path: string) {
  return request(app).get(path).set("x-test-member", member);
}
function remove(
  member: string,
  id: string,
  operationId: string,
  expectedRevision: number,
) {
  return request(app)
    .post(`${base}/${id}/delete`)
    .set({ "x-test-member": member, origin })
    .type("form")
    .send({
      csrf: csrf(member, secret),
      operationId,
      expectedRevision: String(expectedRevision),
      confirm: "yes",
    });
}

it("LWORK-05 retained recovery renders all27 fields after retirement and downloads exact writing with 20-decision continuation", async () => {
  const f = await fixture(),
    state = emptyLearningSnapshot(bundle, "everyday"),
    parts = splitLearningSnapshot(state);
  const exact = joinLearningSnapshot(
    parts.metadata,
    parts.fields.map(([key], i) => [key, `${i}:私密\u0000\ud800<&>\r\n😀`]),
  );
  expect(
    await workspace.save(f.member, f.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      state: exact,
      basedOnDecisionSequence: 0,
    }),
  ).toMatchObject({ kind: "saved", revision: 2 });
  for (let i = 1; i <= 23; i++)
    expect(
      await workspace.append(f.member, f.id, {
        operationId: randomUUID(),
        expectedRevision: i + 1,
        decision: decision(i),
      }),
    ).toMatchObject({ kind: "saved" });
  expect(await catalog.retire(f.editor, identity.contentId)).toBe(true);
  loader.mockRejectedValue(new Error("Retired bundle files unavailable"));
  const list = await get(f.member, base);
  expect(list.status).toBe(200);
  expect(list.text).toContain(`${base}/${f.id}`);
  const detail = await get(f.member, `${base}/${f.id}`);
  expect(detail.text).toContain("teaching source is unavailable");
  expect(detail.text).toContain("based on feedback decision 0");
  expect(detail.text).toContain("Current feedback head: decision 23");
  for (let i = 0; i < 27; i++)
    expect(detail.text).toContain(
      `${i}:私密\\u0000\\ud800&lt;&amp;&gt;\\u000d`,
    );
  expect(detail.text).not.toContain("Six invented lessons");
  const first = await get(f.member, `${base}/${f.id}/download`);
  expect(first.body.notebook.state).toEqual(exact);
  expect(first.body.historyPage.items).toHaveLength(20);
  expect(first.body.historyPage.items[19]).toMatchObject(decision(20));
  expect(first.body.historyPage.nextDownload).toBe(
    `${base}/${f.id}/download?after=20`,
  );
  const next = await get(f.member, first.body.historyPage.nextDownload);
  expect(
    next.body.historyPage.items.map((item: LearningDecision) => item.id),
  ).toEqual([21, 22, 23]);
  expect(next.body.historyPage.nextDownload).toBeNull();
  const history = await get(f.member, `${base}/${f.id}/history?after=20`);
  expect(history.text).toContain("Decision 23: revise");
  expect(history.text).toContain("End of saved history");
});

it("LWORK-06 recovery continuations deny other owners, staff, revoked and expired sessions without leaking stored words", async () => {
  const f = await fixture(),
    path = `${base}/${f.id}`;
  const saved = await workspace.save(f.member, f.id, {
    operationId: randomUUID(),
    expectedRevision: 1,
    state: emptyLearningSnapshot(bundle, "everyday"),
    basedOnDecisionSequence: 0,
  });
  expect(saved.kind).toBe("saved");
  for (const outsider of [f.other, f.editor, token()]) {
    for (const suffix of ["", "/history", "/download"]) {
      const response = await get(outsider, path + suffix);
      expect([401, 404]).toContain(response.status);
      expect(response.text).not.toContain("Invented everyday artifact");
    }
  }
  expect((await get(f.other, base)).text).not.toContain(f.id);
  expect((await remove(f.other, f.id, randomUUID(), 2)).status).toBe(404);
  const operationId = randomUUID();
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [f.ownerId],
  );
  for (const suffix of [
    "",
    "/history?after=20",
    "/download?after=20",
    `/status?operationId=${operationId}&expectedRevision=2`,
  ])
    expect((await get(f.member, path + suffix)).status).toBe(401);
  expect((await remove(f.member, f.id, operationId, 2)).status).toBe(401);
  await pool.query(
    "UPDATE principals SET revoked_at=NULL,expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [f.ownerId],
  );
  expect((await get(f.member, `${path}/download`)).status).toBe(401);
  expect(
    (
      await pool.query(
        "SELECT revision FROM learning_workspace_notebooks WHERE id=$1",
        [f.id],
      )
    ).rows[0].revision,
  ).toBe(2);
});

it("LWORK-06 explicit stable deletion status distinguishes unrelated receipts, stale revisions and same-operation replay", async () => {
  const f = await fixture(),
    path = `${base}/${f.id}`,
    saveOperation = randomUUID();
  await workspace.save(f.member, f.id, {
    operationId: saveOperation,
    expectedRevision: 1,
    state: emptyLearningSnapshot(bundle, "everyday"),
    basedOnDecisionSequence: 0,
  });
  expect(
    (
      await get(
        f.member,
        `${path}/status?operationId=${saveOperation}&expectedRevision=1`,
      )
    ).status,
  ).toBe(409);
  const operationId = randomUUID(),
    statusPath = `${path}/status?operationId=${operationId}&expectedRevision=2`;
  const status = await get(f.member, statusPath);
  expect(status.status).toBe(200);
  expect(status.text).toContain(`name="operationId" value="${operationId}"`);
  expect(
    (
      await pool.query(
        "SELECT revision FROM learning_workspace_notebooks WHERE id=$1",
        [f.id],
      )
    ).rows[0].revision,
  ).toBe(2);
  const stale = await remove(f.member, f.id, randomUUID(), 1);
  expect(stale.status).toBe(409);
  const first = await remove(f.member, f.id, operationId, 2);
  expect(first.status).toBe(303);
  expect(first.headers.location).toBe(statusPath);
  const confirmed = await get(f.member, statusPath);
  expect(confirmed.status).toBe(200);
  expect(confirmed.text).toContain("receipt and saved record confirm");
  const replay = await remove(f.member, f.id, operationId, 2);
  expect(replay.status).toBe(303);
  expect((await get(f.member, `${path}/download`)).status).toBe(410);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM learning_workspace_operations WHERE operation_id=$1",
        [operationId],
      )
    ).rows[0].count,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM learning_workspace_fields WHERE notebook_id=$1",
        [f.id],
      )
    ).rows[0].count,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT revision FROM learning_workspace_notebooks WHERE id=$1",
        [f.id],
      )
    ).rows[0].revision,
  ).toBe(3);
});

it("LWORK-06 simultaneous saved revision and removal have one winner, and repeated explicit deletes share one receipt", async () => {
  const f = await fixture(),
    operationId = randomUUID();
  const results = await Promise.all([
    workspace.save(f.member, f.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      basedOnDecisionSequence: 0,
      state: emptyLearningSnapshot(bundle, "everyday"),
    }),
    remove(f.member, f.id, operationId, 1),
  ]);
  if (results[0].kind === "saved") {
    expect(results[1].status).toBe(409);
    expect((await get(f.member, `${base}/${f.id}`)).status).toBe(200);
  } else {
    expect(results[0].kind).toBe("deleted");
    expect(results[1].status).toBe(303);
    expect((await get(f.member, `${base}/${f.id}`)).status).toBe(410);
  }
  const created = (await workspace.create(f.member, {
    ...identity,
    variant: "work",
    operationId: randomUUID(),
  })) as LearningSaved;
  const same = randomUUID();
  const deleted = await Promise.all([
    remove(f.member, created.notebookId, same, 1),
    remove(f.member, created.notebookId, same, 1),
  ]);
  expect(deleted.map((result) => result.status)).toEqual([303, 303]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM learning_workspace_operations WHERE operation_id=$1",
        [same],
      )
    ).rows[0].count,
  ).toBe(1);
});
