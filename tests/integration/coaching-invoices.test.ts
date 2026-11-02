import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import {
  simpleInvoiceStore,
  type InvoiceResult,
} from "../../src/simple-invoice-store.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

const pool = testPool(),
  members = store(pool);
const invoices = simpleInvoiceStore(pool, {
  sample: true,
  issuer: "Invented coaching issuer",
  instructions: "Sample only; do not pay.",
});
const application = app(members, {
  origin: "http://127.0.0.1:3000",
  secret: "coaching-native-test",
  mode: "test",
  simpleInvoices: invoices,
});
import { authorizationStore } from "../support/administrator-fixture.ts";
import { memberExportStore } from "../../src/member-export.ts";
import type { Pool, PoolClient } from "pg";
const auth = authorizationStore(pool),
  settings = {
    sample: true,
    issuer: "Invented coaching issuer",
    instructions: "Sample only; do not pay.",
  };
let admin: string, admin2: string, month: string;
const ready = <T>(result: InvoiceResult<T>): T => {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected ready");
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
const rateInput = (
  id: string,
  cents = 12000,
  expectedVersion = 0,
  effectiveMonth = month,
) => ({
  ownerId: id,
  effectiveMonth,
  cents,
  expectedVersion,
  operationId: randomUUID(),
});
const saveInput = (minutes = 90, expectedRevision = 0) => ({
  month,
  minutes,
  expectedRevision,
  operationId: randomUUID(),
  name: "陳 Invented member",
  email: "recipient@example.invalid",
});
async function submitted(cents = 12000, minutes = 90, service = invoices) {
  const m = await member(),
    rate = ready(await service.setCoachingRate(admin, rateInput(m.id, cents)));
  const saved = ready(await service.saveCoaching(m.token, saveInput(minutes)));
  const submission = ready(
    await service.submitCoaching(m.token, {
      month,
      rateId: rate.rateId,
      sample: settings.sample,
      expectedRevision: saved.revision,
      operationId: randomUUID(),
    }),
  );
  return { ...m, rate, revision: submission.revision };
}
const issueInput = (m: { id: string; revision: number }) => ({
  ownerId: m.id,
  month,
  expectedRevision: m.revision,
  taxCents: 0,
  operationId: randomUUID(),
});
const post = (
  path: string,
  token: string,
  fields: Record<string, string>,
  origin = "http://127.0.0.1:3000",
) =>
  withLoopback(application, (s) =>
    request(s)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf: csrf(token, "coaching-native-test"), ...fields }),
  );
beforeAll(async () => {
  await migrate(pool);
  admin = await staff();
  admin2 = await staff();
  month = (
    await pool.query<{ month: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS month",
    )
  ).rows[0]!.month;
});
afterAll(() => pool.end());
it("HOUR01/04 an existing registered member can reach its private monthly coaching hours without creating a bill", async () => {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const response = await withLoopback(application, (server) =>
    request(server)
      .get("/account/coaching")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
  expect(response.status).toBe(200);
  expect(response.text).toContain("Monthly coaching hours");
  expect((await invoices.overview(token)).kind).toBe("ready");
  expect(ready(await invoices.overview(token)).invoices).toEqual([]);
});

it("HOUR02/03/04/07 different member rates produce private exact invoices, explicit tax and immutable snapshots", async () => {
  const a = await submitted(12000),
    b = await submitted(8000);
  const ai = ready(
      await invoices.issueCoaching(admin, { ...issueInput(a), taxCents: 2340 }),
    ),
    bi = ready(await invoices.issueCoaching(admin2, issueInput(b)));
  const first = ready(await invoices.invoice(a.token, ai.invoiceId)),
    second = ready(await invoices.invoice(b.token, bi.invoiceId));
  expect(first.totalCents).toBe(20340);
  expect(second.totalCents).toBe(12000);
  expect(first.document.coaching).toMatchObject({
    month,
    minutes: 90,
    rateCents: 12000,
    rateVersion: 1,
    submissionRevision: 2,
  });
  expect(first.document.billedTo).toBe("陳 Invented member");
  expect((await invoices.invoice(b.token, ai.invoiceId)).kind).toBe(
    "not-found",
  );
  await expect(
    pool.query(
      "UPDATE simple_invoices SET coaching_month='2020-01' WHERE id=$1",
      [ai.invoiceId],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query(
      "UPDATE coaching_submissions SET snapshot='{}' WHERE owner_id=$1",
      [a.id],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("UPDATE coaching_rates SET cents=10 WHERE owner_id=$1", [a.id]),
  ).rejects.toThrow("immutable");
  ready(await invoices.setCoachingRate(admin, rateInput(a.id, 20000, 1)));
  expect(ready(await invoices.invoice(a.token, ai.invoiceId)).document).toEqual(
    first.document,
  );
  const page = await withLoopback(application, (s) =>
    request(s)
      .get(`/account/purchases/invoices/${ai.invoiceId}`)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${a.token}`),
  );
  expect(page.status).toBe(200);
  expect(page.text).toContain("1 hour 30 minutes");
  expect(page.text).toContain("Coaching charges");
});
it("HOUR02/03 zero and rounded-zero submissions are retained without invoices; no rate never fabricates an amount", async () => {
  for (const [cents, minutes] of [
    [12000, 0],
    [1, 1],
  ]) {
    const m = await submitted(cents, minutes),
      overview = ready(await invoices.coachingOverview(m.token, month));
    expect(overview.entry?.state).toBe("submitted");
    expect(overview.entry?.snapshot?.subtotalCents).toBe(0);
    expect(
      (await invoices.issueCoaching(admin, { ...issueInput(m), taxCents: 100 }))
        .kind,
    ).toBe("invalid");
    expect(ready(await invoices.overview(m.token)).invoices).toEqual([]);
  }
  const m = await member();
  ready(await invoices.saveCoaching(m.token, saveInput()));
  expect(
    ready(await invoices.coachingOverview(m.token, month)).rate,
  ).toBeNull();
  expect(
    (
      await invoices.submitCoaching(m.token, {
        month,
        rateId: randomUUID(),
        sample: true,
        expectedRevision: 1,
        operationId: randomUUID(),
      })
    ).kind,
  ).toBe("unavailable");
  expect(
    (await invoices.saveCoaching(m.token, { ...saveInput(), month: "2999-01" }))
      .kind,
  ).toBe("invalid");
  expect(
    (
      await invoices.saveCoaching(m.token, {
        ...saveInput(),
        month: "2024-02",
        minutes: 41761,
      })
    ).kind,
  ).toBe("invalid");
});
it("HOUR05 effective-month inheritance, stale rate confirmation and returned resubmission preserve prior snapshots", async () => {
  const m = await member();
  ready(
    await invoices.setCoachingRate(admin, rateInput(m.id, 8000, 0, "2024-01")),
  );
  ready(
    await invoices.setCoachingRate(admin, rateInput(m.id, 12000, 1, "2024-03")),
  );
  for (const [selected, cents] of [
    ["2023-12", null],
    ["2024-02", 8000],
    ["2024-03", 12000],
    ["2024-04", 12000],
  ] as const)
    expect(
      ready(await invoices.coachingOverview(m.token, selected)).rate?.cents ??
        null,
    ).toBe(cents);
  ready(await invoices.saveCoaching(m.token, saveInput()));
  const old = ready(await invoices.coachingOverview(m.token, month)).rate!;
  ready(await invoices.setCoachingRate(admin2, rateInput(m.id, 14000, 2)));
  const input = {
    month,
    rateId: old.id,
    sample: true,
    expectedRevision: 1,
    operationId: randomUUID(),
  };
  expect((await invoices.submitCoaching(m.token, input)).kind).toBe("conflict");
  const rate = ready(await invoices.coachingOverview(m.token, month)).rate!;
  ready(
    await invoices.submitCoaching(m.token, {
      ...input,
      rateId: rate.id,
      operationId: randomUUID(),
    }),
  );
  const oldSnapshot = ready(await invoices.coachingOverview(m.token, month))
    .entry!.snapshot;
  ready(
    await invoices.returnCoaching(admin, {
      ownerId: m.id,
      month,
      expectedRevision: 2,
      operationId: randomUUID(),
      reason: "Correct duration",
    }),
  );
  ready(await invoices.setCoachingRate(admin, rateInput(m.id, 16000, 3)));
  ready(await invoices.saveCoaching(m.token, saveInput(60, 3)));
  ready(
    await invoices.submitCoaching(m.token, {
      month,
      rateId: ready(await invoices.coachingOverview(m.token, month)).rate!.id,
      sample: true,
      expectedRevision: 4,
      operationId: randomUUID(),
    }),
  );
  expect(
    (
      await pool.query(
        "SELECT snapshot FROM coaching_submissions WHERE owner_id=$1 ORDER BY revision",
        [m.id],
      )
    ).rows.map((r) => r.snapshot),
  ).toEqual([
    oldSnapshot,
    expect.objectContaining({ minutes: 60, subtotalCents: 16000 }),
  ]);
  expect(
    (
      await invoices.issueCoaching(admin, {
        ...issueInput({ id: m.id, revision: 2 }),
      })
    ).kind,
  ).toBe("conflict");
});
it("HOUR06 distinct administrators serialize duplicate rate and issue operations; same key recovers exactly once", async () => {
  const m = await member(),
    r1 = rateInput(m.id),
    r2 = rateInput(m.id, 8000);
  const rates = await Promise.all([
    invoices.setCoachingRate(admin, r1),
    invoices.setCoachingRate(admin2, r2),
  ]);
  expect(rates.map((r) => r.kind).sort()).toEqual(["conflict", "ready"]);
  const winner =
    rates[0]!.kind === "ready"
      ? { actor: admin, input: r1, result: rates[0]! }
      : { actor: admin2, input: r2, result: rates[1]! };
  expect(await invoices.setCoachingRate(winner.actor, winner.input)).toEqual(
    winner.result,
  );
  expect(
    (
      await invoices.setCoachingRate(winner.actor, {
        ...winner.input,
        cents: 1,
      })
    ).kind,
  ).toBe("conflict");
  const saved = saveInput();
  ready(await invoices.saveCoaching(m.token, saved));
  expect(await invoices.saveCoaching(m.token, saved)).toEqual({
    kind: "ready",
    value: { month, revision: 1 },
  });
  const submit = {
    month,
    rateId: ready(await invoices.coachingOverview(m.token, month)).rate!.id,
    sample: true,
    expectedRevision: 1,
    operationId: randomUUID(),
  };
  ready(await invoices.submitCoaching(m.token, submit));
  ready(await invoices.submitCoaching(m.token, submit));
  const input = issueInput({ id: m.id, revision: 2 });
  const issued = await Promise.all([
    invoices.issueCoaching(admin, input),
    invoices.issueCoaching(admin2, { ...input, operationId: randomUUID() }),
  ]);
  expect(issued.map((r) => r.kind).sort()).toEqual(["conflict", "ready"]);
  expect(ready(await invoices.overview(m.token)).invoices).toHaveLength(1);
  expect(
    (
      await pool.query("SELECT * FROM coaching_submissions WHERE owner_id=$1", [
        m.id,
      ])
    ).rowCount,
  ).toBe(1);
});
it("HOUR05/06 issue versus return and rate versus submit leave only one atomic accepted outcome", async () => {
  const m = await submitted();
  const raced = await Promise.all([
    invoices.issueCoaching(admin, issueInput(m)),
    invoices.returnCoaching(admin2, {
      ownerId: m.id,
      month,
      expectedRevision: 2,
      operationId: randomUUID(),
      reason: "Review correction",
    }),
  ]);
  expect(raced.map((r) => r.kind).sort()).toEqual(["conflict", "ready"]);
  const n = await member(),
    rate = ready(await invoices.setCoachingRate(admin, rateInput(n.id)));
  ready(await invoices.saveCoaching(n.token, saveInput()));
  const changed = await Promise.all([
    invoices.setCoachingRate(admin2, rateInput(n.id, 8000, 1)),
    invoices.submitCoaching(n.token, {
      month,
      rateId: rate.rateId,
      sample: true,
      expectedRevision: 1,
      operationId: randomUUID(),
    }),
  ]);
  expect(changed[0]!.kind).toBe("ready");
  expect(["ready", "conflict"]).toContain(changed[1]!.kind);
  const entry = ready(await invoices.coachingOverview(n.token, month)).entry!;
  if (entry.state === "submitted")
    expect(entry.snapshot?.rate.cents).toBe(12000);
  else expect(entry.snapshot).toBeNull();
});
it("HOUR07 staff, revoked administrators, forged owner and CSRF cannot change private coaching records", async () => {
  const m = await submitted(),
    other = await member(),
    reviewer = await staff("reviewer"),
    revoked = await staff();
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE token_hash=$1",
    [(await import("../../src/store.ts")).hash(revoked)],
  );
  for (const denied of [m.token, reviewer, revoked])
    expect((await invoices.issueCoaching(denied, issueInput(m))).kind).toBe(
      "denied",
    );
  expect((await invoices.coachingOverview(other.token, month, m.id)).kind).toBe(
    "denied",
  );
  expect(
    (
      await post(
        `/operator/coaching/${m.id}/issue`,
        admin,
        {
          month,
          action: "issue",
          confirm: "issue",
          revision: "2",
          tax: "0.00",
          operationId: randomUUID(),
        },
        "https://other.invalid",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await post("/account/coaching/save", other.token, {
        ...Object.fromEntries(
          Object.entries(saveInput()).map(([k, v]) => [k, String(v)]),
        ),
        ownerId: m.id,
      })
    ).status,
  ).toBe(403);
  expect(ready(await invoices.overview(m.token)).invoices).toEqual([]);
});
it("HOUR08 unpaid void/reopen/edit/resubmit creates linked replacement and retained history, never a second active coaching invoice", async () => {
  const m = await submitted(),
    first = ready(await invoices.issueCoaching(admin, issueInput(m)));
  const correction = {
    ownerId: m.id,
    month,
    expectedRevision: 3,
    reason: "Wrong duration",
    operationId: randomUUID(),
  };
  expect((await invoices.returnCoaching(admin, correction)).kind).toBe(
    "conflict",
  );
  ready(
    await invoices.voidInvoice(admin, {
      invoiceId: first.invoiceId,
      expectedRevision: 1,
      reason: "Wrong duration",
      operationId: randomUUID(),
    }),
  );
  ready(await invoices.returnCoaching(admin, correction));
  ready(await invoices.saveCoaching(m.token, saveInput(60, 4)));
  ready(
    await invoices.submitCoaching(m.token, {
      month,
      rateId: m.rate.rateId,
      sample: true,
      expectedRevision: 5,
      operationId: randomUUID(),
    }),
  );
  const replacement = ready(
    await invoices.issueCoaching(admin, issueInput({ id: m.id, revision: 6 })),
  );
  expect(
    ready(await invoices.invoice(m.token, replacement.invoiceId)).document
      .coaching?.replacesInvoiceId,
  ).toBe(first.invoiceId);
  expect(ready(await invoices.overview(m.token)).invoices).toHaveLength(2);
  expect(
    (
      await pool.query(
        "SELECT id FROM simple_invoices WHERE owner_id=$1 AND coaching_month=$2 AND void_reason IS NULL",
        [m.id, month],
      )
    ).rowCount,
  ).toBe(1);
  const original = ready(await invoices.invoice(m.token, first.invoiceId));
  expect(original.document.coaching?.minutes).toBe(90);
  expect(original.voidReason).toBe("Wrong duration");
  await expect(
    pool.query(
      "INSERT INTO simple_invoices(id,owner_id,cycle,document,sample,total_cents,coaching_month) SELECT $2,owner_id,0,document,sample,total_cents,coaching_month FROM simple_invoices WHERE id=$1",
      [replacement.invoiceId, randomUUID()],
    ),
  ).rejects.toThrow("simple_invoice_one_coaching_month");
  await pool.query(
    "INSERT INTO simple_invoices(id,owner_id,cycle,document,sample,total_cents) SELECT $2,owner_id,0,document-'coaching',sample,total_cents FROM simple_invoices WHERE id=$1",
    [replacement.invoiceId, randomUUID()],
  );
  expect(ready(await invoices.overview(m.token)).invoices).toHaveLength(3);
});
it("HOUR08 payment racing void cannot erase received funds; delivery uncertainty blocks correction", async () => {
  const m = await submitted(),
    i = ready(await invoices.issueCoaching(admin, issueInput(m))),
    today = new Date().toISOString().slice(0, 10);
  const results = await Promise.all([
    invoices.pay(admin, {
      invoiceId: i.invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      amountCents: 100,
      receivedOn: today,
    }),
    invoices.voidInvoice(admin2, {
      invoiceId: i.invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      reason: "Correction",
    }),
  ]);
  expect(results.map((r) => r.kind).sort()).toEqual(["conflict", "ready"]);
  const current = ready(await invoices.invoice(m.token, i.invoiceId));
  expect(
    current.paidCents === 100
      ? current.voidReason === null
      : current.voidReason === "Correction",
  ).toBe(true);
  if (current.paidCents)
    expect(
      (
        await invoices.returnCoaching(admin, {
          ownerId: m.id,
          month,
          expectedRevision: 3,
          operationId: randomUUID(),
          reason: "Cannot erase funds",
        })
      ).kind,
    ).toBe("conflict");
  for (const delivery of ["sending", "unconfirmed"]) {
    const n = await submitted(),
      ni = ready(await invoices.issueCoaching(admin, issueInput(n)));
    await pool.query("UPDATE simple_invoices SET delivery=$2 WHERE id=$1", [
      ni.invoiceId,
      delivery,
    ]);
    expect(
      (
        await invoices.voidInvoice(admin, {
          invoiceId: ni.invoiceId,
          expectedRevision: 1,
          operationId: randomUUID(),
          reason: "Correction",
        })
      ).kind,
    ).toBe("conflict");
  }
});
it("HOUR09 sample pending submissions never silently become payable, and member expiry does not discard accepted work", async () => {
  const m = await submitted(),
    configured = simpleInvoiceStore(pool, { ...settings, sample: false });
  expect((await configured.issueCoaching(admin, issueInput(m))).kind).toBe(
    "conflict",
  );
  expect(ready(await invoices.overview(m.token)).invoices).toEqual([]);
  ready(
    await configured.returnCoaching(admin, {
      ownerId: m.id,
      month,
      expectedRevision: 2,
      operationId: randomUUID(),
      reason: "Confirm configured billing mode",
    }),
  );
  expect(
    (
      await configured.submitCoaching(m.token, {
        month,
        rateId: m.rate.rateId,
        sample: true,
        expectedRevision: 3,
        operationId: randomUUID(),
      })
    ).kind,
  ).toBe("conflict");
  ready(
    await configured.submitCoaching(m.token, {
      month,
      rateId: m.rate.rateId,
      sample: false,
      expectedRevision: 3,
      operationId: randomUUID(),
    }),
  );
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
    [m.id],
  );
  expect((await configured.coachingOverview(m.token, month)).kind).toBe(
    "denied",
  );
  const issued = ready(
    await configured.issueCoaching(
      admin,
      issueInput({ id: m.id, revision: 4 }),
    ),
  );
  expect(
    ready(await configured.invoice(admin, issued.invoiceId, true)).document
      .sample,
  ).toBe(false);
});
it("HOUR09 own export includes rates, drafts, immutable submissions and invoices; deletion erases sample only", async () => {
  const m = await submitted(),
    other = await submitted(),
    issued = ready(await invoices.issueCoaching(admin, issueInput(m)));
  const exporter = memberExportStore(pool),
    records: Record<string, unknown[]> = {};
  let cursor: string | undefined;
  do {
    const result = await exporter.exportOwned(m.token, cursor);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw Error();
    for (const [key, rows] of Object.entries(result.payload.records))
      records[key] = [...(records[key] ?? []), ...rows];
    cursor = result.payload.page.nextCursor ?? undefined;
  } while (cursor);
  expect(records.coachingRates).toHaveLength(1);
  expect(records.coachingMonths).toHaveLength(1);
  expect(records.coachingSubmissions).toHaveLength(1);
  expect(records.invoices).toHaveLength(1);
  expect(JSON.stringify(records)).not.toContain(other.id);
  await members.remove(m.id);
  for (const table of [
    "coaching_rates",
    "coaching_months",
    "coaching_submissions",
    "simple_invoices",
  ])
    expect(
      (await pool.query(`SELECT 1 FROM ${table} WHERE owner_id=$1`, [m.id]))
        .rowCount,
    ).toBe(0);
  expect(
    (
      await pool.query("SELECT id FROM simple_invoices WHERE id=$1", [
        issued.invoiceId,
      ])
    ).rowCount,
  ).toBe(0);
  const n = await submitted(),
    configured = simpleInvoiceStore(pool, { ...settings, sample: false });
  ready(
    await configured.returnCoaching(admin, {
      ownerId: n.id,
      month,
      expectedRevision: 2,
      reason: "Reconfirm",
      operationId: randomUUID(),
    }),
  );
  ready(
    await configured.submitCoaching(n.token, {
      month,
      rateId: n.rate.rateId,
      sample: false,
      expectedRevision: 3,
      operationId: randomUUID(),
    }),
  );
  const retained = ready(
    await configured.issueCoaching(
      admin,
      issueInput({ id: n.id, revision: 4 }),
    ),
  );
  await members.remove(n.id);
  expect(
    ready(await configured.invoice(admin, retained.invoiceId, true)).document
      .coaching?.minutes,
  ).toBe(90);
});
function lostCommit() {
  let lost = false;
  return new Proxy(pool, {
    get(target, key) {
      if (key === "connect")
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(c, k) {
              if (k === "query")
                return async (...args: unknown[]) => {
                  const result = await (
                    c.query as (...v: unknown[]) => Promise<unknown>
                  ).apply(c, args);
                  if (args[0] === "COMMIT" && !lost) {
                    lost = true;
                    throw Error("Invented acknowledgement loss");
                  }
                  return result;
                };
              return typeof c[k as keyof PoolClient] === "function"
                ? (
                    c[k as keyof PoolClient] as (...args: unknown[]) => unknown
                  ).bind(c)
                : c[k as keyof PoolClient];
            },
          });
        };
      return typeof target[key as keyof Pool] === "function"
        ? (target[key as keyof Pool] as (...args: unknown[]) => unknown).bind(
            target,
          )
        : target[key as keyof Pool];
    },
  }) as Pool;
}
it("HOUR06 lost commit acknowledgements for rate/save/submit/issue recover original receipts without duplicate writes", async () => {
  const m = await member(),
    rate = rateInput(m.id);
  expect(
    (
      await simpleInvoiceStore(lostCommit(), settings).setCoachingRate(
        admin,
        rate,
      )
    ).kind,
  ).toBe("unavailable");
  const r = ready(await invoices.setCoachingRate(admin, rate));
  expect(
    ready(await invoices.inspect(admin, rate.operationId, true)).result,
  ).toEqual(r);
  const save = saveInput();
  expect(
    (
      await simpleInvoiceStore(lostCommit(), settings).saveCoaching(
        m.token,
        save,
      )
    ).kind,
  ).toBe("unavailable");
  ready(await invoices.saveCoaching(m.token, save));
  const submit = {
    month,
    rateId: r.rateId,
    sample: true,
    expectedRevision: 1,
    operationId: randomUUID(),
  };
  expect(
    (
      await simpleInvoiceStore(lostCommit(), settings).submitCoaching(
        m.token,
        submit,
      )
    ).kind,
  ).toBe("unavailable");
  ready(await invoices.submitCoaching(m.token, submit));
  const issue = issueInput({ id: m.id, revision: 2 });
  expect(
    (
      await simpleInvoiceStore(lostCommit(), settings).issueCoaching(
        admin,
        issue,
      )
    ).kind,
  ).toBe("unavailable");
  const result = ready(await invoices.issueCoaching(admin, issue));
  expect(
    ready(await invoices.inspect(admin, issue.operationId, true)).result,
  ).toEqual(result);
  expect(ready(await invoices.overview(m.token)).invoices).toHaveLength(1);
});

it("HOUR06 shared-self verified administrator contention fails atomically and recovers only by deliberate same-key action", async () => {
  const target = (
    await pool.query<{ id: string; token_hash: string }>(
      "SELECT p.id,p.token_hash FROM principals p JOIN administrator_sessions a ON a.member_id=p.id JOIN principals staff ON staff.id=a.staff_id WHERE staff.token_hash=$1",
      [(await import("../../src/store.ts")).hash(admin)],
    )
  ).rows[0]!;
  await pool.query(
    "INSERT INTO learners(id,token_hash,background,goal) VALUES($1,$2,'explorer','everyday') ON CONFLICT(id) DO NOTHING",
    [target.id, target.token_hash],
  );
  let arrived = 0,
    release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fenced = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, args?: unknown[]) => {
          const result = await client.query(sql, args);
          if (sql.includes("FROM authorized_staff_profiles")) {
            arrived++;
            if (arrived === 2) release();
            await barrier;
          }
          return result;
        },
        release: (error?: Error) => client.release(error),
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  const service = simpleInvoiceStore(fenced, settings),
    a = rateInput(target.id),
    b = rateInput(target.id, 8000);
  const results = await Promise.all([
    service.setCoachingRate(admin, a),
    service.setCoachingRate(admin2, b),
  ]);
  expect(results.map((r) => r.kind).sort()).toEqual(["ready", "unavailable"]);
  expect(
    (
      await pool.query("SELECT version FROM coaching_rates WHERE owner_id=$1", [
        target.id,
      ])
    ).rows,
  ).toEqual([{ version: 1 }]);
  const failed =
    results[0]!.kind === "unavailable"
      ? { actor: admin, input: a }
      : { actor: admin2, input: b };
  expect(
    (await invoices.inspect(failed.actor, failed.input.operationId, true)).kind,
  ).toBe("not-found");
  // Same payload cannot overwrite the successful concurrent rate after contention clears.
  expect(
    (await invoices.setCoachingRate(failed.actor, failed.input)).kind,
  ).toBe("conflict");
  expect(
    (
      await pool.query(
        "SELECT 1 FROM simple_invoice_operations WHERE operation_id=ANY($1::uuid[])",
        [[a.operationId, b.operationId]],
      )
    ).rowCount,
  ).toBe(1);
  const winner =
    results[0]!.kind === "ready"
      ? { actor: admin, input: a, result: results[0] }
      : { actor: admin2, input: b, result: results[1] };
  expect(await invoices.setCoachingRate(winner.actor, winner.input)).toEqual(
    winner.result,
  );
});
it("HOUR09 deletion waits for issued sample transaction then erases its private coaching rows", async () => {
  const m = await submitted(),
    input = issueInput(m);
  let reached!: () => void, resume!: () => void;
  const paused = new Promise<void>((resolve) => {
      reached = resolve;
    }),
    release = new Promise<void>((resolve) => {
      resume = resolve;
    });
  const fenced = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, args?: unknown[]) => {
          const result = await client.query(sql, args);
          if (sql.startsWith("INSERT INTO simple_invoices")) {
            reached();
            await release;
          }
          return result;
        },
        release: (error?: Error) => client.release(error),
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  const issuing = simpleInvoiceStore(fenced, settings).issueCoaching(
    admin,
    input,
  );
  await paused;
  const deleting = members.remove(m.id);
  try {
    await vi.waitFor(
      async () => {
        expect(
          (
            await pool.query<{ n: number }>(
              "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'DELETE FROM principals%'",
            )
          ).rows[0]!.n,
        ).toBeGreaterThan(0);
      },
      { timeout: 2000, interval: 20 },
    );
  } finally {
    resume();
  }
  const issued = ready(await issuing);
  await deleting;
  for (const table of [
    "coaching_rates",
    "coaching_months",
    "coaching_submissions",
    "simple_invoices",
  ])
    expect(
      (await pool.query(`SELECT 1 FROM ${table} WHERE owner_id=$1`, [m.id]))
        .rowCount,
    ).toBe(0);
  expect((await invoices.invoice(admin, issued.invoiceId, true)).kind).toBe(
    "not-found",
  );
  expect(
    ready(await invoices.inspect(admin, input.operationId, true)).result,
  ).toEqual(issued);
});

it("HOUR09 appended coaching-rate export continues beyond one page exactly once and excludes another member", async () => {
  const m = await member(),
    outsider = await member(),
    ids: string[] = [];
  for (let version = 0; version < 101; version++)
    ids.push(
      ready(
        await invoices.setCoachingRate(
          admin,
          rateInput(m.id, 12000 + version, version),
        ),
      ).rateId,
    );
  const privateRate = ready(
    await invoices.setCoachingRate(admin, rateInput(outsider.id, 8000)),
  );
  const exporter = memberExportStore(pool),
    seen: string[] = [];
  let cursor: string | undefined,
    pages = 0;
  do {
    const result = await exporter.exportOwned(m.token, cursor);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw Error("Export unavailable");
    pages++;
    expect(result.payload.page.number).toBe(pages);
    expect(result.payload.page.recordCount).toBeLessThanOrEqual(100);
    seen.push(
      ...result.payload.records.coachingRates!.map((row) => String(row.id)),
    );
    expect(JSON.stringify(result.payload)).not.toContain(privateRate.rateId);
    const next = result.payload.page.nextCursor;
    expect(result.payload.page.complete).toBe(next === null);
    if (next) {
      expect(next).not.toBe(cursor);
      expect((await exporter.exportOwned(outsider.token, next)).kind).toBe(
        "denied",
      );
    }
    cursor = next ?? undefined;
  } while (cursor);
  expect(pages).toBe(2);
  expect(seen).toEqual(ids);
  expect(new Set(seen).size).toBe(101);
});
