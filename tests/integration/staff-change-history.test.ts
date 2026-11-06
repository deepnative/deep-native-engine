import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { accountRoleAdmin } from "../../src/account-role-admin.ts";
import { administratorEntry } from "../../src/administrator-entry.ts";
import { catalogStore, seedDraftPack } from "../../src/catalog.ts";
import { foundationImportStore } from "../../src/foundation-import.ts";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import {
  simpleInvoiceStore,
  type InvoiceResult,
} from "../../src/simple-invoice-store.ts";
import {
  changeHistoryBody,
  changeText,
  type ChangeHistory,
} from "../../src/staff-change-history.ts";
import { hash, migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  catalog = catalogStore(pool),
  entry = administratorEntry(pool),
  admin = accountRoleAdmin(pool),
  settings = {
    sample: true,
    issuer: "Invented issuer",
    instructions: "Sample only; do not pay.",
  },
  invoices = simpleInvoiceStore(pool, settings);
let tom: { token: string; id: string; credential: string },
  today: string,
  month: string;

const ready = <T>(result: InvoiceResult<T>): T => {
  if (result.kind !== "ready") throw Error(result.kind);
  return result.value;
};
async function account(name?: string, address?: string) {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token, "account");
  if (session.kind !== "active") throw Error("No invented member");
  const id = session.learner.id;
  if (address) {
    let link = "";
    const email = memberEmailAccess(
      pool,
      {
        async send(_address, value) {
          link = value;
        },
      },
      "http://127.0.0.1:3000",
    );
    expect(await email.requestAttach(token, address)).toBe("sent");
    const code = new URL(link).searchParams.get("code")!;
    expect((await email.consume(code, token)).kind).toBe("attached");
  }
  if (name)
    await pool.query("UPDATE learners SET display_name=$2 WHERE id=$1", [
      id,
      name,
    ]);
  return { token, id };
}
async function history(before?: string): Promise<ChangeHistory> {
  const result = await admin.changes(tom.credential, before);
  if (result.kind !== "ready") throw Error(result.kind);
  return result.value;
}
const sentences = async () =>
  (await history()).entries.map((entry) => changeText(entry));
const proposal = (
  ownerId: string,
  cadence: "one_time" | "monthly" = "one_time",
) => ({
  ownerId,
  operationId: randomUUID(),
  courses: [{ id: "FND-001", version: 2, amountCents: 1000 }],
  cadence,
  startsOn: today,
  taxCents: 0,
});
async function acceptedInvoice(ownerToken: string, ownerId: string) {
  const plan = ready(await invoices.propose(tom.credential, proposal(ownerId)));
  const { invoiceId } = ready(
    await invoices.accept(ownerToken, {
      planId: plan.planId,
      expectedRevision: 1,
      operationId: randomUUID(),
      name: "Invented recipient",
      email: "invented-recipient@example.invalid",
    }),
  );
  return { planId: plan.planId, invoiceId };
}
async function coachingInvoice(ownerToken: string, ownerId: string) {
  const rate = ready(
    await invoices.setCoachingRate(tom.credential, {
      ownerId,
      effectiveMonth: month,
      cents: 12000,
      expectedVersion: 0,
      operationId: randomUUID(),
    }),
  );
  const saved = ready(
    await invoices.saveCoaching(ownerToken, {
      month,
      minutes: 90,
      expectedRevision: 0,
      operationId: randomUUID(),
      name: "Invented recipient",
      email: "invented-recipient@example.invalid",
    }),
  );
  const submitted = ready(
    await invoices.submitCoaching(ownerToken, {
      month,
      rateId: rate.rateId,
      sample: settings.sample,
      expectedRevision: saved.revision,
      operationId: randomUUID(),
    }),
  );
  return submitted.revision;
}

beforeAll(async () => {
  await migrate(pool);
  await seedDraftPack(pool);
  const token = randomBytes(32).toString("hex");
  const editor = randomBytes(32).toString("hex"),
    reviewer = randomBytes(32).toString("hex"),
    expiry = new Date(Date.now() + 3_600_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  expect(await foundationImportStore(pool).import(editor)).toBe("imported");
  for (const item of await reviewedFoundation()) {
    expect(await catalog.submit(editor, item.id, item.version)).toBe(true);
    expect(await catalog.approve(reviewer, item.id, item.version, true)).toBe(
      true,
    );
    expect(await catalog.publish(editor, item.id, item.version)).toBe(true);
  }
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token, "account");
  if (session.kind !== "active") throw Error("No invented administrator");
  let link = "";
  const email = memberEmailAccess(
    pool,
    {
      async send(_address, value) {
        link = value;
      },
    },
    "http://127.0.0.1:3000",
  );
  expect(await email.requestAttach(token, "tom@deepnative.io")).toBe("sent");
  expect(
    (await email.consume(new URL(link).searchParams.get("code")!, token)).kind,
  ).toBe("attached");
  await pool.query("UPDATE learners SET display_name=$2 WHERE id=$1", [
    session.learner.id,
    "Invented Tom",
  ]);
  const entered = await entry.enter(token);
  if (entered.kind !== "ready" || !entered.credential)
    throw Error("No administrator session");
  tom = { token, id: session.learner.id, credential: entered.credential };
  const now = (
    await pool.query<{ day: string; month: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
              to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS month`,
    )
  ).rows[0]!;
  today = now.day;
  month = now.month;
});
beforeEach(() =>
  pool.query("TRUNCATE account_role_events, billing_change_events"),
);
afterAll(() => pool.end());

it("CHANGELOG-01 says nothing is recorded when nothing changed", async () => {
  const value = await history();
  expect(value).toEqual({ entries: [], older: null });
  expect(changeHistoryBody(value, true)).toContain("No changes are recorded.");
});

it("CHANGELOG-02 lists role and coach changes with who, whom and when, newest first", async () => {
  const coach = await account("Invented Coach", "coach-02@example.test"),
    ada = await account("Invented Ada");
  const coachHash = hash("coach-02@example.test");
  expect(
    await admin.grant(tom.credential, {
      email: "coach-02@example.test",
      roles: ["coach"],
    }),
  ).toEqual({ kind: "ready" });
  expect(
    await admin.setCoaches(tom.credential, {
      learnerId: ada.id,
      coaches: [coachHash],
    }),
  ).toEqual({ kind: "ready" });
  expect(
    await admin.setCoaches(tom.credential, { learnerId: ada.id, coaches: [] }),
  ).toEqual({ kind: "ready" });
  expect(await sentences()).toEqual([
    "Invented Tom removed Invented Coach as a coach for Invented Ada.",
    "Invented Tom made Invented Coach a coach for Invented Ada.",
    "Invented Tom gave Invented Coach the Coach role.",
  ]);
  expect(coach.id).toBeTruthy();
});

it("CHANGELOG-03 logs each assignment a coach loses with their role", async () => {
  await account("Invented Coach Three", "coach-03@example.test");
  const ada = await account("Invented Ada Three"),
    bo = await account("Invented Bo Three"),
    coachHash = hash("coach-03@example.test");
  await admin.grant(tom.credential, {
    email: "coach-03@example.test",
    roles: ["coach"],
  });
  for (const learner of [ada, bo])
    await admin.setCoaches(tom.credential, {
      learnerId: learner.id,
      coaches: [coachHash],
    });
  expect(
    await admin.remove(tom.credential, {
      emailHash: coachHash,
      role: "coach",
    }),
  ).toEqual({ kind: "ready" });
  const now = await sentences();
  expect(now[0]).toBe(
    "Invented Tom removed the Coach role from Invented Coach Three.",
  );
  expect(now.slice(1, 3).sort()).toEqual([
    "Invented Tom removed Invented Coach Three as a coach for Invented Ada Three.",
    "Invented Tom removed Invented Coach Three as a coach for Invented Bo Three.",
  ]);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM coach_assignments WHERE coach_email_hash=$1",
        [coachHash],
      )
    ).rowCount,
  ).toBe(0);
});

it("CHANGELOG-04 logs each staff billing change once, with its amount", async () => {
  const m = await account("Invented Payer");
  const { invoiceId } = await acceptedInvoice(m.token, m.id);
  const open = ready(await invoices.invoice(tom.credential, invoiceId, true));
  ready(
    await invoices.pay(tom.credential, {
      invoiceId,
      expectedRevision: open.revision,
      operationId: randomUUID(),
      amountCents: 400,
      receivedOn: today,
    }),
  );
  const second = await account("Invented Voided");
  const voided = await acceptedInvoice(second.token, second.id);
  ready(
    await invoices.voidInvoice(tom.credential, {
      invoiceId: voided.invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      reason: "Invented private void reason",
    }),
  );
  const third = await account("Invented Hours");
  const revision = await coachingInvoice(third.token, third.id);
  const returned = ready(
    await invoices.returnCoaching(tom.credential, {
      ownerId: third.id,
      month,
      expectedRevision: revision,
      operationId: randomUUID(),
      reason: "Invented private return reason",
    }),
  );
  const saved = ready(
    await invoices.saveCoaching(third.token, {
      month,
      minutes: 60,
      expectedRevision: returned.revision,
      operationId: randomUUID(),
      name: "Invented recipient",
      email: "invented-recipient@example.invalid",
    }),
  );
  const rate = (
    await pool.query<{ id: string }>(
      "SELECT id FROM coaching_rates WHERE owner_id=$1",
      [third.id],
    )
  ).rows[0]!.id;
  const resubmitted = ready(
    await invoices.submitCoaching(third.token, {
      month,
      rateId: rate,
      sample: settings.sample,
      expectedRevision: saved.revision,
      operationId: randomUUID(),
    }),
  );
  ready(
    await invoices.issueCoaching(tom.credential, {
      ownerId: third.id,
      month,
      expectedRevision: resubmitted.revision,
      taxCents: 0,
      operationId: randomUUID(),
    }),
  );
  expect((await sentences()).reverse()).toEqual([
    "Invented Tom offered Invented Payer a course plan of CAD 10.00.",
    "Invented Tom recorded a payment of CAD 4.00 from Invented Payer.",
    "Invented Tom offered Invented Voided a course plan of CAD 10.00.",
    "Invented Tom voided an invoice of CAD 10.00 for Invented Voided.",
    `Invented Tom set the coaching rate for Invented Hours to CAD 120.00 per hour from ${month}.`,
    `Invented Tom returned the coaching hours for Invented Hours for ${month}.`,
    `Invented Tom issued Invented Hours a coaching invoice of CAD 120.00 for ${month}.`,
  ]);
});

it("CHANGELOG-05 a replay or refusal logs nothing extra, and a failed log write undoes the change", async () => {
  const m = await account("Invented Replay");
  const input = proposal(m.id);
  const planId = ready(await invoices.propose(tom.credential, input)).planId;
  expect(ready(await invoices.propose(tom.credential, input)).planId).toBe(
    planId,
  );
  const { invoiceId } = ready(
    await invoices.accept(m.token, {
      planId,
      expectedRevision: 1,
      operationId: randomUUID(),
      name: "Invented recipient",
      email: "invented-recipient@example.invalid",
    }),
  );
  const pay = {
    invoiceId,
    expectedRevision: ready(
      await invoices.invoice(tom.credential, invoiceId, true),
    ).revision,
    operationId: randomUUID(),
    amountCents: 100,
    receivedOn: today,
  };
  ready(await invoices.pay(tom.credential, pay));
  ready(await invoices.pay(tom.credential, pay));
  expect(
    (
      await invoices.pay(tom.credential, {
        ...pay,
        operationId: randomUUID(),
      })
    ).kind,
  ).toBe("conflict");
  expect(await sentences()).toHaveLength(2);

  await pool.query(
    "ALTER TABLE billing_change_events ADD CONSTRAINT invented_log_failure CHECK(amount_cents<>4242) NOT VALID",
  );
  try {
    const failed = await invoices.pay(tom.credential, {
      ...pay,
      expectedRevision: pay.expectedRevision + 1,
      operationId: randomUUID(),
      amountCents: 4242,
    });
    expect(failed.kind).not.toBe("ready");
  } finally {
    await pool.query(
      "ALTER TABLE billing_change_events DROP CONSTRAINT invented_log_failure",
    );
  }
  expect(
    (
      await pool.query<{ paid: string }>(
        "SELECT paid_cents::text AS paid FROM simple_invoices WHERE id=$1",
        [invoiceId],
      )
    ).rows[0]!.paid,
  ).toBe("100");
  expect(await sentences()).toHaveLength(2);
});

it("CHANGELOG-06 what members and the scheduled run do isn't a staff change", async () => {
  const m = await account("Invented Monthly");
  const { planId } = await (async () => {
    const offered = ready(
      await invoices.propose(tom.credential, proposal(m.id, "monthly")),
    );
    ready(
      await invoices.accept(m.token, {
        planId: offered.planId,
        expectedRevision: 1,
        operationId: randomUUID(),
        name: "Invented recipient",
        email: "invented-recipient@example.invalid",
      }),
    );
    return offered;
  })();
  // Backdate an accepted agreement, as OFFPUR-10 does, so a later cycle is due.
  const row = (
    await pool.query<{ terms: Record<string, unknown>; staff: string }>(
      "SELECT terms,created_by AS staff FROM simple_invoice_plans WHERE id=$1",
      [planId],
    )
  ).rows[0]!;
  const anchor = (
    await pool.query<{ day: string }>(
      "SELECT to_char(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 month','YYYY-MM-DD') AS day",
    )
  ).rows[0]!.day;
  const makeDue = async (owner: string) => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO simple_invoice_plans(id,owner_id,workspace_id,terms,state,created_by,accepted_at,recipient_name,recipient_email) VALUES($1,$2,$2,$3,'active',$4,clock_timestamp()-interval '1 month','Invented student','invented-student@example.invalid')",
      [
        id,
        owner,
        JSON.stringify({ ...row.terms, startsOn: anchor }),
        row.staff,
      ],
    );
  };
  await pool.query(
    "UPDATE simple_invoice_plans SET state='cancelled',revision=revision+1 WHERE id=$1",
    [planId],
  );
  await makeDue(m.id);
  await pool.query("TRUNCATE billing_change_events");
  const scheduled = ready(await invoices.generateScheduled());
  expect(scheduled.created).toBeGreaterThan(0);
  expect(await sentences()).toEqual([]);

  const other = await account("Invented Admin Run");
  await makeDue(other.id);
  ready(await invoices.generateDue(tom.credential));
  const listed = await sentences();
  expect(listed.length).toBeGreaterThan(0);
  for (const line of listed)
    expect(line).toBe(
      "Invented Tom issued Invented Admin Run a monthly invoice of CAD 10.00.",
    );

  const cancelling = await account("Invented Canceller");
  const plan = await acceptedInvoice(cancelling.token, cancelling.id);
  await pool.query("TRUNCATE billing_change_events");
  ready(
    await invoices.cancel(cancelling.token, {
      planId: plan.planId,
      expectedRevision: (
        await pool.query<{ revision: number }>(
          "SELECT revision FROM simple_invoice_plans WHERE id=$1",
          [plan.planId],
        )
      ).rows[0]!.revision,
      operationId: randomUUID(),
    }),
  );
  expect(await sentences()).toEqual([]);
});

it("CHANGELOG-07 earlier plan offers, payments and voids carry over when the log is created", async () => {
  const m = await account("Invented Earlier");
  const paid = await acceptedInvoice(m.token, m.id);
  ready(
    await invoices.pay(tom.credential, {
      invoiceId: paid.invoiceId,
      expectedRevision: ready(
        await invoices.invoice(tom.credential, paid.invoiceId, true),
      ).revision,
      operationId: randomUUID(),
      amountCents: 500,
      receivedOn: today,
    }),
  );
  const v = await account("Invented Earlier Void");
  const voided = await acceptedInvoice(v.token, v.id);
  ready(
    await invoices.voidInvoice(tom.credential, {
      invoiceId: voided.invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      reason: "Invented private void reason",
    }),
  );
  await pool.query("TRUNCATE billing_change_events");
  await pool.query("DROP TABLE billing_change_events CASCADE");
  await pool.query(
    "DROP TRIGGER account_role_events_append_only ON account_role_events",
  );
  await pool.query("DROP INDEX account_role_events_time");
  await pool.query("DELETE FROM schema_migrations WHERE version=100");
  await migrate(pool);
  const carried = await sentences();
  for (const line of [
    "Invented Tom offered Invented Earlier a course plan.",
    "Invented Tom recorded a payment of CAD 5.00 from Invented Earlier.",
    "Invented Tom voided an invoice of CAD 10.00 for Invented Earlier Void.",
  ])
    expect(carried).toContain(line);
  await migrate(pool);
  expect(
    (await sentences()).filter((line) => line === carried[0]),
  ).toHaveLength(1);
});

it("CHANGELOG-08 entries can't be edited or deleted", async () => {
  const m = await account("Invented Fixed");
  ready(await invoices.propose(tom.credential, proposal(m.id)));
  await admin.grant(tom.credential, {
    email: "someone-08@example.test",
    roles: ["coach"],
  });
  for (const table of ["billing_change_events", "account_role_events"]) {
    await expect(
      pool.query(`UPDATE ${table} SET actor_id=$1`, [randomUUID()]),
    ).rejects.toThrow("append-only");
    await expect(pool.query(`DELETE FROM ${table}`)).rejects.toThrow(
      "append-only",
    );
  }
  expect(await sentences()).toHaveLength(2);
});

it("CHANGELOG-09 entries outlive a deleted member and a former administrator without their names", async () => {
  const gone = await account("Invented Gone Member");
  ready(await invoices.propose(tom.credential, proposal(gone.id)));
  await pool.query("DELETE FROM simple_invoice_plans WHERE owner_id=$1", [
    gone.id,
  ]);
  await pool.query("DELETE FROM workspaces WHERE owner_principal_id=$1", [
    gone.id,
  ]);
  await pool.query("DELETE FROM learners WHERE id=$1", [gone.id]);
  await pool.query(
    "INSERT INTO billing_change_events(actor_id,action,member_id,amount_cents) VALUES($1,'plan_offered',$2,100)",
    [randomUUID(), tom.id],
  );
  const lines = await sentences();
  expect(lines).toEqual([
    "A former administrator offered Invented Tom a course plan of CAD 1.00.",
    "Invented Tom offered a deleted account a course plan of CAD 10.00.",
  ]);
  expect(lines.join()).not.toContain("Invented Gone Member");
});

it("CHANGELOG-10 shows no email, fingerprint, credential or reason", async () => {
  const address = "private-10@example.test";
  await account("Invented Holder", address);
  await admin.grant(tom.credential, { email: address, roles: ["coach"] });
  await admin.grant(tom.credential, {
    email: "nobody-10@example.test",
    roles: ["coach"],
  });
  const m = await account("Invented Ten");
  const voided = await acceptedInvoice(m.token, m.id);
  ready(
    await invoices.voidInvoice(tom.credential, {
      invoiceId: voided.invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      reason: "Invented private void reason",
    }),
  );
  const value = await history();
  const html = changeHistoryBody(value, true);
  expect(html).toContain(
    "gave an email not linked to an account the Coach role",
  );
  for (const secret of [
    address,
    hash(address),
    "nobody-10@example.test",
    hash("nobody-10@example.test"),
    "invented-recipient@example.invalid",
    "Invented private void reason",
    tom.credential,
    tom.token,
    tom.id,
    m.id,
    voided.invoiceId,
  ]) {
    expect(html).not.toContain(secret);
    expect(JSON.stringify(value)).not.toContain(secret);
  }
});

it("CHANGELOG-11 paging neither repeats nor skips and refuses a bad link", async () => {
  // All at one instant in each source, so only the tie-break keeps them apart.
  await pool.query(
    `INSERT INTO billing_change_events(actor_id,action,member_id,amount_cents,occurred_at)
     SELECT $1,'payment_recorded',$2,n,'2026-11-01 12:00:00.123456+00' FROM generate_series(1,40) n`,
    [randomUUID(), tom.id],
  );
  await pool.query(
    `INSERT INTO account_role_events(actor_id,action,email_hash,role,occurred_at)
     SELECT $1,'granted',$2,'coach','2026-11-01 12:00:00.123456+00' FROM generate_series(1,25)`,
    [randomUUID(), hash("paging@example.test")],
  );
  const seen: string[] = [];
  let before: string | undefined,
    pages = 0;
  do {
    const value = await history(before);
    pages++;
    for (const item of value.entries)
      seen.push(`${item.source}:${item.amountCents}`);
    before = value.older ?? undefined;
    if (before) expect(value.entries).toHaveLength(30);
  } while (before);
  expect(pages).toBe(3);
  expect(seen).toHaveLength(65);
  expect(seen.slice(0, 25)).toEqual(Array(25).fill("role:null"));
  expect(new Set(seen.slice(25)).size).toBe(40);
  for (const bad of [
    "nope",
    Buffer.from("2026-11-01T12:00:00.123456Z|invoice|1").toString("base64url"),
    Buffer.from("not a date|role|1").toString("base64url"),
  ])
    expect(await admin.changes(tom.credential, bad)).toEqual({
      kind: "invalid",
    });
});
