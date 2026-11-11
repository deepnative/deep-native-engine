import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import type { Pool } from "pg";

// Shared steps for the full-MVP per-student coaching cases (the owner's 9 and
// 10 November 2026 decisions): an administrator saves one student's price,
// period, renewal date and allowances on the student's coaching page. Invoices
// only; nothing here takes payment. Every person and amount is invented.

export interface TermsForm {
  price: string;
  startsOn: string;
  endsOn: string;
  renewsOn: string;
  reviewMinutes: number;
  coachingSessions: number;
  aiRequests: number;
}

/** A calendar date this many days from today in Toronto, where periods run. */
export async function torontoDay(pool: Pool, offset = 0) {
  return (
    await pool.query<{ day: string }>(
      "SELECT to_char((clock_timestamp() AT TIME ZONE 'America/Toronto')::date+$1::integer,'YYYY-MM-DD') AS day",
      [offset],
    )
  ).rows[0]!.day;
}

/** The date as the coaching pages print it. */
export const readableDay = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-CA", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

export const termsSection = (page: Page) =>
  page.locator('section[aria-labelledby="coaching-terms"]');
export const termsInvoiceSection = (page: Page) =>
  page.getByRole("region", { name: "Invoice these coaching terms" });

/** The value shown beside one label in the terms or allowances list. */
export const shown = (page: Page, list: string, label: string) =>
  termsSection(page)
    .locator(`dl.${list} dt`)
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator("+ dd");

async function hiddenFields(form: ReturnType<Page["locator"]>) {
  const value = async (name: string) =>
    (await form.locator(`input[name="${name}"]`).getAttribute("value"))!;
  return {
    csrf: await value("csrf"),
    operationId: await value("operationId"),
    revision: await value("revision"),
  };
}

/**
 * The administrator fills and saves the terms form on the student's coaching
 * page. Returns the exact form that was sent, so a test can send it again.
 */
export async function saveTerms(
  admin: Page,
  origin: string,
  reference: string,
  terms: TermsForm,
) {
  await admin.goto(`${origin}/operator/coaching/${reference}`);
  const form = admin.locator(
    `form[action="/operator/coaching/${reference}/terms"]`,
  );
  await form.getByLabel("Price (CAD)").fill(terms.price);
  await form.getByLabel("Start date").fill(terms.startsOn);
  await form.getByLabel("End date").fill(terms.endsOn);
  await form.getByLabel("Renewal date").fill(terms.renewsOn);
  await form
    .getByLabel("Expert review minutes")
    .fill(String(terms.reviewMinutes));
  await form
    .getByLabel("Coaching sessions")
    .fill(String(terms.coachingSessions));
  await form.getByLabel("AI requests").fill(String(terms.aiRequests));
  const sent = {
    ...(await hiddenFields(form)),
    price: terms.price,
    startsOn: terms.startsOn,
    endsOn: terms.endsOn,
    renewsOn: terms.renewsOn,
    reviewMinutes: String(terms.reviewMinutes),
    coachingSessions: String(terms.coachingSessions),
    aiRequests: String(terms.aiRequests),
  };
  await form.getByRole("button", { name: "Save coaching terms" }).click();
  await expect(admin).toHaveURL(`${origin}/operator/coaching/${reference}`);
  await expect(termsSection(admin)).toContainText("Current terms, version");
  return sent;
}

/** Sends a terms or terms-invoice form straight to the server. */
export function postForm(
  admin: Page,
  origin: string,
  path: string,
  form: Record<string, string>,
) {
  return admin.request.post(origin + path, {
    form,
    headers: { Origin: origin },
    maxRedirects: 0,
  });
}

/** The student saves the billing recipient an invoice needs. */
export async function saveRecipient(student: Page, origin: string) {
  await student.goto(origin + "/account/billing");
  await student.getByLabel("Invoice recipient name").fill("Invented Student");
  await student
    .getByLabel("Invoice email")
    .fill("invented.student@example.invalid");
  await student.getByRole("button", { name: "Save billing recipient" }).click();
}

/**
 * The administrator issues the invoice for the current terms version. Returns
 * the invoice ID and the form that was sent. `tax` is typed in sample billing
 * only; configured billing adds 13% HST itself.
 */
export async function issueTermsInvoice(
  admin: Page,
  origin: string,
  reference: string,
  tax?: string,
) {
  await admin.goto(`${origin}/operator/coaching/${reference}`);
  const section = termsInvoiceSection(admin),
    form = section.locator("form");
  const sent = {
    ...(await hiddenFields(form)),
    confirm: "terms-invoice",
    ...(tax === undefined ? {} : { tax }),
  };
  if (tax !== undefined)
    await form.getByLabel("Invented sample tax (CAD)").fill(tax);
  await form
    .getByRole("checkbox", {
      name: "I checked this terms version, amount and recipient.",
    })
    .check();
  await form
    .getByRole("button", { name: "Issue invoice for these terms" })
    .click();
  await expect(
    admin.getByRole("heading", { name: "Invoice", exact: true }),
  ).toBeVisible();
  return { invoiceId: admin.url().split("/").at(-1)!, sent };
}

export interface StoredTerms {
  id: string;
  version: number;
  priceCents: number;
  startsOn: string;
  endsOn: string;
  renewsOn: string;
  reviewMinutes: number;
  coachingSessions: number;
  aiRequests: number;
}
/** Every saved terms version of one student, oldest first. */
export async function storedTerms(pool: Pool, ownerId: string) {
  return (
    await pool.query<StoredTerms>(
      `SELECT id,version,price_cents AS "priceCents",to_char(starts_on,'YYYY-MM-DD') AS "startsOn",
        to_char(ends_on,'YYYY-MM-DD') AS "endsOn",to_char(renews_on,'YYYY-MM-DD') AS "renewsOn",
        review_minutes AS "reviewMinutes",coaching_sessions AS "coachingSessions",ai_requests AS "aiRequests"
       FROM coaching_terms WHERE owner_id=$1 ORDER BY version`,
      [ownerId],
    )
  ).rows;
}

export interface StoredGrant {
  version: number;
  category: "review_minutes" | "study_requests";
  quantity: number;
  available: number;
  startsOn: string;
  endsOn: string;
  /** Usable right now: started, not ended and not written off. */
  usable: boolean;
}
/** Every coaching allowance grant of one student, by terms version. */
export async function storedGrants(pool: Pool, ownerId: string) {
  return (
    await pool.query<StoredGrant>(
      `SELECT t.version,c.category,g.quantity,g.available,
        to_char(c.starts_on,'YYYY-MM-DD') AS "startsOn",to_char(c.ends_on,'YYYY-MM-DD') AS "endsOn",
        (g.expired_at IS NULL AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp()) AS usable
       FROM coaching_allowance_grants c
       JOIN coaching_terms t ON t.id=c.terms_id
       JOIN synthetic_entitlement_grants g ON g.id=c.grant_id
       WHERE c.owner_id=$1 ORDER BY t.version,c.category,g.id`,
      [ownerId],
    )
  ).rows;
}

export interface StoredInvoice {
  id: string;
  /** The terms version it bills; null for any other invoice. */
  version: number | null;
  totalCents: number;
  paidCents: number;
  taxCents: number;
  void: boolean;
}
/** Every invoice of one student, oldest first. */
export async function storedInvoices(pool: Pool, ownerId: string) {
  return (
    await pool.query<StoredInvoice>(
      `SELECT i.id,t.version,i.total_cents::integer AS "totalCents",i.paid_cents::integer AS "paidCents",
        (i.document->>'taxCents')::integer AS "taxCents",(i.void_reason IS NOT NULL) AS void
       FROM simple_invoices i LEFT JOIN coaching_terms t ON t.id=i.coaching_terms_id
       WHERE i.owner_id=$1 ORDER BY i.created_at,i.id`,
      [ownerId],
    )
  ).rows;
}

/** What the student's own units page says is usable now and starts later. */
export async function unitsShown(
  student: Page,
  origin: string,
  category: "review_minutes" | "study_requests",
) {
  await student.goto(origin + "/member/test-units");
  const row = student.locator(`[data-test-unit-category="${category}"]`);
  if (!(await row.count())) return { usable: "0", future: "0" };
  return {
    usable: await row.locator('[data-field="usable"]').innerText(),
    future: await row.locator('[data-field="future"]').innerText(),
  };
}

/**
 * Stands in for days passing: every saved coaching date and allowance period
 * of this one student moves the same number of days into the past. Only this
 * isolated fixture database is touched, and the history guards are restored in
 * the same transaction. Nothing else about the records changes.
 */
export async function daysLater(pool: Pool, ownerId: string, days: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const table of ["coaching_terms", "coaching_allowance_grants"]) {
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      await client.query(
        `UPDATE ${table} SET starts_on=starts_on-$2::integer,ends_on=ends_on-$2::integer${table === "coaching_terms" ? ",renews_on=renews_on-$2::integer" : ""} WHERE owner_id=$1`,
        [ownerId, days],
      );
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }
    await client.query(
      `UPDATE synthetic_entitlement_grants g SET
         starts_at=((c.starts_on)::timestamp AT TIME ZONE 'America/Toronto'),
         expires_at=((c.ends_on+1)::timestamp AT TIME ZONE 'America/Toronto')
       FROM coaching_allowance_grants c WHERE c.grant_id=g.id AND c.owner_id=$1`,
      [ownerId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const newOperation = () => randomUUID();

// What staff and the student agreed (#94): append-only records beside the terms.
export const agreedSection = (page: Page) =>
  page.locator('section[aria-labelledby="agreed-changes"]');

export interface AgreedForm {
  kind: "Early release" | "Refund" | "Other change";
  agreed: string;
  reason: string;
}
/** The administrator records one agreed change on the student's coaching page. */
export async function recordAgreedChange(
  admin: Page,
  origin: string,
  reference: string,
  change: AgreedForm,
) {
  await admin.goto(`${origin}/operator/coaching/${reference}`);
  const form = agreedSection(admin).locator("form");
  await form.getByLabel("Kind of change").selectOption({ label: change.kind });
  await form.getByLabel("What was agreed").fill(change.agreed);
  await form.getByLabel("Reason").fill(change.reason);
  await form
    .getByRole("checkbox", {
      name: "This is what the student and staff agreed.",
    })
    .check();
  await form.getByRole("button", { name: "Record agreed change" }).click();
  await expect(admin).toHaveURL(
    `${origin}/operator/coaching/${reference}#agreed-changes`,
  );
}

/** Every agreed-change record of one student as stored, oldest first. */
export async function storedAgreed(pool: Pool, ownerId: string) {
  return (
    await pool.query<{
      id: string;
      kind: string;
      agreed: string;
      reason: string;
      recordedAt: string;
    }>(
      `SELECT id,kind,agreed,reason,created_at::text AS "recordedAt"
       FROM coaching_agreed_changes WHERE owner_id=$1 ORDER BY created_at,id`,
      [ownerId],
    )
  ).rows;
}

/** One invoice's amounts and its receipt and refund rows as stored, oldest first. */
export async function invoiceMoney(pool: Pool, invoiceId: string) {
  return (
    await pool.query<{
      paidCents: number;
      refundedCents: number;
      rows: string[];
    }>(
      `SELECT i.paid_cents::integer AS "paidCents",i.refunded_cents::integer AS "refundedCents",
        COALESCE(array_agg(p.id||':'||p.kind||':'||p.amount_cents ORDER BY p.recorded_at,p.id)
          FILTER (WHERE p.id IS NOT NULL),'{}') AS rows
       FROM simple_invoices i LEFT JOIN simple_invoice_payments p ON p.invoice_id=i.id
       WHERE i.id=$1 GROUP BY i.id`,
      [invoiceId],
    )
  ).rows[0]!;
}

/** The administrator records money received offline for one invoice. */
export async function recordOfflinePayment(
  admin: Page,
  origin: string,
  invoiceId: string,
  amount: string,
) {
  await admin.goto(`${origin}/operator/invoices/${invoiceId}`);
  const form = admin.locator('form[action$="/payment"]');
  await form.getByLabel("Amount received (CAD)").fill(amount);
  await form
    .getByLabel("Received on", { exact: true })
    .fill(new Date().toISOString().slice(0, 10));
  await form.getByLabel("Evidence reference").fill("Invented e-Transfer");
  await form
    .getByRole("checkbox", { name: /I verified these funds were received/ })
    .check();
  await form.getByRole("button", { name: "Record offline payment" }).click();
  await expect(
    admin.getByRole("table", { name: "Recorded receipts and refunds" }),
  ).toBeVisible();
}

/** The administrator records a refund that was sent offline for one invoice. */
export async function recordOfflineRefund(
  admin: Page,
  origin: string,
  invoiceId: string,
  amount: string,
) {
  await admin.goto(`${origin}/operator/invoices/${invoiceId}`);
  const form = admin.locator('form[action$="/refund"]');
  await form.getByLabel("Amount refunded (CAD)").fill(amount);
  await form
    .getByLabel("Refunded on")
    .fill(new Date().toISOString().slice(0, 10));
  await form
    .getByLabel("Evidence reference")
    .fill("Invented refund e-Transfer");
  await form
    .getByRole("checkbox", { name: /I confirm this refund was sent/ })
    .check();
  await form.getByRole("button", { name: "Record offline refund" }).click();
  await expect(
    admin
      .getByRole("table", { name: "Recorded receipts and refunds" })
      .locator("tbody tr"),
  ).not.toHaveCount(0);
}
