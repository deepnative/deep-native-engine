import { expect, test, type Browser, type TestInfo } from "@playwright/test";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import { memberReference } from "../support/course-bundle-journey.ts";
import {
  daysLater,
  issueTermsInvoice,
  newOperation,
  postForm,
  readableDay,
  saveRecipient,
  saveTerms,
  shown,
  storedGrants,
  storedInvoices,
  storedTerms,
  termsInvoiceSection,
  termsSection,
  torontoDay,
  unitsShown,
  type TermsForm,
} from "../support/coaching-terms-journey.ts";
import { staffTrace } from "../support/staff-trace.ts";

// The per-student coaching cases (the owner's 9 and 10 November 2026
// decisions): an administrator sets one student's price, period, renewal date
// and allowances. Invoices only: no provider, no payment processing, and
// nothing renews or charges by itself. Every person and amount is invented.
test.use({ trace: staffTrace });

const NOTHING_AUTOMATIC = "Nothing renews or charges automatically.";

async function setUp(browser: Browser, info: TestInfo) {
  test.setTimeout(90_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    const admin = (await f.staff("platform_admin")).page;
    const student = await f.member();
    const reference = await memberReference(student, f.origin);
    const day = (offset: number) => torontoDay(f.pool, offset);
    return { f, admin, student, reference, day };
  } catch (error) {
    await f.close();
    throw error;
  }
}
type Journey = Awaited<ReturnType<typeof setUp>>;

/** A period of `length` days starting `from` days from today. */
async function period(
  j: Journey,
  from: number,
  length: number,
  rest: Pick<
    TermsForm,
    "price" | "reviewMinutes" | "coachingSessions" | "aiRequests"
  >,
): Promise<TermsForm> {
  return {
    ...rest,
    startsOn: await j.day(from),
    endsOn: await j.day(from + length - 1),
    renewsOn: await j.day(from + length),
  };
}
const FIRST = {
  price: "1200.00",
  reviewMinutes: 120,
  coachingSessions: 6,
  aiRequests: 200,
} as const;
const NEXT = {
  price: "1500.00",
  reviewMinutes: 90,
  coachingSessions: 4,
  aiRequests: 150,
} as const;

/** The allowance grants one terms version should have: one per category. */
const grantsOf = (version: number, terms: TermsForm, usable: boolean) => [
  {
    version,
    category: "review_minutes",
    quantity: terms.reviewMinutes,
    available: terms.reviewMinutes,
    startsOn: terms.startsOn,
    endsOn: terms.endsOn,
    usable,
  },
  {
    version,
    category: "study_requests",
    quantity: terms.aiRequests,
    available: terms.aiRequests,
    startsOn: terms.startsOn,
    endsOn: terms.endsOn,
    usable,
  },
];
const left = (n: number, unit = "") =>
  `${n} of ${n}${unit} left, 0 held, 0 used`;

async function generateDueInvoices(j: Journey) {
  await j.admin.goto(j.f.origin + "/operator/invoices");
  await j.admin
    .getByRole("button", { name: "Generate due recurring invoices" })
    .click();
}
const renewalsDue = (j: Journey) =>
  j.admin.locator('section[aria-labelledby="renewals-due"]');
async function payments(j: Journey) {
  return (
    await j.f.pool.query(
      "SELECT 1 FROM simple_invoice_payments p JOIN simple_invoices i ON i.id=p.invoice_id WHERE i.owner_id=$1",
      [j.reference],
    )
  ).rowCount;
}

test("[F-ROADMAP-01-A] an administrator's saved terms are the student's only current terms, and the first period shows exactly those allowances, issued once", async ({
  browser,
}, info) => {
  const j = await setUp(browser, info);
  try {
    const terms = await period(j, 0, 90, FIRST);
    let sent: Awaited<ReturnType<typeof saveTerms>>;

    await requiredCheck(1, async () => {
      sent = await saveTerms(j.admin, j.f.origin, j.reference, terms);
      await expect(termsSection(j.admin)).toContainText(
        "Current terms, version 1:",
      );
      await expect(shown(j.admin, "coaching-terms", "Price")).toHaveText(
        "CAD 1,200.00",
      );
      await expect(
        shown(j.admin, "coaching-terms", "Coaching period"),
      ).toHaveText(
        `${readableDay(terms.startsOn)} to ${readableDay(terms.endsOn)}`,
      );
      await expect(shown(j.admin, "coaching-terms", "Renewal date")).toHaveText(
        readableDay(terms.renewsOn),
      );
      await expect(termsSection(j.admin)).toContainText(NOTHING_AUTOMATIC);
      expect(await storedTerms(j.f.pool, j.reference)).toEqual([
        expect.objectContaining({
          version: 1,
          priceCents: 120000,
          startsOn: terms.startsOn,
          endsOn: terms.endsOn,
          renewsOn: terms.renewsOn,
          reviewMinutes: 120,
          coachingSessions: 6,
          aiRequests: 200,
        }),
      ]);
      // Saving terms issues no invoice and records no payment.
      expect(await storedInvoices(j.f.pool, j.reference)).toEqual([]);
      expect(await payments(j)).toBe(0);
      await j.student.goto(j.f.origin + "/account/purchases");
      await expect(
        j.student
          .locator("h2", { hasText: "Your invoices" })
          .locator("+ ul li"),
      ).toHaveCount(0);
    });

    await requiredCheck(2, async () => {
      await j.student.goto(j.f.origin + "/account/coaching");
      await expect(
        shown(j.student, "coaching-terms", "Coaching sessions"),
      ).toHaveText("6");
      await expect(
        shown(j.student, "coaching-terms", "Expert review time"),
      ).toHaveText("120 minutes");
      await expect(
        shown(j.student, "coaching-terms", "AI requests"),
      ).toHaveText("200");
      await expect(
        shown(j.student, "coaching-allowances", "Expert review time"),
      ).toHaveText(left(120, " minutes"));
      await expect(
        shown(j.student, "coaching-allowances", "AI requests"),
      ).toHaveText(left(200));
      expect(await unitsShown(j.student, j.f.origin, "review_minutes")).toEqual(
        { usable: "120", future: "0" },
      );
      expect(await unitsShown(j.student, j.f.origin, "study_requests")).toEqual(
        { usable: "200", future: "0" },
      );

      // The same form sent again is the same save; an out-of-date form is
      // refused. Neither issues a second set of units.
      const path = `/operator/coaching/${j.reference}/terms`;
      expect((await postForm(j.admin, j.f.origin, path, sent)).status()).toBe(
        303,
      );
      expect(
        (
          await postForm(j.admin, j.f.origin, path, {
            ...sent,
            operationId: newOperation(),
          })
        ).status(),
      ).toBe(409);
      expect(await storedTerms(j.f.pool, j.reference)).toHaveLength(1);
      expect(await storedGrants(j.f.pool, j.reference)).toEqual(
        grantsOf(1, terms, true),
      );
      expect(await unitsShown(j.student, j.f.origin, "review_minutes")).toEqual(
        { usable: "120", future: "0" },
      );
      expect(await unitsShown(j.student, j.f.origin, "study_requests")).toEqual(
        { usable: "200", future: "0" },
      );
    });
  } finally {
    await j.f.close();
  }
});

test("[F-ROADMAP-04-A] a student's first terms are one version with one invoice for its price plus HST and one set of dated allowances", async ({
  browser,
}, info) => {
  const j = await setUp(browser, info);
  try {
    // Configured (not sample) invoicing as Deep Native Inc. with 13% HST, on
    // the same database. Issuing still takes no payment.
    const real = await j.f.configuredInvoiceListener();
    const terms = await period(j, 0, 90, FIRST);

    await requiredCheck(1, async () => {
      await saveTerms(j.admin, real, j.reference, terms);
      await saveRecipient(j.student, real);
      await j.admin.goto(`${real}/operator/coaching/${j.reference}`);
      await expect(termsInvoiceSection(j.admin)).toContainText(
        "Issue an invoice for terms version 1: CAD 1,200.00 plus HST (13%) CAD 156.00, total CAD 1,356.00, to Invented Student",
      );
      const { invoiceId, sent } = await issueTermsInvoice(
        j.admin,
        real,
        j.reference,
      );
      await j.admin.goto(`${real}/operator/coaching/${j.reference}`);
      await expect(termsSection(j.admin)).toContainText(
        "Current terms, version 1:",
      );
      await expect(termsInvoiceSection(j.admin)).toContainText(
        "Terms version 1 is invoiced.",
      );
      await expect(
        termsInvoiceSection(j.admin).getByRole("button"),
      ).toHaveCount(0);
      // The same form again is the same invoice; a new request is refused.
      const path = `/operator/coaching/${j.reference}/terms-invoice`;
      const again = await postForm(j.admin, real, path, sent);
      expect(again.status()).toBe(303);
      expect(again.headers().location).toBe(`/operator/invoices/${invoiceId}`);
      expect(
        (
          await postForm(j.admin, real, path, {
            ...sent,
            operationId: newOperation(),
          })
        ).status(),
      ).toBe(409);
      expect(await storedTerms(j.f.pool, j.reference)).toHaveLength(1);
      expect(await storedInvoices(j.f.pool, j.reference)).toEqual([
        {
          id: invoiceId,
          version: 1,
          totalCents: 135600,
          paidCents: 0,
          taxCents: 15600,
          void: false,
        },
      ]);
      expect(await payments(j)).toBe(0);
    });

    await requiredCheck(2, async () => {
      expect(await storedGrants(j.f.pool, j.reference)).toEqual(
        grantsOf(1, terms, true),
      );
      await j.student.goto(real + "/account/coaching");
      await expect(
        shown(j.student, "coaching-terms", "Coaching period"),
      ).toHaveText(
        `${readableDay(terms.startsOn)} to ${readableDay(terms.endsOn)}`,
      );
      await expect(
        shown(j.student, "coaching-terms", "Coaching sessions"),
      ).toHaveText("6");
      await expect(
        shown(j.student, "coaching-allowances", "Expert review time"),
      ).toHaveText(left(120, " minutes"));
      await expect(
        shown(j.student, "coaching-allowances", "AI requests"),
      ).toHaveText(left(200));
    });
  } finally {
    await j.f.close();
  }
});

/**
 * First terms saved and invoiced, then the next terms saved before the first
 * renewal date, for the period that starts the day after the first one ends.
 */
async function firstThenNext(j: Journey) {
  const first = await period(j, 0, 30, FIRST);
  await saveTerms(j.admin, j.f.origin, j.reference, first);
  await saveRecipient(j.student, j.f.origin);
  const invoice = await issueTermsInvoice(
    j.admin,
    j.f.origin,
    j.reference,
    "0.00",
  );
  const before = {
    terms: await storedTerms(j.f.pool, j.reference),
    invoices: await storedInvoices(j.f.pool, j.reference),
  };
  const next = await period(j, 30, 30, NEXT);
  await saveTerms(j.admin, j.f.origin, j.reference, next);
  return { first, next, invoice, before };
}

/** The current (second) version is invoiced once; a second request is refused. */
async function invoiceNextOnce(j: Journey) {
  const { invoiceId, sent } = await issueTermsInvoice(
    j.admin,
    j.f.origin,
    j.reference,
    "0.00",
  );
  expect(
    (
      await postForm(
        j.admin,
        j.f.origin,
        `/operator/coaching/${j.reference}/terms-invoice`,
        { ...sent, operationId: newOperation() },
      )
    ).status(),
  ).toBe(409);
  await j.admin.goto(`${j.f.origin}/operator/coaching/${j.reference}`);
  await expect(termsInvoiceSection(j.admin)).toContainText(
    "Terms version 2 is invoiced.",
  );
  return invoiceId;
}

test("[F-ROADMAP-04-B] next terms saved before the renewal date keep the administrator's dates and leave the earlier version and its invoice unchanged", async ({
  browser,
}, info) => {
  const j = await setUp(browser, info);
  try {
    let saved: Awaited<ReturnType<typeof firstThenNext>>;

    await requiredCheck(1, async () => {
      saved = await firstThenNext(j);
      const versions = await storedTerms(j.f.pool, j.reference);
      expect(versions).toHaveLength(2);
      expect(versions[0]).toEqual(saved.before.terms[0]);
      expect(versions[1]).toEqual(
        expect.objectContaining({
          version: 2,
          priceCents: 150000,
          startsOn: saved.next.startsOn,
          endsOn: saved.next.endsOn,
          renewsOn: saved.next.renewsOn,
        }),
      );
      expect(await storedInvoices(j.f.pool, j.reference)).toEqual(
        saved.before.invoices,
      );
      await expect(termsSection(j.admin)).toContainText(
        "Current terms, version 2:",
      );
      await expect(
        shown(j.admin, "coaching-terms", "Coaching period"),
      ).toHaveText(
        `${readableDay(saved.next.startsOn)} to ${readableDay(saved.next.endsOn)}`,
      );
      await expect(shown(j.admin, "coaching-terms", "Renewal date")).toHaveText(
        readableDay(saved.next.renewsOn),
      );
    });

    await requiredCheck(2, async () => {
      expect(await storedGrants(j.f.pool, j.reference)).toEqual([
        ...grantsOf(1, saved.first, true),
        ...grantsOf(2, saved.next, false),
      ]);
      const second = await invoiceNextOnce(j);
      expect(await storedInvoices(j.f.pool, j.reference)).toEqual([
        saved.before.invoices[0],
        {
          id: second,
          version: 2,
          totalCents: 150000,
          paidCents: 0,
          taxCents: 0,
          void: false,
        },
      ]);
      expect(await payments(j)).toBe(0);
      // Invoicing granted nothing more.
      expect(await storedGrants(j.f.pool, j.reference)).toHaveLength(4);
      expect(await unitsShown(j.student, j.f.origin, "review_minutes")).toEqual(
        { usable: "120", future: "90" },
      );
    });
  } finally {
    await j.f.close();
  }
});

test("[F-ROADMAP-04-C] a passed renewal date only shows the student as due; renewing is a new terms version with its own dates and allowances", async ({
  browser,
}, info) => {
  const j = await setUp(browser, info);
  try {
    // A period that ends today, whose renewal date was yesterday.
    const first: TermsForm = {
      ...FIRST,
      startsOn: await j.day(-30),
      endsOn: await j.day(0),
      renewsOn: await j.day(-1),
    };
    await saveTerms(j.admin, j.f.origin, j.reference, first);

    await requiredCheck(1, async () => {
      await j.admin.goto(j.f.origin + "/operator/coaching");
      const due = renewalsDue(j)
        .locator("li")
        .filter({
          has: j.admin.locator(`a[href="/operator/coaching/${j.reference}"]`),
        });
      await expect(due).toContainText(
        `renewal date ${readableDay(first.renewsOn)}`,
      );
      await expect(due).toContainText(/\d+ days? overdue/);
      await expect(renewalsDue(j)).toContainText(NOTHING_AUTOMATIC);
      await generateDueInvoices(j);
      expect(await storedTerms(j.f.pool, j.reference)).toHaveLength(1);
      expect(await storedGrants(j.f.pool, j.reference)).toEqual(
        grantsOf(1, first, true),
      );
      expect(await storedInvoices(j.f.pool, j.reference)).toEqual([]);
      await j.student.goto(j.f.origin + "/account/coaching");
      await expect(termsSection(j.student)).toContainText(NOTHING_AUTOMATIC);
      await expect(
        shown(j.student, "coaching-terms", "Renewal date"),
      ).toHaveText(readableDay(first.renewsOn));
    });

    await requiredCheck(2, async () => {
      const renewal: TermsForm = {
        price: "1800.00",
        startsOn: await j.day(1),
        endsOn: await j.day(182),
        renewsOn: await j.day(183),
        reviewMinutes: 240,
        coachingSessions: 12,
        aiRequests: 400,
      };
      await saveTerms(j.admin, j.f.origin, j.reference, renewal);
      const versions = await storedTerms(j.f.pool, j.reference);
      expect(versions).toHaveLength(2);
      expect(versions[1]).toEqual(
        expect.objectContaining({
          version: 2,
          priceCents: 180000,
          startsOn: renewal.startsOn,
          endsOn: renewal.endsOn,
          renewsOn: renewal.renewsOn,
          reviewMinutes: 240,
          coachingSessions: 12,
          aiRequests: 400,
        }),
      );
      expect(await storedGrants(j.f.pool, j.reference)).toEqual([
        ...grantsOf(1, first, true),
        ...grantsOf(2, renewal, false),
      ]);
      expect(await storedInvoices(j.f.pool, j.reference)).toEqual([]);
      await expect(
        shown(j.admin, "coaching-terms", "Coaching period"),
      ).toHaveText(
        `${readableDay(renewal.startsOn)} to ${readableDay(renewal.endsOn)}`,
      );
      await expect(shown(j.admin, "coaching-terms", "Price")).toHaveText(
        "CAD 1,800.00",
      );
      // The student is no longer listed as due.
      await j.admin.goto(j.f.origin + "/operator/coaching");
      await expect(
        renewalsDue(j).locator(`a[href="/operator/coaching/${j.reference}"]`),
      ).toHaveCount(0);
      expect(await unitsShown(j.student, j.f.origin, "review_minutes")).toEqual(
        { usable: "120", future: "240" },
      );
    });
  } finally {
    await j.f.close();
  }
});

test("[F-ROADMAP-07-A] moving into the next coaching period makes only that period's administrator-set allowances available", async ({
  browser,
}, info) => {
  const j = await setUp(browser, info);
  try {
    const first = await period(j, 0, 30, FIRST);
    await saveTerms(j.admin, j.f.origin, j.reference, first);
    const next = await period(j, 30, 30, NEXT);
    await saveTerms(j.admin, j.f.origin, j.reference, next);
    // Before the move only the first period's units can be used.
    expect(await unitsShown(j.student, j.f.origin, "review_minutes")).toEqual({
      usable: "120",
      future: "90",
    });
    expect(await unitsShown(j.student, j.f.origin, "study_requests")).toEqual({
      usable: "200",
      future: "150",
    });
    await daysLater(j.f.pool, j.reference, 30);
    const usable = async (category: string) =>
      (await storedGrants(j.f.pool, j.reference)).filter(
        (grant) => grant.usable && grant.category === category,
      );

    await requiredCheck(1, async () => {
      expect(await usable("review_minutes")).toEqual([
        expect.objectContaining({ version: 2, quantity: 90, available: 90 }),
      ]);
      expect(await unitsShown(j.student, j.f.origin, "review_minutes")).toEqual(
        { usable: "90", future: "0" },
      );
      await j.student.goto(j.f.origin + "/account/coaching");
      await expect(
        shown(j.student, "coaching-terms", "Coaching sessions"),
      ).toHaveText("4");
      await expect(
        shown(j.student, "coaching-allowances", "Expert review time"),
      ).toHaveText(left(90, " minutes"));
    });

    await requiredCheck(2, async () => {
      expect(await usable("study_requests")).toEqual([
        expect.objectContaining({ version: 2, quantity: 150, available: 150 }),
      ]);
      // One AI grant per period, and reading the pages grants nothing more.
      expect(
        (await storedGrants(j.f.pool, j.reference))
          .filter((grant) => grant.category === "study_requests")
          .map((grant) => [grant.version, grant.quantity]),
      ).toEqual([
        [1, 200],
        [2, 150],
      ]);
      expect(await unitsShown(j.student, j.f.origin, "study_requests")).toEqual(
        { usable: "150", future: "0" },
      );
      await j.student.goto(j.f.origin + "/account/coaching");
      await expect(
        shown(j.student, "coaching-allowances", "AI requests"),
      ).toHaveText(left(150));
      expect(await storedGrants(j.f.pool, j.reference)).toHaveLength(4);
    });
  } finally {
    await j.f.close();
  }
});

test("[F-BUILD-04-A] next terms saved on time start on the administrator's date with no gap or overlap, and each version is invoiced and granted once", async ({
  browser,
}, info) => {
  const j = await setUp(browser, info);
  try {
    let saved: Awaited<ReturnType<typeof firstThenNext>>;

    await requiredCheck(1, async () => {
      saved = await firstThenNext(j);
      const [one, two] = await storedTerms(j.f.pool, j.reference);
      expect(one).toEqual(saved.before.terms[0]);
      expect(one).toEqual(
        expect.objectContaining({
          startsOn: saved.first.startsOn,
          endsOn: saved.first.endsOn,
          renewsOn: saved.first.renewsOn,
        }),
      );
      expect(two!.startsOn).toBe(saved.next.startsOn);
      // The next period starts the day after the first ends.
      expect(two!.startsOn).toBe(await j.day(30));
      expect(one!.endsOn).toBe(await j.day(29));
      await expect(
        shown(j.admin, "coaching-terms", "Coaching period"),
      ).toHaveText(
        `${readableDay(saved.next.startsOn)} to ${readableDay(saved.next.endsOn)}`,
      );
    });

    await requiredCheck(2, async () => {
      const second = await invoiceNextOnce(j);
      expect(await storedInvoices(j.f.pool, j.reference)).toEqual([
        {
          id: saved.invoice.invoiceId,
          version: 1,
          totalCents: 120000,
          paidCents: 0,
          taxCents: 0,
          void: false,
        },
        {
          id: second,
          version: 2,
          totalCents: 150000,
          paidCents: 0,
          taxCents: 0,
          void: false,
        },
      ]);
      expect(await storedGrants(j.f.pool, j.reference)).toEqual([
        ...grantsOf(1, saved.first, true),
        ...grantsOf(2, saved.next, false),
      ]);
      await j.student.goto(j.f.origin + "/account/purchases");
      await expect(
        j.student.getByRole("link", { name: `DN-${saved.invoice.invoiceId}` }),
      ).toBeVisible();
      await expect(
        j.student.getByRole("link", { name: `DN-${second}` }),
      ).toBeVisible();
    });
  } finally {
    await j.f.close();
  }
});

test("[F-BUILD-04-B] after the coaching period and renewal date pass with no new terms, nothing more is invoiced or granted", async ({
  browser,
}, info) => {
  const j = await setUp(browser, info);
  try {
    const first = await period(j, 0, 30, FIRST);
    await saveTerms(j.admin, j.f.origin, j.reference, first);
    await saveRecipient(j.student, j.f.origin);
    const { invoiceId } = await issueTermsInvoice(
      j.admin,
      j.f.origin,
      j.reference,
      "0.00",
    );
    const before = await storedInvoices(j.f.pool, j.reference);
    // 31 days on: the period ended yesterday and the renewal date is today.
    await daysLater(j.f.pool, j.reference, 31);

    await requiredCheck(1, async () => {
      await generateDueInvoices(j);
      await j.admin.goto(j.f.origin + "/operator/coaching");
      await expect(
        renewalsDue(j)
          .locator("li")
          .filter({
            has: j.admin.locator(`a[href="/operator/coaching/${j.reference}"]`),
          }),
      ).toContainText(/due today|\d+ days? overdue/);
      expect(before).toEqual([
        expect.objectContaining({ id: invoiceId, version: 1 }),
      ]);
      expect(await storedInvoices(j.f.pool, j.reference)).toEqual(before);
      expect(await payments(j)).toBe(0);
      expect(await storedTerms(j.f.pool, j.reference)).toHaveLength(1);
      await j.student.goto(j.f.origin + "/account/purchases");
      await expect(
        j.student
          .locator("h2", { hasText: "Your invoices" })
          .locator("+ ul li"),
      ).toHaveCount(1);
    });

    await requiredCheck(2, async () => {
      const grants = await storedGrants(j.f.pool, j.reference);
      expect(grants.map((g) => [g.version, g.category, g.quantity])).toEqual([
        [1, "review_minutes", 120],
        [1, "study_requests", 200],
      ]);
      expect(grants.some((grant) => grant.usable)).toBe(false);
      for (const category of ["review_minutes", "study_requests"] as const)
        expect(await unitsShown(j.student, j.f.origin, category)).toEqual({
          usable: "0",
          future: "0",
        });
      await j.student.goto(j.f.origin + "/account/coaching");
      await expect(
        shown(j.student, "coaching-allowances", "Expert review time"),
      ).toHaveText("0 of 120 minutes left, 0 held, 0 used");
      await expect(
        shown(j.student, "coaching-allowances", "AI requests"),
      ).toHaveText("0 of 200 left, 0 held, 0 used");
      await expect(termsSection(j.student)).toContainText(NOTHING_AUTOMATIC);
    });
  } finally {
    await j.f.close();
  }
});

test("[F-BUILD-04-D] terms with a different length and price, and their later renewal, are separate versions with their own price, dates and allowances", async ({
  browser,
}, info) => {
  const j = await setUp(browser, info);
  try {
    const short = await period(j, 0, 45, {
      price: "777.50",
      reviewMinutes: 45,
      coachingSessions: 2,
      aiRequests: 30,
    });

    await requiredCheck(1, async () => {
      await saveTerms(j.admin, j.f.origin, j.reference, short);
      expect(await storedTerms(j.f.pool, j.reference)).toEqual([
        expect.objectContaining({
          version: 1,
          priceCents: 77750,
          startsOn: short.startsOn,
          endsOn: short.endsOn,
          renewsOn: short.renewsOn,
          reviewMinutes: 45,
          coachingSessions: 2,
          aiRequests: 30,
        }),
      ]);
      expect(await storedGrants(j.f.pool, j.reference)).toEqual(
        grantsOf(1, short, true),
      );
      await expect(shown(j.admin, "coaching-terms", "Price")).toHaveText(
        "CAD 777.50",
      );
      await expect(
        shown(j.admin, "coaching-terms", "Coaching period"),
      ).toHaveText(
        `${readableDay(short.startsOn)} to ${readableDay(short.endsOn)}`,
      );
      await expect(
        shown(j.admin, "coaching-allowances", "Expert review time"),
      ).toHaveText(left(45, " minutes"));
      await expect(
        shown(j.admin, "coaching-allowances", "AI requests"),
      ).toHaveText(left(30));
    });

    await requiredCheck(2, async () => {
      // 45 days on, the administrator renews from today for 120 days.
      await daysLater(j.f.pool, j.reference, 45);
      const earlier = (await storedTerms(j.f.pool, j.reference))[0]!;
      const renewal = await period(j, 0, 120, {
        price: "2400.00",
        reviewMinutes: 300,
        coachingSessions: 10,
        aiRequests: 500,
      });
      await saveTerms(j.admin, j.f.origin, j.reference, renewal);
      const versions = await storedTerms(j.f.pool, j.reference);
      expect(versions).toHaveLength(2);
      expect(versions[0]).toEqual(earlier);
      expect(versions[1]).toEqual(
        expect.objectContaining({
          version: 2,
          priceCents: 240000,
          startsOn: renewal.startsOn,
          endsOn: renewal.endsOn,
          renewsOn: renewal.renewsOn,
          reviewMinutes: 300,
          coachingSessions: 10,
          aiRequests: 500,
        }),
      );
      const grants = await storedGrants(j.f.pool, j.reference);
      expect(grants.filter((grant) => grant.version === 1)).toEqual(
        grantsOf(
          1,
          { ...short, startsOn: earlier.startsOn, endsOn: earlier.endsOn },
          false,
        ),
      );
      expect(grants.filter((grant) => grant.version === 2)).toEqual(
        grantsOf(2, renewal, true),
      );
      await expect(termsSection(j.admin)).toContainText(
        "Current terms, version 2:",
      );
      await expect(shown(j.admin, "coaching-terms", "Price")).toHaveText(
        "CAD 2,400.00",
      );
      await expect(
        shown(j.admin, "coaching-allowances", "Expert review time"),
      ).toHaveText(left(300, " minutes"));
      expect(await unitsShown(j.student, j.f.origin, "study_requests")).toEqual(
        { usable: "500", future: "0" },
      );
    });
  } finally {
    await j.f.close();
  }
});
