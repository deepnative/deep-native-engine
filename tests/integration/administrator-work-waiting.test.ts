import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  administratorDiagnostics,
  type DiagnosticsResult,
} from "../../src/administrator-diagnostics.ts";
import type { WorkWaiting } from "../../src/administrator-work-waiting.ts";
import { sampleAssignmentIntake } from "../../src/sample-assignment-intake.ts";
import { migrate, store } from "../../src/store.ts";
import { supportAssignmentStore } from "../../src/support-assignment.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { workflowReviewStaffStore } from "../../src/workflow-review-staff.ts";
import { workflowReviewStore } from "../../src/workflow-review.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { sampleAssignmentFixture } from "../support/sample-assignment.ts";

const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  diagnostics = administratorDiagnostics(pool),
  support = supportRequestStore(pool),
  assignments = supportAssignmentStore(pool, "invented-work-waiting-cursor"),
  flags = { enabled: true, mode: "test" as const },
  secret = "invented-work-waiting-secret",
  reviews = workflowReviewStore(pool, flags, secret),
  reviewStaff = workflowReviewStaffStore(pool, flags, secret),
  fresh = () => randomBytes(32).toString("hex"),
  later = () => new Date(Date.now() + 3600000);
let root = "";
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne39-waiting-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
afterAll(() => pool.end());

function ready(result: DiagnosticsResult<WorkWaiting>) {
  if (result.kind !== "ready") throw Error("Expected counts: " + result.kind);
  return result.value;
}
async function administrator() {
  const token = fresh();
  await auth.provisionStaff(token, "platform_admin", later());
  return token;
}
async function member() {
  const token = fresh();
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  return { token, id: session.learner.id };
}
async function supportRequest(owner: string) {
  const created = await support.create(owner, {
    idempotencyKey: randomUUID(),
    subject: "PRIVATE-SUBJECT",
    body: "PRIVATE-MEMBER-CONTENT",
  });
  if (!("receipt" in created)) throw Error("Invented request unavailable");
  return created.receipt.requestId;
}
async function workflowRequest(owner: string, note = "Invented note") {
  expect(
    await workflowFeedbackStore(pool).save(owner, "WF-001", 3, note, 0),
  ).toBe(true);
  const preview = await reviews.preview(owner, "WF-001");
  if (preview.kind !== "ready") throw Error("Owned preview required");
  const request = await reviews.request(owner, {
    checked: preview.preview.checked,
    operationId: randomUUID(),
    confirm: "yes",
  });
  if (request.kind !== "applied") throw Error("Member request required");
  return request.receipt.requestId;
}
async function proposal(memberId: string, state: string) {
  const removed = state === "rejected" || state === "withdrawn",
    reviewed = state === "rejected" || state === "quarantined",
    returned = state === "changes_requested",
    entered = state !== "draft" && state !== "withdrawn";
  const moderator =
    reviewed || returned
      ? await auth.provisionStaff(fresh(), "moderator", later())
      : null;
  await pool.query(
    `INSERT INTO member_proposals(id,member_id,title,body,sources,state,sample_attested_at,rights_attested_at,submitted_at,withdrawn_at,moderated_by,moderated_at,change_feedback,change_feedback_revision,changes_requested_at)
     VALUES($1,$2,$3,$3,$3,$4,now(),$12,$5,$6,$7,$8,$9,$10,$11)`,
    [
      randomUUID(),
      memberId,
      removed ? null : "PRIVATE-PROPOSAL",
      state,
      // A minute past two hours, so a database clock a few ms behind still reads 120.
      entered ? new Date(Date.now() - 7260000) : null,
      state === "withdrawn" ? new Date() : null,
      moderator,
      reviewed || returned ? new Date() : null,
      returned ? "Invented change request" : null,
      returned ? 1 : null,
      returned ? new Date() : null,
      entered && !returned ? new Date(Date.now() - 7200000) : null,
    ],
  );
}

it("WAITWORK-01 counts an unassigned support request with its age and no member content", async () => {
  const admin = await administrator(),
    owner = await member();
  // Received time is immutable, so an older request is inserted as one.
  const id = randomUUID();
  await pool.query(
    `INSERT INTO support_requests(id,member_id,workspace_id,intake_key,subject,body,received_at)
     VALUES($1,$2,$2,$3,'PRIVATE-SUBJECT','PRIVATE-MEMBER-CONTENT',clock_timestamp()-INTERVAL '3 hours')`,
    [id, owner.id, randomUUID()],
  );
  const value = ready(await diagnostics.work(admin));
  expect(value.support).toMatchObject({ waiting: 1, assigned: 0 });
  expect(value.support.oldestWaitingMinutes).toBeGreaterThanOrEqual(180);
  expect(value.support.oldestWaitingMinutes).toBeLessThan(182);
  const text = JSON.stringify(value);
  expect(text).not.toContain("PRIVATE");
  expect(text).not.toContain(owner.id);
  expect(text).not.toContain(id);
});

it("WAITWORK-02 moves support between waiting and assigned, and drops finished requests", async () => {
  const admin = await administrator(),
    operator = fresh(),
    owner = await member();
  const staffId = await auth.provisionStaff(operator, "operator", later());
  const id = await supportRequest(owner.token);
  const granted = await assignments.assign(admin, {
    requestId: id,
    staffId,
    idempotencyKey: randomUUID(),
    startsAt: new Date(Date.now() - 60000),
    expiresAt: new Date(Date.now() + 1800000),
  });
  expect(granted.kind).toBe("ready");
  const assigned = ready(await diagnostics.work(admin)).support;
  expect(assigned).toMatchObject({ waiting: 0, assigned: 1, people: 1 });
  expect(assigned.oldestWaitingMinutes).toBeNull();
  expect(assigned.oldestAssignedMinutes).toBeGreaterThanOrEqual(0);

  // A lapsed assignment leaves the request waiting for someone new.
  await pool.query(
    "UPDATE support_request_grants SET revoked_at=clock_timestamp() WHERE request_id=$1",
    [id],
  );
  expect(ready(await diagnostics.work(admin)).support).toMatchObject({
    waiting: 1,
    assigned: 0,
  });
  await pool.query(
    "UPDATE support_requests SET resolved_at=clock_timestamp(),resolved_by=$2 WHERE id=$1",
    [id, staffId],
  );
  expect(ready(await diagnostics.work(admin)).support).toMatchObject({
    waiting: 0,
    assigned: 0,
  });
  const withdrawn = await supportRequest(owner.token);
  await pool.query(
    "UPDATE support_requests SET withdrawn_at=clock_timestamp(),subject=NULL,body=NULL WHERE id=$1",
    [withdrawn],
  );
  expect(ready(await diagnostics.work(admin)).support.waiting).toBe(0);
});

it("WAITWORK-03 matches the pending feedback list, then counts assigned work until feedback is published", async () => {
  const f = await sampleAssignmentFixture(pool, root);
  const pending = await sampleAssignmentIntake(
    pool,
    true,
    randomBytes(32),
  ).pending(f.administratorToken);
  if (pending.kind !== "ready") throw Error("Pending list unavailable");
  expect(pending.items).toHaveLength(1);
  const waiting = ready(await diagnostics.work(f.administratorToken)).feedback;
  expect(waiting).toMatchObject({ waiting: 1, assigned: 0, people: 1 });
  expect(waiting.oldestWaitingMinutes).toBeGreaterThanOrEqual(0);

  expect((await f.assignments.assign(f.administratorToken, f.input)).kind).toBe(
    "applied",
  );
  const assigned = ready(await diagnostics.work(f.administratorToken)).feedback;
  expect(assigned).toMatchObject({ waiting: 0, assigned: 1 });
  expect(assigned.oldestAssignedMinutes).toBeGreaterThanOrEqual(0);
});

it("WAITWORK-04 lists waiting workflow review references, oldest first, and excludes settled requests", async () => {
  const admin = await administrator(),
    moderator = fresh();
  const moderatorId = await auth.provisionStaff(
    moderator,
    "moderator",
    later(),
  );
  const first = await member(),
    second = await member(),
    expired = await member(),
    superseded = await member(),
    withdrawn = await member(),
    taken = await member();
  const oldest = await workflowRequest(first.token);
  const newest = await workflowRequest(second.token);
  await pool.query(
    "UPDATE workflow_review_requests SET created_at=clock_timestamp()-INTERVAL '2 days' WHERE id=$1",
    [oldest],
  );
  await pool.query(
    "UPDATE workflow_review_requests SET expires_at=clock_timestamp()-INTERVAL '1 minute',created_at=clock_timestamp()-INTERVAL '1 day' WHERE id=$1",
    [await workflowRequest(expired.token)],
  );
  await workflowRequest(superseded.token);
  await pool.query(
    "UPDATE workflow_feedback SET revision=revision+1 WHERE member_id=$1",
    [superseded.id],
  );
  await pool.query(
    "UPDATE workflow_review_requests SET withdrawn_at=clock_timestamp() WHERE id=$1",
    [await workflowRequest(withdrawn.token)],
  );
  const checked = await reviewStaff.check(
    admin,
    await workflowRequest(taken.token),
    moderatorId,
  );
  if (checked.kind !== "ready") throw Error("Checked moderator required");
  expect(
    (await reviewStaff.assign(admin, checked.checked, randomUUID(), "yes"))
      .kind,
  ).toBe("applied");

  const value = ready(await diagnostics.work(admin)).workflow;
  expect(value).toMatchObject({
    waiting: 2,
    assigned: 1,
    people: 1,
    references: [oldest, newest],
  });
  expect(value.oldestWaitingMinutes).toBeGreaterThanOrEqual(2880);
  expect(value.oldestAssignedMinutes).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(value)).not.toContain("Invented note");
});

it("WAITWORK-04 caps the listed references at 20 and keeps the full count", async () => {
  const admin = await administrator();
  for (let i = 0; i < 21; i++) await workflowRequest((await member()).token);
  const value = ready(await diagnostics.work(admin)).workflow;
  expect(value.waiting).toBe(21);
  expect(value.references).toHaveLength(20);
});

it("WAITWORK-05 counts only submitted contributions", async () => {
  const admin = await administrator(),
    owner = await member();
  for (const state of [
    "draft",
    "quarantined",
    "rejected",
    "withdrawn",
    "changes_requested",
  ])
    await proposal(owner.id, state);
  expect(ready(await diagnostics.work(admin)).contributions).toMatchObject({
    waiting: 0,
    assigned: null,
  });
  await proposal(owner.id, "submitted");
  const value = ready(await diagnostics.work(admin)).contributions;
  expect(value).toMatchObject({ waiting: 1, assigned: null });
  expect(value.oldestWaitingMinutes).toBeGreaterThanOrEqual(120);
  expect(value.oldestAssignedMinutes).toBeNull();
  expect(JSON.stringify(value)).not.toContain("PRIVATE");
});

it("WAITWORK-06 ignores work from deleting or revoked members", async () => {
  const admin = await administrator(),
    deleting = await member(),
    revoked = await member();
  for (const owner of [deleting, revoked]) {
    await supportRequest(owner.token);
    await workflowRequest(owner.token);
    await proposal(owner.id, "submitted");
  }
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
    [deleting.id],
  );
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [revoked.id],
  );
  const value = ready(await diagnostics.work(admin));
  expect(value.support.waiting).toBe(0);
  expect(value.workflow.waiting).toBe(0);
  expect(value.contributions.waiting).toBe(0);
});

it("WAITWORK-07 returns denied to anyone but a current administrator", async () => {
  const owner = await member(),
    moderator = fresh(),
    expired = fresh();
  await auth.provisionStaff(moderator, "moderator", later());
  await auth.provisionStaff(expired, "platform_admin", later());
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-INTERVAL '1 minute' WHERE kind='staff' AND id NOT IN (SELECT principal_id FROM staff_profiles WHERE role='moderator')",
  );
  for (const credential of [
    owner.token,
    moderator,
    expired,
    "not-a-credential",
  ])
    expect(await diagnostics.work(credential)).toEqual({ kind: "denied" });
});

it("WAITWORK-09 counts current people per queue, excluding expired or revoked staff", async () => {
  const admin = await administrator(),
    empty = ready(await diagnostics.work(admin));
  // The administrator can moderate contributions but no other queue.
  expect(empty.support.people).toBe(0);
  expect(empty.feedback.people).toBe(0);
  expect(empty.workflow.people).toBe(0);
  expect(empty.contributions.people).toBe(1);

  const moderatorId = await auth.provisionStaff(fresh(), "moderator", later());
  await auth.provisionStaff(fresh(), "operator", later());
  const gone = await auth.provisionStaff(fresh(), "operator", later());
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [gone],
  );
  const value = ready(await diagnostics.work(admin));
  expect(value.support.people).toBe(1);
  expect(value.workflow.people).toBe(1);
  expect(value.contributions.people).toBe(2);
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-INTERVAL '1 minute' WHERE id=$1",
    [moderatorId],
  );
  expect(ready(await diagnostics.work(admin)).workflow.people).toBe(0);
});
