import { expect, test, type Page } from "@playwright/test";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import {
  signTestProviderEvent,
  TEST_PROVIDER_PATH,
  TEST_PROVIDER_SIGNATURE,
} from "../../src/test-provider-events.ts";

// Signed test events are off by default and refused on any hosted site (#32), so
// each case runs on its own listener and database with sample invoices and a test
// key. Staff credentials stay out of traces.
test.use({ trace: "off" });
const key = "invented-provisional-test-provider-key-05";
type Fixture = Awaited<ReturnType<typeof reviewedContentFixture>>;

// An administrator offers two invented courses through the billing page and the
// member accepts, giving one CAD 30.00 sample invoice.
async function sampleInvoice(f: Fixture) {
  await f.publishFixture();
  const member = await f.member();
  const admin = await f.staff("platform_admin");
  await member.goto(f.origin + "/account");
  const reference = await member.locator("code").first().textContent();
  if (!reference) throw Error("Student reference missing");
  await admin.page.goto(f.origin + "/staff");
  await admin.page
    .getByRole("link", { name: "Course billing and invoices", exact: true })
    .click();
  await admin.page
    .getByLabel("Learner", { exact: true })
    .selectOption(reference);
  for (const [id, amount] of [
    ["FND-001", "10.00"],
    ["FND-002", "20.00"],
  ] as const) {
    await admin.page
      .locator(`input[name="courses"][value='["${id}",2]']`)
      .check();
    await admin.page.locator(`input[name="amount_${id}_2"]`).fill(amount);
  }
  await admin.page
    .getByLabel("Billing", { exact: true })
    .selectOption("one_time");
  const day = (
    await f.pool.query<{ day: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
    )
  ).rows[0]!.day;
  await admin.page.getByLabel("Starts on (UTC date)").fill(day);
  await admin.page
    .getByLabel("Configured tax amount per invoice (CAD)")
    .fill("0.00");
  await admin.page
    .getByRole("button", { name: "Prepare course billing proposal" })
    .click();
  await member
    .getByRole("link", { name: "Courses and invoices", exact: true })
    .click();
  await member
    .getByLabel("Invoice recipient name")
    .fill("Invented provisional student");
  await member
    .getByLabel("Invoice email")
    .fill("invented-provisional@example.invalid");
  await member
    .getByRole("checkbox", {
      name: /I accept these exact courses and one-time/,
    })
    .check();
  await member
    .getByRole("button", { name: "Accept courses and create invoice" })
    .click();
  await expect(
    member.getByRole("heading", { name: "Invoice", exact: true }),
  ).toBeVisible();
  const invoiceId = member.url().split("/").at(-1)!;
  const invoicePath = new URL(member.url()).pathname;
  // The processor posts signed raw bytes; the member's context only carries them.
  const deliver = async (event: Record<string, unknown>) => {
    const body = JSON.stringify({ invoiceId, ...event });
    const response = await member.request.post(f.origin + TEST_PROVIDER_PATH, {
      headers: {
        "Content-Type": "application/json",
        [TEST_PROVIDER_SIGNATURE]: signTestProviderEvent(key, body),
      },
      data: body,
    });
    return { status: response.status(), body: await response.json() };
  };
  return { member, admin: admin.page, invoiceId, invoicePath, deliver };
}

const amount = (page: Page, label: string) =>
  page.locator("dt").filter({ hasText: label }).locator("+ dd");
async function invoiceState(f: Fixture, invoiceId: string) {
  const row = (
    await f.pool.query<{
      paid: string;
      refunded: string;
      rows: string[];
    }>(
      `SELECT i.paid_cents::text AS paid,i.refunded_cents::text AS refunded,
              COALESCE(array_agg(p.kind||':'||p.provider_event_id||':'||p.amount_cents ORDER BY p.provider_occurred_at,p.provider_event_id)
                FILTER (WHERE p.id IS NOT NULL),'{}') AS rows
       FROM simple_invoices i LEFT JOIN simple_invoice_payments p ON p.invoice_id=i.id
       WHERE i.id=$1 GROUP BY i.id`,
      [invoiceId],
    )
  ).rows[0]!;
  const history = (
    await f.pool.query<{ action: string; amount: string }>(
      `SELECT action,amount_cents::text AS amount FROM billing_change_events
       WHERE action LIKE 'test\\_%' ORDER BY occurred_at,id`,
    )
  ).rows.map((entry) => `${entry.action}:${entry.amount}`);
  return { ...row, history };
}
// The administrator report keeps signed rows out of collected cash.
async function reportShowsOneSimulatedReceipt(admin: Page, f: Fixture) {
  await admin.goto(f.origin + "/operator/invoice-reconciliation");
  const sample = admin.locator('[data-invoice-group="sample"]');
  await expect(
    sample.locator('[data-reconciliation-status="consistent"]'),
  ).toBeVisible();
  await expect(sample.locator('[data-field="simulatedReceipts"]')).toHaveText(
    "CAD 30.00",
  );
  await expect(sample.locator('[data-field="receipts"]')).toHaveText(
    "CAD 0.00",
  );
  await expect(sample.locator('[data-field="mismatched"]')).toHaveText("0");
  await expect(sample.locator('[data-field="unpaid"]')).toHaveText("CAD 0.00");
}

test("[F-BUILD-05-A] a replayed signed test payment event records one durable effect", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
    testProviderKey: key,
  });
  try {
    const { member, admin, invoiceId, invoicePath, deliver } =
      await sampleInvoice(f);
    await requiredCheck(1, async () => {
      const event = {
        id: "evt-provisional-pay-1",
        type: "payment.succeeded",
        paymentRef: "pay-provisional-1",
        amountCents: 3000,
        occurredAt: "2026-11-02T12:00:00.000Z",
      };
      expect(await deliver(event)).toEqual({
        status: 200,
        body: { outcome: "receipt" },
      });
      // The same signed bytes again, then the same ID carrying a different amount.
      expect(await deliver(event)).toEqual({
        status: 200,
        body: { outcome: "duplicate" },
      });
      expect(await deliver({ ...event, amountCents: 1000 })).toEqual({
        status: 409,
        body: { error: "conflict" },
      });
      expect(await invoiceState(f, invoiceId)).toEqual({
        paid: "3000",
        refunded: "0",
        rows: ["receipt:evt-provisional-pay-1:3000"],
        history: ["test_payment_received:3000"],
      });

      await member.goto(f.origin + invoicePath);
      const record = member.getByRole("table", {
        name: "Recorded receipts and refunds",
      });
      await expect(record.locator("tbody tr")).toHaveCount(1);
      await expect(record).toContainText("Test receipt");
      await expect(amount(member, "Recorded payment")).toHaveText("CAD 30.00");
      await expect(amount(member, "Balance")).toHaveText("CAD 0.00");
      await expect(
        member.getByText(/No payment provider checked them and no money moved/),
      ).toBeVisible();

      await admin.goto(f.origin + "/operator/changes");
      await expect(
        admin.getByText(
          /A signed test event recorded a simulated test payment of CAD 30\.00/,
        ),
      ).toHaveCount(1);
      await reportShowsOneSimulatedReceipt(admin, f);
    });
  } finally {
    await f.close();
  }
});

test("[F-BUILD-05-B] older signed test events cannot overwrite a newer paid state", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
    testProviderKey: key,
  });
  try {
    const { member, admin, invoiceId, invoicePath, deliver } =
      await sampleInvoice(f);
    await requiredCheck(1, async () => {
      const paymentRef = "pay-provisional-2";
      expect(
        await deliver({
          id: "evt-provisional-newer-paid",
          type: "payment.succeeded",
          paymentRef,
          amountCents: 3000,
          occurredAt: "2026-11-03T12:00:00.000Z",
        }),
      ).toEqual({ status: 200, body: { outcome: "receipt" } });
      // Two older events for the same payment arrive afterwards: an earlier
      // failure, and an earlier success under another event ID.
      expect(
        await deliver({
          id: "evt-provisional-older-failed",
          type: "payment.failed",
          paymentRef,
          amountCents: 3000,
          occurredAt: "2026-11-01T12:00:00.000Z",
        }),
      ).toEqual({ status: 200, body: { outcome: "failure" } });
      expect(
        await deliver({
          id: "evt-provisional-older-paid",
          type: "payment.succeeded",
          paymentRef,
          amountCents: 3000,
          occurredAt: "2026-11-02T12:00:00.000Z",
        }),
      ).toEqual({ status: 200, body: { outcome: "held" } });
      expect(await invoiceState(f, invoiceId)).toEqual({
        paid: "3000",
        refunded: "0",
        rows: [
          "failure:evt-provisional-older-failed:3000",
          "held:evt-provisional-older-paid:3000",
          "receipt:evt-provisional-newer-paid:3000",
        ],
        history: ["test_payment_received:3000", "test_payment_failed:3000"],
      });

      await member.goto(f.origin + invoicePath);
      const record = member.getByRole("table", {
        name: "Recorded receipts and refunds",
      });
      await expect(record.locator("tbody tr")).toHaveCount(3);
      for (const label of [
        "Test receipt",
        "Test payment failed",
        "Test event not applied",
      ])
        await expect(record).toContainText(label);
      await expect(amount(member, "Recorded payment")).toHaveText("CAD 30.00");
      await expect(
        member.locator("dt").filter({ hasText: "Recorded refund" }),
      ).toHaveCount(0);
      await expect(amount(member, "Balance")).toHaveText("CAD 0.00");
      await expect(
        member.getByText(
          /A failed or not applied test event changes no amount/,
        ),
      ).toBeVisible();

      await admin.goto(f.origin + "/operator/invoices/" + invoiceId);
      await expect(amount(admin, "Recorded payment")).toHaveText("CAD 30.00");
      await expect(amount(admin, "Balance")).toHaveText("CAD 0.00");
      await reportShowsOneSimulatedReceipt(admin, f);
    });
  } finally {
    await f.close();
  }
});
