import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { reviewTimeGrants } from "../../src/review-time-grants.ts";
import { reviewTimeStore } from "../../src/review-time-store.ts";
import { sampleFeedbackStore } from "../../src/sample-feedback.ts";
import { SAMPLE_FEEDBACK_PURPOSE } from "../../src/sample-feedback-values.ts";
import { COOKIE } from "../../src/session.ts";
import {
  staffCapacityStore,
  type StaffCapacityResult,
} from "../../src/staff-capacity.ts";
import { migrate, store } from "../../src/store.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #123 CAP-01..09 on real PostgreSQL with invented roster records only.
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  report = staffCapacityStore(pool),
  minutes = reviewTimeStore(pool, { enabled: true, mode: "test" }),
  timeGrants = reviewTimeGrants(pool, { enabled: true, mode: "test" }),
  application = app(members, {
    origin: "http://127.0.0.1:3000",
    secret: "native-staff-capacity-test",
    mode: "test",
    staffCapacity: report,
  }),
  path = "/operator/staff-capacity",
  hour = 3_600_000;
let root = "";
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne-capacity-test-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
afterAll(() => pool.end());

const ready = (result: StaffCapacityResult) => {
  if (result.kind !== "ready") throw Error(`Expected report: ${result.kind}`);
  return result.value;
};
const staff = async (
  role: "coach" | "reviewer" | "operator" | "platform_admin" | "editor",
) => {
  const token = randomBytes(32).toString("hex");
  const id = await auth.provisionStaff(
    token,
    role,
    new Date(Date.now() + 10 * 86_400_000),
  );
  return { token, id };
};
interface Roster {
  staffId: string;
  role?: "coach" | "reviewer";
  backup?: string | null;
  verifier?: string | null;
  capacity?: number;
  committed?: number;
  starts?: Date;
  ends?: Date;
  retired?: boolean;
  qualification?: string;
}
async function roster(r: Roster) {
  const id = randomUUID(),
    role = r.role ?? "coach";
  await pool.query(
    `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,
       loaded_cost_cents,capacity_minutes,committed_minutes,backup_staff_id,
       qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at,retired_at)
     VALUES($1,$2,$3,'education',$4,$5,$6,987654,$7,$8,$9,$10,'INVENTED-AGREEMENT-REF','INVENTED-CONFLICT-REF',
       $11::uuid,CASE WHEN $11::uuid IS NULL THEN NULL ELSE clock_timestamp()-interval '1 minute' END,
       CASE WHEN $12 THEN clock_timestamp() END)`,
    [
      id,
      r.staffId,
      role,
      role === "coach" ? "coaching" : "formal-review",
      r.starts ?? new Date(Date.now() - hour),
      r.ends ?? new Date(Date.now() + 30 * 86_400_000),
      r.capacity ?? 120,
      r.committed ?? 0,
      r.backup ?? null,
      r.qualification ?? "INVENTED-QUALIFICATION-REF",
      r.verifier === undefined ? verifierId : r.verifier,
      r.retired ?? false,
    ],
  );
  return id;
}
async function slot(registryId: string, startsIn: number, retired = false) {
  const starts = new Date(Math.floor((Date.now() + startsIn) / 60000) * 60000);
  await pool.query(
    `INSERT INTO expert_availability_slots(id,expert_registry_id,starts_at,ends_at,created_by,retired_at)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      randomUUID(),
      registryId,
      starts,
      new Date(+starts + hour),
      verifierId,
      retired ? new Date() : null,
    ],
  );
}
let verifierId = "";
const get = (url: string, token?: string) =>
  withLoopback(application, (s) => {
    const r = request(s).get(url).set("Host", "127.0.0.1:3000");
    return token ? r.set("Cookie", `${COOKIE}=${token}`) : r;
  });

it("CAP-01 an empty roster and no review time read as nothing to compare", async () => {
  const admin = await staff("platform_admin");
  const value = ready(await report.snapshot(admin.token));
  for (const group of value.groups)
    expect(group).toMatchObject({
      status: "empty",
      records: 0,
      notCurrent: 0,
      capacityMinutes: 0,
      availableMinutes: null,
    });
  expect(value.reviewTime).toMatchObject({
    status: "empty",
    open: 0,
    completed: 0,
  });
  const page = await get(path, admin.token);
  expect(page.status).toBe(200);
  expect(page.text).toMatch(/data-field="coaching.available">Not recorded/);
  expect(page.text).toContain("No review time to compare.");
});

it("CAP-02..06 and CAP-09 verified, unverified and lapsed records stay apart; reading changes nothing", async () => {
  const admin = await staff("platform_admin");
  verifierId = admin.id;
  const [a, b, c, d, e, h, k] = await Promise.all(
    Array.from({ length: 7 }, () => staff("coach")),
  );
  const [r1, r2] = await Promise.all([staff("reviewer"), staff("reviewer")]);
  // Covered coaching pair: A has 300 - 60 committed - one 60-minute slot.
  const aRecord = await roster({
    staffId: a!.id,
    backup: b!.id,
    capacity: 300,
    committed: 60,
  });
  await roster({ staffId: b!.id, backup: a!.id, capacity: 120 });
  await slot(aRecord, 2 * 86_400_000);
  await slot(aRecord, 3 * 86_400_000, true);
  // Unverified: no verifier, and a blank qualification reference.
  await roster({
    staffId: c!.id,
    backup: a!.id,
    verifier: null,
    capacity: 480,
    committed: 30,
  });
  await roster({
    staffId: k!.id,
    backup: a!.id,
    capacity: 90,
    qualification: "   ",
  });
  // Verified, but the named backup has no record at all.
  await roster({ staffId: d!.id, backup: e!.id, capacity: 200 });
  // Verified, but this staff member's access has ended.
  await roster({ staffId: h!.id, backup: a!.id, capacity: 100 });
  await pool.query("UPDATE principals SET revoked_at=now() WHERE id=$1", [
    h!.id,
  ]);
  // Not current: expired, retired, and not yet started.
  await roster({
    staffId: e!.id,
    backup: a!.id,
    starts: new Date(Date.now() - 3 * hour),
    ends: new Date(Date.now() - 2 * hour),
  });
  await roster({ staffId: e!.id, backup: a!.id, retired: true });
  await roster({
    staffId: e!.id,
    backup: a!.id,
    starts: new Date(Date.now() + 86_400_000),
  });
  // Formal review: R1 is committed past capacity by its open slot; R2 has room.
  const r1Record = await roster({
    staffId: r1!.id,
    role: "reviewer",
    backup: r2!.id,
    capacity: 60,
    committed: 60,
  });
  await roster({
    staffId: r2!.id,
    role: "reviewer",
    backup: r1!.id,
    capacity: 120,
  });
  await slot(r1Record, 2 * 86_400_000);

  const counts = async () =>
    (
      await pool.query(
        `SELECT (SELECT count(*) FROM expert_registry)::int roster,
          (SELECT count(*) FROM expert_availability_slots)::int slots,
          (SELECT md5(string_agg(e::text,',' ORDER BY e.id)) FROM expert_registry e) digest`,
      )
    ).rows[0];
  const before = await counts();
  const value = ready(await report.snapshot(admin.token));
  expect(value.groups[0]).toEqual({
    service: "coaching",
    status: "consistent",
    records: 6,
    notCurrent: 3,
    covered: 2,
    capacityMinutes: 420,
    committedMinutes: 60,
    slotMinutes: 60,
    heldSlots: 0,
    availableMinutes: 300,
    overcommitted: 0,
    overcommitMinutes: 0,
    unverified: 2,
    unverifiedCapacityMinutes: 570,
    unverifiedCommittedMinutes: 30,
    noBackup: 1,
    noBackupCapacityMinutes: 200,
    inactive: 1,
    inactiveCapacityMinutes: 100,
  });
  expect(value.groups[1]).toMatchObject({
    service: "formal-review",
    status: "discrepancies",
    records: 2,
    covered: 2,
    capacityMinutes: 180,
    availableMinutes: 120,
    overcommitted: 1,
    overcommitMinutes: 60,
    unverified: 0,
  });

  const operator = await staff("operator");
  const page = await get(path, operator.token);
  expect(page.status).toBe(200);
  expect(page.headers["cache-control"]).toBe("no-store");
  expect(page.text).toMatch(
    /Unverified records, not qualified coverage \(2\)<\/dt><dd data-field="coaching.unverified">570 min declared/,
  );
  expect(page.text).toMatch(/data-field="formal-review.overcommitted">60 min/);
  for (const secret of [
    a!.id,
    r1!.id,
    admin.id,
    aRecord,
    "INVENTED-QUALIFICATION-REF",
    "INVENTED-AGREEMENT-REF",
    "INVENTED-CONFLICT-REF",
    "9876.54",
    "9,876.54",
  ])
    expect(page.text).not.toContain(secret);
  expect(await counts()).toEqual(before);
});

// The same invented private-review fixture the review-time tests use.
async function allocation(granted: boolean) {
  const ownerToken = randomBytes(32).toString("hex"),
    reviewerToken = randomBytes(32).toString("hex"),
    adminToken = randomBytes(32).toString("hex");
  await members.create(ownerToken, {
    background: "professional",
    goal: "everyday",
  });
  const owner = await members.session(ownerToken);
  if (owner.kind !== "active") throw Error("Expected active owner");
  const end = new Date(Date.now() + hour),
    admin = await auth.provisionStaff(adminToken, "platform_admin", end),
    reviewer = await auth.provisionStaff(reviewerToken, "reviewer", end),
    objects = fileObjectStorage(root),
    evidence = evidenceStore(pool, objects, "invented-capacity-secret"),
    feedback = sampleFeedbackStore(pool, objects, {
      reviewTimeWrites: true,
      mode: "test",
    });
  const upload = await evidence.upload(ownerToken, {
    name: "Invented capacity sample",
    mediaType: "text/plain",
    data: Buffer.from("An invented team checks claims against its sources."),
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
    "invented capacity review",
    end,
  );
  await auth.grantEvidenceReview(
    admin,
    reviewer,
    assignment,
    submission,
    SAMPLE_FEEDBACK_PURPOSE,
    end,
  );
  await syntheticLedger(pool).grant(
    owner.learner.id,
    "review_minutes",
    20,
    randomUUID(),
    {
      startsAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: end.toISOString(),
    },
  );
  const held = await minutes.allocate(ownerToken, upload.id, randomUUID(), 20);
  if (held.kind !== "applied") throw Error("Expected allocated minutes");
  const allocationId = held.receipt.allocationId;
  let grantId = "";
  if (granted) {
    const grant = await timeGrants.grant(
      adminToken,
      allocationId,
      reviewer,
      new Date(Date.now() - 60000),
      end,
      randomUUID(),
    );
    if (grant.kind !== "applied") throw Error("Expected exact time grant");
    grantId = grant.grantId;
  }
  return {
    reviewer,
    reviewerToken,
    admin,
    adminToken,
    feedback,
    id: upload.id,
    allocationId,
    grantId,
  };
}

it("CAP-07 review time granted to an unrostered reviewer is flagged; waiting and used time are counted apart", async () => {
  const granted = await allocation(true),
    waiting = await allocation(false);
  verifierId = granted.admin;
  let review = ready(await report.snapshot(granted.adminToken)).reviewTime;
  expect(review).toEqual({
    status: "discrepancies",
    open: 2,
    openMinutes: 40,
    granted: 1,
    grantedMinutes: 20,
    reviewers: 1,
    unrostered: 1,
    unrosteredMinutes: 20,
    unrosteredReviewers: 1,
    waiting: 1,
    waitingMinutes: 20,
    completed: 0,
    reviewMinutes: 0,
    preparationMinutes: 0,
  });
  // Give the granted reviewer a verified formal-review record with a verified backup.
  await roster({
    staffId: granted.reviewer,
    role: "reviewer",
    backup: waiting.reviewer,
  });
  await roster({
    staffId: waiting.reviewer,
    role: "reviewer",
    backup: granted.reviewer,
  });
  review = ready(await report.snapshot(granted.adminToken)).reviewTime;
  expect(review).toMatchObject({
    status: "consistent",
    unrostered: 0,
    unrosteredReviewers: 0,
    waiting: 1,
  });
  // Complete the granted review: 10 review and 5 preparation minutes, each once.
  const draft = await granted.feedback.save(granted.reviewerToken, granted.id, {
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
  });
  if (draft.kind !== "saved") throw Error("Expected saved draft");
  expect(
    (
      await granted.feedback.beginReview(
        granted.reviewerToken,
        granted.id,
        granted.allocationId,
        granted.grantId,
        randomUUID(),
      )
    ).kind,
  ).toBe("applied");
  const end = Math.floor(Date.now() / 60000) * 60000 - 60000;
  const published = await granted.feedback.publish(
    granted.reviewerToken,
    granted.id,
    draft.revision,
    randomUUID(),
    {
      allocationId: granted.allocationId,
      grantId: granted.grantId,
      intervals: {
        reviewStart: new Date(end - 600000),
        reviewEnd: new Date(end),
        preparationStart: new Date(end - 900000),
        preparationEnd: new Date(end - 600000),
      },
    },
  );
  expect(published.kind).toBe("saved");
  review = ready(await report.snapshot(granted.adminToken)).reviewTime;
  expect(review).toMatchObject({
    status: "consistent",
    open: 1,
    granted: 0,
    waiting: 1,
    completed: 1,
    reviewMinutes: 10,
    preparationMinutes: 5,
  });
});

it("CAP-08 signed-out, member, reviewer and coach sessions are refused without figures; query fields are refused", async () => {
  verifierId = (await staff("platform_admin")).id;
  const reviewer = await staff("reviewer"),
    coach = await staff("coach"),
    editor = await staff("editor"),
    admin = await staff("platform_admin");
  await roster({ staffId: coach.id, backup: reviewer.id, capacity: 240 });
  const member = randomBytes(32).toString("hex");
  await members.create(member, { background: "explorer", goal: "everyday" });
  for (const token of [
    undefined,
    member,
    reviewer.token,
    coach.token,
    editor.token,
  ]) {
    const r = await get(path, token);
    expect(r.status).toBe(403);
    expect(r.text).not.toMatch(/\d+ min/);
  }
  expect((await report.snapshot(member)).kind).toBe("denied");
  expect((await get(`${path}?service=coaching`, admin.token)).status).toBe(400);
  const live = app(members, {
    origin: "http://127.0.0.1:3000",
    secret: "native-staff-capacity-live",
    mode: "live",
    staffCapacity: report,
  });
  const r = await withLoopback(live, (s) =>
    request(s)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${admin.token}`),
  );
  expect(r.status).toBe(404);
  expect(r.text).not.toMatch(/\d+ min/);
});

// #94 SUPCAP-01..03: support time members hold from their support test
// minutes, shown beside the roster. Invented requests and minutes only.
const support = supportRequestStore(pool);
async function supportMember(minutesGranted: number) {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Expected member");
  await syntheticLedger(pool).grant(
    session.learner.id,
    "support_minutes",
    minutesGranted,
    randomUUID(),
    {
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + hour).toISOString(),
    },
  );
  return { token, id: session.learner.id };
}
async function booking(memberToken: string, ceiling = 20) {
  const intake = await support.create(memberToken, {
    idempotencyKey: randomUUID(),
    subject: "Invented capacity support request",
    body: "INVENTED PRIVATE SUPPORT TEXT",
  });
  if (!("receipt" in intake)) throw Error("Expected support request");
  const requestId = intake.receipt.requestId;
  const held = await support.time!.allocate(
    memberToken,
    requestId,
    randomUUID(),
    ceiling,
  );
  if (!("receipt" in held)) throw Error("Expected held support minutes");
  return { requestId, allocationId: held.receipt.allocationId };
}
async function supportGrant(
  adminToken: string,
  b: { requestId: string; allocationId: string },
  staffId: string,
) {
  const granted = await support.time!.grant(adminToken, {
    ...b,
    staffId,
    role: "operator",
    idempotencyKey: randomUUID(),
    startsAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + hour),
  });
  if (!("grantId" in granted)) throw Error("Expected support time grant");
  return granted.grantId;
}
const EMPTY_SUPPORT = {
  status: "empty",
  open: 0,
  openMinutes: 0,
  granted: 0,
  grantedMinutes: 0,
  operators: 0,
  waiting: 0,
  waitingMinutes: 0,
  completed: 0,
  supportMinutes: 0,
  preparationMinutes: 0,
};

it("SUPCAP-01/02 held support time counts once at its ceiling: waiting, granted, cancelled and settled time stay apart", async () => {
  const admin = await staff("platform_admin"),
    first = await staff("operator"),
    second = await staff("operator");
  const read = async () =>
    ready(await report.snapshot(admin.token)).supportTime;
  expect(await read()).toEqual(EMPTY_SUPPORT);

  const m = await supportMember(60);
  const a = await booking(m.token),
    b = await booking(m.token),
    c = await booking(m.token);
  expect(await read()).toEqual({
    ...EMPTY_SUPPORT,
    status: "recorded",
    open: 3,
    openMinutes: 60,
    waiting: 3,
    waitingMinutes: 60,
  });

  // Two operators on one booking: still one booking of 20 minutes.
  const grantId = await supportGrant(admin.token, a, first.id);
  const spare = await supportGrant(admin.token, a, second.id);
  expect(await read()).toMatchObject({
    open: 3,
    openMinutes: 60,
    granted: 1,
    grantedMinutes: 20,
    operators: 2,
    waiting: 2,
    waitingMinutes: 40,
  });
  // A revoked grant no longer counts its operator.
  expect((await support.time!.revoke(admin.token, spare)).kind).toBe("revoked");
  expect(await read()).toMatchObject({ granted: 1, operators: 1 });

  // A cancelled booking frees its minutes and counts nowhere.
  expect(
    (await support.time!.cancel(m.token, b.requestId, b.allocationId)).kind,
  ).toBe("applied");
  expect(await read()).toMatchObject({
    open: 2,
    openMinutes: 40,
    waiting: 1,
    waitingMinutes: 20,
    completed: 0,
  });

  // A begun booking is still open at its ceiling; settling it moves the
  // minutes actually used to completed, with preparation counted once.
  const scope = { ...a, grantId };
  expect(
    (await support.time!.begin(first.token, scope, randomUUID())).kind,
  ).toBe("applied");
  expect(await read()).toMatchObject({
    open: 2,
    openMinutes: 40,
    granted: 1,
    grantedMinutes: 20,
  });
  const start = new Date(Date.now() - hour),
    end = new Date(+start + 10 * 60_000);
  expect(
    await support.time!.record(first.token, scope, randomUUID(), {
      supportStart: start,
      supportEnd: end,
      preparationStart: end,
      preparationEnd: new Date(+end + 5 * 60_000),
    }),
  ).toMatchObject({
    kind: "applied",
    receipt: { consumed: 15, released: 5, held: 0 },
  });
  expect(await read()).toEqual({
    status: "recorded",
    open: 1,
    openMinutes: 20,
    granted: 0,
    grantedMinutes: 0,
    operators: 0,
    waiting: 1,
    waitingMinutes: 20,
    completed: 1,
    supportMinutes: 10,
    preparationMinutes: 5,
  });
  expect(c.allocationId).toBeTruthy();
});

it("SUPCAP-03 the page shows support time to operators and administrators only, without the member, request or staff", async () => {
  const admin = await staff("platform_admin"),
    operator = await staff("operator"),
    reviewer = await staff("reviewer");
  const m = await supportMember(20);
  const b = await booking(m.token);
  const grantId = await supportGrant(admin.token, b, operator.id);
  for (const token of [admin.token, operator.token]) {
    const page = await get(path, token);
    expect(page.status).toBe(200);
    expect(page.text).toContain("<h2>Support time · Test data</h2>");
    expect(page.text).toMatch(
      /Open support time \(1\)<\/dt><dd data-field="support.open">20 min/,
    );
    expect(page.text).toMatch(/data-field="support.granted">20 min/);
    expect(page.text).toMatch(/data-field="support.operators">1</);
    for (const secret of [
      m.id,
      b.requestId,
      b.allocationId,
      grantId,
      operator.id,
      "INVENTED PRIVATE SUPPORT TEXT",
      "Invented capacity support request",
    ])
      expect(page.text).not.toContain(secret);
  }
  for (const token of [reviewer.token, m.token]) {
    const refused = await get(path, token);
    expect(refused.status).toBe(403);
    expect(refused.text).not.toMatch(/\d+ min/);
  }
  // Reading the report changed nothing.
  expect(await support.time!.receipt(m.token, b.requestId)).toMatchObject({
    kind: "ready",
    value: { state: "allocated", ceiling: 20, held: 20 },
  });
});
