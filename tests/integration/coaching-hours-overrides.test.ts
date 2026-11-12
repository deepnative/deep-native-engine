import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { hash, migrate, store } from "../../src/store.ts";
import {
  simpleInvoiceStore,
  type InvoiceResult,
} from "../../src/simple-invoice-store.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { readChangeHistory } from "../../src/staff-change-history.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #832 slice A (owner, 12 November 2026): an administrator can change hours a
// student saved or submitted, with a reason, and cannot enter new hours.
// Every person, rate and reason here is invented.
const pool = testPool(),
  members = store(pool),
  settings = {
    sample: true,
    issuer: "Invented coaching issuer",
    instructions: "Sample only; do not pay.",
  },
  invoices = simpleInvoiceStore(pool, settings),
  secret = "coaching-override-native-test",
  origin = "http://127.0.0.1:3000",
  application = app(members, {
    origin,
    secret,
    mode: "test",
    simpleInvoices: invoices,
  }),
  auth = authorizationStore(pool);
let admin: string, month: string;
const ready = <T>(result: InvoiceResult<T>): T => {
  if (result.kind !== "ready")
    throw Error(`Expected ready, got ${result.kind}`);
  return result.value;
};
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const s = await members.session(token, "account");
  if (s.kind !== "active") throw Error();
  return { token, id: s.learner.id };
}
async function staff(role: "platform_admin" | "reviewer" = "platform_admin") {
  const token = randomBytes(32).toString("hex");
  await auth.provisionStaff(token, role, new Date(Date.now() + 3600000));
  return token;
}
/** A student with a CAD 120.00 rate and a saved draft of `minutes`. */
async function saved(minutes = 600) {
  const m = await member(),
    rate = ready(
      await invoices.setCoachingRate(admin, {
        ownerId: m.id,
        effectiveMonth: month,
        cents: 12000,
        expectedVersion: 0,
        operationId: randomUUID(),
      }),
    ),
    draft = ready(
      await invoices.saveCoaching(m.token, {
        month,
        minutes,
        expectedRevision: 0,
        operationId: randomUUID(),
        name: "Invented student",
        email: "student@example.invalid",
      }),
    );
  return { ...m, rateId: rate.rateId, revision: draft.revision };
}
async function submitted(minutes = 600) {
  const m = await saved(minutes),
    s = ready(
      await invoices.submitCoaching(m.token, {
        month,
        rateId: m.rateId,
        sample: true,
        expectedRevision: m.revision,
        operationId: randomUUID(),
      }),
    );
  return { ...m, revision: s.revision };
}
const change = (
  m: { id: string; revision: number },
  minutes: number,
  reason = "Invented: two sessions were cancelled",
) => ({
  ownerId: m.id,
  month,
  minutes,
  reason,
  expectedRevision: m.revision,
  operationId: randomUUID(),
});
const overrides = async (id: string) =>
  (
    await pool.query(
      'SELECT previous_minutes AS "previousMinutes",minutes,reason,state,revision FROM coaching_hours_overrides WHERE owner_id=$1 ORDER BY revision',
      [id],
    )
  ).rows;
const entry = async (m: { id: string }) =>
  ready(await invoices.coachingOverview(admin, month, m.id)).entry!;
const post = (
  path: string,
  token: string,
  fields: Record<string, string>,
  from = origin,
) =>
  withLoopback(application, (s) =>
    request(s)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", from)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf: csrf(token, secret), ...fields }),
  );
const get = (path: string, token: string) =>
  withLoopback(application, (s) =>
    request(s)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
beforeAll(async () => {
  await migrate(pool);
  admin = await staff();
  month = (
    await pool.query<{ month: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS month",
    )
  ).rows[0]!.month;
});
afterAll(() => pool.end());

it("OVR832-01 changed submitted hours stay awaiting review at the confirmed rate, and the invoice is issued on the changed figure", async () => {
  const m = await submitted(600);
  // A later rate does not reprice what the student confirmed.
  ready(
    await invoices.setCoachingRate(admin, {
      ownerId: m.id,
      effectiveMonth: month,
      cents: 99900,
      expectedVersion: 1,
      operationId: randomUUID(),
    }),
  );
  const changed = ready(
    await invoices.overrideCoachingHours(admin, change(m, 480)),
  );
  expect(changed).toEqual({ month, revision: 3 });
  const now = await entry(m);
  expect(now).toMatchObject({
    state: "submitted",
    minutes: 480,
    revision: 3,
    submittedRevision: 3,
    snapshot: {
      minutes: 480,
      subtotalCents: 96000,
      rate: { cents: 12000, version: 1 },
    },
  });
  // The student's own submission is still retained beside the changed one.
  expect(
    (
      await pool.query(
        "SELECT revision,(snapshot->>'minutes')::integer AS minutes FROM coaching_submissions WHERE owner_id=$1 ORDER BY revision",
        [m.id],
      )
    ).rows,
  ).toEqual([
    { revision: 2, minutes: 600 },
    { revision: 3, minutes: 480 },
  ]);
  // OVR832-05: the issue form opened before the change is refused.
  const issue = (revision: number) => ({
    ownerId: m.id,
    month,
    expectedRevision: revision,
    taxCents: 0,
    operationId: randomUUID(),
  });
  expect((await invoices.issueCoaching(admin, issue(2))).kind).toBe("conflict");
  const issued = ready(await invoices.issueCoaching(admin, issue(3)));
  const invoice = ready(await invoices.invoice(admin, issued.invoiceId, true));
  expect(invoice.document.coaching).toMatchObject({
    minutes: 480,
    rateCents: 12000,
    submissionRevision: 3,
  });
  expect(invoice.document.lines[0]!.amountCents).toBe(96000);
  // OVR832-06: an issued invoice is not changed.
  expect(
    (
      await invoices.overrideCoachingHours(
        admin,
        change({ id: m.id, revision: 4 }, 60),
      )
    ).kind,
  ).toBe("conflict");
  expect(await overrides(m.id)).toEqual([
    {
      previousMinutes: 600,
      minutes: 480,
      reason: "Invented: two sessions were cancelled",
      state: "submitted",
      revision: 3,
    },
  ]);
});

it("OVR832-02/05 a changed draft stays the student's to submit, and the student's form from before the change is refused", async () => {
  const m = await saved(600);
  ready(await invoices.overrideCoachingHours(admin, change(m, 480)));
  expect(await entry(m)).toMatchObject({
    state: "draft",
    minutes: 480,
    revision: 2,
    submittedRevision: null,
  });
  const stale = {
    month,
    minutes: 600,
    expectedRevision: 1,
    operationId: randomUUID(),
    name: "Invented student",
    email: "student@example.invalid",
  };
  expect((await invoices.saveCoaching(m.token, stale)).kind).toBe("conflict");
  // The administrator's own stale form is refused too.
  expect(
    (await invoices.overrideCoachingHours(admin, change(m, 300))).kind,
  ).toBe("conflict");
  expect((await entry(m)).minutes).toBe(480);
  const s = ready(
    await invoices.submitCoaching(m.token, {
      month,
      rateId: m.rateId,
      sample: true,
      expectedRevision: 2,
      operationId: randomUUID(),
    }),
  );
  expect((await entry(m)).snapshot).toMatchObject({
    minutes: 480,
    subtotalCents: 96000,
  });
  expect(s.revision).toBe(3);
  // A second change keeps the first in the history.
  ready(
    await invoices.overrideCoachingHours(
      admin,
      change({ id: m.id, revision: 3 }, 450, "Invented: half a session added"),
    ),
  );
  expect(
    (await overrides(m.id)).map((o) => [o.previousMinutes, o.minutes, o.state]),
  ).toEqual([
    [600, 480, "draft"],
    [480, 450, "submitted"],
  ]);
});

it("OVR832-03 an administrator cannot enter hours for a month the student has not started, on the route or in the database", async () => {
  const m = await member();
  expect(
    (
      await invoices.overrideCoachingHours(
        admin,
        change({ id: m.id, revision: 0 }, 480),
      )
    ).kind,
  ).toBe("not-found");
  const page = await get(`/operator/coaching/${m.id}?month=${month}`, admin);
  expect(page.status).toBe(200);
  expect(page.text).toContain(
    "An administrator cannot enter new hours for a student",
  );
  expect(page.text).not.toContain("/override");
  const refused = await post(`/operator/coaching/${m.id}/override`, admin, {
    month,
    action: "override",
    hours: "8",
    minutes: "0",
    reason: "Invented reason",
    revision: "0",
    operationId: randomUUID(),
  });
  expect(refused.status).toBe(404);
  expect(refused.text).toContain(
    "The student has not saved hours for this period, so there is nothing to change.",
  );
  expect(
    (
      await pool.query("SELECT 1 FROM coaching_months WHERE owner_id=$1", [
        m.id,
      ])
    ).rowCount,
  ).toBe(0);
  // The database itself refuses a change record with no saved hours.
  await expect(
    pool.query(
      "INSERT INTO coaching_hours_overrides(id,owner_id,month,previous_minutes,minutes,reason,state,revision,actor_id) VALUES($1,$2,$3,0,480,'Invented','draft',2,$4)",
      [randomUUID(), m.id, month, randomUUID()],
    ),
  ).rejects.toThrow(/coaching_hours_overrides_started_period/);
});

it("OVR832-04 a missing reason, hours beyond the month or an unchanged figure are refused and nothing changes", async () => {
  const m = await submitted(600);
  for (const bad of [
    change(m, 480, "   "),
    change(m, 31 * 24 * 60 + 1),
    change(m, 600),
  ])
    expect((await invoices.overrideCoachingHours(admin, bad)).kind).toBe(
      "invalid",
    );
  const page = await post(`/operator/coaching/${m.id}/override`, admin, {
    month,
    action: "override",
    hours: "8",
    minutes: "0",
    reason: "",
    revision: "2",
    operationId: randomUUID(),
  });
  expect(page.status).toBe(422);
  expect(page.text).toContain("The hours were not changed. Give a reason");
  expect(await entry(m)).toMatchObject({ minutes: 600, revision: 2 });
  expect(await overrides(m.id)).toEqual([]);
  // The database refuses the same shapes.
  for (const [previous, minutes, reason] of [
    [600, 600, "Invented"],
    [600, 480, " "],
    [600, 44641, "Invented"],
  ])
    await expect(
      pool.query(
        "INSERT INTO coaching_hours_overrides(id,owner_id,month,previous_minutes,minutes,reason,state,revision,actor_id) VALUES($1,$2,$3,$4,$5,$6,'submitted',3,$7)",
        [randomUUID(), m.id, month, previous, minutes, reason, randomUUID()],
      ),
    ).rejects.toThrow(/check constraint/);
});

it("OVR832-06 after the unpaid invoice is voided and the month returned, the hours can be changed and a replacement issued", async () => {
  const m = await submitted(600),
    first = ready(
      await invoices.issueCoaching(admin, {
        ownerId: m.id,
        month,
        expectedRevision: 2,
        taxCents: 0,
        operationId: randomUUID(),
      }),
    );
  ready(
    await invoices.voidInvoice(admin, {
      invoiceId: first.invoiceId,
      expectedRevision: 1,
      reason: "Invented: wrong hours",
      operationId: randomUUID(),
    }),
  );
  // Voided but not yet returned: still an issued month.
  expect(
    (
      await invoices.overrideCoachingHours(
        admin,
        change({ id: m.id, revision: 3 }, 480),
      )
    ).kind,
  ).toBe("conflict");
  ready(
    await invoices.returnCoaching(admin, {
      ownerId: m.id,
      month,
      expectedRevision: 3,
      reason: "Invented: correct the hours",
      operationId: randomUUID(),
    }),
  );
  ready(
    await invoices.overrideCoachingHours(
      admin,
      change({ id: m.id, revision: 4 }, 480),
    ),
  );
  ready(
    await invoices.submitCoaching(m.token, {
      month,
      rateId: m.rateId,
      sample: true,
      expectedRevision: 5,
      operationId: randomUUID(),
    }),
  );
  const second = ready(
    await invoices.issueCoaching(admin, {
      ownerId: m.id,
      month,
      expectedRevision: 6,
      taxCents: 0,
      operationId: randomUUID(),
    }),
  );
  expect(
    ready(await invoices.invoice(admin, second.invoiceId, true)).document
      .coaching,
  ).toMatchObject({ minutes: 480, replacesInvoiceId: first.invoiceId });
});

it("OVR832-07 the student reads the change with their earlier figure, it is in Download my records without the administrator, and it cannot be edited", async () => {
  const m = await submitted(600),
    other = await submitted(300);
  ready(await invoices.overrideCoachingHours(admin, change(m, 480)));
  const own = ready(await invoices.coachingOverview(m.token, month));
  expect(own.overrides).toMatchObject([
    {
      previousMinutes: 600,
      minutes: 480,
      reason: "Invented: two sessions were cancelled",
      state: "submitted",
      actorName: null,
    },
  ]);
  expect(own.months[0]).toMatchObject({ minutes: 480, overridden: true });
  expect(
    ready(await invoices.coachingOverview(other.token, month)),
  ).toMatchObject({ overrides: [], months: [{ overridden: false }] });
  const page = await get(`/account/coaching?month=${month}`, m.token);
  expect(page.text).toContain("Hours changed by an administrator");
  expect(page.text).toContain(
    "from <strong>10 hours 0 minutes</strong> to <strong>8 hours 0 minutes</strong><p>Reason: Invented: two sessions were cancelled</p>",
  );
  expect(page.text).not.toContain("/override");
  const exporter = memberExportStore(pool),
    records: Record<string, Record<string, unknown>[]> = {};
  let cursor: string | undefined, version: string | undefined;
  do {
    const result = await exporter.exportOwned(m.token, cursor);
    if (result.kind !== "ready") throw Error("Expected export");
    version = result.payload.version;
    for (const [key, rows] of Object.entries(result.payload.records))
      records[key] = [...(records[key] ?? []), ...rows];
    cursor = result.payload.page.nextCursor ?? undefined;
  } while (cursor);
  expect(version).toBe("local-member-records-v52");
  expect(records.coachingHoursOverrides).toEqual([
    {
      month,
      previousMinutes: 600,
      minutes: 480,
      reason: "Invented: two sessions were cancelled",
      stateWhenChanged: "submitted",
      changedAt: expect.any(Date),
    },
  ]);
  const staffId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM principals WHERE token_hash=$1",
      [hash(admin)],
    )
  ).rows[0]!.id;
  expect(JSON.stringify(records.coachingHoursOverrides)).not.toContain(staffId);
  for (const sql of [
    "UPDATE coaching_hours_overrides SET minutes=1 WHERE owner_id=$1",
    "DELETE FROM coaching_hours_overrides WHERE owner_id=$1",
  ])
    await expect(pool.query(sql, [m.id])).rejects.toThrow(
      "Coaching history is immutable",
    );
  // Deleting the account removes the change records with the hours.
  await members.remove(m.id);
  for (const table of ["coaching_hours_overrides", "coaching_months"])
    expect(
      (await pool.query(`SELECT 1 FROM ${table} WHERE owner_id=$1`, [m.id]))
        .rowCount,
    ).toBe(0);
  expect((await overrides(other.id)).length).toBe(0);
});

it("OVR832-08 only a current platform administrator changes hours, through the checked form, and Change history names who and when", async () => {
  const m = await submitted(600),
    other = await member(),
    reviewer = await staff("reviewer"),
    revoked = await staff();
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE token_hash=$1",
    [hash(revoked)],
  );
  for (const denied of [m.token, other.token, reviewer, revoked])
    expect(
      (await invoices.overrideCoachingHours(denied, change(m, 480))).kind,
    ).toBe("denied");
  const fields = {
    month,
    action: "override",
    hours: "8",
    minutes: "0",
    reason: "Invented: two sessions were cancelled",
    revision: "2",
    operationId: randomUUID(),
  };
  const path = `/operator/coaching/${m.id}/override`;
  expect(
    (await post(path, admin, fields, "https://other.invalid")).status,
  ).toBe(403);
  expect(
    (
      await withLoopback(application, (s) =>
        request(s)
          .post(path)
          .set("Host", "127.0.0.1:3000")
          .set("Origin", origin)
          .set("Cookie", `${COOKIE}=${admin}`)
          .type("form")
          .send({ ...fields, csrf: "forged" }),
      )
    ).status,
  ).toBe(403);
  expect((await post(path, m.token, fields)).status).toBeGreaterThanOrEqual(
    403,
  );
  expect(await entry(m)).toMatchObject({ minutes: 600, revision: 2 });
  const accepted = await post(path, admin, fields);
  expect(accepted.status).toBe(303);
  expect(accepted.headers.location).toBe(
    `/operator/coaching/${m.id}?month=${month}#hours-changes`,
  );
  // The same form posted again returns the original outcome, once.
  expect((await post(path, admin, fields)).status).toBe(303);
  expect(await overrides(m.id)).toHaveLength(1);
  const review = await get(accepted.headers.location!, admin);
  expect(review.text).toContain("Hours changed by an administrator");
  expect(review.text).toContain("Change this student’s hours");
  const staffId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM principals WHERE token_hash=$1",
      [hash(admin)],
    )
  ).rows[0]!.id;
  expect(
    (
      await pool.query(
        "SELECT actor_id,action,month,amount_cents FROM billing_change_events WHERE member_id=$1 AND action='hours_overridden'",
        [m.id],
      )
    ).rows,
  ).toEqual([
    {
      actor_id: staffId,
      action: "hours_overridden",
      month,
      amount_cents: null,
    },
  ]);
  const client = await pool.connect();
  try {
    const history = await readChangeHistory(client, undefined);
    expect(
      history.kind === "ready" &&
        history.value.entries.some(
          (e) => e.action === "hours_overridden" && e.month === month,
        ),
    ).toBe(true);
  } finally {
    client.release();
  }
  // Restarting re-runs every migration; the widened history check survives.
  await migrate(pool);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM billing_change_events WHERE member_id=$1 AND action='hours_overridden'",
        [m.id],
      )
    ).rowCount,
  ).toBe(1);
});
