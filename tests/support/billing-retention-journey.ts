import { expect, type Page } from "@playwright/test";
import type { reviewedContentFixture } from "./reviewed-content-browser.ts";
import {
  acceptBundle,
  memberReference,
  prepareBundle,
  utcToday,
} from "./course-bundle-journey.ts";

// #12 D08 (owner, 10 Nov 2026): issued invoices and their payment records are
// kept six years after deletion under CRA rules; backups expire in 30 days.
type Fixture = Awaited<ReturnType<typeof reviewedContentFixture>>;

export const BILLING_EXPIRY =
  "Issued invoices and the payments and refunds recorded against them are kept for 6 years after the account is deleted, following Canada Revenue Agency record-keeping rules (records are kept 6 years from the end of the last tax year they relate to).";
export const BACKUP_EXPIRY =
  "Copies in service backups are kept for up to 30 days, then they expire.";
// A false total-erasure claim, in any of the ways it could be worded.
export const TOTAL_ERASURE =
  /all (of )?your (data|records|information)|everything (was|is|has been) (deleted|erased|removed)|permanently (deleted|erased)|nothing (is|was) kept/i;
// RETAIN-01: the only fields an issued invoice document may hold.
const INVOICE_FIELDS = new Set([
  "number",
  "issuedOn",
  "issuer",
  "billedTo",
  "billedToCompany",
  "recipientEmail",
  "lines",
  "billing",
  "currency",
  "taxCents",
  "paidCents",
  "instructions",
  "sample",
  "tax",
  "coaching",
  "coachingTerms",
]);

/**
 * An administrator offers one invented course with configured (Deep Native
 * Inc., 13% HST) billing, the member accepts, and the administrator records
 * an invented offline payment. Returns the invoice ID and the member reference.
 */
export async function issuedInvoiceWithPayment(
  f: Fixture,
  admin: Page,
  member: Page,
) {
  const realOrigin = await f.configuredInvoiceListener();
  const reference = await memberReference(member, f.origin);
  await prepareBundle({ ...f, origin: realOrigin }, admin, reference, {
    amounts: [["FND-001", "35.40"]],
    cadence: "one_time",
  });
  await member.goto(realOrigin + "/account/purchases");
  const invoiceId = await acceptBundle(member, "one_time");
  await admin.goto(realOrigin + "/operator/invoices/" + invoiceId);
  await admin.getByLabel("Amount received (CAD)").fill("40.00");
  await admin
    .getByLabel("Received on", { exact: true })
    .fill(await utcToday(f));
  await admin
    .getByLabel("Evidence reference")
    .first()
    .fill("Invented e-Transfer reference");
  await admin.getByRole("checkbox", { name: /I verified these funds/ }).check();
  await admin.getByRole("button", { name: "Record offline payment" }).click();
  await expect(
    admin.getByRole("table", { name: "Recorded receipts and refunds" }),
  ).toContainText("Invented e-Transfer reference");
  return { invoiceId, reference };
}

/** The member confirms deletion on My account; returns the response notice. */
export async function deleteAccount(f: Fixture, member: Page) {
  await member.goto(f.origin + "/account");
  await member.locator('.account-delete input[name="confirm"]').check();
  await member.locator(".account-delete button").click();
  const status = member.getByRole("status").filter({ hasText: "were deleted" });
  await expect(status).toBeVisible();
  return status;
}

/**
 * RETAIN-03: the response names the billing exception and its expiry, and
 * the kept invoice and payment hold only invoice facts, unlinked from the
 * deleted account.
 */
export async function expectBillingRetained(
  f: Fixture,
  status: ReturnType<Page["getByRole"]>,
  invoiceId: string,
  reference: string,
) {
  await expect(status).toContainText("Not everything is erased yet.");
  await expect(status).toContainText(BILLING_EXPIRY);
  const invoice = (
    await f.pool.query<{
      owner_id: string | null;
      sample: boolean;
      document: Record<string, unknown>;
      row: Record<string, unknown>;
    }>(
      "SELECT owner_id,sample,document,to_jsonb(i) AS row FROM simple_invoices i WHERE id=$1",
      [invoiceId],
    )
  ).rows;
  expect(invoice).toHaveLength(1);
  expect(invoice[0]!.owner_id).toBeNull();
  expect(invoice[0]!.sample).toBe(false);
  for (const key of Object.keys(invoice[0]!.document))
    expect(INVOICE_FIELDS.has(key), key).toBe(true);
  expect(invoice[0]!.document).toMatchObject({
    billedTo: "Invented provisional student",
    recipientEmail: "invented-provisional@example.invalid",
    issuer: expect.stringContaining("Deep Native Inc."),
  });
  expect(JSON.stringify(invoice[0]!.row)).not.toContain(reference);
  const payments = (
    await f.pool.query<{ row: Record<string, unknown> }>(
      "SELECT to_jsonb(p) AS row FROM simple_invoice_payments p WHERE invoice_id=$1",
      [invoiceId],
    )
  ).rows;
  expect(payments).toHaveLength(1);
  expect(payments[0]!.row).toMatchObject({
    amount_cents: 4000,
    kind: "receipt",
    evidence_reference: "Invented e-Transfer reference",
  });
  expect(JSON.stringify(payments[0]!.row)).not.toContain(reference);
  // The course agreement and account are gone with the account.
  for (const sql of [
    "SELECT id FROM simple_invoice_plans WHERE owner_id=$1",
    "SELECT id FROM principals WHERE id=$1",
  ])
    expect((await f.pool.query(sql, [reference])).rowCount, sql).toBe(0);
}

/** RETAIN-02: the backup expiry is named, with no total-erasure claim. */
export async function expectBackupExpiryNamed(
  member: Page,
  status: ReturnType<Page["getByRole"]>,
) {
  await expect(status).toContainText(BACKUP_EXPIRY);
  expect(await status.textContent()).not.toMatch(TOTAL_ERASURE);
  // The response links to the full list, which says the same.
  await status
    .getByRole("link", { name: "See everything that is kept" })
    .click();
  await expect(member).toHaveURL(/\/terms#deletion-kept$/);
  const kept = member.locator("#deletion-kept");
  await expect(kept).toContainText(BILLING_EXPIRY);
  await expect(kept).toContainText(BACKUP_EXPIRY);
  await expect(member.locator("main")).toContainText("Not legally reviewed.");
  expect(await member.locator("main").textContent()).not.toMatch(TOTAL_ERASURE);
}
