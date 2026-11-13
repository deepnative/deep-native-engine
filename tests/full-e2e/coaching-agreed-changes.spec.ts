import {
  expect,
  test,
  type Browser,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import { memberReference } from "../support/course-bundle-journey.ts";
import {
  signTestProviderEvent,
  TEST_PROVIDER_PATH,
  TEST_PROVIDER_SIGNATURE,
} from "../../src/test-provider-events.ts";
import {
  agreedSection,
  invoiceMoney,
  issueTermsInvoice,
  readableDay,
  recordAgreedChange,
  recordOfflinePayment,
  recordOfflineRefund,
  saveRecipient,
  saveTerms,
  shown,
  storedAgreed,
  storedGrants,
  storedInvoices,
  storedTerms,
  termsSection,
  torontoDay,
  type AgreedForm,
  type TermsForm,
} from "../support/coaching-terms-journey.ts";
import { staffTrace } from "../support/staff-trace.ts";

// Cancellation, early release and refunds under the owner's 9 and 10 November
// 2026 decisions: there are no automatic rules. The student contacts
// info@deepnative.io, and an administrator records what was agreed and why.
// Invoices are paid offline in full; no provider, no payment processing.
// Signed test events are off by default and refused on any hosted site (#32).
// Every person, amount and reason is invented.
// Staff sign in here, so traces are off except in a full-release run, which
// needs one per execution: see ../support/staff-trace.ts.
test.use({ trace: staffTrace });
const key = "invented-provisional-test-provider-key-94";
const CONTACT_RULE =
  "There are no cancellation or refund rules. To ask about changes, contact info@deepnative.io.";
const NOT_AUTOMATIC = "No cancellation or refund happens automatically.";

const RELEASE: AgreedForm = {
  kind: "Early release",
  agreed: "Invented: coaching ends 15 days early, at the new end date.",
  reason: "Invented: the student is moving abroad.",
};
const REFUND: AgreedForm = {
  kind: "Refund",
  agreed: "Invented: CAD 300.00 is refunded by e-Transfer.",
  reason: "Invented: two coaching sessions were not delivered.",
};

async function setUp(browser: Browser, info: TestInfo) {
  test.setTimeout(120_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
    testProviderKey: key,
  });
  try {
    const admin = (await f.staff("platform_admin")).page;
    const student = await f.member();
    const reference = await memberReference(student, f.origin);
    const day = (offset: number) => torontoDay(f.pool, offset);
    // A 30-day period from today at CAD 1,200.00, invoiced with no sample tax.
    const terms: TermsForm = {
      price: "1200.00",
      startsOn: await day(0),
      endsOn: await day(29),
      renewsOn: await day(30),
      reviewMinutes: 120,
      coachingSessions: 6,
      aiRequests: 200,
    };
    await saveTerms(admin, f.origin, reference, terms);
    await saveRecipient(student, f.origin);
    const { invoiceId } = await issueTermsInvoice(
      admin,
      f.origin,
      reference,
      "0.00",
    );
    return { f, admin, student, reference, day, terms, invoiceId };
  } catch (error) {
    await f.close();
    throw error;
  }
}
type Journey = Awaited<ReturnType<typeof setUp>>;

const amount = (page: Page, label: string) =>
  page.locator("dt").filter({ hasText: label }).locator("+ dd");
const paymentRecord = (page: Page) =>
  page.getByRole("table", { name: "Recorded receipts and refunds" });
/** Everything about the student that an automatic rule would have changed. */
async function state(j: Journey) {
  return {
    terms: await storedTerms(j.f.pool, j.reference),
    grants: await storedGrants(j.f.pool, j.reference),
    invoices: await storedInvoices(j.f.pool, j.reference),
    money: await invoiceMoney(j.f.pool, j.invoiceId),
  };
}
/** The student reads the contact rule and has nothing to cancel or refund with. */
async function studentIsToldToContact(j: Journey) {
  await j.student.goto(j.f.origin + "/account/coaching");
  await expect(termsSection(j.student)).toContainText(CONTACT_RULE);
  await expect(
    termsSection(j.student)
      .locator("p", { hasText: "There are no cancellation or refund rules." })
      .locator('a[href="mailto:info@deepnative.io"]'),
  ).toBeVisible();
  await expect(agreedSection(j.student)).toContainText(NOT_AUTOMATIC);
  await expect(agreedSection(j.student).locator("form")).toHaveCount(0);
  await expect(
    j.student
      .locator("main")
      .getByRole("button", { name: /cancel|refund|release/i }),
  ).toHaveCount(0);
}
const record = (page: Page, change: AgreedForm) =>
  agreedSection(page).locator("li").filter({ hasText: change.agreed });
/** Both people read the record: its kind, what was agreed and the reason. */
async function recordIsShown(j: Journey, change: AgreedForm) {
  for (const page of [j.admin, j.student]) {
    await page.goto(
      page === j.admin
        ? `${j.f.origin}/operator/coaching/${j.reference}/package`
        : j.f.origin + "/account/coaching",
    );
    await expect(record(page, change)).toContainText(
      `${change.kind} · recorded`,
    );
    await expect(record(page, change)).toContainText(
      `Agreed: ${change.agreed}`,
    );
    await expect(record(page, change)).toContainText(
      `Reason: ${change.reason}`,
    );
  }
}
/** The agreed early end, saved as a new terms version for the same start date. */
async function saveEarlierEnd(j: Journey) {
  const shorter: TermsForm = {
    ...j.terms,
    endsOn: await j.day(14),
    renewsOn: await j.day(15),
  };
  await saveTerms(j.admin, j.f.origin, j.reference, shorter);
  return shorter;
}

test("[F-ROADMAP-09-B] staff record what was agreed for an early-release and a refund request, with the reason, and nothing happens automatically", async ({
  browser,
}, info) => {
  const j = await setUp(browser, info);
  try {
    await recordOfflinePayment(j.admin, j.f.origin, j.invoiceId, "1200.00");
    const before = await state(j);
    await studentIsToldToContact(j);

    await requiredCheck(1, async () => {
      await recordAgreedChange(j.admin, j.f.origin, j.reference, RELEASE);
      await recordIsShown(j, RELEASE);
      expect(await storedAgreed(j.f.pool, j.reference)).toEqual([
        expect.objectContaining({
          kind: "early_release",
          agreed: RELEASE.agreed,
          reason: RELEASE.reason,
        }),
      ]);
      // No automatic release: the terms, units and invoice are as they were.
      expect(await state(j)).toEqual(before);
      await expect(
        shown(j.student, "coaching-terms", "Coaching period"),
      ).toHaveText(
        `${readableDay(j.terms.startsOn)} to ${readableDay(j.terms.endsOn)}`,
      );
    });

    await requiredCheck(2, async () => {
      await recordAgreedChange(j.admin, j.f.origin, j.reference, REFUND);
      await recordIsShown(j, REFUND);
      await recordIsShown(j, RELEASE);
      expect(
        (await storedAgreed(j.f.pool, j.reference)).map((r) => r.kind),
      ).toEqual(["early_release", "refund"]);
      // No invented refund: the invoice is still paid in full, nothing refunded.
      expect(await state(j)).toEqual(before);
      await j.student.goto(
        `${j.f.origin}/account/purchases/invoices/${j.invoiceId}`,
      );
      await expect(amount(j.student, "Recorded payment")).toHaveText(
        "CAD 1200.00",
      );
      await expect(
        j.student.locator("dt").filter({ hasText: "Recorded refund" }),
      ).toHaveCount(0);
      await expect(paymentRecord(j.student).locator("tbody tr")).toHaveCount(1);
    });
  } finally {
    await j.f.close();
  }
});

test("[F-BUILD-05-C] an agreed refund and an agreed early release are appended as staff records, and earlier history is unchanged", async ({
  browser,
}, info) => {
  const j = await setUp(browser, info);
  try {
    await recordOfflinePayment(j.admin, j.f.origin, j.invoiceId, "1200.00");
    const paid = await state(j);
    await studentIsToldToContact(j);

    await requiredCheck(1, async () => {
      await recordAgreedChange(j.admin, j.f.origin, j.reference, REFUND);
      // The record alone refunds nothing.
      expect(await state(j)).toEqual(paid);
      await recordOfflineRefund(j.admin, j.f.origin, j.invoiceId, "300.00");
      const money = await invoiceMoney(j.f.pool, j.invoiceId);
      expect(money.paidCents).toBe(120000);
      expect(money.refundedCents).toBe(30000);
      // The receipt row is the same row; the refund is a new one after it.
      expect(money.rows).toHaveLength(2);
      expect(money.rows[0]).toBe(paid.money.rows[0]);
      expect(money.rows[1]).toMatch(/:refund:30000$/);
      for (const page of [j.admin, j.student]) {
        await page.goto(
          page === j.admin
            ? `${j.f.origin}/operator/invoices/${j.invoiceId}`
            : `${j.f.origin}/account/purchases/invoices/${j.invoiceId}`,
        );
        await expect(paymentRecord(page).locator("tbody tr")).toHaveCount(2);
        await expect(paymentRecord(page)).toContainText("Invented e-Transfer");
        await expect(paymentRecord(page)).toContainText(
          "Invented refund e-Transfer",
        );
        await expect(amount(page, "Recorded payment")).toHaveText(
          "CAD 1200.00",
        );
        await expect(amount(page, "Recorded refund")).toHaveText("CAD 300.00");
      }
      await recordIsShown(j, REFUND);
      await studentIsToldToContact(j);
    });

    await requiredCheck(2, async () => {
      const before = await state(j);
      const agreedBefore = await storedAgreed(j.f.pool, j.reference);
      await recordAgreedChange(j.admin, j.f.origin, j.reference, RELEASE);
      // The record alone ends nothing early.
      expect(await state(j)).toEqual(before);
      const agreed = await storedAgreed(j.f.pool, j.reference);
      expect(agreed).toHaveLength(2);
      expect(agreed[0]).toEqual(agreedBefore[0]);
      expect(agreed[1]).toEqual(
        expect.objectContaining({
          kind: "early_release",
          agreed: RELEASE.agreed,
          reason: RELEASE.reason,
        }),
      );
      await recordIsShown(j, RELEASE);
      await recordIsShown(j, REFUND);

      // Staff then save the agreed end date as a new terms version. The
      // first version, the invoice and both records stay as they were.
      const shorter = await saveEarlierEnd(j);
      const versions = await storedTerms(j.f.pool, j.reference);
      expect(versions).toHaveLength(2);
      expect(versions[0]).toEqual(before.terms[0]);
      expect(versions[1]).toEqual(
        expect.objectContaining({ version: 2, endsOn: shorter.endsOn }),
      );
      expect(await storedInvoices(j.f.pool, j.reference)).toEqual(
        before.invoices,
      );
      expect(await invoiceMoney(j.f.pool, j.invoiceId)).toEqual(before.money);
      expect(await storedAgreed(j.f.pool, j.reference)).toEqual(agreed);
    });
  } finally {
    await j.f.close();
  }
});

test("[F-ROADMAP-04-D] duplicate, delayed and stale test payment events, an unpaid invoice paid offline in full, and a cancellation and refund that are only what staff record as agreed", async ({
  browser,
}, info) => {
  const j = await setUp(browser, info);
  try {
    // The processor posts signed raw bytes; the student's context only carries them.
    const deliver = async (event: Record<string, unknown>) => {
      const body = JSON.stringify({ invoiceId: j.invoiceId, ...event });
      const response = await j.student.request.post(
        j.f.origin + TEST_PROVIDER_PATH,
        {
          headers: {
            "Content-Type": "application/json",
            [TEST_PROVIDER_SIGNATURE]: signTestProviderEvent(key, body),
          },
          data: body,
        },
      );
      return { status: response.status(), body: await response.json() };
    };
    const kinds = async () =>
      (await invoiceMoney(j.f.pool, j.invoiceId)).rows
        .map((row) => row.split(":").slice(1).join(":"))
        .sort();
    const grants = await storedGrants(j.f.pool, j.reference);
    const paid = {
      id: "evt-provisional-94-paid",
      type: "payment.succeeded",
      paymentRef: "pay-provisional-94",
      amountCents: 120000,
      occurredAt: "2026-11-03T12:00:00.000Z",
    };

    await requiredCheck(1, async () => {
      expect(await deliver(paid)).toEqual({
        status: 200,
        body: { outcome: "receipt" },
      });
      expect(await deliver(paid)).toEqual({
        status: 200,
        body: { outcome: "duplicate" },
      });
      expect(await kinds()).toEqual(["receipt:120000"]);
      expect((await invoiceMoney(j.f.pool, j.invoiceId)).paidCents).toBe(
        120000,
      );
    });

    await requiredCheck(2, async () => {
      // The same payment reported again, late, under another event ID.
      expect(
        await deliver({
          ...paid,
          id: "evt-provisional-94-delayed",
          occurredAt: "2026-11-02T12:00:00.000Z",
        }),
      ).toEqual({ status: 200, body: { outcome: "held" } });
      expect(await kinds()).toEqual(["held:120000", "receipt:120000"]);
      const money = await invoiceMoney(j.f.pool, j.invoiceId);
      expect(money.paidCents).toBe(120000);
      expect(money.refundedCents).toBe(0);
      expect(await storedGrants(j.f.pool, j.reference)).toEqual(grants);
      expect(await storedInvoices(j.f.pool, j.reference)).toHaveLength(1);
      await j.student.goto(
        `${j.f.origin}/account/purchases/invoices/${j.invoiceId}`,
      );
      await expect(paymentRecord(j.student)).toContainText(
        "Test event not applied",
      );
      await expect(amount(j.student, "Balance")).toHaveText("CAD 0.00");
    });

    await requiredCheck(3, async () => {
      expect(
        await deliver({
          id: "evt-provisional-94-older-failed",
          type: "payment.failed",
          paymentRef: paid.paymentRef,
          amountCents: 120000,
          occurredAt: "2026-11-01T12:00:00.000Z",
        }),
      ).toEqual({ status: 200, body: { outcome: "failure" } });
      expect(await kinds()).toEqual([
        "failure:120000",
        "held:120000",
        "receipt:120000",
      ]);
      expect((await invoiceMoney(j.f.pool, j.invoiceId)).paidCents).toBe(
        120000,
      );
      await j.student.reload();
      await expect(amount(j.student, "Recorded payment")).toHaveText(
        "CAD 1200.00",
      );
      await expect(amount(j.student, "Balance")).toHaveText("CAD 0.00");
    });

    // The next period's terms, with their own invoice.
    const next: TermsForm = {
      price: "1500.00",
      startsOn: await j.day(30),
      endsOn: await j.day(59),
      renewsOn: await j.day(60),
      reviewMinutes: 90,
      coachingSessions: 4,
      aiRequests: 150,
    };
    await saveTerms(j.admin, j.f.origin, j.reference, next);
    const second = (
      await issueTermsInvoice(j.admin, j.f.origin, j.reference, "0.00")
    ).invoiceId;
    const secondPath = `${j.f.origin}/account/purchases/invoices/${second}`;

    await requiredCheck(4, async () => {
      await j.student.goto(secondPath);
      await expect(amount(j.student, "Balance")).toHaveText("CAD 1500.00");
      await expect(j.student.locator("main")).not.toContainText(
        /instal?ments?/i,
      );
      await expect(paymentRecord(j.student)).toHaveCount(0);
      expect(await invoiceMoney(j.f.pool, second)).toEqual({
        paidCents: 0,
        refundedCents: 0,
        rows: [],
      });
      // One invoice per terms version, and nothing else was charged.
      expect(
        (await storedInvoices(j.f.pool, j.reference)).map((i) => [
          i.version,
          i.totalCents,
          i.paidCents,
        ]),
      ).toEqual([
        [1, 120000, 120000],
        [2, 150000, 0],
      ]);
    });

    await requiredCheck(5, async () => {
      await recordOfflinePayment(j.admin, j.f.origin, second, "1500.00");
      const money = await invoiceMoney(j.f.pool, second);
      expect(money.paidCents).toBe(150000);
      expect(money.rows).toHaveLength(1);
      expect(money.rows[0]).toMatch(/:receipt:150000$/);
      await j.student.goto(secondPath);
      await expect(amount(j.student, "Balance")).toHaveText("CAD 0.00");
      await expect(paymentRecord(j.student).locator("tbody tr")).toHaveCount(1);
      // Nothing is left to receive, so it can't be recorded twice.
      await j.admin.goto(`${j.f.origin}/operator/invoices/${second}`);
      await expect(j.admin.locator('form[action$="/payment"]')).toHaveCount(0);
      await j.admin.goto(j.f.origin + "/operator/invoice-reconciliation");
      const sample = j.admin.locator('[data-invoice-group="sample"]');
      await expect(
        sample.locator('[data-reconciliation-status="consistent"]'),
      ).toBeVisible();
      await expect(sample.locator('[data-field="receipts"]')).toHaveText(
        "CAD 1500.00",
      );
      await expect(
        sample.locator('[data-field="simulatedReceipts"]'),
      ).toHaveText("CAD 1200.00");
      await expect(sample.locator('[data-field="mismatched"]')).toHaveText("0");
      await expect(sample.locator('[data-field="unpaid"]')).toHaveText(
        "CAD 0.00",
      );
    });

    await requiredCheck(6, async () => {
      const before = await state(j);
      await studentIsToldToContact(j);
      expect(await state(j)).toEqual(before);
      // Staff record the agreed early end of the next period, then save it.
      const change: AgreedForm = {
        ...RELEASE,
        agreed: "Invented: the next coaching period ends 15 days early.",
      };
      await recordAgreedChange(j.admin, j.f.origin, j.reference, change);
      expect(await state(j)).toEqual(before);
      const shorter: TermsForm = {
        ...next,
        endsOn: await j.day(44),
        renewsOn: await j.day(45),
      };
      await saveTerms(j.admin, j.f.origin, j.reference, shorter);
      await recordIsShown(j, change);
      await expect(
        shown(j.student, "coaching-terms", "Coaching period"),
      ).toHaveText(
        `${readableDay(shorter.startsOn)} to ${readableDay(shorter.endsOn)}`,
      );
      const versions = await storedTerms(j.f.pool, j.reference);
      expect(versions.map((v) => [v.version, v.endsOn])).toEqual([
        [1, j.terms.endsOn],
        [2, next.endsOn],
        [3, shorter.endsOn],
      ]);
      // The first period, which nobody agreed to change, keeps its units.
      expect(
        (await storedGrants(j.f.pool, j.reference)).filter(
          (grant) => grant.version === 1,
        ),
      ).toEqual(before.grants.filter((grant) => grant.version === 1));
    });

    await requiredCheck(7, async () => {
      await studentIsToldToContact(j);
      expect(await invoiceMoney(j.f.pool, second)).toMatchObject({
        paidCents: 150000,
        refundedCents: 0,
      });
      const change: AgreedForm = {
        ...REFUND,
        agreed: "Invented: CAD 750.00 of the next period is refunded.",
      };
      await recordAgreedChange(j.admin, j.f.origin, j.reference, change);
      // The record alone refunds nothing; staff record the refund they sent.
      expect((await invoiceMoney(j.f.pool, second)).refundedCents).toBe(0);
      await recordOfflineRefund(j.admin, j.f.origin, second, "750.00");
      const money = await invoiceMoney(j.f.pool, second);
      expect(money.paidCents).toBe(150000);
      expect(money.refundedCents).toBe(75000);
      expect(money.rows).toHaveLength(2);
      await recordIsShown(j, change);
      for (const page of [j.admin, j.student]) {
        await page.goto(
          page === j.admin
            ? `${j.f.origin}/operator/invoices/${second}`
            : secondPath,
        );
        await expect(paymentRecord(page).locator("tbody tr")).toHaveCount(2);
        await expect(paymentRecord(page)).toContainText(
          "Invented refund e-Transfer",
        );
        await expect(amount(page, "Recorded refund")).toHaveText("CAD 750.00");
      }
      // The first invoice was never refunded.
      expect((await invoiceMoney(j.f.pool, j.invoiceId)).refundedCents).toBe(0);
    });
  } finally {
    await j.f.close();
  }
});
