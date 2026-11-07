// #125 (CTP-009 follow-up): consented assignment evidence stays pinned to the
// exact submitted version when the assignment, the member's goal or the
// publication status changes later, across the three member profiles.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import { attemptStore } from "../../src/attempts.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { catalogStore } from "../../src/catalog.ts";
import { assignmentEvidenceStore } from "../../src/assignment-evidence.ts";
import { assignmentObjectStorage } from "../../src/assignment-evidence-storage.ts";
import type { AssignmentEvidenceInstruction } from "../../src/assignment-evidence-values.ts";
import { evidenceStore } from "../../src/evidence.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { sampleFeedbackStore } from "../../src/sample-feedback.ts";
import { SAMPLE_FEEDBACK_PURPOSE } from "../../src/sample-feedback-values.ts";
import type { Background, Domain, Goal } from "../../src/content.ts";

const pool = testPool(),
  db = store(pool),
  attempts = attemptStore(pool),
  auth = authorizationStore(pool),
  catalog = catalogStore(pool),
  copies = assignmentEvidenceStore(pool, { enabled: true });
const files = {
  put: vi.fn(async () => {}),
  get: vi.fn(async () => Buffer.from("unexpected physical fallback")),
  remove: vi.fn(async () => {}),
};
const objects = assignmentObjectStorage(pool, files),
  evidence = evidenceStore(pool, objects, "invented-test-secret"),
  feedback = sampleFeedbackStore(pool, objects);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const end = () => new Date(Date.now() + 3600000);

beforeAll(async () => {
  await migrate(pool);
}, 30000);
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  vi.clearAllMocks();
});
afterAll(async () => {
  await pool.end();
});

async function staff() {
  const editor = randomBytes(32).toString("hex"),
    reviewer = randomBytes(32).toString("hex");
  await auth.provisionStaff(editor, "editor", end());
  const reviewerId = await auth.provisionStaff(reviewer, "reviewer", end());
  const admin = await auth.provisionStaff(
    randomBytes(32).toString("hex"),
    "platform_admin",
    end(),
  );
  return { editor, reviewer, reviewerId, admin };
}
type Staff = Awaited<ReturnType<typeof staff>>;
interface Version {
  id: string;
  version: number;
  title: string;
  rubric: string;
  rubricVersion: number;
  goals: Goal[];
  backgrounds: Background[];
  domains: Domain[];
}
async function publish(s: Staff, v: Version) {
  expect(
    await catalog.createDraft(s.editor, {
      ...v,
      kind: "assignment",
      origin: "curated",
      body: `${v.title}: compare invented options.`,
      owner: "Synthetic editor",
      sources: "Original invented example",
      rights: "Owned sample",
      prerequisites: "None",
    }),
  ).toBe(true);
  expect(await catalog.submit(s.editor, v.id, v.version)).toBe(true);
  expect(await catalog.approve(s.reviewer, v.id, v.version, true)).toBe(true);
  expect(await catalog.publish(s.editor, v.id, v.version)).toBe(true);
}
async function member(
  background: Background,
  goal: Goal,
  domainTags: Domain[] = [],
) {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background, goal });
  const session = await db.session(token);
  if (session.kind !== "active") throw Error("Invented member missing");
  if (domainTags.length) await profile(token, background, goal, domainTags);
  return { token, id: session.learner.id };
}
async function profile(
  token: string,
  background: Background,
  goal: Goal,
  domainTags: Domain[] = [],
) {
  expect(
    await db.updateProfile(token, {
      displayName: "Invented member",
      background,
      goal,
      backgroundTags: [],
      domainTags,
      itRoles: [],
      experience: null,
      exploratory: false,
    }),
  ).toBe(true);
}
// Choose, save and submit one response; returns the exact copy instruction.
async function submitted(
  token: string,
  v: Pick<Version, "id" | "version" | "rubricVersion">,
  response: string,
): Promise<AssignmentEvidenceInstruction> {
  expect(await db.chooseAssignment(token, v.id, v.version)).toBe(true);
  const attemptId = await attempts.start(token);
  if (!attemptId) throw Error("Invented attempt missing");
  expect(await attempts.save(token, attemptId, 1, response)).toBe(true);
  expect(await attempts.submit(token, attemptId, 2)).toBe(true);
  return {
    operationId: randomUUID(),
    attemptId,
    sequence: 1,
    contentId: v.id,
    contentVersion: v.version,
    rubricVersion: v.rubricVersion,
    sourceSha256: sha(response),
    privateReview: true,
  };
}
async function copy(token: string, input: AssignmentEvidenceInstruction) {
  const result = await copies.create(token, input);
  expect(result.kind).toBe("created");
  if (result.kind !== "created" || !result.receipt.evidenceId)
    throw Error(JSON.stringify(result));
  return result.receipt;
}
// The member requests review and an administrator grants one exact reviewer.
async function grantReview(
  s: Staff,
  owner: { token: string; id: string },
  evidenceId: string,
) {
  expect(await evidence.submitForReview(owner.token, evidenceId)).toBe(true);
  const submission = (
    await pool.query(
      "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
      [evidenceId],
    )
  ).rows[0].id;
  const assignment = await auth.grantAssignment(
    s.admin,
    s.reviewerId,
    owner.id,
    "reviewer",
    "Invented feedback",
    end(),
  );
  await auth.grantEvidenceReview(
    s.admin,
    s.reviewerId,
    assignment,
    submission,
    SAMPLE_FEEDBACK_PURPOSE,
    end(),
  );
}
const count = async (table: string) =>
  (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;

it("AEV-01 a newer assignment version, a changed goal and retirement never migrate a pinned copy", async () => {
  // Given a member submitted version 1 and consented to one exact copy
  const s = await staff(),
    owner = await member("explorer", "everyday");
  const v1: Version = {
    id: "SYN-125",
    version: 1,
    title: "Invented reading plan",
    rubric: "Explain the options and check one assumption.",
    rubricVersion: 4,
    goals: ["everyday"],
    backgrounds: [],
    domains: [],
  };
  await publish(s, v1);
  const first = "An invented reading plan checks one assumption first.",
    v1Input = await submitted(owner.token, v1, first),
    v1Receipt = await copy(owner.token, v1Input);

  // When the editor publishes version 2 with a different title and rubric,
  // and the member changes their learning goal
  const v2: Version = {
    ...v1,
    version: 2,
    title: "Invented reading plan, revised",
    rubric: "Compare two options and name one risk.",
    rubricVersion: 5,
    goals: ["work"],
  };
  await publish(s, v2);
  await profile(owner.token, "explorer", "work");

  // Then the original submission still opens with its own version and rubric
  expect(await copies.open(owner.token, v1Input.attemptId, 1)).toMatchObject({
    kind: "ready",
    source: {
      contentVersion: 1,
      title: v1.title,
      rubric: v1.rubric,
      rubricVersion: 4,
      response: first,
    },
  });
  // And the receipt keeps the pinned provenance
  const pinned = {
    attemptId: v1Input.attemptId,
    contentId: v1.id,
    contentVersion: 1,
    rubricVersion: 4,
    sourceSha256: sha(first),
  };
  expect(await copies.inspect(owner.token, v1Input.operationId)).toMatchObject({
    kind: "ready",
    receipt: { state: "available", assignmentOrigin: pinned },
  });
  // And a copy request claiming the new version for the old submission is refused
  expect(
    await copies.create(owner.token, {
      ...v1Input,
      operationId: randomUUID(),
      contentVersion: 2,
      rubricVersion: 5,
    }),
  ).toEqual({ kind: "conflict" });

  // When the member submits version 2 and copies it
  const second = "A revised invented plan compares two options and one risk.",
    v2Input = await submitted(owner.token, v2, second),
    v2Receipt = await copy(owner.token, v2Input);
  // Then the two copies stay separate, each with its own pinned version
  expect(v2Receipt.evidenceId).not.toBe(v1Receipt.evidenceId);
  expect(v2Receipt.assignmentOrigin).toMatchObject({
    contentVersion: 2,
    rubricVersion: 5,
    sourceSha256: sha(second),
  });
  // And an old-version instruction cannot be replayed onto the new attempt
  expect(
    await copies.create(owner.token, {
      ...v2Input,
      operationId: randomUUID(),
      contentVersion: 1,
      rubricVersion: 4,
    }),
  ).toEqual({ kind: "conflict" });

  // When the assignment is retired
  expect(await catalog.retire(s.editor, v1.id)).toBe(true);
  // Then both receipts are still available with unchanged provenance
  expect(await copies.inspect(owner.token, v1Input.operationId)).toMatchObject({
    kind: "ready",
    receipt: { state: "available", assignmentOrigin: pinned },
  });
  expect(await copies.inspect(owner.token, v2Input.operationId)).toMatchObject({
    kind: "ready",
    receipt: { state: "available", assignmentOrigin: { contentVersion: 2 } },
  });
  // And no review was requested or granted automatically
  expect(await count("evidence_review_submissions")).toBe(0);
  expect(await feedback.reviewer(s.reviewer, v1Receipt.evidenceId!)).toEqual({
    kind: "denied",
  });

  // When review is deliberately requested and granted for the old copy only
  await grantReview(s, owner, v1Receipt.evidenceId!);
  // Then the reviewer sees the original bytes and version 1 provenance
  expect(
    await feedback.reviewer(s.reviewer, v1Receipt.evidenceId!),
  ).toMatchObject({
    kind: "ready",
    source: first,
    sourceSha256: sha(first),
    assignmentOrigin: pinned,
  });
  // And never the newer copy
  expect(await feedback.reviewer(s.reviewer, v2Receipt.evidenceId!)).toEqual({
    kind: "denied",
  });
  // And the owner's export keeps each exact version
  const exported = await memberExportStore(pool).exportOwned(owner.token);
  if (exported.kind !== "ready") throw Error("Member export unavailable");
  expect(
    (exported.payload.records.assignmentEvidenceOrigins ?? [])
      .map((row) => row.assignmentOrigin as { contentVersion: number })
      .sort((a, b) => a.contentVersion - b.contentVersion),
  ).toMatchObject([pinned, { contentVersion: 2, rubricVersion: 5 }]);
  // And the stored rows were never rewritten
  expect(
    (
      await pool.query(
        "SELECT content_version v,rubric_version r FROM assignment_evidence_origins ORDER BY content_version",
      )
    ).rows,
  ).toEqual([
    { v: 1, r: 4 },
    { v: 2, r: 5 },
  ]);
});

it("AEV-02 IT, non-IT professional and general-learning members each copy only their own exact submission", async () => {
  const s = await staff();
  const examples = [
    {
      profile: ["technical", "build", []] as const,
      version: {
        id: "ITX-125",
        title: "Invented deployment checklist",
        rubric: "Name one rollback check.",
        goals: ["build"],
        backgrounds: ["technical"],
        domains: [],
      },
      response: "An invented checklist confirms the rollback path first.",
    },
    {
      profile: ["professional", "work", ["health"]] as const,
      version: {
        id: "PRO-125",
        title: "Invented clinic rota note",
        rubric: "Explain one privacy check.",
        goals: ["work"],
        backgrounds: ["professional"],
        domains: ["health"],
      },
      response: "An invented rota note removes names before sharing.",
    },
    {
      profile: ["explorer", "everyday", []] as const,
      version: {
        id: "GEN-125",
        title: "Invented weekly meal plan",
        rubric: "Check one assumption.",
        goals: ["everyday"],
        backgrounds: ["explorer"],
        domains: [],
      },
      response: "An invented meal plan checks the shopping budget.",
    },
  ];
  const done = [];
  for (const example of examples) {
    const v = {
      ...example.version,
      version: 1,
      rubricVersion: 1,
    } as Version;
    await publish(s, v);
    const [background, goal, domains] = example.profile,
      owner = await member(background, goal, [...domains]),
      input = await submitted(owner.token, v, example.response),
      receipt = await copy(owner.token, input);
    // Each copy pins its own assignment and bytes
    expect(receipt.assignmentOrigin).toMatchObject({
      contentId: v.id,
      contentVersion: 1,
      sourceSha256: sha(example.response),
      label: "Member assignment submission · private · unreviewed",
    });
    done.push({ owner, input, receipt });
  }
  // No member can preview, copy or inspect another member's submission
  for (const [index, { owner }] of done.entries()) {
    const other = done[(index + 1) % done.length]!;
    expect(await copies.open(owner.token, other.input.attemptId, 1)).toEqual({
      kind: "denied",
    });
    expect(
      await copies.create(owner.token, {
        ...other.input,
        operationId: randomUUID(),
      }),
    ).toEqual({ kind: "denied" });
    // OPKEY-03: another member's key reads exactly like an unused one.
    expect(
      await copies.inspect(owner.token, other.input.operationId),
    ).toMatchObject({ kind: "absent" });
    const exported = await memberExportStore(pool).exportOwned(owner.token);
    if (exported.kind !== "ready") throw Error("Member export unavailable");
    expect(
      (exported.payload.records.assignmentEvidenceOrigins ?? []).map(
        (row) => row.evidenceId,
      ),
    ).toEqual([done[index]!.receipt.evidenceId]);
  }
  // And nothing reached a reviewer
  expect(await count("evidence_objects")).toBe(3);
  expect(await count("evidence_review_submissions")).toBe(0);
  for (const { receipt } of done)
    expect(await feedback.reviewer(s.reviewer, receipt.evidenceId!)).toEqual({
      kind: "denied",
    });
});
