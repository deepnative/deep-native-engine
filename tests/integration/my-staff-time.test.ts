import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { availabilityStore } from "../../src/availability.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import {
  myStaffTimeStore,
  type MyStaffTimeResult,
} from "../../src/my-staff-time.ts";
import { reviewTimeGrants } from "../../src/review-time-grants.ts";
import { reviewTimeStore } from "../../src/review-time-store.ts";
import { SAMPLE_FEEDBACK_PURPOSE } from "../../src/sample-feedback-values.ts";
import { COOKIE } from "../../src/session.ts";
import { memberSlotHolds } from "../../src/slot-holds.ts";
import { staffCapacityStore } from "../../src/staff-capacity.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #193 MYTIME-01..06 on real PostgreSQL with invented roster records only.
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  mine = myStaffTimeStore(pool),
  holds = memberSlotHolds(pool),
  slots = availabilityStore(pool),
  ledger = syntheticLedger(pool),
  minutes = reviewTimeStore(pool, { enabled: true, mode: "test" }),
  timeGrants = reviewTimeGrants(pool, { enabled: true, mode: "test" }),
  application = app(members, {
    origin: "http://127.0.0.1:3000",
    secret: "native-my-time-test",
    mode: "test",
    myStaffTime: mine,
  }),
  path = "/review/my-time",
  hour = 3_600_000,
  day = 86_400_000;
let root = "";
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs,principals,cohorts CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne-my-time-test-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
afterAll(() => pool.end());

const ready = (result: MyStaffTimeResult) => {
  if (result.kind !== "ready") throw Error(`Expected snapshot: ${result.kind}`);
  return result.value;
};
const staff = async (
  role: "coach" | "reviewer" | "operator" | "platform_admin",
  token = randomBytes(32).toString("hex"),
) => {
  const id = await auth.provisionStaff(
    token,
    role,
    new Date(Date.now() + 10 * day),
  );
  return { token, id };
};
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Expected active member");
  const grantId = await ledger.grant(
    session.learner.id,
    "coach_minutes",
    60,
    randomUUID(),
    {
      startsAt: new Date(Date.now() - hour).toISOString(),
      expiresAt: new Date(Date.now() + 10 * day).toISOString(),
    },
  );
  return { token, id: session.learner.id, grantId };
}
let verifierId = "";
async function roster(
  staffId: string,
  backup: string | null,
  options: {
    service?: "coaching" | "formal-review";
    capacity?: number;
    committed?: number;
    verified?: boolean;
    ends?: Date;
  } = {},
) {
  const id = randomUUID(),
    service = options.service ?? "coaching";
  await pool.query(
    `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,
       loaded_cost_cents,capacity_minutes,committed_minutes,backup_staff_id,
       qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
     VALUES($1,$2,$3,'education',$4,clock_timestamp()-interval '1 hour',$5,987654,$6,$7,$8,
       'INVENTED-QUALIFICATION-REF','INVENTED-AGREEMENT-REF','INVENTED-CONFLICT-REF',
       $9::uuid,CASE WHEN $9::uuid IS NULL THEN NULL ELSE clock_timestamp()-interval '1 minute' END)`,
    [
      id,
      staffId,
      service === "coaching" ? "coach" : "reviewer",
      service,
      options.ends ?? new Date(Date.now() + 30 * day),
      options.capacity ?? 120,
      options.committed ?? 0,
      backup,
      options.verified === false ? null : verifierId,
    ],
  );
  return id;
}
const get = (url: string, token?: string) =>
  withLoopback(application, (s) => {
    const r = request(s).get(url).set("Host", "127.0.0.1:3000");
    return token ? r.set("Cookie", `${COOKIE}=${token}`) : r;
  });

it("MYTIME-01/02/06 a staff member sees only their own records, held slot times and room", async () => {
  const admin = await staff("platform_admin"),
    operator = await staff("operator"),
    a = await staff("coach"),
    b = await staff("coach");
  verifierId = admin.id;
  const aRecord = await roster(a.id, b.id, { capacity: 300, committed: 60 }),
    // The backup needs room to cover A's three slots as well as its own.
    bRecord = await roster(b.id, a.id, { capacity: 300 });
  const start = Math.floor((Date.now() + 3 * day) / 60000) * 60000,
    at = (offset: number) => new Date(start + offset * 2 * hour),
    slot = async (record: string, offset: number) => {
      const id = await slots.create(
        operator.token,
        record,
        at(offset),
        new Date(+at(offset) + hour),
      );
      if (!id) throw Error("Expected slot");
      return id;
    };
  const held = await slot(aRecord, 0),
    withdrawn = await slot(aRecord, 1);
  await slot(aRecord, 2);
  const elsewhere = await slot(bRecord, 3);
  const [m1, m2, m3] = [await member(), await member(), await member()];
  await holds.request(m1.token, held, m1.grantId, randomUUID());
  const gone = randomUUID();
  await holds.request(m2.token, withdrawn, m2.grantId, gone);
  await holds.withdraw(m2.token, gone);
  await holds.request(m3.token, elsewhere, m3.grantId, randomUUID());

  const value = ready(await mine.snapshot(a.token));
  expect(value.notCurrent).toBe(0);
  expect(value.records).toEqual([
    {
      service: "coaching",
      domain: "education",
      startsAt: expect.any(Date),
      endsAt: expect.any(Date),
      standing: "covered",
      capacityMinutes: 300,
      committedMinutes: 60,
      slotMinutes: 180,
      held: [{ startsAt: at(0), endsAt: new Date(+at(0) + hour) }],
      roomMinutes: 60,
    },
  ]);
  // B is A's backup but sees only B's own record and its own held slot.
  expect(ready(await mine.snapshot(b.token)).records).toEqual([
    expect.objectContaining({
      capacityMinutes: 300,
      slotMinutes: 60,
      held: [{ startsAt: at(3), endsAt: new Date(+at(3) + hour) }],
      roomMinutes: 240,
    }),
  ]);
  // The same held rule as the staff capacity report.
  const report = await staffCapacityStore(pool).snapshot(admin.token);
  if (report.kind !== "ready") throw Error("Expected capacity report");
  expect(report.value.groups[0].heldSlots).toBe(2);

  const page = await get(path, a.token);
  expect(page.status).toBe(200);
  expect(page.headers["cache-control"]).toBe("no-store");
  expect(page.text).toMatch(/data-field="0.room">60 min/);
  expect(page.text).toMatch(/data-field="0.held">1/);
  expect(page.text).toContain(at(0).toISOString());
  expect(page.text).not.toContain(at(1).toISOString());
  expect(page.text).not.toContain(at(3).toISOString());
  for (const secret of [
    m1.id,
    m1.grantId,
    held,
    aRecord,
    b.id,
    a.id,
    "INVENTED-",
    "9876",
  ])
    expect(page.text).not.toContain(secret);
});

it("MYTIME-03 records that aren't covered offer no room; lapsed records are only counted", async () => {
  const admin = await staff("platform_admin"),
    a = await staff("coach"),
    b = await staff("coach"),
    c = await staff("coach");
  verifierId = admin.id;
  await roster(a.id, b.id, { capacity: 480, verified: false });
  await roster(a.id, c.id, { capacity: 90 }); // C has no record at all.
  await roster(a.id, b.id, { ends: new Date(Date.now() - 1000) });
  await roster(b.id, a.id, { capacity: 200 });
  await pool.query("UPDATE principals SET revoked_at=now() WHERE id=$1", [
    b.id,
  ]);
  const value = ready(await mine.snapshot(a.token));
  expect(value.notCurrent).toBe(1);
  expect(value.records.map((r) => [r.standing, r.roomMinutes])).toEqual([
    ["unverified", null],
    ["no_backup", null],
  ]);
  const page = await get(path, a.token);
  expect(page.text).toContain("isn't qualified coverage");
  expect(page.text).toContain(
    "your named backup has no current verified record",
  );
  expect(page.text).toContain("1 of your records is outside its window");
  expect(page.text).toMatch(/data-field="0.room">Not bookable/);
  expect(page.text).toMatch(/data-field="1.room">Not bookable/);
  // A revoked staff member is refused outright.
  expect(await mine.snapshot(b.token)).toEqual({ kind: "denied" });
});

it("MYTIME-04 review time granted to a reviewer leaves their room unchanged and is never shown as time", async () => {
  const admin = await staff("platform_admin"),
    backup = await staff("reviewer");
  verifierId = admin.id;
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
    grantor = await auth.provisionStaff(adminToken, "platform_admin", end),
    reviewer = await auth.provisionStaff(reviewerToken, "reviewer", end);
  await roster(reviewer, backup.id, {
    service: "formal-review",
    capacity: 240,
  });
  await roster(backup.id, reviewer, { service: "formal-review", capacity: 60 });
  const before = ready(await mine.snapshot(reviewerToken));
  expect(before.records[0]).toMatchObject({ roomMinutes: 240 });

  const objects = fileObjectStorage(root),
    evidence = evidenceStore(pool, objects, "invented-my-time-secret");
  const upload = await evidence.upload(ownerToken, {
    name: "Invented booked time sample",
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
    grantor,
    reviewer,
    owner.learner.id,
    "reviewer",
    "invented booked time review",
    end,
  );
  await auth.grantEvidenceReview(
    grantor,
    reviewer,
    assignment,
    submission,
    SAMPLE_FEEDBACK_PURPOSE,
    end,
  );
  await ledger.grant(owner.learner.id, "review_minutes", 20, randomUUID(), {
    startsAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: end.toISOString(),
  });
  const allocated = await minutes.allocate(
    ownerToken,
    upload.id,
    randomUUID(),
    20,
  );
  if (allocated.kind !== "applied") throw Error("Expected allocated minutes");
  const granted = await timeGrants.grant(
    adminToken,
    allocated.receipt.allocationId,
    reviewer,
    new Date(Date.now() - 60000),
    end,
    randomUUID(),
  );
  expect(granted.kind).toBe("applied");

  const after = ready(await mine.snapshot(reviewerToken));
  expect(after.records).toEqual(before.records);
  const page = await get(path, reviewerToken);
  expect(page.text).toMatch(/data-field="0.room">240 min/);
  expect(page.text).toContain(
    "Queued review or support requests are not available time and set no due date.",
  );
  expect(page.text).not.toContain("20 min");
});

it("MYTIME-05 no record, members, signed-out visitors and lapsed staff see no figures", async () => {
  const lonely = await staff("operator");
  const none = ready(await mine.snapshot(lonely.token));
  expect(none).toMatchObject({ records: [], notCurrent: 0 });
  const empty = await get(path, lonely.token);
  expect(empty.status).toBe(200);
  expect(empty.text).toContain("nothing is bookable with you");

  const m = await member();
  expect(await mine.snapshot(m.token)).toEqual({ kind: "denied" });
  const expired = await staff("coach");
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [expired.id],
  );
  expect(await mine.snapshot(expired.token)).toEqual({ kind: "denied" });
  for (const token of [m.token, expired.token, undefined]) {
    const denied = await get(path, token);
    expect(denied.status).toBe(403);
    expect(denied.headers["cache-control"]).toBe("no-store");
    expect(denied.text).not.toMatch(/\d+ min/);
  }
  expect((await get(`${path}?staff=${lonely.id}`, lonely.token)).status).toBe(
    400,
  );
});
