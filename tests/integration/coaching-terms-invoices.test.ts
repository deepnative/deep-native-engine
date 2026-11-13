import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import {
  simpleInvoiceStore,
  type InvoiceResult,
} from "../../src/simple-invoice-store.ts";
import { coachingTermsStore } from "../../src/coaching-terms.ts";
import { billingProfileStore } from "../../src/billing-profile.ts";
import { DEEP_NATIVE_INVOICE_ISSUER } from "../../src/invoice-issuer.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";

// #318 under the owner's 9 Nov 2026 decisions: an administrator issues one
// invoice for a student's current coaching terms (#316/#800), with 13% HST and
// Deep Native Inc.'s offline payment wording (#797). Staff record the offline
// payment with the existing form. Invented people and amounts only.
const pool = testPool(),
  members = store(pool),
  terms = coachingTermsStore(pool),
  profiles = billingProfileStore(pool),
  auth = authorizationStore(pool),
  invoices = simpleInvoiceStore(pool, {
    sample: false,
    ...DEEP_NATIVE_INVOICE_ISSUER,
  }),
  samples = simpleInvoiceStore(pool, {
    sample: true,
    issuer: "Invented coaching issuer",
    instructions: "Sample only; do not pay.",
  });
const origin = "http://127.0.0.1:3000",
  secret = "coaching-terms-invoice-test";
const application = app(members, {
  origin,
  secret,
  mode: "test",
  simpleInvoices: invoices,
  coachingTerms: terms,
  billingProfiles: profiles,
});
const ready = <T>(
  result: InvoiceResult<T> | { kind: string; value?: T },
): T => {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready" || !("value" in result))
    throw Error("Expected ready");
  return result.value as T;
};
async function member(recipient = true) {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const s = await members.session(token, "account");
  if (s.kind !== "active") throw Error();
  if (recipient)
    ready(
      await profiles.save(token, {
        name: "Invented Student",
        email: "invented.student@example.test",
        company: "Invented Studio",
        revision: 0,
      }),
    );
  return { token, id: s.learner.id };
}
async function staff(role: "platform_admin" | "reviewer" = "platform_admin") {
  const token = randomBytes(32).toString("hex");
  await auth.provisionStaff(token, role, new Date(Date.now() + 3600000));
  return token;
}
const agreed = {
  priceCents: 120000,
  startsOn: "2026-12-01",
  endsOn: "2027-05-31",
  renewsOn: "2027-06-01",
  reviewMinutes: 120,
  coachingSessions: 6,
  aiRequests: 200,
};
const setTerms = async (
  ownerId: string,
  expectedVersion = 0,
  values = agreed,
) =>
  ready(
    await terms.save(admin, {
      ...values,
      ownerId,
      expectedVersion,
      operationId: randomUUID(),
    }),
  );
const issueInput = (ownerId: string, version = 1) => ({
  ownerId,
  version,
  operationId: randomUUID(),
});
const get = (path: string, token: string) =>
  withLoopback(application, (s) =>
    request(s)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
const post = (
  path: string,
  token: string,
  fields: Record<string, string>,
  from = origin,
  anti = csrf(token, secret),
) =>
  withLoopback(application, (s) =>
    request(s)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", from)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf: anti, ...fields }),
  );
const issued = async (ownerId: string) =>
  (
    await pool.query<{ id: string; total: string; void: string | null }>(
      "SELECT id,total_cents AS total,void_reason AS void FROM simple_invoices WHERE owner_id=$1 ORDER BY created_at",
      [ownerId],
    )
  ).rows;
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1");
let admin: string;
beforeAll(async () => {
  await migrate(pool);
  admin = await staff();
});
afterAll(() => pool.end());

it("TERMSINV318-01 an administrator issues the current terms as a Deep Native Inc. invoice with 13% HST", async () => {
  const m = await member();
  await setTerms(m.id);
  const page = text(
    (await get(`/operator/coaching/${m.id}/package`, admin)).text,
  );
  expect(page).toContain("Invoice these coaching terms");
  expect(page).toContain(
    "Issue an invoice for terms version 1: CAD 1,200.00 plus HST (13%) CAD 156.00, total CAD 1,356.00, to Invented Student · Invented Studio · invented.student@example.test.",
  );
  const sent = await post(`/operator/coaching/${m.id}/terms-invoice`, admin, {
    revision: "1",
    operationId: randomUUID(),
    confirm: "terms-invoice",
  });
  expect(sent.status).toBe(303);
  const [row] = await issued(m.id);
  expect(sent.headers.location).toBe(`/operator/invoices/${row!.id}`);
  expect(Number(row!.total)).toBe(135600);
  const doc = (
    await pool.query("SELECT document FROM simple_invoices WHERE id=$1", [
      row!.id,
    ])
  ).rows[0]!.document;
  expect(doc).toMatchObject({
    issuer: "Deep Native Inc. · Ontario, Canada",
    instructions:
      "Pay by Interac e-Transfer to info@deepnative.io or by cheque to Deep Native Inc.",
    billedTo: "Invented Student",
    billedToCompany: "Invented Studio",
    recipientEmail: "invented.student@example.test",
    lines: [
      {
        description: "Coaching · 2026-12-01 to 2027-05-31 · terms version 1",
        amountCents: 120000,
      },
    ],
    billing: { kind: "one_time" },
    taxCents: 15600,
    sample: false,
    tax: DEEP_NATIVE_INVOICE_ISSUER.tax,
    coachingTerms: { version: 1, startsOn: "2026-12-01", endsOn: "2027-05-31" },
  });
  const shown = text((await get(`/operator/invoices/${row!.id}`, admin)).text);
  for (const sentence of [
    "Coaching terms",
    "Terms version 1 · coaching period 2026-12-01 to 2027-05-31",
    "HST registration number 713254472RT0001",
    "Total CAD 1356.00",
  ])
    expect(shown).toContain(sentence);
  const own = text(
    (await get(`/account/purchases/invoices/${row!.id}`, m.token)).text,
  );
  expect(own).toContain(
    "Terms version 1 · coaching period 2026-12-01 to 2027-05-31",
  );
});

it("TERMSINV318-02 one live invoice per terms version: replay returns it, a second is refused, a new version or a void allows another", async () => {
  const m = await member();
  await setTerms(m.id);
  const first = issueInput(m.id);
  const { invoiceId } = ready(await invoices.issueCoachingTerms(admin, first));
  expect(ready(await invoices.issueCoachingTerms(admin, first))).toEqual({
    invoiceId,
  });
  expect(await invoices.issueCoachingTerms(admin, issueInput(m.id))).toEqual({
    kind: "conflict",
  });
  ready(
    await invoices.voidInvoice(admin, {
      invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      reason: "Invented correction",
    }),
  );
  ready(await invoices.issueCoachingTerms(admin, issueInput(m.id)));
  await setTerms(m.id, 1, { ...agreed, priceCents: 90000 });
  // An invoice for an earlier version is refused once a newer one is current.
  expect(await invoices.issueCoachingTerms(admin, issueInput(m.id, 1))).toEqual(
    {
      kind: "conflict",
    },
  );
  const second = ready(
    await invoices.issueCoachingTerms(admin, issueInput(m.id, 2)),
  );
  const rows = await issued(m.id);
  expect(rows.map((r) => [Number(r.total), r.void !== null])).toEqual([
    [135600, true],
    [135600, false],
    [101700, false],
  ]);
  expect(rows[2]!.id).toBe(second.invoiceId);
  await expect(
    pool.query(
      "UPDATE simple_invoices SET coaching_terms_id=NULL WHERE id=$1",
      [second.invoiceId],
    ),
  ).rejects.toThrow();
});

it("TERMSINV318-03 without a saved billing recipient or terms, nothing is issued and the administrator is told why", async () => {
  const m = await member(false);
  expect(await invoices.issueCoachingTerms(admin, issueInput(m.id))).toEqual({
    kind: "not-found",
  });
  await setTerms(m.id);
  const page = text(
    (await get(`/operator/coaching/${m.id}/package`, admin)).text,
  );
  expect(page).toContain(
    "This student hasn't saved a billing recipient yet. Ask them to save one on their Billing recipient page before you issue an invoice for these terms.",
  );
  expect(await invoices.issueCoachingTerms(admin, issueInput(m.id))).toEqual({
    kind: "conflict",
  });
  const refused = await post(
    `/operator/coaching/${m.id}/terms-invoice`,
    admin,
    {
      revision: "1",
      operationId: randomUUID(),
      confirm: "terms-invoice",
    },
  );
  expect(refused.status).toBe(409);
  expect(await issued(m.id)).toEqual([]);
});

it("TERMSINV318-04 only a platform administrator with a valid, confirmed, current form can issue", async () => {
  const m = await member(),
    other = await member(),
    reviewer = await staff("reviewer");
  await setTerms(m.id);
  const path = `/operator/coaching/${m.id}/terms-invoice`;
  const fields = {
    revision: "1",
    operationId: randomUUID(),
    confirm: "terms-invoice",
  };
  for (const refused of [
    await post(path, m.token, fields),
    await post(path, other.token, fields),
    await post(path, reviewer, fields),
    await post(path, admin, fields, "http://evil.invalid"),
    await post(path, admin, fields, origin, "wrong"),
    await post(path, admin, { ...fields, tax: "1.00" }),
  ])
    expect(refused.status).toBe(403);
  expect(
    (await post(path, admin, { ...fields, confirm: "issue" })).status,
  ).toBe(422);
  expect((await post(path, admin, { ...fields, revision: "x" })).status).toBe(
    422,
  );
  expect((await post(path, admin, { ...fields, revision: "2" })).status).toBe(
    409,
  );
  expect(await invoices.issueCoachingTerms(m.token, issueInput(m.id))).toEqual({
    kind: "denied",
  });
  expect(await invoices.issueCoachingTerms(reviewer, issueInput(m.id))).toEqual(
    {
      kind: "denied",
    },
  );
  expect(
    await invoices.issueCoachingTerms(admin, {
      ...issueInput(m.id),
      version: 0,
    }),
  ).toEqual({ kind: "invalid" });
  expect(await issued(m.id)).toEqual([]);
});

it("TERMSINV318-05 staff record the offline payment with the existing form; the student sees the invoice, and staff history names it", async () => {
  const m = await member();
  await setTerms(m.id);
  const { invoiceId } = ready(
    await invoices.issueCoachingTerms(admin, issueInput(m.id)),
  );
  const overview = ready(await invoices.overview(m.token));
  expect(overview.invoices.map((i) => i.id)).toContain(invoiceId);
  ready(
    await invoices.pay(admin, {
      invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      amountCents: 135600,
      receivedOn: new Date().toISOString().slice(0, 10),
      evidence: "Invented e-Transfer reference",
    }),
  );
  const paid = ready(await invoices.overview(m.token)).invoices.find(
    (i) => i.id === invoiceId,
  )!;
  expect(paid.paidCents).toBe(135600);
  const events = (
    await pool.query<{ action: string; amount: string }>(
      "SELECT action,amount_cents AS amount FROM billing_change_events WHERE member_id=$1 ORDER BY id",
      [m.id],
    )
  ).rows;
  // Every migration re-runs at each start; the logged issue must survive it.
  await migrate(pool);
  expect(events.map((e) => [e.action, Number(e.amount)])).toEqual([
    ["coaching_invoice_issued", 135600],
    ["payment_recorded", 135600],
  ]);
});

it("TERMSINV318-06 sample mode keeps an invented typed tax and marks the invoice as a sample", async () => {
  const m = await member();
  await setTerms(m.id);
  expect(await samples.issueCoachingTerms(admin, issueInput(m.id))).toEqual({
    kind: "invalid",
  });
  expect(
    await invoices.issueCoachingTerms(admin, {
      ...issueInput(m.id),
      taxCents: 100,
    }),
  ).toEqual({ kind: "invalid" });
  const { invoiceId } = ready(
    await samples.issueCoachingTerms(admin, {
      ...issueInput(m.id),
      taxCents: 500,
    }),
  );
  const row = (
    await pool.query(
      "SELECT document,sample,total_cents AS total FROM simple_invoices WHERE id=$1",
      [invoiceId],
    )
  ).rows[0]!;
  expect(row.sample).toBe(true);
  expect(Number(row.total)).toBe(120500);
  expect(row.document).toMatchObject({
    issuer: "Invented coaching issuer",
    taxCents: 500,
    sample: true,
  });
  expect(row.document.tax).toBeUndefined();
});

// #44 walk of 10 Nov 2026: the one-invoice rule is per version, so a
// correction of the same period must not look unbilled.
it("TERMSINV318-08 a corrected version names the earlier invoice for the same period; a renewal or a voided invoice doesn't", async () => {
  const m = await member();
  await setTerms(m.id);
  const { invoiceId } = ready(
    await invoices.issueCoachingTerms(admin, issueInput(m.id)),
  );
  // The same period with a different allowance: version 2, not yet invoiced.
  await setTerms(m.id, 1, { ...agreed, aiRequests: 100 });
  const corrected = (await get(`/operator/coaching/${m.id}/package`, admin))
    .text;
  expect(text(corrected)).toContain(
    "Terms version 1 covers an overlapping coaching period (December 1, 2026 to May 31, 2027) and is already invoiced: view that invoice. Issue another invoice only if the student owes both. To replace the earlier invoice, void it first.",
  );
  expect(corrected).toContain(`href="/operator/invoices/${invoiceId}"`);
  // The warning informs; the form is still offered.
  expect(text(corrected)).toContain("Issue an invoice for terms version 2:");
  expect(corrected).toContain('name="confirm" value="terms-invoice"');
  // Once the earlier invoice is void, nothing is named.
  ready(
    await invoices.voidInvoice(admin, {
      invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      reason: "Invented correction",
    }),
  );
  expect(
    text((await get(`/operator/coaching/${m.id}/package`, admin)).text),
  ).not.toContain("is already invoiced");
  // A renewal for a later, separate period is its own invoice.
  const r = await member();
  await setTerms(r.id);
  ready(await invoices.issueCoachingTerms(admin, issueInput(r.id)));
  await setTerms(r.id, 1, {
    ...agreed,
    startsOn: "2027-06-01",
    endsOn: "2027-11-30",
    renewsOn: "2027-12-01",
  });
  const renewal = text(
    (await get(`/operator/coaching/${r.id}/package`, admin)).text,
  );
  expect(renewal).toContain("Issue an invoice for terms version 2:");
  expect(renewal).not.toContain("is already invoiced");
});
