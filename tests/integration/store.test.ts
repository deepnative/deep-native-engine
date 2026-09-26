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
  type AdapterResult,
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
import { circleStore } from "../../src/circles.ts";
import { metricsStore } from "../../src/metrics.ts";
import { attemptStore } from "../../src/attempts.ts";
import { practiceStore } from "../../src/practice.ts";
import {
  catalogStore,
  seedDraftPack,
  type DraftContent,
} from "../../src/catalog.ts";
const pool = testPool(),
  db = store(pool);
const aiProvenance = {
  promptTemplateVersion: "study-reflection-v1",
  modelContractVersion: "synthetic-model-v1",
};
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
it("keeps a sample practice note private and pinned through replay, replacement, retirement and account deletion", async () => {
  const auth = authorizationStore(pool);
  const catalog = catalogStore(pool);
  const practice = practiceStore(pool);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  await auth.provisionStaff(
    editor,
    "editor",
    new Date(Date.now() + 86_400_000),
  );
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  const lesson: DraftContent = {
    ...contentDraft,
    id: "SYN-130",
    kind: "lesson",
    title: "Invented source",
    body: "Verify an invented claim against the original sample.",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    rubric: null,
    rubricVersion: null,
  };
  const publish = async (version: number) => {
    expect(await catalog.createDraft(editor, { ...lesson, version })).toBe(
      true,
    );
    expect(await catalog.submit(editor, lesson.id, version)).toBe(true);
    expect(await catalog.approve(reviewer, lesson.id, version, true)).toBe(
      true,
    );
    expect(await catalog.publish(editor, lesson.id, version)).toBe(true);
  };
  await publish(1);
  const first = await member();
  const second = await member();
  expect(await practice.current(first.token, lesson.id)).toMatchObject({
    version: 1,
    response: null,
    goal: "everyday",
  });
  expect(await practice.current("invalid", lesson.id)).toBeNull();
  expect(await practice.save(first.token, lesson.id, 2, "sample")).toBe(
    "unavailable",
  );
  const outcomes = await Promise.all([
    practice.save(first.token, lesson.id, 1, "first invented response"),
    practice.save(first.token, lesson.id, 1, "second invented response"),
  ]);
  expect(outcomes).toContain("saved");
  expect(outcomes).toContain("conflict");
  const saved = (await practice.current(first.token, lesson.id))!.response!;
  expect(await practice.save(first.token, lesson.id, 1, saved)).toBe(
    "replayed",
  );
  expect(
    await practice.save(first.token, lesson.id, 1, "late stale reply"),
  ).toBe("conflict");
  expect(
    (await practice.history(first.token)).map((entry) => entry.response),
  ).toEqual([saved]);
  expect(await practice.history(second.token)).toEqual([]);
  expect(
    (await practice.current(second.token, lesson.id))!.response,
  ).toBeNull();
  await db.updateProfile(first.learner.id, {
    background: "professional",
    goal: "work",
    backgroundTags: [],
    domainTags: [],
    itRoles: [],
    experience: "new",
    exploratory: false,
    timezone: "America/Toronto",
    weeklyMinutes: 30,
  });
  expect(await practice.current(first.token, lesson.id)).toBeNull();
  expect((await practice.history(first.token))[0]).toMatchObject({
    available: false,
    version: 1,
  });
  expect(await practice.save(first.token, lesson.id, 1, "changed goal")).toBe(
    "unavailable",
  );
  await publish(2);
  expect((await practice.history(first.token))[0]).toMatchObject({
    available: false,
    version: 1,
  });
  expect(await practice.save(first.token, lesson.id, 1, "old version")).toBe(
    "unavailable",
  );
  expect(await catalog.retire(editor, lesson.id)).toBe(true);
  expect(await practice.current(second.token, lesson.id)).toBeNull();
  expect((await practice.history(first.token))[0]).toMatchObject({
    available: false,
    version: 1,
  });
  await db.remove(first.learner.id);
  expect(
    (await pool.query("SELECT count(*)::int AS count FROM private_practice"))
      .rows[0].count,
  ).toBe(0);
});
it("distinguishes an empty authorized staff worklist from member and revoked access", async () => {
  const learner = await member();
  const catalog = catalogStore(pool);
  const editorToken = randomBytes(32).toString("hex");
  const editorId = await authorizationStore(pool).provisionStaff(
    editorToken,
    "editor",
    new Date(Date.now() + 86_400_000),
  );
  expect(await catalog.staffList(learner.token)).toBeNull();
  expect(await catalog.staffList(editorToken)).toEqual([]);
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [editorId],
  );
  expect(await catalog.staffList(editorToken)).toBeNull();
});
it("keeps local circle membership separate from cohort grants and removes it with the member", async () => {
  const owner = await member();
  const outsider = await member();
  const circles = circleStore(pool);
  await pool.query("INSERT INTO cohorts(id) VALUES('everyday-ai')");
  await pool.query(
    "INSERT INTO cohort_content(cohort_id,content_id,body) VALUES('everyday-ai','sample','Shared cohort secret')",
  );
  expect(await circles.join(owner.token, "everyday-ai")).toBe("joined");
  expect(await circles.join(owner.token, "everyday-ai")).toBe("joined");
  expect((await circles.list(owner.token))?.[0]).toMatchObject({
    joined: true,
    seatsRemaining: 3,
  });
  expect((await circles.list(outsider.token))?.[0]).toMatchObject({
    joined: false,
    seatsRemaining: 3,
  });
  expect(
    await authorizationStore(pool).readCohort(
      owner.token,
      "everyday-ai",
      "sample",
    ),
  ).toEqual({ kind: "denied" });
  expect((await pool.query("SELECT * FROM cohort_memberships")).rowCount).toBe(
    0,
  );
  expect(await circles.leave(outsider.token, "everyday-ai")).toBe(false);
  expect(await circles.leave(owner.token, "everyday-ai")).toBe(true);
  expect(await circles.leave(owner.token, "everyday-ai")).toBe(false);
  expect(await circles.join(owner.token, "everyday-ai")).toBe("joined");
  expect((await circles.list(owner.token))?.[0]?.seatsRemaining).toBe(3);
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP WHERE id=$1",
    [owner.learner.id],
  );
  expect(await circles.list(owner.token)).toBeNull();
  expect((await circles.list(outsider.token))?.[0]?.seatsRemaining).toBe(4);
  expect(await circles.join(owner.token, "professional-work")).toBe("denied");
  expect(await circles.leave(owner.token, "everyday-ai")).toBe(false);
  expect(await circles.join("0".repeat(64), "everyday-ai")).toBe("denied");
  await db.remove(owner.learner.id);
  expect(
    (
      await pool.query(
        "SELECT * FROM preview_circle_memberships WHERE member_id=$1",
        [owner.learner.id],
      )
    ).rowCount,
  ).toBe(0);
});

it("serializes the last local circle seat across concurrent members", async () => {
  const circles = circleStore(pool);
  const members = await Promise.all(Array.from({ length: 5 }, () => member()));
  for (const entry of members.slice(0, 3)) {
    expect(await circles.join(entry.token, "technical-practice")).toBe(
      "joined",
    );
  }
  expect(
    (
      await Promise.all(
        members
          .slice(3)
          .map((entry) => circles.join(entry.token, "technical-practice")),
      )
    ).sort(),
  ).toEqual(["full", "joined"]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM preview_circle_memberships WHERE circle_id='technical-practice' AND left_at IS NULL",
      )
    ).rows[0]?.n,
  ).toBe(4);
});
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
it("orders synthetic moderation by submission time and revokes queue access", async () => {
  const proposals = proposalStore(pool);
  const learner = await member();
  const moderatorToken = randomBytes(32).toString("hex");
  const reviewerToken = randomBytes(32).toString("hex");
  const editorToken = randomBytes(32).toString("hex");
  const adminToken = randomBytes(32).toString("hex");
  const moderatorId = await authorizationStore(pool).provisionStaff(
    moderatorToken,
    "moderator",
    new Date(Date.now() + 86_400_000),
  );
  await authorizationStore(pool).provisionStaff(
    reviewerToken,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  await authorizationStore(pool).provisionStaff(
    editorToken,
    "editor",
    new Date(Date.now() + 86_400_000),
  );
  await authorizationStore(pool).provisionStaff(
    adminToken,
    "platform_admin",
    new Date(Date.now() + 86_400_000),
  );
  const sample = {
    title: "Invented queue work",
    body: "Only made-up details",
    sources: "Original sample",
  };
  const firstDraft = (await proposals.createDraft(
    learner.token,
    sample,
    true,
  ))!;
  const secondDraft = (await proposals.createDraft(
    learner.token,
    sample,
    true,
  ))!;
  expect(await proposals.submit(learner.token, secondDraft, true)).toBe(true);
  expect(await proposals.submit(learner.token, firstDraft, true)).toBe(true);
  await pool.query(
    `UPDATE member_proposals SET created_at=CASE WHEN id=$1 THEN '2026-09-20T00:00:00Z'::timestamptz ELSE '2026-09-21T00:00:00Z'::timestamptz END,
       submitted_at=CASE WHEN id=$1 THEN '2026-09-24T00:00:00Z'::timestamptz ELSE '2026-09-23T00:00:00Z'::timestamptz END
     WHERE id IN ($1,$2)`,
    [firstDraft, secondDraft],
  );
  expect(await proposals.moderationQueue(learner.token)).toBeNull();
  expect(await proposals.moderationQueue(reviewerToken)).toBeNull();
  expect(await proposals.moderationQueue(editorToken)).toBeNull();
  expect(
    await proposals.moderationQueue(randomBytes(32).toString("hex")),
  ).toBeNull();
  expect(
    (await proposals.moderationQueue(moderatorToken))?.map((item) => item.id),
  ).toEqual([secondDraft, firstDraft]);
  expect(
    (await proposals.moderationQueue(adminToken))?.map((item) => item.id),
  ).toEqual([secondDraft, firstDraft]);
  await pool.query(
    "UPDATE member_proposals SET submitted_at='2026-09-23T00:00:00Z'::timestamptz WHERE id=$1",
    [firstDraft],
  );
  expect(
    (await proposals.moderationQueue(moderatorToken))?.map((item) => item.id),
  ).toEqual([firstDraft, secondDraft].sort());
  expect(await proposals.withdraw(learner.token, secondDraft)).toBe(true);
  expect(
    (await proposals.moderationQueue(moderatorToken))?.map((item) => item.id),
  ).toEqual([firstDraft]);
  const racing = (await proposals.createDraft(learner.token, sample, true))!;
  expect(await proposals.submit(learner.token, racing, true)).toBe(true);
  const settled = await Promise.all([
    proposals.withdraw(learner.token, racing),
    proposals.moderate(moderatorToken, racing, "reject"),
  ]);
  expect(settled.filter(Boolean)).toHaveLength(1);
  expect(await proposals.preview(learner.token, racing)).toMatchObject({
    title: null,
    body: null,
    sources: null,
  });
  expect(
    (await proposals.moderationQueue(moderatorToken))?.map((item) => item.id),
  ).not.toContain(racing);
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [moderatorId],
  );
  expect(await proposals.moderationQueue(moderatorToken)).toBeNull();
  expect(await proposals.moderate(moderatorToken, firstDraft, "reject")).toBe(
    false,
  );
});
it("caps the private moderation queue at the oldest 100 stable ties", async () => {
  const learner = await member();
  const moderatorToken = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    moderatorToken,
    "moderator",
    new Date(Date.now() + 86_400_000),
  );
  const ids = Array.from({ length: 101 }, () => randomUUID());
  await pool.query(
    `INSERT INTO member_proposals(id,member_id,title,body,sources,state,
       sample_attested_at,rights_attested_at,submitted_at)
     SELECT id,$1,'Invented capped item','Synthetic text','Original sample',
       'submitted',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
       '2026-09-24T00:00:00Z'::timestamptz
     FROM unnest($2::uuid[]) AS source(id)`,
    [learner.learner.id, ids],
  );
  const queue = await proposalStore(pool).moderationQueue(moderatorToken);
  expect(queue).toHaveLength(100);
  expect(queue?.map((item) => item.id)).toEqual(ids.sort().slice(0, 100));
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
    (await catalog.staffList(editorToken))!.map((item) => item.id),
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

it("pins one private assignment attempt, serializes drafts and preserves history through retirement", async () => {
  const owner = await member(),
    outsider = await member();
  const editor = await staff("editor"),
    reviewer = await staff("reviewer");
  const catalog = catalogStore(pool),
    attempts = attemptStore(pool);
  const draft = {
    ...contentDraft,
    id: "SYN-960",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    rubric: "Check the invented source.",
    rubricVersion: 1,
  };
  expect(await catalog.createDraft(editor.token, draft)).toBe(true);
  expect(await catalog.submit(editor.token, draft.id, 1)).toBe(true);
  expect(await catalog.approve(reviewer.token, draft.id, 1, true)).toBe(true);
  expect(await catalog.publish(editor.token, draft.id, 1)).toBe(true);
  expect(await db.chooseAssignment(owner.learner.id, draft.id, 1)).toBe(true);
  const ids = await Promise.all([
    attempts.start(owner.token),
    attempts.start(owner.token),
  ]);
  expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/);
  expect(ids[0]).toBe(ids[1]);
  const id = ids[0]!;
  expect((await attempts.list(owner.token)).map((entry) => entry.id)).toEqual([
    id,
  ]);
  expect(await attempts.list(outsider.token)).toEqual([]);
  expect(await attempts.detail(outsider.token, id)).toBeNull();
  const first = await attempts.detail(owner.token, id);
  expect(first).toMatchObject({
    contentId: draft.id,
    contentVersion: 1,
    goalAtStart: "everyday",
    revision: 1,
    currentEligible: true,
    savedAt: null,
    submittedAt: null,
  });
  expect(
    (
      await pool.query(
        "SELECT rubric_version FROM content_versions WHERE id=$1 AND version=1",
        [draft.id],
      )
    ).rows[0].rubric_version,
  ).toBe(1);
  const writes = await Promise.all([
    attempts.save(owner.token, id, 1, "Invented draft from tab one"),
    attempts.save(owner.token, id, 1, "Invented draft from tab two"),
  ]);
  expect(writes.sort()).toEqual([false, true]);
  const saved = await attempts.detail(owner.token, id);
  expect(saved?.revision).toBe(2);
  expect(saved?.response).toMatch(/^Invented draft from tab/);
  expect(
    await attempts.save(outsider.token, id, 2, "Forged other-member edit"),
  ).toBe(false);
  expect(await attempts.submit(owner.token, id, 1)).toBe(false);
  expect(await attempts.submit(owner.token, id, 2)).toBe(true);
  expect(await attempts.submit(owner.token, id, 2)).toBe(false);
  expect(await attempts.save(owner.token, id, 2, "Late write")).toBe(false);
  expect((await attempts.detail(owner.token, id))?.response).toBe(
    saved?.response,
  );
  await pool.query("UPDATE learners SET goal='work' WHERE id=$1", [
    owner.learner.id,
  ]);
  expect((await attempts.detail(owner.token, id))?.currentEligible).toBe(false);
  expect(await attempts.start(owner.token)).toBeNull();
  expect(await attempts.remove(outsider.token, id)).toBe(false);
  expect(await attempts.remove(owner.token, id)).toBe(true);
  expect(await attempts.detail(owner.token, id)).toBeNull();
});

it("keeps retired drafts readable but denies writes, and privacy deletion cascades", async () => {
  const owner = await member(),
    editor = await staff("editor"),
    reviewer = await staff("reviewer");
  const catalog = catalogStore(pool),
    attempts = attemptStore(pool);
  const draft = {
    ...contentDraft,
    id: "SYN-961",
    goals: ["everyday"],
    backgrounds: ["explorer"],
  };
  expect(await catalog.createDraft(editor.token, draft)).toBe(true);
  expect(await catalog.submit(editor.token, draft.id, 1)).toBe(true);
  expect(await catalog.approve(reviewer.token, draft.id, 1, true)).toBe(true);
  expect(await catalog.publish(editor.token, draft.id, 1)).toBe(true);
  expect(await db.chooseAssignment(owner.learner.id, draft.id, 1)).toBe(true);
  const id = (await attempts.start(owner.token))!;
  expect(
    await attempts.save(owner.token, id, 1, "Private synthetic draft text"),
  ).toBe(true);
  expect(await catalog.retire(editor.token, draft.id)).toBe(true);
  expect((await attempts.detail(owner.token, id))?.currentPublished).toBe(
    false,
  );
  expect(
    await attempts.save(owner.token, id, 2, "New text after retirement"),
  ).toBe(false);
  expect(await attempts.submit(owner.token, id, 2)).toBe(false);
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP WHERE id=$1",
    [owner.learner.id],
  );
  expect(await attempts.detail(owner.token, id)).toBeNull();
  await db.remove(owner.learner.id);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM assignment_attempts WHERE id=$1",
        [id],
      )
    ).rows[0].n,
  ).toBe(0);
});

it("keeps failed PostgreSQL attempt writes unconfirmed until a checked retry", async () => {
  const owner = await member(),
    editor = await staff("editor"),
    reviewer = await staff("reviewer");
  const catalog = catalogStore(pool),
    attempts = attemptStore(pool);
  const draft = {
    ...contentDraft,
    id: "SYN-963",
    goals: ["everyday"],
    backgrounds: ["explorer"],
  };
  expect(await catalog.createDraft(editor.token, draft)).toBe(true);
  expect(await catalog.submit(editor.token, draft.id, 1)).toBe(true);
  expect(await catalog.approve(reviewer.token, draft.id, 1, true)).toBe(true);
  expect(await catalog.publish(editor.token, draft.id, 1)).toBe(true);
  expect(await db.chooseAssignment(owner.learner.id, draft.id, 1)).toBe(true);
  const id = (await attempts.start(owner.token))!;
  await pool.query(
    `CREATE FUNCTION test_reject_attempt_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${id}'::uuid THEN
          RAISE EXCEPTION 'synthetic attempt write fault';
        END IF;
        RETURN NEW;
      END $$`,
  );
  const reject = () =>
    pool.query(
      "CREATE TRIGGER test_reject_attempt_update BEFORE UPDATE ON assignment_attempts FOR EACH ROW EXECUTE FUNCTION test_reject_attempt_update()",
    );
  const allow = () =>
    pool.query(
      "DROP TRIGGER IF EXISTS test_reject_attempt_update ON assignment_attempts",
    );
  try {
    await reject();
    await expect(
      attempts.save(owner.token, id, 1, "Synthetic text after a fault."),
    ).rejects.toThrow("synthetic attempt write fault");
    expect(await attempts.detail(owner.token, id)).toMatchObject({
      response: "",
      revision: 1,
      savedAt: null,
    });
    await allow();
    expect(
      await attempts.save(owner.token, id, 1, "Synthetic text after a fault."),
    ).toBe(true);
    await reject();
    await expect(attempts.submit(owner.token, id, 2)).rejects.toThrow(
      "synthetic attempt write fault",
    );
    expect((await attempts.detail(owner.token, id))?.submittedAt).toBeNull();
    await allow();
    expect(await attempts.submit(owner.token, id, 2)).toBe(true);
    expect(await attempts.submit(owner.token, id, 2)).toBe(false);
    const rows = await pool.query(
      "SELECT count(*)::integer AS n FROM assignment_attempts WHERE id=$1",
      [id],
    );
    expect(rows.rows[0].n).toBe(1);
  } finally {
    await allow();
    await pool.query("DROP FUNCTION IF EXISTS test_reject_attempt_update()");
  }
});

it("counts retained preview learning and circle events once without granting metric access to members", async () => {
  const first = await member(),
    second = await member(),
    third = await member();
  await pool.query(
    "UPDATE learners SET background='professional',goal='work' WHERE id=$1",
    [second.learner.id],
  );
  await pool.query(
    "UPDATE learners SET background='technical',goal='build' WHERE id=$1",
    [third.learner.id],
  );
  const operator = await staff("operator"),
    reviewer = await staff("reviewer");
  const metrics = metricsStore(pool);
  expect(await metrics.snapshot(first.token)).toBeNull();
  expect(await metrics.snapshot(reviewer.token)).toBeNull();
  expect(await metrics.snapshot("f".repeat(64))).toBeNull();
  await pool.query(
    `INSERT INTO content_versions(id,version,kind,origin,title,body,owner,sources,rights)
     VALUES('SYN-990',1,'lesson','curated','Invented lesson','Sample only','Test','Test','Owned')`,
  );
  await pool.query(
    `INSERT INTO lesson_activity(member_id,content_id,content_version,started_at,self_assessed_at)
     VALUES($1,'SYN-990',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
           ($2,'SYN-990',1,NULL,NULL)`,
    [first.learner.id, second.learner.id],
  );
  await pool.query(
    `INSERT INTO preview_circle_memberships(circle_id,member_id,left_at)
     VALUES('everyday-ai',$1,CURRENT_TIMESTAMP),('technical-practice',$1,CURRENT_TIMESTAMP),
           ('professional-work',$2,NULL)`,
    [first.learner.id, second.learner.id],
  );
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP WHERE id=$1",
    [third.learner.id],
  );
  expect((await metrics.snapshot(operator.token))?.counts).toEqual({
    members: 3,
    activated: 2,
    selfAssessed: 1,
    participated: 2,
    activeCircle: 1,
  });
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [operator.id],
  );
  expect(await metrics.snapshot(operator.token)).toBeNull();
});

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
  expect(await evidence.owned(owner.token)).toMatchObject([
    {
      id: created.id,
      name: "sample.txt",
      quarantineState: "pending",
      privateReviewAllowed: true,
    },
  ]);
  expect(await evidence.owned(outsider.token)).toEqual([]);
  expect(await evidence.owned("invalid")).toEqual([]);
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
  expect(await evidence.submitForReview(outsider.token, created.id)).toBe(
    false,
  );
  expect(await evidence.submitForReview(owner.token, created.id)).toBe(false);
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
it("keeps private evidence revisions immutable, owner-bound and linear under concurrent writes", async () => {
  const owner = await member();
  const outsider = await member();
  const files = evidenceStore(
    pool,
    fileObjectStorage(privateStorageRoot),
    "integration-secret",
  );
  const consent = {
    rightsConfirmed: true,
    privateReview: true,
    communityPublication: false,
  };
  const originalBytes = Buffer.from("Invented original submitted evidence");
  const original = await files.upload(owner.token, {
    name: "original.txt",
    mediaType: "text/plain",
    data: originalBytes,
    consent,
  });
  expect(original.kind).toBe("created");
  if (original.kind !== "created") throw new Error("original not created");
  expect(await files.transitionQuarantine(original.id, "clean")).toBe(true);
  expect(await files.submitForReview(owner.token, original.id)).toBe(true);
  const attempt = (token: string, text: string, revisesId = original.id) =>
    files.upload(token, {
      name: "revision.txt",
      mediaType: "text/plain",
      data: Buffer.from(text),
      consent,
      revisesId,
    });
  expect(await attempt(owner.token, "Bad revision target", "invalid")).toEqual({
    kind: "invalid",
  });
  expect(await attempt(outsider.token, "Outsider revision denied")).toEqual({
    kind: "denied",
  });
  const attempted = await Promise.all([
    attempt(owner.token, "Invented revision A"),
    attempt(owner.token, "Invented revision B"),
  ]);
  expect(attempted.map((result) => result.kind).sort()).toEqual([
    "created",
    "denied",
  ]);
  const revised = attempted.find((result) => result.kind === "created");
  if (!revised || revised.kind !== "created")
    throw new Error("revision not created");
  const rows = await pool.query<{
    id: string;
    revision_parent_id: string | null;
    revision_number: number;
    quarantine_state: string;
    storage_key: string;
  }>(
    `SELECT id,revision_parent_id,revision_number,quarantine_state,storage_key
     FROM evidence_objects WHERE owner_principal_id=$1 ORDER BY revision_number`,
    [owner.learner.id],
  );
  expect(rows.rows).toMatchObject([
    {
      id: original.id,
      revision_parent_id: null,
      revision_number: 1,
      quarantine_state: "clean",
    },
    {
      id: revised.id,
      revision_parent_id: original.id,
      revision_number: 2,
      quarantine_state: "pending",
    },
  ]);
  expect(
    await readFile(join(privateStorageRoot, rows.rows[0]!.storage_key)),
  ).toEqual(originalBytes);
  expect((await readdir(privateStorageRoot)).length).toBe(2);
  expect(await files.submitForReview(owner.token, revised.id)).toBe(false);
  expect(await files.owned(outsider.token)).toEqual([]);
  expect(await files.owned(owner.token)).toMatchObject([
    { id: revised.id, revisionParentId: original.id, revisionNumber: 2 },
    {
      id: original.id,
      revisionParentId: null,
      revisionNumber: 1,
      hasRevision: true,
    },
  ]);
  expect(await files.remove(owner.token, original.id)).toBe(true);
  expect(await files.owned(owner.token)).toMatchObject([
    { id: revised.id, revisionParentId: null, revisionNumber: 2 },
  ]);
  expect(
    await readFile(join(privateStorageRoot, rows.rows[1]!.storage_key)),
  ).toEqual(
    Buffer.from(
      attempted[0].kind === "created"
        ? "Invented revision A"
        : "Invented revision B",
    ),
  );
});
it("exports only current owner evidence and withholds unsafe or deleted source bytes", async () => {
  const owner = await member();
  const outsider = await member();
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(privateStorageRoot),
    "integration-secret",
  );
  const consent = {
    rightsConfirmed: true,
    privateReview: true,
    communityPublication: false,
  };
  const clean = await evidence.upload(owner.token, {
    name: "export-clean.txt",
    mediaType: "text/plain",
    data: Buffer.from("Owned invented export data"),
    consent,
  });
  const unsafe = await evidence.upload(owner.token, {
    name: "export-unsafe.txt",
    mediaType: "text/plain",
    data: Buffer.from("Unsafe invented export data"),
    consent,
  });
  expect(clean.kind).toBe("created");
  expect(unsafe.kind).toBe("created");
  if (clean.kind !== "created" || unsafe.kind !== "created") return;
  expect(await evidence.transitionQuarantine(clean.id, "clean")).toBe(true);
  expect(await evidence.transitionQuarantine(unsafe.id, "rejected")).toBe(true);
  expect(await evidence.exportOwned(outsider.token)).toEqual({
    kind: "ready",
    version: "local-evidence-v1",
    items: [],
  });
  const first = await evidence.exportOwned(owner.token);
  expect(first.kind).toBe("ready");
  if (first.kind !== "ready") return;
  expect(first.items.find((item) => item.id === clean.id)).toMatchObject({
    quarantineState: "clean",
    sourceBase64: Buffer.from("Owned invented export data").toString("base64"),
  });
  expect(first.items.find((item) => item.id === unsafe.id)).toMatchObject({
    quarantineState: "rejected",
    sourceBase64: null,
  });
  expect(JSON.stringify(first)).not.toContain("storageKey");
  expect(await evidence.revokePrivateReview(owner.token, clean.id)).toBe(true);
  const revoked = await evidence.exportOwned(owner.token);
  expect(revoked.kind).toBe("ready");
  if (revoked.kind !== "ready") return;
  expect(revoked.items.find((item) => item.id === clean.id)).toMatchObject({
    privateReviewAllowed: false,
  });
  expect(await evidence.remove(owner.token, clean.id)).toBe(true);
  expect(await evidence.exportOwned(owner.token)).toMatchObject({
    items: [{ id: unsafe.id, sourceBase64: null }],
  });
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=$1",
    [hash(owner.token)],
  );
  expect(await evidence.exportOwned(owner.token)).toEqual({ kind: "denied" });
});

it("lets only the member revoke private-review consent while retaining private evidence", async () => {
  const owner = await member();
  const outsider = await member();
  const admin = await staff("platform_admin");
  const reviewer = await staff("reviewer");
  const auth = authorizationStore(pool);
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(privateStorageRoot),
    "integration-secret",
  );
  const created = await evidence.upload(owner.token, {
    name: "invented-review.txt",
    mediaType: "text/plain",
    data: Buffer.from("Invented private review evidence"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: true,
    },
  });
  if (created.kind !== "created") throw new Error("evidence not created");
  expect(await evidence.owned(reviewer.token)).toEqual([]);
  expect(await evidence.owned(outsider.token)).toEqual([]);
  expect(await evidence.transitionQuarantine(created.id, "clean")).toBe(true);
  expect(await evidence.submitForReview(owner.token, created.id)).toBe(true);
  expect(await evidence.submitForReview(reviewer.token, created.id)).toBe(
    false,
  );
  expect(await evidence.owned(owner.token)).toMatchObject([
    { id: created.id, quarantineState: "clean", submissionStatus: "queued" },
  ]);
  const submission = await pool.query<{ id: string }>(
    "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
    [created.id],
  );
  const expires = new Date(Date.now() + 60_000);
  const assignmentId = await auth.grantAssignment(
    admin.id,
    reviewer.id,
    owner.learner.id,
    "reviewer",
    "synthetic private review",
    expires,
  );
  await auth.grantEvidenceReview(
    admin.id,
    reviewer.id,
    assignmentId,
    submission.rows[0]!.id,
    "synthetic exact object",
    expires,
  );
  const reviewerLink = await evidence.issueDownload(reviewer.token, created.id);
  expect(reviewerLink.kind).toBe("issued");
  if (reviewerLink.kind !== "issued") throw new Error("link not issued");
  expect(
    (
      await evidence.download(
        reviewer.token,
        created.id,
        reviewerLink.capability,
      )
    ).kind,
  ).toBe("allowed");
  expect(await evidence.revokePrivateReview(outsider.token, created.id)).toBe(
    false,
  );
  expect(await evidence.revokePrivateReview(reviewer.token, created.id)).toBe(
    false,
  );
  expect(await evidence.revokePrivateReview(owner.token, created.id)).toBe(
    true,
  );
  expect(await evidence.submitForReview(owner.token, created.id)).toBe(false);
  expect(await evidence.owned(owner.token)).toMatchObject([
    {
      id: created.id,
      privateReviewAllowed: false,
      submissionStatus: "withdrawn",
    },
  ]);
  expect(await evidence.revokePrivateReview(owner.token, created.id)).toBe(
    false,
  );
  const row = await pool.query<{
    private_review_allowed: boolean;
    private_review_revoked_at: Date;
    community_publication_allowed: boolean;
    status: string;
  }>(
    `SELECT e.private_review_allowed,e.private_review_revoked_at,
            e.community_publication_allowed,s.status
     FROM evidence_objects e JOIN evidence_review_submissions s
       ON s.evidence_id=e.id WHERE e.id=$1`,
    [created.id],
  );
  expect(row.rows[0]).toMatchObject({
    private_review_allowed: false,
    community_publication_allowed: true,
    status: "withdrawn",
  });
  expect(row.rows[0]!.private_review_revoked_at).toBeInstanceOf(Date);
  await expect(
    evidence.destinationAllowed(created.id, "private-review"),
  ).resolves.toBe(false);
  await expect(
    evidence.destinationAllowed(created.id, "community-publication"),
  ).resolves.toBe(true);
  await expect(
    evidence.issueDownload(reviewer.token, created.id),
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    evidence.download(reviewer.token, created.id, reviewerLink.capability),
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    auth.grantEvidenceReview(
      admin.id,
      reviewer.id,
      assignmentId,
      submission.rows[0]!.id,
      "replay after member revocation",
      expires,
    ),
  ).rejects.toThrow("Privileged grant denied");
  const ownerLink = await evidence.issueDownload(owner.token, created.id);
  expect(ownerLink.kind).toBe("issued");
  if (ownerLink.kind !== "issued") throw new Error("owner link not issued");
  expect(
    (await evidence.download(owner.token, created.id, ownerLink.capability))
      .kind,
  ).toBe("allowed");

  const privateOnly = await evidence.upload(owner.token, {
    name: "invented-private-only.txt",
    mediaType: "text/plain",
    data: Buffer.from("Invented retained private bytes"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (privateOnly.kind !== "created") throw new Error("evidence not created");
  expect(await evidence.transitionQuarantine(privateOnly.id, "clean")).toBe(
    true,
  );
  expect(await evidence.revokePrivateReview(owner.token, privateOnly.id)).toBe(
    true,
  );
  const privateRow = await pool.query<{
    private_review_allowed: boolean;
    community_publication_allowed: boolean;
    learning_circle_id: string | null;
  }>(
    `SELECT private_review_allowed,community_publication_allowed,learning_circle_id
     FROM evidence_objects WHERE id=$1`,
    [privateOnly.id],
  );
  expect(privateRow.rows).toEqual([
    {
      private_review_allowed: false,
      community_publication_allowed: false,
      learning_circle_id: null,
    },
  ]);
  expect((await evidence.issueDownload(owner.token, privateOnly.id)).kind).toBe(
    "issued",
  );
});

it("never leaves a queued review submission after overlapping consent revocation", async () => {
  const owner = await member();
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(privateStorageRoot),
    "integration-secret",
  );
  const created = await evidence.upload(owner.token, {
    name: "invented-overlap.txt",
    mediaType: "text/plain",
    data: Buffer.from("Invented private review evidence"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (created.kind !== "created") throw new Error("evidence not created");
  expect(await evidence.transitionQuarantine(created.id, "clean")).toBe(true);

  const gateKey = randomBytes(4).readUInt32BE(0);
  const holder = await pool.connect();
  let queue: Promise<boolean> | undefined;
  let revoke: Promise<boolean> | undefined;
  try {
    await pool.query(`CREATE FUNCTION dne_test_queue_gate() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(TG_ARGV[0]::bigint);
        RETURN NEW;
      END $$`);
    await pool.query(`CREATE TRIGGER dne_test_queue_gate
      BEFORE INSERT ON evidence_review_submissions
      FOR EACH ROW EXECUTE FUNCTION dne_test_queue_gate('${gateKey}')`);
    await holder.query("SELECT pg_advisory_lock($1::bigint)", [gateKey]);
    const blocked = async (fragment: string, waitEvent?: string) => {
      const result = await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND state='active' AND query LIKE $1 AND wait_event_type='Lock'
            AND ($2::text IS NULL OR wait_event=$2)) AS blocked`,
        [`%${fragment}%`, waitEvent ?? null],
      );
      return result.rows[0]!.blocked;
    };
    const waitFor = async (condition: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Expected database lock state was not observed");
    };
    queue = evidence.submitForReview(owner.token, created.id);
    await waitFor(() =>
      blocked("INSERT INTO evidence_review_submissions", "advisory"),
    );
    let revokeDone = false;
    revoke = evidence
      .revokePrivateReview(owner.token, created.id)
      .then((value) => {
        revokeDone = true;
        return value;
      });
    await waitFor(
      async () => revokeDone || (await blocked("UPDATE evidence_objects e")),
    );
    await holder.query("SELECT pg_advisory_unlock($1::bigint)", [gateKey]);
    expect(await queue).toBe(true);
    expect(await revoke).toBe(true);
    const state = await pool.query<{ status: string | null }>(
      `SELECT s.status FROM evidence_objects e
       LEFT JOIN evidence_review_submissions s ON s.evidence_id=e.id
       WHERE e.id=$1 AND e.private_review_allowed=false`,
      [created.id],
    );
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]!.status).not.toBe("queued");
    expect(await evidence.submitForReview(owner.token, created.id)).toBe(false);
  } finally {
    await holder.query("SELECT pg_advisory_unlock($1::bigint)", [gateKey]);
    await Promise.allSettled([queue, revoke].filter(Boolean));
    await pool.query(
      "DROP TRIGGER IF EXISTS dne_test_queue_gate ON evidence_review_submissions",
    );
    await pool.query("DROP FUNCTION IF EXISTS dne_test_queue_gate()");
    holder.release();
  }
}, 10_000);

it("denies an overlapping queue after revocation owns the evidence row", async () => {
  const owner = await member();
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(privateStorageRoot),
    "integration-secret",
  );
  const created = await evidence.upload(owner.token, {
    name: "invented-revoke-first.txt",
    mediaType: "text/plain",
    data: Buffer.from("Invented private review evidence"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (created.kind !== "created") throw new Error("evidence not created");
  expect(await evidence.transitionQuarantine(created.id, "clean")).toBe(true);

  const gateKey = randomBytes(4).readUInt32BE(0);
  const holder = await pool.connect();
  let queue: Promise<boolean> | undefined;
  let revoke: Promise<boolean> | undefined;
  try {
    await pool.query(`CREATE FUNCTION dne_test_revoke_gate() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(TG_ARGV[0]::bigint);
        RETURN NEW;
      END $$`);
    await pool.query(`CREATE TRIGGER dne_test_revoke_gate
      BEFORE UPDATE OF private_review_allowed ON evidence_objects
      FOR EACH ROW EXECUTE FUNCTION dne_test_revoke_gate('${gateKey}')`);
    await holder.query("SELECT pg_advisory_lock($1::bigint)", [gateKey]);
    const waitForLock = async (fragment: string, event?: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await pool.query<{ blocked: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()
              AND state='active' AND query LIKE $1 AND wait_event_type='Lock'
              AND ($2::text IS NULL OR wait_event=$2)) AS blocked`,
          [`%${fragment}%`, event ?? null],
        );
        if (result.rows[0]!.blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Expected database lock state was not observed");
    };
    revoke = evidence.revokePrivateReview(owner.token, created.id);
    await waitForLock("UPDATE evidence_objects e", "advisory");
    queue = evidence.submitForReview(owner.token, created.id);
    await waitForLock("INSERT INTO evidence_review_submissions");
    await holder.query("SELECT pg_advisory_unlock($1::bigint)", [gateKey]);
    expect(await revoke).toBe(true);
    expect(await queue).toBe(false);
    expect(await evidence.owned(owner.token)).toMatchObject([
      { id: created.id, privateReviewAllowed: false, submissionStatus: null },
    ]);
  } finally {
    await holder.query("SELECT pg_advisory_unlock($1::bigint)", [gateKey]);
    await Promise.allSettled([queue, revoke].filter(Boolean));
    await pool.query(
      "DROP TRIGGER IF EXISTS dne_test_revoke_gate ON evidence_objects",
    );
    await pool.query("DROP FUNCTION IF EXISTS dne_test_revoke_gate()");
    holder.release();
  }
}, 10_000);

it("commits only one concurrent review queue entry and rolls back failed withdrawal", async () => {
  const owner = await member();
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(privateStorageRoot),
    "integration-secret",
  );
  const created = await evidence.upload(owner.token, {
    name: "invented-duplicate.txt",
    mediaType: "text/plain",
    data: Buffer.from("Invented duplicate review evidence"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (created.kind !== "created") throw new Error("evidence not created");
  expect(await evidence.transitionQuarantine(created.id, "clean")).toBe(true);
  expect(
    (
      await Promise.all([
        evidence.submitForReview(owner.token, created.id),
        evidence.submitForReview(owner.token, created.id),
      ])
    ).sort(),
  ).toEqual([false, true]);
  await pool.query(`CREATE FUNCTION dne_test_withdraw_failure() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'synthetic withdrawal failure';
    END $$`);
  try {
    await pool.query(`CREATE TRIGGER dne_test_withdraw_failure
      BEFORE UPDATE ON evidence_review_submissions
      FOR EACH ROW EXECUTE FUNCTION dne_test_withdraw_failure()`);
    await expect(
      evidence.revokePrivateReview(owner.token, created.id),
    ).rejects.toThrow("synthetic withdrawal failure");
    const state = await pool.query<{
      private_review_allowed: boolean;
      status: string;
    }>(
      `SELECT e.private_review_allowed,s.status
       FROM evidence_objects e JOIN evidence_review_submissions s
         ON s.evidence_id=e.id WHERE e.id=$1`,
      [created.id],
    );
    expect(state.rows).toEqual([
      { private_review_allowed: true, status: "queued" },
    ]);
  } finally {
    await pool.query(
      "DROP TRIGGER IF EXISTS dne_test_withdraw_failure ON evidence_review_submissions",
    );
    await pool.query("DROP FUNCTION IF EXISTS dne_test_withdraw_failure()");
  }
  expect(await evidence.revokePrivateReview(owner.token, created.id)).toBe(
    true,
  );
  expect(await evidence.submitForReview(owner.token, created.id)).toBe(false);
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
  expect(await evidence.submitForReview(owner.token, created.id)).toBe(true);
  const submittedId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
      [created.id],
    )
  ).rows[0]!.id;
  await access.grantEvidenceReview(
    admin.id,
    reviewer.id,
    reviewerGrant,
    submittedId,
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

it("keeps issued evidence links bound to one record and current workspace grants", async () => {
  const first = await member(),
    second = await member(),
    unassigned = await member(),
    admin = await staff("platform_admin"),
    reviewer = await staff("reviewer"),
    editor = await staff("editor"),
    access = authorizationStore(pool),
    evidence = evidenceStore(
      pool,
      fileObjectStorage(privateStorageRoot),
      "integration-secret",
    );
  async function cleanSubmission(token: string, text: string, submit = true) {
    const uploaded = await evidence.upload(token, {
      name: "private.txt",
      mediaType: "text/plain",
      data: Buffer.from(text),
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    });
    if (uploaded.kind !== "created") throw new Error("evidence not created");
    expect(await evidence.transitionQuarantine(uploaded.id, "clean")).toBe(
      true,
    );
    if (submit)
      expect(await evidence.submitForReview(token, uploaded.id)).toBe(true);
    return uploaded.id;
  }
  const firstId = await cleanSubmission(
    first.token,
    "First invented private note",
  );
  const secondId = await cleanSubmission(
    second.token,
    "Second invented private note",
  );
  const draftId = await cleanSubmission(
    first.token,
    "Unsubmitted invented private note",
    false,
  );
  const unassignedId = await cleanSubmission(
    unassigned.token,
    "Third member private note",
  );
  const firstGrant = await access.grantAssignment(
    admin.id,
    reviewer.id,
    first.learner.id,
    "reviewer",
    "first review",
    new Date(Date.now() + 60_000),
  );
  const secondGrant = await access.grantAssignment(
    admin.id,
    reviewer.id,
    second.learner.id,
    "reviewer",
    "second review",
    new Date(Date.now() + 60_000),
  );
  async function grantExact(evidenceId: string) {
    const submissionId = (
      await pool.query<{ id: string }>(
        "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
        [evidenceId],
      )
    ).rows[0]!.id;
    return access.grantEvidenceReview(
      admin.id,
      reviewer.id,
      evidenceId === secondId ? secondGrant : firstGrant,
      submissionId,
      "exact synthetic evidence review",
      new Date(Date.now() + 60_000),
    );
  }
  const unassignedSubmission = (
    await pool.query<{ id: string }>(
      "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
      [unassignedId],
    )
  ).rows[0]!.id;
  await expect(
    access.grantEvidenceReview(
      admin.id,
      reviewer.id,
      firstGrant,
      unassignedSubmission,
      "wrong workspace",
      new Date(Date.now() + 60_000),
    ),
  ).rejects.toThrow("denied");
  const firstSubmission = (
    await pool.query<{ id: string }>(
      "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
      [firstId],
    )
  ).rows[0]!.id;
  await expect(
    access.grantEvidenceReview(
      first.learner.id,
      reviewer.id,
      firstGrant,
      firstSubmission,
      "member self grant",
      new Date(Date.now() + 60_000),
    ),
  ).rejects.toThrow("denied");
  await expect(
    access.grantEvidenceReview(
      admin.id,
      editor.id,
      firstGrant,
      firstSubmission,
      "editor grant",
      new Date(Date.now() + 60_000),
    ),
  ).rejects.toThrow("denied");
  await expect(
    access.grantEvidenceReview(
      admin.id,
      reviewer.id,
      firstGrant,
      firstSubmission,
      "expired grant",
      new Date(Date.now() - 1000),
    ),
  ).rejects.toThrow("denied");
  const ownerDraftLink = await evidence.issueDownload(first.token, draftId);
  if (ownerDraftLink.kind !== "issued")
    throw new Error("owner link not issued");
  await expect(
    evidence.download(first.token, draftId, ownerDraftLink.capability),
  ).resolves.toMatchObject({ kind: "allowed" });
  await expect(
    evidence.issueDownload(reviewer.token, draftId),
  ).resolves.toEqual({
    kind: "denied",
  });
  await expect(
    evidence.download(reviewer.token, draftId, ownerDraftLink.capability),
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    evidence.issueDownload(reviewer.token, unassignedId),
  ).resolves.toEqual({ kind: "denied" });
  expect(await evidence.submitForReview(first.token, draftId)).toBe(true);
  await expect(
    evidence.issueDownload(reviewer.token, draftId),
  ).resolves.toEqual({
    kind: "denied",
  });
  const draftGrant = await grantExact(draftId);
  const draftLink = await evidence.issueDownload(reviewer.token, draftId);
  if (draftLink.kind !== "issued") throw new Error("reviewer link not issued");
  await expect(
    evidence.download(reviewer.token, draftId, draftLink.capability),
  ).resolves.toMatchObject({ kind: "allowed" });
  expect(await access.revokeEvidenceReview(admin.id, draftGrant)).toBe(true);
  await expect(
    evidence.issueDownload(reviewer.token, draftId),
  ).resolves.toEqual({
    kind: "denied",
  });
  await expect(
    evidence.download(reviewer.token, draftId, draftLink.capability),
  ).resolves.toEqual({ kind: "denied" });
  await grantExact(draftId);
  await pool.query(
    "UPDATE evidence_review_submissions SET status='withdrawn' WHERE evidence_id=$1",
    [draftId],
  );
  await expect(
    evidence.issueDownload(reviewer.token, draftId),
  ).resolves.toEqual({
    kind: "denied",
  });
  await expect(
    evidence.download(reviewer.token, draftId, draftLink.capability),
  ).resolves.toEqual({ kind: "denied" });
  await grantExact(firstId);
  await grantExact(secondId);
  const firstLink = await evidence.issueDownload(reviewer.token, firstId);
  const secondLink = await evidence.issueDownload(reviewer.token, secondId);
  if (firstLink.kind !== "issued" || secondLink.kind !== "issued")
    throw new Error("expected scoped evidence links");
  await expect(
    evidence.download(reviewer.token, secondId, firstLink.capability),
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    evidence.download(reviewer.token, firstId, secondLink.capability),
  ).resolves.toEqual({ kind: "denied" });
  expect(await access.revokeAssignment(admin.id, firstGrant)).toBe(true);
  await expect(
    evidence.download(reviewer.token, firstId, firstLink.capability),
  ).resolves.toEqual({ kind: "denied" });
  await access.grantAssignment(
    admin.id,
    reviewer.id,
    first.learner.id,
    "reviewer",
    "replacement workspace assignment",
    new Date(Date.now() + 60_000),
  );
  await expect(
    evidence.download(reviewer.token, firstId, firstLink.capability),
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    evidence.download(reviewer.token, secondId, secondLink.capability),
  ).resolves.toMatchObject({ kind: "allowed", name: "private.txt" });
  await pool.query(
    "UPDATE assignment_grants SET expires_at=CURRENT_TIMESTAMP WHERE id=$1",
    [secondGrant],
  );
  await expect(
    evidence.download(reviewer.token, secondId, secondLink.capability),
  ).resolves.toEqual({ kind: "denied" });
  const ownerLink = await evidence.issueDownload(first.token, firstId);
  if (ownerLink.kind !== "issued") throw new Error("owner link not issued");
  expect(await evidence.remove(first.token, firstId)).toBe(true);
  await expect(
    evidence.download(first.token, firstId, ownerLink.capability),
  ).resolves.toEqual({ kind: "denied" });
});

it("deletes stored evidence, review state and derived objects through explicit hooks", async () => {
  const owner = await member(),
    other = await member(),
    admin = await staff("platform_admin"),
    reviewer = await staff("reviewer"),
    access = authorizationStore(pool),
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
  const assignmentId = await access.grantAssignment(
    admin.id,
    reviewer.id,
    owner.learner.id,
    "reviewer",
    "synthetic deletion check",
    new Date(Date.now() + 60_000),
  );
  const submissionId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
      [first],
    )
  ).rows[0]!.id;
  await access.grantEvidenceReview(
    admin.id,
    reviewer.id,
    assignmentId,
    submissionId,
    "synthetic deletion check",
    new Date(Date.now() + 60_000),
  );
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
  expect(
    (await pool.query("SELECT count(*) FROM reviewer_evidence_grants")).rows[0]
      .count,
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
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    access.readWorkspace(
      reviewer.token,
      owner.learner.id,
      "review assigned lesson",
    ),
  ).resolves.toEqual({ kind: "denied" });
  await pool.query(
    `UPDATE assignment_grants
     SET starts_at=CURRENT_TIMESTAMP+INTERVAL '1 hour',
         expires_at=CURRENT_TIMESTAMP+INTERVAL '2 hours'
     WHERE id=$1`,
    [coachGrant],
  );
  await expect(
    access.readWorkspace(coach.token, owner.learner.id),
  ).resolves.toEqual({ kind: "denied" });
  await pool.query(
    `UPDATE assignment_grants
     SET starts_at=CURRENT_TIMESTAMP-INTERVAL '1 hour',
         expires_at=CURRENT_TIMESTAMP+INTERVAL '1 hour'
     WHERE id=$1`,
    [coachGrant],
  );
  await expect(
    access.readWorkspace(coach.token, owner.learner.id),
  ).resolves.toMatchObject({ kind: "allowed", via: "assignment" });
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
  expect(created).toMatchObject({
    promptTemplateVersion: null,
    modelContractVersion: null,
    providerOperationReference: null,
  });
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

it("binds synthetic AI versions to one job and stores only the validated operation reference", async () => {
  const jobs = jobStore(pool);
  const registry = deterministicRegistry({}, "test");
  const input = { inventedScenario: "synthetic-ai-provenance" };
  const [first, duplicate] = await Promise.all([
    enqueueAdapterJob(
      jobs,
      registry,
      "ai",
      "summarize",
      input,
      "versioned-ai",
      3,
      aiProvenance,
    ),
    enqueueAdapterJob(
      jobStore(pool),
      registry,
      "ai",
      "summarize",
      input,
      "versioned-ai",
      3,
      aiProvenance,
    ),
  ]);
  expect(duplicate).toEqual(first);
  expect(first).toMatchObject({
    promptTemplateVersion: aiProvenance.promptTemplateVersion,
    modelContractVersion: aiProvenance.modelContractVersion,
    providerOperationReference: null,
  });
  for (const changed of [
    { ...aiProvenance, promptTemplateVersion: "study-reflection-v2" },
    { ...aiProvenance, modelContractVersion: "synthetic-model-v2" },
  ])
    await expect(
      enqueueAdapterJob(
        jobs,
        registry,
        "ai",
        "summarize",
        input,
        "versioned-ai",
        3,
        changed,
      ),
    ).rejects.toThrow("another request");
  const outcome = await runAdapterJob(jobs, registry, first.id, input);
  expect(outcome).toMatchObject({
    executed: true,
    job: {
      status: "succeeded",
      promptTemplateVersion: aiProvenance.promptTemplateVersion,
      modelContractVersion: aiProvenance.modelContractVersion,
      providerOperationReference: outcome.result?.reference,
    },
  });
  expect(outcome.job.providerOperationReference).toMatch(/^test_[a-f0-9]{24}$/);
  expect(
    await jobs.succeed(first.id, randomUUID(), "another-safe-ref"),
  ).toEqual(outcome.job);
  expect(await jobs.find(first.id)).toEqual(outcome.job);
  expect(
    JSON.stringify((await pool.query("SELECT * FROM adapter_jobs")).rows),
  ).not.toContain(input.inventedScenario);
});

it("accepts legacy unversioned AI rows without inventing provenance", async () => {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO adapter_jobs(
       id,adapter,mode,operation,idempotency_key,request_fingerprint,
       status,attempt_count,max_attempts
     ) VALUES($1,'ai','test','summarize','legacy-ai',$2,'succeeded',1,3)`,
    [id, "a".repeat(64)],
  );
  await migrate(pool);
  expect(await jobStore(pool).find(id)).toMatchObject({
    status: "succeeded",
    promptTemplateVersion: null,
    modelContractVersion: null,
    providerOperationReference: null,
  });
  expect(
    (
      await pool.query(
        "SELECT COUNT(*)::integer AS count FROM schema_migrations WHERE version=20",
      )
    ).rows[0],
  ).toMatchObject({ count: 1 });
});

it("rejects unsafe AI operation references before completing a claimed attempt", async () => {
  const jobs = jobStore(pool);
  const created = await enqueueAdapterJob(
    jobs,
    deterministicRegistry({}, "test"),
    "ai",
    "summarize",
    { scenario: "unsafe-reference" },
    "unsafe-reference",
    3,
    aiProvenance,
  );
  const claimed = await jobs.claim(created.id);
  expect(claimed).toBeDefined();
  await expect(
    jobs.succeed(created.id, claimed!.attemptToken, "raw private text"),
  ).rejects.toThrow("safe token");
  await expect(
    jobs.succeed(created.id, claimed!.attemptToken),
  ).rejects.toMatchObject({ code: "23514" });
  expect(await jobs.find(created.id)).toMatchObject({
    status: "running",
    providerOperationReference: null,
  });
  expect(
    await jobs.succeed(created.id, claimed!.attemptToken, "test_valid-ref"),
  ).toMatchObject({
    status: "succeeded",
    providerOperationReference: "test_valid-ref",
  });
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
         id,adapter,mode,operation,idempotency_key,request_fingerprint,max_attempts,
         prompt_template_version,model_contract_version
       ) VALUES($1,'ai','test','summarize','simultaneous-first',$2,3,$3,$4)`,
      [
        winnerId,
        fingerprint,
        aiProvenance.promptTemplateVersion,
        aiProvenance.modelContractVersion,
      ],
    );
    competing = jobStore(contender as unknown as typeof pool).enqueue(
      "ai",
      "test",
      "summarize",
      "simultaneous-first",
      fingerprint,
      3,
      aiProvenance,
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

it("holds an ambiguous AI outcome without replaying the same request or storing raw errors", async () => {
  const marker = "synthetic-private-provider-text";
  let executions = 0;
  const registry: AdapterRegistry = {
    mode: "test",
    adapter(kind) {
      return {
        kind,
        mode: "test",
        async execute() {
          executions += 1;
          throw new Error(marker);
        },
      };
    },
  };
  const jobs = jobStore(pool);
  const input = { scenario: "ambiguous-outcome" };
  const created = await enqueueAdapterJob(
    jobs,
    registry,
    "ai",
    "summarize",
    input,
    "ambiguous-ai",
    3,
    aiProvenance,
  );
  const first = await runAdapterJob(jobs, registry, created.id, input);
  expect(first).toMatchObject({
    executed: true,
    result: null,
    job: {
      status: "needs_reconciliation",
      attempts: 1,
      safeError: "provider_outcome_unknown",
      retryable: false,
      providerOperationReference: null,
    },
  });
  const replay = await enqueueAdapterJob(
    jobs,
    registry,
    "ai",
    "summarize",
    input,
    "ambiguous-ai",
    3,
    aiProvenance,
  );
  expect(replay).toEqual(first.job);
  expect(await runAdapterJob(jobs, registry, created.id, input)).toMatchObject({
    executed: false,
    result: null,
    job: replay,
  });
  expect(executions).toBe(1);
  await expect(
    enqueueAdapterJob(
      jobs,
      registry,
      "ai",
      "summarize",
      { scenario: "different" },
      "ambiguous-ai",
      3,
      aiProvenance,
    ),
  ).rejects.toThrow("another request");
  expect(
    JSON.stringify((await pool.query("SELECT * FROM adapter_jobs")).rows),
  ).not.toContain(marker);
});

it("holds explicit AI timeout even at the attempt limit", async () => {
  const jobs = jobStore(pool);
  const registry = deterministicRegistry({}, "test");
  const created = await enqueueAdapterJob(
    jobs,
    registry,
    "ai",
    "summarize",
    { scenario: "timeout" },
    "timeout-ai",
    1,
    aiProvenance,
  );
  const claim = await jobs.claim(created.id);
  expect(claim).toBeDefined();
  expect(
    await jobs.fail(created.id, claim!.attemptToken, "provider_timeout"),
  ).toMatchObject({
    status: "needs_reconciliation",
    attempts: 1,
    safeError: "provider_timeout",
    retryable: false,
  });
  expect(await jobs.claim(created.id)).toBeUndefined();
});

it("keeps non-AI rows valid while rejecting a non-AI reconciliation state", async () => {
  const jobs = jobStore(pool);
  const created = await enqueueAdapterJob(
    jobs,
    deterministicRegistry({}, "test"),
    "analytics",
    "record",
    { scenario: "migration-boundary" },
    "migration-boundary",
  );
  await expect(
    pool.query(
      "UPDATE adapter_jobs SET status='needs_reconciliation',safe_error='provider_outcome_unknown' WHERE id=$1",
      [created.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  expect(await jobs.find(created.id)).toMatchObject({
    status: "pending",
    safeError: null,
  });
  expect(
    (
      await pool.query(
        "SELECT COUNT(*)::integer AS count FROM schema_migrations WHERE version=19",
      )
    ).rows[0],
  ).toMatchObject({ count: 1 });
});

it("holds an expired AI lease against concurrent claimers and its delayed worker", async () => {
  const jobs = jobStore(pool);
  const otherConnection = testPool();
  let releaseProvider!: () => void;
  let oldRun: Promise<Awaited<ReturnType<typeof runAdapterJob>>> | undefined;
  try {
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const registry: AdapterRegistry = {
      mode: "test",
      adapter(kind) {
        return {
          kind,
          mode: "test",
          async execute() {
            signalEntered();
            await release;
            return {
              kind,
              mode: "test",
              state: "simulated",
              reference: "late_ai_result",
              message: "synthetic late AI result",
            };
          },
        };
      },
    };
    const input = { scenario: "expired-lease" };
    const created = await enqueueAdapterJob(
      jobs,
      registry,
      "ai",
      "summarize",
      input,
      "expired-ai",
      3,
      aiProvenance,
    );
    oldRun = runAdapterJob(jobs, registry, created.id, input);
    await entered;
    await pool.query(
      "UPDATE adapter_jobs SET lease_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1",
      [created.id],
    );
    const [first, second] = await Promise.all([
      jobs.claim(created.id),
      jobStore(otherConnection).claim(created.id),
    ]);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    const held = await jobs.find(created.id);
    expect(held).toMatchObject({
      status: "needs_reconciliation",
      attempts: 1,
      safeError: "provider_outcome_unknown",
      retryable: false,
      providerOperationReference: null,
    });
    releaseProvider();
    expect(await oldRun).toEqual({ job: held, result: null, executed: true });
    const row = (
      await pool.query(
        "SELECT attempt_token, lease_until FROM adapter_jobs WHERE id=$1",
        [created.id],
      )
    ).rows[0];
    expect(row).toMatchObject({ attempt_token: null, lease_until: null });
  } finally {
    releaseProvider?.();
    await oldRun?.catch(() => undefined);
    await otherConnection.end();
  }
});

it("persists only an allowlisted invalid-result code through bounded PostgreSQL retries", async () => {
  const marker = "synthetic-private-provider-text";
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
            state: "configured",
            reference: "test_invalid",
            message: marker,
            privateText: marker,
          } as unknown as AdapterResult;
        },
      };
    },
  };
  const jobs = jobStore(pool);
  const input = { scenario: "invalid-result" };
  const created = await enqueueAdapterJob(
    jobs,
    registry,
    "ai",
    "summarize",
    input,
    "invalid-result",
    2,
    aiProvenance,
  );
  for (const [attempt, status] of [
    [1, "failed"],
    [2, "exhausted"],
  ] as const) {
    const result = await runAdapterJob(jobs, registry, created.id, input);
    expect(result).toMatchObject({
      executed: true,
      result: null,
      job: {
        status,
        attempts: attempt,
        safeError: "invalid_provider_response",
        retryable: attempt === 1,
      },
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    const row = (
      await pool.query("SELECT * FROM adapter_jobs WHERE id=$1", [created.id])
    ).rows[0];
    expect(row).toMatchObject({
      status,
      attempt_count: attempt,
      safe_error: "invalid_provider_response",
      attempt_token: null,
    });
    expect(JSON.stringify(row)).not.toContain(marker);
  }
  expect(await runAdapterJob(jobs, registry, created.id, input)).toMatchObject({
    executed: false,
    result: null,
    job: { status: "exhausted", attempts: 2 },
  });
  expect(executions).toBe(2);
});

it("recovers from an invalid result on the next attempt without returning extra fields", async () => {
  let executions = 0;
  const registry: AdapterRegistry = {
    mode: "test",
    adapter(kind) {
      return {
        kind,
        mode: "test",
        async execute() {
          executions += 1;
          if (executions === 1)
            return {
              kind,
              mode: "test",
              state: "simulated",
              reference: 42,
              message: "bad",
            } as unknown as AdapterResult;
          return {
            kind,
            mode: "test",
            state: "simulated",
            reference: "test_recovered",
            message: "synthetic recovery",
            privateText: "synthetic-private-provider-text",
          } as AdapterResult;
        },
      };
    },
  };
  const jobs = jobStore(pool);
  const input = { scenario: "recover-invalid-result" };
  const created = await enqueueAdapterJob(
    jobs,
    registry,
    "ai",
    "summarize",
    input,
    "recover-invalid-result",
    2,
    aiProvenance,
  );
  expect(await runAdapterJob(jobs, registry, created.id, input)).toMatchObject({
    result: null,
    job: { status: "failed", safeError: "invalid_provider_response" },
  });
  const recovered = await runAdapterJob(jobs, registry, created.id, input);
  expect(recovered.result).toEqual({
    kind: "ai",
    mode: "test",
    state: "simulated",
    reference: "test_recovered",
    message: "synthetic recovery",
  });
  expect(recovered.job).toMatchObject({
    status: "succeeded",
    attempts: 2,
    safeError: null,
  });
  expect(await jobs.find(created.id)).toEqual(recovered.job);
  expect(executions).toBe(2);
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
      "provider_unavailable",
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
    "provider_unavailable",
  );
  expect(
    await jobs.succeed(failed.id, failedAttempt!.attemptToken),
  ).toMatchObject({ status: "exhausted" });
});

it.each(["running", "succeeded", "exhausted", "lost-acknowledgement"])(
  "fences a delayed non-AI provider result after PostgreSQL lease takeover: %s",
  async (replacement) => {
    const jobs = jobStore(pool);
    const newerConnection = testPool();
    let signalEntered!: () => void;
    let releaseProvider!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const registry: AdapterRegistry = {
      mode: "test",
      adapter(kind) {
        return {
          kind,
          mode: "test",
          async execute() {
            signalEntered();
            await release;
            return {
              kind,
              mode: "test",
              state: "simulated",
              reference: "superseded-result",
              message: "synthetic delayed result",
            };
          },
        };
      },
    };
    const input = { event: "lease-takeover" };
    const created = await enqueueAdapterJob(
      jobs,
      registry,
      "storage",
      "put",
      input,
      "takeover",
      2,
    );
    const oldStore =
      replacement === "lost-acknowledgement"
        ? {
            ...jobs,
            async succeed(id: string, attemptToken: string) {
              await jobs.succeed(id, attemptToken);
              throw new Error("synthetic lost acknowledgement");
            },
          }
        : jobs;
    // Attach a rejection handler immediately; assert the outcome after both workers finish.
    const oldRun = runAdapterJob(oldStore, registry, created.id, input).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    try {
      await entered;
      await pool.query(
        "UPDATE adapter_jobs SET lease_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1",
        [created.id],
      );
      const newerJobs = jobStore(newerConnection);
      const newer = await newerJobs.claim(created.id);
      expect(newer).toMatchObject({ status: "running", attempts: 2 });
      if (replacement === "exhausted")
        await newerJobs.fail(
          created.id,
          newer!.attemptToken,
          "provider_timeout",
        );
      else if (replacement !== "running")
        await newerJobs.succeed(created.id, newer!.attemptToken);
      const winner = await newerJobs.find(created.id);
      expect(winner).toMatchObject({
        status:
          replacement === "lost-acknowledgement" ? "succeeded" : replacement,
        attempts: 2,
      });
      releaseProvider();
      const outcome = await oldRun;
      if (replacement === "lost-acknowledgement") {
        expect(outcome.value).toBeNull();
        expect(outcome.error).toMatchObject({
          message: "Could not confirm adapter job completion.",
        });
      } else {
        expect(outcome.error).toBeNull();
        expect(outcome.value).toEqual({
          job: winner,
          result: null,
          executed: true,
        });
      }
      expect(await newerJobs.find(created.id)).toEqual(winner);
    } finally {
      releaseProvider();
      await oldRun;
      await newerConnection.end();
    }
  },
);

it("recovers its own PostgreSQL completion after losing the acknowledgement", async () => {
  const jobs = jobStore(pool);
  const registry = deterministicRegistry({}, "test");
  const input = { event: "ack-lost" };
  const created = await enqueueAdapterJob(
    jobs,
    registry,
    "ai",
    "summarize",
    input,
    "ack-lost",
    3,
    aiProvenance,
  );
  const result = await runAdapterJob(
    {
      ...jobs,
      async succeed(id, attemptToken, reference) {
        await jobs.succeed(id, attemptToken, reference);
        throw new Error("synthetic lost acknowledgement");
      },
    },
    registry,
    created.id,
    input,
  );
  expect(result).toMatchObject({
    job: { status: "succeeded", attempts: 1 },
    executed: true,
    result: { state: "simulated" },
  });
  expect(await jobs.find(created.id)).toEqual(result.job);
});
