import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { migrate, store, hash, type Learner } from "../../src/store.ts";
import type { MilestoneInput } from "../../src/milestones.ts";
import { careerStore } from "../../src/career.ts";
import {
  deterministicRegistry,
  type AdapterRegistry,
} from "../../src/adapters.ts";
import { enqueueAdapterJob, jobStore, runAdapterJob } from "../../src/jobs.ts";
import { authorizationStore, type StaffRole } from "../../src/authorization.ts";
import {
  evidenceStore,
  fileObjectStorage,
  type ObjectStorage,
} from "../../src/evidence.ts";
import { testPool } from "../support/database.ts";
import { trackStore } from "../../src/track-readiness.ts";
import { proposalStore } from "../../src/proposals.ts";
import {
  catalogStore,
  seedDraftPack,
  type DraftContent,
} from "../../src/catalog.ts";
const pool = testPool(),
  db = store(pool);
let privateStorageRoot = "";
const input = {
  instruction: "Use the provided sample to make a plan.",
  verification: "Compare the plan with the original details.",
  complete: true,
};
beforeAll(async () => {
  await migrate(pool);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
  privateStorageRoot = await mkdtemp(
    join(tmpdir(), "dne-evidence-integration-"),
  );
});
afterEach(async () => {
  await rm(privateStorageRoot, { recursive: true, force: true });
});
afterAll(async () => {
  await pool.end();
});
async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  expect(session.kind).toBe("active");
  return {
    token,
    learner: (session as { kind: "active"; learner: Learner }).learner,
  };
}
const contentDraft: DraftContent = {
  id: "SYN-001",
  version: 1,
  kind: "assignment",
  origin: "curated",
  title: "Synthetic review task",
  body: "Use only invented data.",
  owner: "Test editor",
  sources: "Original test brief",
  rights: "Owned synthetic work",
  goals: ["work", "build"],
  backgrounds: ["explorer", "professional", "technical"],
  domains: [],
  prerequisites: "None",
  rubric: "Check source and uncertainty.",
  rubricVersion: 1,
};
it("keeps optional career plans and draft approvals private, versioned and removable", async () => {
  const owner = await member();
  const outsider = await member();
  const career = careerStore(pool);
  const entry = {
    kind: "opportunity" as const,
    title: "Invented role exploration",
    note: "Only a sample scenario",
    nextAction: "Compare sample requirements",
    selfReportedOutcome: "I may explore this later",
  };
  const draft = {
    kind: "proposal" as const,
    title: "Invented proposal",
    body: "I would plan a private sample project with a small review step.",
  };
  expect(await career.snapshot(owner.learner.id)).toEqual({
    enabled: false,
    entries: [],
    drafts: [],
  });
  expect(await career.createEntry(owner.learner.id, entry)).toBe(false);
  expect(await career.createDraft(owner.learner.id, draft)).toBe(false);
  expect(await career.enable(owner.learner.id)).toBe(true);
  expect(await career.enable(owner.learner.id)).toBe(true);
  expect(await career.createEntry(owner.learner.id, entry)).toBe(true);
  expect(await career.createDraft(owner.learner.id, draft)).toBe(true);
  let own = await career.snapshot(owner.learner.id);
  expect(own).toMatchObject({
    enabled: true,
    entries: [{ ...entry, version: 1 }],
    drafts: [{ ...draft, approved: false, version: 1 }],
  });
  expect(await career.snapshot(outsider.learner.id)).toEqual({
    enabled: false,
    entries: [],
    drafts: [],
  });
  const entryId = own.entries[0]!.id;
  const draftId = own.drafts[0]!.id;
  expect(await career.updateEntry(outsider.learner.id, entryId, 1, entry)).toBe(
    false,
  );
  expect(await career.approveDraft(outsider.learner.id, draftId, 1)).toBe(
    false,
  );
  expect(await career.approveDraft(owner.learner.id, draftId, 1)).toBe(true);
  expect(await career.approveDraft(owner.learner.id, draftId, 1)).toBe(false);
  expect(await career.updateDraft(owner.learner.id, draftId, 1, draft)).toBe(
    false,
  );
  expect(
    await career.updateDraft(owner.learner.id, draftId, 2, {
      ...draft,
      body: "A revised invented proposal with fresh sample details only.",
    }),
  ).toBe(true);
  own = await career.snapshot(owner.learner.id);
  expect(own.drafts[0]).toMatchObject({ approved: false, version: 3 });
  expect(await career.revokeDraft(owner.learner.id, draftId, 3)).toBe(false);
  expect(await career.approveDraft(owner.learner.id, draftId, 3)).toBe(true);
  expect(await career.revokeDraft(owner.learner.id, draftId, 4)).toBe(true);
  expect(
    await career.updateEntry(owner.learner.id, entryId, 1, {
      ...entry,
      selfReportedOutcome: "An invented next step happened",
    }),
  ).toBe(true);
  expect(await career.deleteEntry(owner.learner.id, entryId, 1)).toBe(false);
  expect(await career.deleteEntry(owner.learner.id, entryId, 2)).toBe(true);
  expect(await career.deleteDraft(outsider.learner.id, draftId, 5)).toBe(false);
  expect(await career.deleteDraft(owner.learner.id, draftId, 5)).toBe(true);
  expect(
    await career.createEntry(owner.learner.id, { ...entry, kind: "contract" }),
  ).toBe(true);
  expect(
    await career.createDraft(owner.learner.id, { ...draft, kind: "renewal" }),
  ).toBe(true);
  expect(await career.disable(outsider.learner.id)).toBe(false);
  expect(await career.disable(owner.learner.id)).toBe(true);
  expect(await career.snapshot(owner.learner.id)).toEqual({
    enabled: false,
    entries: [],
    drafts: [],
  });
  expect(await career.enable(owner.learner.id)).toBe(true);
  expect(await career.snapshot(owner.learner.id)).toEqual({
    enabled: true,
    entries: [],
    drafts: [],
  });
  await db.remove(owner.learner.id);
  expect(await career.snapshot(owner.learner.id)).toEqual({
    enabled: false,
    entries: [],
    drafts: [],
  });
});
it("keeps goal milestones private, rejects stale edits and cascades on member deletion", async () => {
  const owner = await member();
  const outsider = await member();
  const input: MilestoneInput = {
    goalTitle: "Use AI for practical planning",
    milestoneTitle: "Compare two invented plans",
    evidenceNote: "I checked both plans against the original sample brief.",
    nextAction: "Revise the missing details",
    reminderDate: "2028-02-29",
    reminderTime: "14:30",
    reminderTimezone: "America/Toronto",
    selfReportedComplete: false,
  };
  const id = await db.createMilestone(owner.learner.id, input);
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(await db.milestones(outsider.learner.id)).toEqual([]);
  expect(await db.milestones(owner.learner.id)).toMatchObject([
    { id, ...input, version: 1 },
  ]);
  expect(await db.updateMilestone(outsider.learner.id, id!, 1, input)).toBe(
    false,
  );
  expect(
    await db.updateMilestone(owner.learner.id, id!, 1, {
      ...input,
      selfReportedComplete: true,
    }),
  ).toBe(true);
  expect(await db.updateMilestone(owner.learner.id, id!, 1, input)).toBe(false);
  expect(await db.deleteMilestone(outsider.learner.id, id!, 2)).toBe(false);
  expect(await db.deleteMilestone(owner.learner.id, id!, 1)).toBe(false);
  expect(await db.milestones(owner.learner.id)).toMatchObject([
    { id, version: 2, selfReportedComplete: true },
  ]);
  await expect(
    pool.query(
      "UPDATE learning_milestones SET reminder_time_zone=NULL WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow();
  await db.remove(owner.learner.id);
  expect(await db.milestones(owner.learner.id)).toEqual([]);
  expect(await db.deleteMilestone(owner.learner.id, id!, 2)).toBe(false);
});
it("stores a private pinned choice only for a currently published assignment and removes it with the member", async () => {
  const first = await member();
  const other = await member();
  const editorToken = randomBytes(32).toString("hex");
  const reviewerToken = randomBytes(32).toString("hex");
  const auth = authorizationStore(pool);
  await auth.provisionStaff(
    editorToken,
    "editor",
    new Date(Date.now() + 86_400_000),
  );
  await auth.provisionStaff(
    reviewerToken,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  const catalog = catalogStore(pool);
  const draft = {
    ...contentDraft,
    id: "SYN-935",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    minimumExperience: "new" as const,
  };
  expect(await db.chooseAssignment(first.learner.id, draft.id, 1)).toBe(false);
  expect(await catalog.createDraft(editorToken, draft)).toBe(true);
  await expect(
    pool.query(
      "UPDATE content_versions SET minimum_experience='unknown' WHERE id=$1",
      [draft.id],
    ),
  ).rejects.toThrow();
  expect(await db.chooseAssignment(first.learner.id, draft.id, 1)).toBe(false);
  expect(await catalog.submit(editorToken, draft.id, 1)).toBe(true);
  expect(await catalog.approve(reviewerToken, draft.id, 1, true)).toBe(true);
  expect(await catalog.publish(editorToken, draft.id, 1)).toBe(true);
  expect(await db.chooseAssignment(first.learner.id, draft.id, 1)).toBe(true);
  expect(await db.assignmentChoice(first.learner.id)).toEqual({
    contentId: draft.id,
    contentVersion: 1,
  });
  expect(await db.assignmentChoice(other.learner.id)).toBeNull();
  const second = { ...draft, version: 2, body: "Revised invented task." };
  expect(await catalog.createDraft(editorToken, second)).toBe(true);
  expect(await catalog.submit(editorToken, draft.id, 2)).toBe(true);
  expect(await catalog.approve(reviewerToken, draft.id, 2, true)).toBe(true);
  expect(await catalog.publish(editorToken, draft.id, 2)).toBe(true);
  expect(await db.chooseAssignment(first.learner.id, draft.id, 1)).toBe(false);
  expect(await db.chooseAssignment(first.learner.id, draft.id, 2)).toBe(true);
  expect(await catalog.retire(editorToken, draft.id)).toBe(true);
  expect(await db.chooseAssignment(first.learner.id, draft.id, 2)).toBe(false);
  expect(await db.assignmentChoice(first.learner.id)).toEqual({
    contentId: draft.id,
    contentVersion: 2,
  });
  await db.remove(first.learner.id);
  expect(await db.assignmentChoice(first.learner.id)).toBeNull();
});
it("keeps consented member samples private through moderation, withdrawal and deletion", async () => {
  const proposals = proposalStore(pool);
  const first = await member();
  const other = await member();
  const moderatorToken = randomBytes(32).toString("hex");
  const reviewerToken = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    moderatorToken,
    "moderator",
    new Date(Date.now() + 86_400_000),
  );
  await authorizationStore(pool).provisionStaff(
    reviewerToken,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  const input = {
    title: "Invented community event",
    body: "Twelve invented volunteers plan a two-hour event.",
    sources: "Original invented example; no external source",
  };
  expect(await proposals.createDraft(first.token, input, false)).toBeNull();
  expect(await proposals.createDraft(reviewerToken, input, true)).toBeNull();
  const id = await proposals.createDraft(first.token, input, true);
  expect(id).toEqual(expect.any(String));
  expect(await proposals.owned(other.token)).toEqual([]);
  expect(await proposals.preview(other.token, id!)).toBeNull();
  expect(await proposals.preview(first.token, id!)).toMatchObject({
    title: input.title,
    state: "draft",
  });
  expect(await proposals.submit(first.token, id!, false)).toBe(false);
  expect(await proposals.submit(other.token, id!, true)).toBe(false);
  expect(await proposals.submit(first.token, id!, true)).toBe(true);
  expect(await proposals.submit(first.token, id!, true)).toBe(false);
  expect(await proposals.moderationQueue(reviewerToken)).toBeNull();
  expect((await proposals.moderationQueue(moderatorToken))?.[0]).toMatchObject({
    id,
    state: "submitted",
  });
  expect(await proposals.moderate(reviewerToken, id!, "quarantine")).toBe(
    false,
  );
  expect(await proposals.moderate(moderatorToken, id!, "quarantine")).toBe(
    true,
  );
  expect(await proposals.withdraw(other.token, id!)).toBe(false);
  expect(await proposals.withdraw(first.token, id!)).toBe(true);
  expect(await proposals.moderate(moderatorToken, id!, "reject")).toBe(false);
  expect(await proposals.moderationQueue(moderatorToken)).toEqual([]);
  expect(await proposals.preview(first.token, id!)).toMatchObject({
    title: null,
    body: null,
    sources: null,
    state: "withdrawn",
  });
  const second = await proposals.createDraft(first.token, input, true);
  expect(await proposals.submit(first.token, second!, true)).toBe(true);
  expect(await proposals.moderate(moderatorToken, second!, "reject")).toBe(
    true,
  );
  expect(await proposals.preview(first.token, second!)).toMatchObject({
    state: "rejected",
    body: null,
  });
  const third = await proposals.createDraft(first.token, input, true);
  expect(await proposals.submit(first.token, third!, true)).toBe(true);
  expect(await proposals.moderate(moderatorToken, third!, "quarantine")).toBe(
    true,
  );
  expect(await proposals.moderate(moderatorToken, third!, "reject")).toBe(true);
  expect(await proposals.preview(first.token, third!)).toMatchObject({
    state: "rejected",
    body: null,
  });
  expect(await catalogStore(pool).search({ q: input.title })).toEqual([]);
  await db.remove(first.learner.id);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM member_proposals WHERE member_id=$1",
        [first.learner.id],
      )
    ).rows[0],
  ).toEqual({ n: 0 });
});
it("keeps the expert roster private and all live track states unprepared without qualified evidence", async () => {
  const tracks = trackStore(pool);
  const operatorToken = randomBytes(32).toString("hex");
  const reviewerToken = randomBytes(32).toString("hex");
  const operatorId = await authorizationStore(pool).provisionStaff(
    operatorToken,
    "operator",
    new Date(Date.now() + 86_400_000),
  );
  const reviewerId = await authorizationStore(pool).provisionStaff(
    reviewerToken,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  await seedDraftPack(pool);
  await pool.query(
    `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,
      starts_at,ends_at,loaded_cost_cents,capacity_minutes,qualification_ref)
     VALUES($1,$2,'reviewer','education','formal-review',
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '30 days',12000,120,'synthetic claim')`,
    [randomUUID(), reviewerId],
  );
  expect(await tracks.registry(reviewerToken)).toBeNull();
  const registry = await tracks.registry(operatorToken);
  expect(registry).toHaveLength(1);
  expect(registry?.[0]).toMatchObject({
    staffId: reviewerId,
    loadedCostCents: 12000,
    verifiedBy: null,
  });
  expect(
    (await tracks.snapshot()).foundation.every(
      (track) => track.state === "in preparation",
    ),
  ).toBe(true);
  expect(
    (await tracks.snapshot()).specialties.every(
      (track) => track.state === "in preparation",
    ),
  ).toBe(true);
  await expect(
    pool.query(
      `UPDATE expert_registry SET verified_by=$1,verified_at=CURRENT_TIMESTAMP`,
      [operatorId],
    ),
  ).rejects.toThrow();
  await expect(
    pool.query(
      `UPDATE expert_registry SET qualification_ref='sample qualification',
       agreement_ref='sample agreement',conflict_review_ref='sample conflict check',
       backup_staff_id=$2,verified_by=$1,verified_at=CURRENT_TIMESTAMP`,
      [operatorId, operatorId],
    ),
  ).rejects.toThrow();
  const adminToken = randomBytes(32).toString("hex");
  const adminId = await authorizationStore(pool).provisionStaff(
    adminToken,
    "platform_admin",
    new Date(Date.now() + 86_400_000),
  );
  await pool.query(
    `UPDATE expert_registry SET qualification_ref='synthetic qualification',
     agreement_ref='synthetic agreement',conflict_review_ref='synthetic check',
     backup_staff_id=$2,verified_by=$1,verified_at=CURRENT_TIMESTAMP`,
    [adminId, operatorId],
  );
  expect(
    (await tracks.snapshot()).specialties.every(
      (track) => track.state === "in preparation",
    ),
  ).toBe(true);
});
it("imports the six-lesson content pack as hidden drafts that cannot self-certify qualified sign-off", async () => {
  const catalog = catalogStore(pool);
  const editorToken = randomBytes(32).toString("hex");
  const reviewerToken = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    editorToken,
    "editor",
    new Date(Date.now() + 86_400_000),
  );
  await authorizationStore(pool).provisionStaff(
    reviewerToken,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  expect(await seedDraftPack(pool)).toBe(12);
  expect(await seedDraftPack(pool)).toBe(0);
  expect(await catalog.search({})).toEqual([]);
  expect(
    (await catalog.staffList(editorToken)).map((item) => item.id),
  ).toContain("FND-006");
  expect(await catalog.preview("unrelated", "FND-001", 1)).toBeNull();
  expect(await catalog.preview(editorToken, "FND-001", 1)).toMatchObject({
    state: "draft",
    requiresQualifiedSignoff: true,
    kind: "lesson",
    goals: ["everyday", "work", "build"],
  });
  expect(await catalog.submit(editorToken, "FND-001", 1)).toBe(true);
  expect(await catalog.approve(reviewerToken, "FND-001", 1, true)).toBe(false);
  expect(await catalog.publish(editorToken, "FND-001", 1)).toBe(false);
  expect(await catalog.published("FND-001")).toBeNull();
});
it("enforces review, rights, retirement and immutable version-pinned simulated assessment history", async () => {
  const catalog = catalogStore(pool);
  const auth = authorizationStore(pool);
  const editorToken = randomBytes(32).toString("hex");
  const reviewerToken = randomBytes(32).toString("hex");
  const adminToken = randomBytes(32).toString("hex");
  const editorId = await auth.provisionStaff(
    editorToken,
    "editor",
    new Date(Date.now() + 86_400_000),
  );
  const reviewerId = await auth.provisionStaff(
    reviewerToken,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  const adminId = await auth.provisionStaff(
    adminToken,
    "platform_admin",
    new Date(Date.now() + 86_400_000),
  );
  const person = await member();
  expect(await catalog.createDraft(person.token, contentDraft)).toBe(false);
  expect(
    await catalog.createDraft(editorToken, { ...contentDraft, rights: "" }),
  ).toBe(false);
  expect(
    await catalog.createDraft(editorToken, { ...contentDraft, version: 2 }),
  ).toBe(false);
  expect(await catalog.createDraft(editorToken, contentDraft)).toBe(true);
  expect(await catalog.createDraft(editorToken, contentDraft)).toBe(false);
  expect(await catalog.publish(editorToken, contentDraft.id, 1)).toBe(false);
  expect(await catalog.approve(reviewerToken, contentDraft.id, 1, true)).toBe(
    false,
  );
  expect(await catalog.submit(person.token, contentDraft.id, 1)).toBe(false);
  expect(await catalog.submit(editorToken, contentDraft.id, 1)).toBe(true);
  expect(await catalog.approve(reviewerToken, contentDraft.id, 1, false)).toBe(
    false,
  );
  expect(await catalog.approve(editorToken, contentDraft.id, 1, true)).toBe(
    false,
  );
  expect(await catalog.approve(reviewerToken, contentDraft.id, 1, true)).toBe(
    true,
  );
  expect(await catalog.publish(editorToken, contentDraft.id, 1)).toBe(true);
  expect(await catalog.search({ goal: "everyday" })).toEqual([]);
  expect(
    (
      await catalog.search({
        goal: "work",
        background: "professional",
        q: "review",
      })
    ).map((item) => item.version),
  ).toEqual([1]);
  expect(
    await catalog.assess(
      reviewerToken,
      person.learner.id,
      contentDraft.id,
      1,
      "Synthetic result",
    ),
  ).toBeNull();
  await auth.grantAssignment(
    adminId,
    reviewerId,
    person.learner.id,
    "reviewer",
    "synthetic task",
    new Date(Date.now() + 86_400_000),
  );
  const assessmentId = await catalog.assess(
    reviewerToken,
    person.learner.id,
    contentDraft.id,
    1,
    "Synthetic result",
  );
  expect(assessmentId).toEqual(expect.any(String));
  await expect(
    pool.query("UPDATE content_assessments SET result='changed' WHERE id=$1", [
      assessmentId,
    ]),
  ).rejects.toThrow("Assessment history is immutable");
  const next = {
    ...contentDraft,
    version: 2,
    body: "New synthetic brief",
    rubric: "Revised source check.",
    rubricVersion: 2,
  };
  expect(await catalog.createDraft(editorToken, next)).toBe(true);
  expect(await catalog.submit(editorToken, next.id, 2)).toBe(true);
  expect(await catalog.approve(reviewerToken, next.id, 2, true)).toBe(true);
  expect(await catalog.publish(editorToken, next.id, 2)).toBe(true);
  expect((await catalog.published(next.id))?.version).toBe(2);
  const pinned = (
    await pool.query(
      "SELECT content_version,rubric_version,result FROM content_assessments WHERE id=$1",
      [assessmentId],
    )
  ).rows[0];
  expect(pinned).toEqual({
    content_version: 1,
    rubric_version: 1,
    result: "Synthetic result",
  });
  await expect(
    pool.query(
      "UPDATE content_versions SET title='rewritten' WHERE id=$1 AND version=1",
      [next.id],
    ),
  ).rejects.toThrow("Released content is immutable");
  await expect(
    pool.query(
      "UPDATE content_versions SET retired_at=CURRENT_TIMESTAMP WHERE id=$1 AND version=1",
      [next.id],
    ),
  ).rejects.toThrow("Released content has an invalid retirement");
  expect(await catalog.retire(editorToken, next.id)).toBe(true);
  expect(await catalog.published(next.id)).toBeNull();
  expect(await catalog.search({ q: "review" })).toEqual([]);
  expect(await catalog.createDraft(editorToken, { ...next, version: 3 })).toBe(
    false,
  );
  await db.remove(person.learner.id);
  expect(
    (
      await pool.query("SELECT count(*) FROM content_assessments WHERE id=$1", [
        assessmentId,
      ])
    ).rows[0].count,
  ).toBe("0");
  expect(editorId).toEqual(expect.any(String));
});
it("preserves private synthetic lesson activity across goal changes, versions and retirement", async () => {
  const owner = await member(),
    outsider = await member();
  const catalog = catalogStore(pool),
    auth = authorizationStore(pool);
  const editorToken = randomBytes(32).toString("hex");
  const reviewerToken = randomBytes(32).toString("hex");
  await auth.provisionStaff(
    editorToken,
    "editor",
    new Date(Date.now() + 86_400_000),
  );
  await auth.provisionStaff(
    reviewerToken,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  const draft = {
    ...contentDraft,
    id: "SYN-102",
    kind: "lesson" as const,
    title: "Invented reading sample",
    goals: ["everyday", "work"],
    rubric: null,
    rubricVersion: null,
  };
  const publish = async (version: number) => {
    expect(await catalog.createDraft(editorToken, { ...draft, version })).toBe(
      true,
    );
    expect(await catalog.submit(editorToken, draft.id, version)).toBe(true);
    expect(await catalog.approve(reviewerToken, draft.id, version, true)).toBe(
      true,
    );
    expect(await catalog.publish(editorToken, draft.id, version)).toBe(true);
  };
  await publish(1);
  expect(await db.openLesson(owner.learner.id, draft.id, 1)).toBe(true);
  const opened = (await db.lessonActivities(owner.learner.id))[0]!;
  expect(opened).toMatchObject({
    contentId: draft.id,
    contentVersion: 1,
    startedAt: null,
    selfAssessedAt: null,
    available: true,
  });
  expect(await db.lessonActivities(outsider.learner.id)).toEqual([]);
  expect(
    await db.advanceLesson(outsider.learner.id, draft.id, 1, "start"),
  ).toBe(false);
  expect(
    await db.advanceLesson(owner.learner.id, draft.id, 1, "complete"),
  ).toBe(false);
  expect(await db.advanceLesson(owner.learner.id, draft.id, 1, "start")).toBe(
    true,
  );
  expect(
    await db.advanceLesson(owner.learner.id, draft.id, 1, "complete"),
  ).toBe(true);
  expect(await db.openLesson(owner.learner.id, draft.id, 1)).toBe(true);
  expect((await db.lessonActivities(owner.learner.id))[0]!.openedAt).toEqual(
    opened.openedAt,
  );
  await pool.query("UPDATE learners SET goal='work' WHERE id=$1", [
    owner.learner.id,
  ]);
  expect(
    (await db.lessonActivities(owner.learner.id))[0]!.selfAssessedAt,
  ).toBeInstanceOf(Date);
  await publish(2);
  expect((await db.lessonActivities(owner.learner.id))[0]!.available).toBe(
    false,
  );
  expect(await db.openLesson(owner.learner.id, draft.id, 1)).toBe(false);
  expect(await db.advanceLesson(owner.learner.id, draft.id, 1, "start")).toBe(
    false,
  );
  expect(await db.openLesson(owner.learner.id, draft.id, 2)).toBe(true);
  expect(
    (await db.lessonActivities(owner.learner.id)).map(
      ({ contentVersion }) => contentVersion,
    ),
  ).toEqual([2, 1]);
  expect(await catalog.retire(editorToken, draft.id)).toBe(true);
  expect(
    (await db.lessonActivities(owner.learner.id)).every(
      ({ available }) => !available,
    ),
  ).toBe(true);
  await db.remove(owner.learner.id);
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM lesson_activity WHERE member_id=$1",
        [owner.learner.id],
      )
    ).rows[0].count,
  ).toBe("0");
});

function wrappedPool(wrap: (client: PoolClient) => PoolClient) {
  return {
    query: pool.query.bind(pool),
    connect: async () => wrap(await pool.connect()),
  } as unknown as Pool;
}

async function blockingPids(queryFragment: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = (
      await pool.query<{ blockers: number[] }>(
        `SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
         WHERE datname=current_database() AND state='active'
           AND wait_event_type='Lock' AND position($1 in query)>0
         LIMIT 1`,
        [queryFragment],
      )
    ).rows[0];
    if (row?.blockers.length) return row.blockers;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return [];
}
it("backfills and safely reruns authorization migration over populated learning data", async () => {
  const schema = `migration_${randomBytes(8).toString("hex")}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const initial = await readFile(
        new URL("../../migrations/001-learning.sql", import.meta.url),
        "utf8",
      ),
      authorization = await readFile(
        new URL(
          "../../migrations/003-workspace-authorization.sql",
          import.meta.url,
        ),
        "utf8",
      ),
      learnerProfile = await readFile(
        new URL("../../migrations/005-learner-profile.sql", import.meta.url),
        "utf8",
      ),
      learnerPlan = await readFile(
        new URL("../../migrations/009-learning-plan.sql", import.meta.url),
        "utf8",
      ),
      activeId = randomUUID(),
      expiredId = randomUUID(),
      activeToken = randomBytes(32).toString("hex"),
      expiredToken = randomBytes(32).toString("hex");
    await client.query(initial);
    await client.query(
      `INSERT INTO learners(id,token_hash,background,goal,expires_at)
       VALUES($1,$2,'explorer','everyday',CURRENT_TIMESTAMP+INTERVAL '1 day'),
             ($3,$4,'professional','work',CURRENT_TIMESTAMP-INTERVAL '1 day')`,
      [activeId, hash(activeToken), expiredId, hash(expiredToken)],
    );
    await client.query(
      `INSERT INTO exercises(
         learner_id,lesson_id,lesson_version,instruction,verification,completed_at
       ) VALUES
         ($1,'clear-instructions',1,'Completed work','Verified',CURRENT_TIMESTAMP),
         ($2,'clear-instructions',1,'Saved draft','Pending',NULL)`,
      [activeId, expiredId],
    );
    await client.query(authorization);
    await client.query(authorization);
    await client.query(learnerProfile);
    await client.query(learnerProfile);
    await client.query(learnerPlan);
    await client.query(learnerPlan);
    const migrated = store(client as unknown as Pool);
    await expect(migrated.session(activeToken)).resolves.toMatchObject({
      kind: "active",
      learner: { id: activeId },
    });
    await expect(migrated.session(expiredToken)).resolves.toEqual({
      kind: "expired",
    });
    await expect(migrated.progress(activeId)).resolves.toMatchObject({
      instruction: "Completed work",
      completed_at: expect.any(Date),
    });
    expect(
      (
        await client.query(
          "SELECT count(*) FROM exercises WHERE workspace_id=learner_id",
        )
      ).rows[0].count,
    ).toBe("2");
    expect(
      (await client.query("SELECT count(*) FROM workspaces")).rows[0].count,
    ).toBe("2");
    await client.query(
      "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
      [activeId],
    );
    await expect(migrated.session(activeToken)).resolves.toEqual({
      kind: "expired",
    });
  } finally {
    await client.query("RESET search_path");
    client.release();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
});
it("persists drafts and completions across independent database connections and migrations", async () => {
  const { learner, token } = await member();
  await db.save(learner.id, { ...input, complete: false });
  const reopened = testPool();
  try {
    expect(await store(reopened).progress(learner.id)).toMatchObject({
      instruction: input.instruction,
      completed_at: null,
    });
    await db.save(learner.id, input);
    expect(
      (await store(reopened).progress(learner.id))?.completed_at,
    ).toBeInstanceOf(Date);
    expect(
      (await pool.query("SELECT token_hash FROM principals")).rows[0]
        .token_hash,
    ).toBe(hash(token));
    await migrate(pool);
    expect((await db.progress(learner.id))?.instruction).toBe(
      input.instruction,
    );
  } finally {
    await reopened.end();
  }
});
it("keeps each member's weekly plan preferences private and preserves saved practice after a goal change", async () => {
  const token = randomBytes(32).toString("hex");
  await db.create(token, {
    background: "explorer",
    goal: "everyday",
    experience: "new",
    timezone: "UTC",
    weeklyMinutes: 15,
  });
  const first = await db.session(token);
  expect(first.kind).toBe("active");
  const id = (first as { kind: "active"; learner: Learner }).learner.id;
  expect(first).toMatchObject({
    learner: { timezone: "UTC", weeklyMinutes: 15 },
  });
  await db.save(id, { ...input, complete: false });
  const other = await member();
  expect(other.learner).toMatchObject({
    timezone: null,
    weeklyMinutes: null,
  });
  await db.updateProfile(id, {
    background: "explorer",
    goal: "work",
    backgroundTags: [],
    domainTags: [],
    itRoles: [],
    experience: "some",
    exploratory: true,
    timezone: "America/Toronto",
    weeklyMinutes: 60,
  });
  expect(await db.session(token)).toMatchObject({
    learner: {
      goal: "work",
      experience: "some",
      timezone: "America/Toronto",
      weeklyMinutes: 60,
    },
  });
  expect(await db.progress(id)).toMatchObject({ goal_at_start: "everyday" });
  await expect(
    pool.query("UPDATE learners SET weekly_minutes=31 WHERE id=$1", [id]),
  ).rejects.toThrow();
  expect(await db.session(other.token)).toMatchObject({
    learner: { timezone: null, weeklyMinutes: null },
  });
  await db.remove(id);
  expect(await db.session(token)).toEqual({ kind: "new" });
});
it("makes duplicate onboarding and simultaneous completion idempotent without cross-member writes", async () => {
  const { learner, token } = await member();
  await Promise.all([
    db.create(token, { background: "technical", goal: "build" }),
    db.create(token, { background: "professional", goal: "work" }),
  ]);
  expect(
    (await pool.query("SELECT count(*) FROM learners")).rows[0].count,
  ).toBe("1");
  const alternative = {
    instruction: "Alternative useful instruction with details.",
    verification: "Alternative way of checking the result.",
    complete: true,
  };
  await Promise.all([
    db.save(learner.id, input),
    db.save(learner.id, alternative),
  ]);
  const saved = await db.progress(learner.id);
  expect([input.instruction, alternative.instruction]).toContain(
    saved?.instruction,
  );
  expect(saved?.verification).toBe(
    saved?.instruction === input.instruction
      ? input.verification
      : alternative.verification,
  );
  await db.save(learner.id, { ...alternative, complete: false });
  await db.save(learner.id, alternative);
  expect(await db.progress(learner.id)).toEqual(saved);
  expect(
    (await pool.query("SELECT count(*) FROM exercises")).rows[0].count,
  ).toBe("1");
  const other = await member();
  expect(await db.progress(other.learner.id)).toBeUndefined();
});
it("keeps concurrent draft/completion coherent and complete", async () => {
  const { learner } = await member();
  await Promise.all([
    db.save(learner.id, {
      instruction: "unfinished",
      verification: "draft",
      complete: false,
    }),
    db.save(learner.id, input),
  ]);
  expect(await db.progress(learner.id)).toMatchObject({
    instruction: input.instruction,
    verification: input.verification,
    completed_at: expect.any(Date),
  });
});
it("enforces expiry and deletion including cascaded exercise records", async () => {
  const { learner, token } = await member();
  await db.save(learner.id, input);
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP WHERE id=$1",
    [learner.id],
  );
  expect(await db.session(token)).toEqual({ kind: "expired" });
  await db.remove(learner.id);
  expect(await db.session(token)).toEqual({ kind: "new" });
  expect(
    (await pool.query("SELECT count(*) FROM exercises")).rows[0].count,
  ).toBe("0");
});

async function staff(role: StaffRole) {
  const credential = randomBytes(32).toString("hex");
  return {
    token: credential,
    id: await authorizationStore(pool).provisionStaff(
      credential,
      role,
      new Date(Date.now() + 86_400_000),
    ),
  };
}

it("keeps evidence private through consent, quarantine and review eligibility", async () => {
  const owner = await member(),
    outsider = await member(),
    evidence = evidenceStore(
      pool,
      fileObjectStorage(privateStorageRoot),
      "integration-secret",
    );
  await pool.query("INSERT INTO cohorts(id) VALUES('group-a'),('group-b')");
  await pool.query(
    `INSERT INTO cohort_memberships(cohort_id,member_id,can_read_shared_content)
     VALUES('group-a',$1,true)`,
    [owner.learner.id],
  );
  const created = await evidence.upload(owner.token, {
    name: "sample.txt",
    mediaType: "text/plain",
    data: Buffer.from("Synthetic private evidence"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: true,
      learningCircleId: "group-a",
    },
  });
  expect(created).toMatchObject({ kind: "created", state: "pending" });
  if (created.kind !== "created") throw new Error("evidence not created");
  const row = (
    await pool.query(
      `SELECT original_name,media_type,byte_size,sha256,storage_key,
              quarantine_state,private_review_allowed,
              community_publication_allowed,learning_circle_id
       FROM evidence_objects WHERE id=$1`,
      [created.id],
    )
  ).rows[0];
  expect(row).toMatchObject({
    original_name: "sample.txt",
    media_type: "text/plain",
    byte_size: 26,
    quarantine_state: "pending",
    private_review_allowed: true,
    community_publication_allowed: true,
    learning_circle_id: "group-a",
  });
  expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (await stat(join(privateStorageRoot, row.storage_key))).mode & 0o077,
  ).toBe(0);
  expect(await evidence.submitForReview(owner.token, created.id)).toBe(false);
  await expect(
    evidence.destinationAllowed(created.id, "private-review"),
  ).resolves.toBe(false);
  expect(await evidence.transitionQuarantine(created.id, "clean")).toBe(true);
  expect(await evidence.transitionQuarantine(created.id, "infected")).toBe(
    false,
  );
  expect(await evidence.submitForReview(owner.token, created.id)).toBe(true);
  await expect(
    evidence.destinationAllowed(created.id, "private-review"),
  ).resolves.toBe(true);
  await expect(
    evidence.destinationAllowed(created.id, "community-publication"),
  ).resolves.toBe(true);
  await expect(
    evidence.destinationAllowed(created.id, "learning-circle:group-a"),
  ).resolves.toBe(true);
  await expect(
    evidence.destinationAllowed(created.id, "learning-circle:group-b"),
  ).resolves.toBe(false);
  await evidence.addDerivative(
    created.id,
    "text-extract",
    Buffer.from("derived synthetic text"),
  );
  await expect(
    evidence.upload(outsider.token, {
      name: "outside.txt",
      mediaType: "text/plain",
      data: Buffer.from("Outsider synthetic evidence"),
      consent: {
        rightsConfirmed: true,
        privateReview: false,
        communityPublication: false,
        learningCircleId: "group-a",
      },
    }),
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    evidence.upload(owner.token, {
      name: "unsafe.html",
      mediaType: "text/html",
      data: Buffer.from("<script>never run</script>"),
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    }),
  ).resolves.toEqual({ kind: "invalid" });
  expect(
    (await pool.query("SELECT count(*) FROM evidence_objects")).rows[0].count,
  ).toBe("1");
  expect((await readdir(privateStorageRoot)).length).toBe(2);
});

it("rechecks authorization and quarantine for every short-lived evidence download", async () => {
  let now = 1_800_000_000_000;
  const owner = await member(),
    circleMember = await member(),
    outsider = await member(),
    admin = await staff("platform_admin"),
    reviewer = await staff("reviewer"),
    editor = await staff("editor"),
    access = authorizationStore(pool),
    evidence = evidenceStore(
      pool,
      fileObjectStorage(privateStorageRoot),
      "integration-secret",
      () => now,
    );
  await pool.query("INSERT INTO cohorts(id) VALUES('group-a')");
  await pool.query(
    `INSERT INTO cohort_memberships(cohort_id,member_id,can_read_shared_content)
     VALUES('group-a',$1,true),('group-a',$2,true)`,
    [owner.learner.id, circleMember.learner.id],
  );
  const created = await evidence.upload(owner.token, {
    name: "review.pdf",
    mediaType: "application/pdf",
    data: Buffer.from("%PDF-synthetic-private"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
      learningCircleId: "group-a",
    },
  });
  if (created.kind !== "created") throw new Error("evidence not created");
  await evidence.transitionQuarantine(created.id, "clean");
  const ownerLink = await evidence.issueDownload(owner.token, created.id);
  if (ownerLink.kind !== "issued") throw new Error("link not issued");
  await expect(
    evidence.download(owner.token, created.id, ownerLink.capability),
  ).resolves.toMatchObject({
    kind: "allowed",
    name: "review.pdf",
    mediaType: "application/pdf",
  });
  await expect(
    evidence.issueDownload(outsider.token, created.id),
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    evidence.issueDownload(editor.token, created.id),
  ).resolves.toEqual({ kind: "denied" });
  const reviewerGrant = await access.grantAssignment(
    admin.id,
    reviewer.id,
    owner.learner.id,
    "reviewer",
    "review synthetic evidence",
    new Date(Date.now() + 60_000),
  );
  const reviewerLink = await evidence.issueDownload(reviewer.token, created.id);
  expect(reviewerLink.kind).toBe("issued");
  if (reviewerLink.kind !== "issued") throw new Error("link not issued");
  expect(await access.revokeAssignment(admin.id, reviewerGrant)).toBe(true);
  await expect(
    evidence.download(reviewer.token, created.id, reviewerLink.capability),
  ).resolves.toEqual({ kind: "denied" });
  const circleLink = await evidence.issueDownload(
    circleMember.token,
    created.id,
  );
  expect(circleLink.kind).toBe("issued");
  if (circleLink.kind !== "issued") throw new Error("link not issued");
  await pool.query(
    "UPDATE cohort_memberships SET revoked_at=CURRENT_TIMESTAMP WHERE cohort_id='group-a' AND member_id=$1",
    [circleMember.learner.id],
  );
  await expect(
    evidence.download(circleMember.token, created.id, circleLink.capability),
  ).resolves.toEqual({ kind: "denied" });
  now += 300_001;
  await expect(
    evidence.download(owner.token, created.id, ownerLink.capability),
  ).resolves.toEqual({ kind: "denied" });
  await pool.query(
    "UPDATE evidence_objects SET quarantine_state='infected' WHERE id=$1",
    [created.id],
  );
  await expect(
    evidence.issueDownload(owner.token, created.id),
  ).resolves.toEqual({ kind: "denied" });
});

it("deletes stored evidence, review state and derived objects through explicit hooks", async () => {
  const owner = await member(),
    other = await member(),
    evidence = evidenceStore(
      pool,
      fileObjectStorage(privateStorageRoot),
      "integration-secret",
    ),
    upload = async (name: string) => {
      const created = await evidence.upload(owner.token, {
        name,
        mediaType: "text/plain",
        data: Buffer.from(`Synthetic evidence for ${name}`),
        consent: {
          rightsConfirmed: true,
          privateReview: true,
          communityPublication: false,
        },
      });
      if (created.kind !== "created") throw new Error("evidence not created");
      await evidence.transitionQuarantine(created.id, "clean");
      return created.id;
    };
  const first = await upload("first.txt");
  await evidence.submitForReview(owner.token, first);
  await evidence.addDerivative(first, "thumbnail", Buffer.from("thumbnail"));
  await expect(evidence.remove(other.token, first)).resolves.toBe(false);
  await expect(evidence.remove(owner.token, first)).resolves.toBe(true);
  expect(
    (await pool.query("SELECT count(*) FROM evidence_objects")).rows[0].count,
  ).toBe("0");
  expect(
    (await pool.query("SELECT count(*) FROM evidence_review_submissions"))
      .rows[0].count,
  ).toBe("0");
  expect((await readdir(privateStorageRoot)).length).toBe(0);
  await upload("second.txt");
  await upload("third.txt");
  await evidence.removeWorkspace(owner.token);
  await db.remove(owner.learner.id);
  expect((await readdir(privateStorageRoot)).length).toBe(0);
  expect(
    (await pool.query("SELECT count(*) FROM evidence_objects")).rows[0].count,
  ).toBe("0");
});

it("serializes derivative creation with evidence deletion and removes every object", async () => {
  const owner = await member(),
    files = fileObjectStorage(privateStorageRoot),
    setup = evidenceStore(pool, files, "integration-secret"),
    created = await setup.upload(owner.token, {
      name: "race.txt",
      mediaType: "text/plain",
      data: Buffer.from("Synthetic source"),
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    });
  if (created.kind !== "created") throw new Error("evidence not created");
  await setup.transitionQuarantine(created.id, "clean");

  let releaseWrite!: () => void,
    enteredWrite!: () => void,
    lockerPid = 0;
  const entered = new Promise<void>((resolve) => (enteredWrite = resolve));
  const gate = new Promise<void>((resolve) => (releaseWrite = resolve));
  const blockedFiles: ObjectStorage = {
    ...files,
    async put(key, data) {
      if (data.toString() === "blocked derivative") {
        enteredWrite();
        await gate;
      }
      await files.put(key, data);
    },
  };
  const tracked = wrappedPool((client) => {
    const query = client.query.bind(client);
    return {
      query: (async (statement: string, values?: unknown[]) => {
        if (statement.startsWith("BEGIN") && lockerPid === 0) {
          lockerPid = (
            await query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]!.pid;
        }
        return query(statement, values);
      }) as PoolClient["query"],
      release: client.release.bind(client),
    } as PoolClient;
  });
  const evidence = evidenceStore(tracked, blockedFiles, "integration-secret");
  const derivative = evidence.addDerivative(
    created.id,
    "thumbnail",
    Buffer.from("blocked derivative"),
  );
  await entered;
  const removal = evidence.remove(owner.token, created.id);
  const blockers = await blockingPids(
    "UPDATE evidence_objects e SET quarantine_state='deleting'",
  );
  releaseWrite();
  expect(blockers).toContain(lockerPid);
  await derivative;
  await expect(removal).resolves.toBe(true);
  expect((await readdir(privateStorageRoot)).length).toBe(0);
  expect(
    (await pool.query("SELECT count(*) FROM evidence_objects")).rows[0].count,
  ).toBe("0");
});

it("serializes uploads with workspace deletion and rejects later uploads", async () => {
  const owner = await member(),
    files = fileObjectStorage(privateStorageRoot);
  let releaseWrite!: () => void,
    enteredWrite!: () => void,
    lockerPid = 0;
  const entered = new Promise<void>((resolve) => (enteredWrite = resolve));
  const gate = new Promise<void>((resolve) => (releaseWrite = resolve));
  const blockedFiles: ObjectStorage = {
    ...files,
    async put(key, data) {
      enteredWrite();
      await gate;
      await files.put(key, data);
    },
  };
  const tracked = wrappedPool((client) => {
    const query = client.query.bind(client);
    return {
      query: (async (statement: string, values?: unknown[]) => {
        if (statement.startsWith("BEGIN") && lockerPid === 0) {
          lockerPid = (
            await query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]!.pid;
        }
        return query(statement, values);
      }) as PoolClient["query"],
      release: client.release.bind(client),
    } as PoolClient;
  });
  const evidence = evidenceStore(tracked, blockedFiles, "integration-secret");
  const upload = evidence.upload(owner.token, {
    name: "concurrent.txt",
    mediaType: "text/plain",
    data: Buffer.from("Synthetic concurrent upload"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  await entered;
  const cleanup = evidence.removeWorkspace(owner.token);
  const blockers = await blockingPids("SELECT w.id FROM workspaces w");
  releaseWrite();
  expect(blockers).toContain(lockerPid);
  await expect(upload).resolves.toMatchObject({ kind: "created" });
  await cleanup;
  await expect(
    evidence.upload(owner.token, {
      name: "too-late.txt",
      mediaType: "text/plain",
      data: Buffer.from("Synthetic late upload"),
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    }),
  ).resolves.toEqual({ kind: "denied" });
  expect((await readdir(privateStorageRoot)).length).toBe(0);
  expect(
    (await pool.query("SELECT count(*) FROM evidence_objects")).rows[0].count,
  ).toBe("0");
});

it("rolls back acknowledged inserts and reconciles acknowledged commits", async () => {
  const owner = await member(),
    files = fileObjectStorage(privateStorageRoot),
    uploadInput = {
      name: "acknowledgement.txt",
      mediaType: "text/plain",
      data: Buffer.from("Synthetic acknowledgement evidence"),
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    } as const;
  let insertThrown = false;
  const insertFailure = wrappedPool((client) => {
    const query = client.query.bind(client);
    return {
      query: (async (statement: string, values?: unknown[]) => {
        const result = await query(statement, values);
        if (
          !insertThrown &&
          statement.includes("INSERT INTO evidence_objects")
        ) {
          insertThrown = true;
          throw new Error("insert acknowledgement lost");
        }
        return result;
      }) as PoolClient["query"],
      release: client.release.bind(client),
    } as PoolClient;
  });
  await expect(
    evidenceStore(insertFailure, files, "integration-secret").upload(
      owner.token,
      uploadInput,
    ),
  ).rejects.toThrow("insert acknowledgement lost");
  expect(
    (await pool.query("SELECT count(*) FROM evidence_objects")).rows[0].count,
  ).toBe("0");
  expect((await readdir(privateStorageRoot)).length).toBe(0);

  let commitThrown = false;
  const commitFailure = wrappedPool((client) => {
    const query = client.query.bind(client);
    return {
      query: (async (statement: string, values?: unknown[]) => {
        const result = await query(statement, values);
        if (!commitThrown && statement === "COMMIT") {
          commitThrown = true;
          throw new Error("commit acknowledgement lost");
        }
        return result;
      }) as PoolClient["query"],
      release: client.release.bind(client),
    } as PoolClient;
  });
  await expect(
    evidenceStore(commitFailure, files, "integration-secret").upload(
      owner.token,
      uploadInput,
    ),
  ).resolves.toMatchObject({ kind: "created", state: "pending" });
  expect(
    (await pool.query("SELECT count(*) FROM evidence_objects")).rows[0].count,
  ).toBe("1");
  expect((await readdir(privateStorageRoot)).length).toBe(1);
});

it("derives private workspace ownership and rejects cross-workspace references", async () => {
  const first = await member(),
    second = await member(),
    access = authorizationStore(pool);
  await db.save(first.learner.id, input);
  await expect(
    access.readWorkspace(first.token, first.learner.id),
  ).resolves.toMatchObject({
    kind: "allowed",
    via: "member",
    records: [{ instruction: input.instruction }],
  });
  await expect(
    access.readWorkspace(second.token, first.learner.id),
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    pool.query(
      `INSERT INTO exercises(
         learner_id,workspace_id,lesson_id,lesson_version,instruction,verification
       ) VALUES($1,$2,'cross-workspace',1,'private','check')`,
      [first.learner.id, second.learner.id],
    ),
  ).rejects.toMatchObject({ code: "23503" });
});

it("enforces assignment roles, expiry and revocation without role self-escalation", async () => {
  const owner = await member(),
    other = await member(),
    admin = await staff("platform_admin"),
    coach = await staff("coach"),
    reviewer = await staff("reviewer"),
    editor = await staff("editor"),
    moderator = await staff("moderator"),
    access = authorizationStore(pool),
    future = new Date(Date.now() + 60_000);
  await db.save(owner.learner.id, input);
  const coachGrant = await access.grantAssignment(
    admin.id,
    coach.id,
    owner.learner.id,
    "coach",
    "lesson coaching",
    future,
  );
  await access.grantAssignment(
    admin.id,
    reviewer.id,
    owner.learner.id,
    "reviewer",
    "lesson review",
    future,
  );
  await expect(
    access.readWorkspace(coach.token, owner.learner.id),
  ).resolves.toMatchObject({ kind: "allowed", via: "assignment" });
  await expect(
    access.readWorkspace(reviewer.token, owner.learner.id),
  ).resolves.toMatchObject({ kind: "allowed", via: "assignment" });
  await pool.query(
    `UPDATE assignment_grants
     SET starts_at=CURRENT_TIMESTAMP+INTERVAL '1 hour',
         expires_at=CURRENT_TIMESTAMP+INTERVAL '2 hours'
     WHERE staff_id=$1`,
    [reviewer.id],
  );
  await expect(
    access.readWorkspace(reviewer.token, owner.learner.id),
  ).resolves.toEqual({ kind: "denied" });
  await pool.query(
    `UPDATE assignment_grants
     SET starts_at=CURRENT_TIMESTAMP-INTERVAL '1 hour',
         expires_at=CURRENT_TIMESTAMP+INTERVAL '1 hour'
     WHERE staff_id=$1`,
    [reviewer.id],
  );
  for (const denied of [
    editor.token,
    moderator.token,
    admin.token,
    other.token,
  ])
    await expect(
      access.readWorkspace(denied, owner.learner.id),
    ).resolves.toEqual({ kind: "denied" });
  await pool.query(
    `UPDATE assignment_grants
     SET starts_at=CURRENT_TIMESTAMP-INTERVAL '2 hours',
         expires_at=CURRENT_TIMESTAMP-INTERVAL '1 hour'
     WHERE id=$1`,
    [coachGrant],
  );
  await expect(
    access.readWorkspace(coach.token, owner.learner.id),
  ).resolves.toEqual({ kind: "denied" });
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [reviewer.id],
  );
  await expect(
    access.readWorkspace(reviewer.token, owner.learner.id),
  ).resolves.toEqual({ kind: "denied" });
  const replacement = await access.grantAssignment(
    admin.id,
    coach.id,
    owner.learner.id,
    "coach",
    "replacement coaching",
    future,
  );
  expect(await access.revokeAssignment(admin.id, replacement)).toBe(true);
  expect(await access.revokeAssignment(admin.id, replacement)).toBe(false);
  await expect(
    access.readWorkspace(coach.token, owner.learner.id),
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    access.grantAssignment(
      owner.learner.id,
      coach.id,
      owner.learner.id,
      "coach",
      "self grant",
      future,
    ),
  ).rejects.toThrow("denied");
  await pool.query(
    "UPDATE learners SET background='technical',goal='build' WHERE id=$1",
    [owner.learner.id],
  );
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM staff_profiles WHERE principal_id=$1",
        [owner.learner.id],
      )
    ).rows[0].count,
  ).toBe("0");
});

it("requires purpose-bound support access and records every privileged read", async () => {
  const owner = await member(),
    admin = await staff("platform_admin"),
    operator = await staff("operator"),
    access = authorizationStore(pool),
    future = new Date(Date.now() + 60_000);
  await db.save(owner.learner.id, input);
  const supportGrant = await access.grantSupport(
    admin.id,
    operator.id,
    owner.learner.id,
    "operator",
    "resolve case 42",
    future,
  );
  await pool.query(
    `UPDATE support_access_grants
     SET starts_at=CURRENT_TIMESTAMP+INTERVAL '1 hour',
         expires_at=CURRENT_TIMESTAMP+INTERVAL '2 hours'
     WHERE id=$1`,
    [supportGrant],
  );
  await expect(
    access.readWorkspace(operator.token, owner.learner.id, "resolve case 42"),
  ).resolves.toEqual({ kind: "denied" });
  await pool.query(
    `UPDATE support_access_grants
     SET starts_at=CURRENT_TIMESTAMP-INTERVAL '1 hour',
         expires_at=CURRENT_TIMESTAMP+INTERVAL '1 hour'
     WHERE id=$1`,
    [supportGrant],
  );
  await expect(
    access.readWorkspace(operator.token, owner.learner.id),
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    access.readWorkspace(operator.token, owner.learner.id, "wrong purpose"),
  ).resolves.toEqual({ kind: "denied" });
  for (let read = 0; read < 2; read += 1)
    await expect(
      access.readWorkspace(operator.token, owner.learner.id, "resolve case 42"),
    ).resolves.toMatchObject({
      kind: "allowed",
      via: "support",
      purpose: "resolve case 42",
    });
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM authorization_audit WHERE support_access_id=$1 AND purpose=$2",
        [supportGrant, "resolve case 42"],
      )
    ).rows[0].count,
  ).toBe("2");
  await pool.query(
    `UPDATE support_access_grants
     SET starts_at=CURRENT_TIMESTAMP-INTERVAL '2 hours',
         expires_at=CURRENT_TIMESTAMP-INTERVAL '1 hour'
     WHERE id=$1`,
    [supportGrant],
  );
  await expect(
    access.readWorkspace(operator.token, owner.learner.id, "resolve case 42"),
  ).resolves.toEqual({ kind: "denied" });
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM authorization_audit WHERE support_access_id=$1",
        [supportGrant],
      )
    ).rows[0].count,
  ).toBe("2");
  await pool.query(
    `UPDATE support_access_grants
     SET starts_at=CURRENT_TIMESTAMP-INTERVAL '1 hour',
         expires_at=CURRENT_TIMESTAMP+INTERVAL '1 hour'
     WHERE id=$1`,
    [supportGrant],
  );
  await expect(
    access.readWorkspace(operator.token, owner.learner.id, "resolve case 42"),
  ).resolves.toMatchObject({ kind: "allowed", via: "support" });
  expect(await access.revokeSupport(admin.id, supportGrant)).toBe(true);
  await expect(
    access.readWorkspace(operator.token, owner.learner.id, "resolve case 42"),
  ).resolves.toEqual({ kind: "denied" });
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM authorization_audit WHERE support_access_id=$1",
        [supportGrant],
      )
    ).rows[0].count,
  ).toBe("3");
  await db.remove(owner.learner.id);
  expect(
    (await pool.query("SELECT count(*) FROM authorization_audit")).rows[0]
      .count,
  ).toBe("0");
});

it("limits cohort membership to its explicitly permitted shared content", async () => {
  const allowed = await member(),
    denied = await member(),
    staffReader = await staff("reviewer"),
    access = authorizationStore(pool);
  await pool.query("INSERT INTO cohorts(id) VALUES('group-a'),('group-b')");
  await pool.query(
    `INSERT INTO cohort_content(cohort_id,content_id,body)
     VALUES('group-a','guide','Group A guide'),('group-b','guide','Group B guide')`,
  );
  await pool.query(
    `INSERT INTO cohort_memberships(cohort_id,member_id,can_read_shared_content)
     VALUES('group-a',$1,true),('group-a',$2,false)`,
    [allowed.learner.id, denied.learner.id],
  );
  await expect(
    access.readCohort(allowed.token, "group-a", "guide"),
  ).resolves.toEqual({
    kind: "allowed",
    cohortId: "group-a",
    contentId: "guide",
    body: "Group A guide",
  });
  await pool.query(
    `UPDATE cohort_memberships
     SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 hour'
     WHERE cohort_id='group-a' AND member_id=$1`,
    [allowed.learner.id],
  );
  await expect(
    access.readCohort(allowed.token, "group-a", "guide"),
  ).resolves.toEqual({ kind: "denied" });
  await pool.query(
    `UPDATE cohort_memberships
     SET expires_at=NULL,revoked_at=CURRENT_TIMESTAMP
     WHERE cohort_id='group-a' AND member_id=$1`,
    [allowed.learner.id],
  );
  await expect(
    access.readCohort(allowed.token, "group-a", "guide"),
  ).resolves.toEqual({ kind: "denied" });
  for (const [credential, cohort] of [
    [allowed.token, "group-b"],
    [denied.token, "group-a"],
    [staffReader.token, "group-a"],
  ])
    await expect(
      access.readCohort(credential!, cohort!, "guide"),
    ).resolves.toEqual({ kind: "denied" });
});
it("enforces relational constraints and parameterizes hostile content", async () => {
  const { learner } = await member();
  await expect(
    pool.query("UPDATE learners SET background='admin' WHERE id=$1", [
      learner.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    db.save(randomBytes(16).toString("hex"), input),
  ).rejects.toThrow();
  await expect(
    db.save(learner.id, { ...input, instruction: "a".repeat(2001) }),
  ).rejects.toMatchObject({ code: "23514" });
  const hostile = "'; DROP TABLE learners;-- <script>alert(1)</script>";
  await db.save(learner.id, { ...input, instruction: hostile });
  expect((await db.progress(learner.id))?.instruction).toBe(hostile);
  expect(
    (await pool.query("SELECT count(*) FROM learners")).rows[0].count,
  ).toBe("1");
});

it("makes job enqueue idempotent across connections and rejects changed requests", async () => {
  const jobs = jobStore(pool),
    registry = deterministicRegistry({}, "test"),
    input = { template: "welcome" };
  const created = await enqueueAdapterJob(
    jobs,
    registry,
    "email",
    "send",
    input,
    "welcome-email",
  );
  const reopened = testPool();
  try {
    const duplicate = await enqueueAdapterJob(
      jobStore(reopened),
      registry,
      "email",
      "send",
      input,
      "welcome-email",
    );
    expect(duplicate.id).toBe(created.id);
    await expect(
      enqueueAdapterJob(
        jobStore(reopened),
        registry,
        "email",
        "send",
        { template: "changed" },
        "welcome-email",
      ),
    ).rejects.toThrow("another request");
    expect(
      (await reopened.query("SELECT count(*) FROM adapter_jobs")).rows[0].count,
    ).toBe("1");
  } finally {
    await reopened.end();
  }
});

it("finds the committed winner after a simultaneous first enqueue conflict", async () => {
  const fingerprint = "a".repeat(64),
    winnerId = randomUUID(),
    blocker = await pool.connect(),
    contender = await pool.connect();
  let transactionOpen = false;
  let competing: ReturnType<ReturnType<typeof jobStore>["enqueue"]> | undefined;
  try {
    await blocker.query("BEGIN");
    transactionOpen = true;
    const blockerPid = (
        await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid,
      contenderPid = (
        await contender.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
    await blocker.query(
      `INSERT INTO adapter_jobs(
         id,adapter,mode,operation,idempotency_key,request_fingerprint,max_attempts
       ) VALUES($1,'ai','test','summarize','simultaneous-first',$2,3)`,
      [winnerId, fingerprint],
    );
    competing = jobStore(contender as unknown as typeof pool).enqueue(
      "ai",
      "test",
      "summarize",
      "simultaneous-first",
      fingerprint,
    );
    let observedBlockedInsert = false;
    for (let check = 0; check < 100; check += 1) {
      const blocked = (
        await pool.query<{ blocked: boolean }>(
          "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
          [blockerPid, contenderPid],
        )
      ).rows[0]!.blocked;
      if (blocked) {
        observedBlockedInsert = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(observedBlockedInsert).toBe(true);
    await blocker.query("COMMIT");
    transactionOpen = false;
    await expect(competing).resolves.toMatchObject({ id: winnerId });
  } finally {
    if (transactionOpen) await blocker.query("ROLLBACK");
    await competing?.catch(() => undefined);
    blocker.release();
    contender.release();
  }
});

it("gives one concurrent worker the active adapter attempt", async () => {
  let executions = 0;
  const registry: AdapterRegistry = {
    mode: "test",
    adapter(kind) {
      return {
        kind,
        mode: "test",
        async execute() {
          executions += 1;
          return {
            kind,
            mode: "test",
            state: "simulated",
            reference: "test_once",
            message: "simulated once",
          };
        },
      };
    },
  };
  const input = { event: "lesson-opened" };
  const created = await enqueueAdapterJob(
    jobStore(pool),
    registry,
    "analytics",
    "record",
    input,
    "lesson-opened",
  );
  const [first, second] = await Promise.all([
    runAdapterJob(jobStore(pool), registry, created.id, input),
    runAdapterJob(jobStore(pool), registry, created.id, input),
  ]);
  expect(executions).toBe(1);
  expect([first.executed, second.executed].sort()).toEqual([false, true]);
  expect(await jobStore(pool).find(created.id)).toMatchObject({
    status: "succeeded",
    attempts: 1,
    safeError: null,
  });
});

it("persists retries across connections and stops invoking at exhaustion", async () => {
  let executions = 0;
  const registry: AdapterRegistry = {
    mode: "test",
    adapter(kind) {
      return {
        kind,
        mode: "test",
        async execute() {
          executions += 1;
          throw new Error("api_key=private-secret");
        },
      };
    },
  };
  const input = { template: "welcome" };
  const created = await enqueueAdapterJob(
    jobStore(pool),
    registry,
    "email",
    "send",
    input,
    "failing-email",
    3,
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reopened = testPool();
    try {
      await runAdapterJob(jobStore(reopened), registry, created.id, input);
    } finally {
      await reopened.end();
    }
  }
  const stopped = await runAdapterJob(
    jobStore(pool),
    registry,
    created.id,
    input,
  );
  expect(stopped.executed).toBe(false);
  expect(executions).toBe(3);
  expect(stopped.job).toMatchObject({
    status: "exhausted",
    attempts: 3,
    retryable: false,
    safeError: "provider_unavailable",
  });
  expect(
    JSON.stringify((await pool.query("SELECT * FROM adapter_jobs")).rows),
  ).not.toContain("private-secret");
});

it("recovers an expired lease after a crash but does not steal an active lease", async () => {
  let executions = 0;
  const input = { object: "lesson" };
  const registry: AdapterRegistry = {
    mode: "test",
    adapter(kind) {
      return {
        kind,
        mode: "test",
        async execute() {
          executions += 1;
          return {
            kind,
            mode: "test",
            state: "simulated",
            reference: "test_recovered",
            message: "simulated recovery",
          };
        },
      };
    },
  };
  const jobs = jobStore(pool);
  const created = await enqueueAdapterJob(
    jobs,
    registry,
    "storage",
    "store",
    input,
    "stored-lesson",
  );
  expect(await jobs.claim(created.id)).toMatchObject({
    status: "running",
    attempts: 1,
  });
  expect(
    (await runAdapterJob(jobs, registry, created.id, input)).executed,
  ).toBe(false);
  expect(executions).toBe(0);
  await pool.query(
    "UPDATE adapter_jobs SET lease_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1",
    [created.id],
  );
  const recovered = await runAdapterJob(jobs, registry, created.id, input);
  expect(recovered).toMatchObject({
    executed: true,
    job: { status: "succeeded", attempts: 2 },
  });
  expect(executions).toBe(1);
});

it("keeps terminal states when a late worker reports out of order", async () => {
  const jobs = jobStore(pool),
    registry = deterministicRegistry({}, "test"),
    successInput = { event: "complete" };
  const success = await enqueueAdapterJob(
    jobs,
    registry,
    "analytics",
    "record",
    successInput,
    "terminal-success",
    1,
  );
  const successAttempt = await jobs.claim(success.id);
  expect(successAttempt).toBeDefined();
  await jobs.succeed(success.id, successAttempt!.attemptToken);
  expect(
    await jobs.fail(
      success.id,
      successAttempt!.attemptToken,
      new Error("late failure"),
    ),
  ).toMatchObject({ status: "succeeded" });

  const failed = await enqueueAdapterJob(
    jobs,
    registry,
    "analytics",
    "record",
    { event: "fail" },
    "terminal-failure",
    1,
  );
  const failedAttempt = await jobs.claim(failed.id);
  expect(failedAttempt).toBeDefined();
  await jobs.fail(
    failed.id,
    failedAttempt!.attemptToken,
    new Error("provider failed"),
  );
  expect(
    await jobs.succeed(failed.id, failedAttempt!.attemptToken),
  ).toMatchObject({ status: "exhausted" });
});
