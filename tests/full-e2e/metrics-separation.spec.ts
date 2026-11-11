import { expect, test, type Page } from "@playwright/test";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import {
  acceptBundle,
  memberReference,
  prepareBundle,
} from "../support/course-bundle-journey.ts";
import { staffTrace } from "../support/staff-trace.ts";
import { randomBytes } from "node:crypto";
import { store } from "../../src/store.ts";

// Staff measures and their demo separation (ECO-08-A/B, BUILD-09-A). Each case
// runs on its own database. The main listener issues sample (demo) course
// billing; a second listener on the same database issues configured billing,
// whose agreements and invoices are the only "real" ones. Nothing is payable,
// no provider is called and no money moves. Staff credentials stay out of traces.
// Staff sign in here, so traces are off except in a full-release run, which
// needs one per execution: see ../support/staff-trace.ts.
test.use({ trace: staffTrace });
type Fixture = Awaited<ReturnType<typeof reviewedContentFixture>>;

const field = (page: Page, group: string, name: string) =>
  page.locator(
    `[data-agreement-group="${group}"] [data-field="${group}.${name}"]`,
  );
const cash = (page: Page, group: string, name: string) =>
  page.locator(`[data-invoice-group="${group}"] [data-field="${name}"]`);

// Configured subtotals whose 13% HST brings the totals to CAD 40.00 and 50.00.
const REAL_40 = "35.40",
  REAL_50 = "44.25";

async function setUp(f: Fixture) {
  await f.publishFixture();
  const admin = (await f.staff("platform_admin")).page;
  const real = f.configuredInvoiceListener();
  return { admin, realOrigin: await real };
}

// An administrator prepares a one-time offer on the given listener and the
// member accepts it there. Returns the invoice ID.
async function offerAndAccept(
  f: Fixture,
  admin: Page,
  member: Page,
  origin: string,
  amount: string,
  accept = true,
) {
  const reference = await memberReference(member, f.origin);
  await prepareBundle({ ...f, origin }, admin, reference, {
    amounts: [["FND-001", amount]],
    cadence: "one_time",
    // ISSUER-02: configured billing adds 13% HST, so it takes no typed tax.
    ...(origin === f.origin ? { tax: "0.00" } : {}),
  });
  if (!accept) return undefined;
  await member.goto(origin + "/account/purchases");
  return acceptBundle(member, "one_time");
}

async function recordPayment(
  admin: Page,
  origin: string,
  invoiceId: string,
  amount: string,
  date: string,
) {
  await admin.goto(origin + "/operator/invoices/" + invoiceId);
  await admin.getByLabel("Amount received (CAD)").fill(amount);
  await admin.getByLabel("Received on", { exact: true }).fill(date);
  await admin
    .getByLabel("Evidence reference")
    .first()
    .fill("Invented reference for a browser test");
  await admin.getByRole("checkbox", { name: /I verified these funds/ }).check();
  await admin.getByRole("button", { name: "Record offline payment" }).click();
  await expect(
    admin.getByRole("table", { name: "Recorded receipts and refunds" }),
  ).toContainText("Invented reference for a browser test");
}

// The aggregate data behind the staff snapshot page.
async function metricsJson(admin: Page, origin: string) {
  const response = await admin.request.get(origin + "/operator/metrics");
  expect(response.status()).toBe(200);
  return response.json();
}

async function selfAssess(f: Fixture, member: Page) {
  await member.goto(f.origin + "/library/FND-001?version=2");
  await member.getByRole("button", { name: "Start this lesson" }).click();
  await member
    .getByLabel("I have finished reading this lesson; this is my own report.")
    .check();
  await member
    .getByRole("button", { name: "Mark self-assessed complete" })
    .click();
  await expect(
    member.locator('section[aria-labelledby="reader-progress-title"]'),
  ).toContainText("Self-assessed complete · version 2");
}

test("[F-ECO-08-A] learning, participation, reviewed-contribution and paid-conversion measures keep separate definitions and denominators", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const f = await reviewedContentFixture(browser, info, {
    memberContributions: true,
  });
  try {
    const { admin, realOrigin } = await setUp(f);
    const learner = await f.member(),
      buyer = await f.member("professional", "work"),
      declined = await f.member("technical", "build");
    await selfAssess(f, learner);
    await offerAndAccept(f, admin, buyer, realOrigin, REAL_40);
    await offerAndAccept(f, admin, declined, realOrigin, REAL_40, false);

    await admin.goto(f.origin + "/operator/metrics/report");
    const report = admin.locator("main");
    await requiredCheck(1, async () => {
      await expect(
        admin.getByRole("heading", {
          name: "Learning and participation snapshot",
        }),
      ).toBeVisible();
      const accounts = admin.locator(
        'section[aria-labelledby="metrics-members"]',
      );
      await expect(accounts).toContainText(
        "Current retained local-preview member records",
      );
      const activity = admin.locator(
        'section[aria-labelledby="metrics-activity"]',
      );
      await expect(activity).toContainText(
        "Each measure counts distinct retained members.",
      );
      for (const [key, label, definition] of [
        [
          "activated",
          "Opened a versioned lesson",
          "at least one versioned lesson open, divided by members",
        ],
        [
          "selfAssessed",
          "Self-assessed lesson completion",
          "at least one self-assessed lesson completion, divided by members",
        ],
        [
          "submittedAssignment",
          "Submitted an assignment",
          "private assignment submission snapshot, divided by members",
        ],
      ] as const) {
        const term = activity.locator("dt", { hasText: label });
        await expect(term).toHaveCount(1);
        await expect(term.locator("+ dd")).toContainText(definition);
        // Each measure has its own computed value cell, withheld on its own.
        await expect(term.locator("+ dd").locator("[data-metric]")).toHaveCount(
          1,
        );
        await expect(
          term.locator("+ dd").locator(`[data-metric="${key}"]`),
        ).toHaveText("Suppressed");
      }
      // The data behind the page keeps one definition and one value per
      // learning measure, each over members, and carries no paid measure.
      const data = await metricsJson(admin, f.origin);
      expect(data.learning.disclosure).toBe("suppressed");
      const learningKeys = [
        "activated",
        "selfAssessed",
        "submittedAssignment",
      ] as const;
      for (const key of learningKeys) {
        expect(data.definitions[key]).toContain("divided by members");
        expect(data.learning.values).toHaveProperty(key, null);
      }
      expect(
        new Set(learningKeys.map((key) => data.definitions[key])).size,
      ).toBe(learningKeys.length);
      for (const key of [
        ...Object.keys(data),
        ...Object.keys(data.definitions),
        ...Object.keys(data.learning.values),
      ])
        expect(key).not.toMatch(/paid|revenue|conversion|offer|invoice/i);
      // Four members is below the 20-member floor, so values are withheld,
      // not shown as small exact counts.
      await expect(accounts.locator('[data-metric="members"]')).toHaveText(
        "Suppressed",
      );
      // The learning snapshot carries no paid or revenue measure.
      await expect(report).toContainText(
        "paid conversion, revenue and service capacity are not included",
      );
      await expect(activity).not.toContainText("accepted");
    });

    await requiredCheck(2, async () => {
      const activity = admin.locator(
        'section[aria-labelledby="metrics-activity"]',
      );
      for (const [key, label, definition] of [
        [
          "participated",
          "Ever joined a circle",
          "who ever joined a local circle, divided by members",
        ],
        [
          "activeCircle",
          "Currently in a circle",
          "with no recorded departure, divided by members",
        ],
      ] as const) {
        const value = activity
          .locator("dt", { hasText: label })
          .locator("+ dd");
        await expect(value).toContainText(definition);
        // Each participation measure has its own value cell, withheld alone.
        await expect(value.locator("[data-metric]")).toHaveCount(1);
        await expect(value.locator(`[data-metric="${key}"]`)).toHaveText(
          "Suppressed",
        );
      }
      await expect(activity).toContainText(
        "Measures overlap and must not be added together.",
      );
      const contributions = admin.locator(
        'section[aria-labelledby="metrics-contributions"]',
      );
      await expect(
        contributions.getByRole("heading", { name: "Reviewed contributions" }),
      ).toBeVisible();
      // Contributions count distinct revisions and contributing owners, not
      // members, and keep member-origin and sample-attested work apart.
      await expect(contributions).toContainText("distinct revisions");
      await expect(contributions).toContainText(
        "A group needs at least 20 contributing owners",
      );
      await expect(contributions).toContainText(
        "Distinct revisions that received their first editorial decision",
      );
      await expect(
        contributions.getByRole("heading", {
          name: "Member-origin contributions",
        }),
      ).toBeVisible();
      await expect(
        contributions.getByRole("heading", {
          name: "Sample-attested contributions",
        }),
      ).toBeVisible();
      await expect(contributions).not.toContainText("divided by members");
      // Each contribution group is withheld as a group of its own.
      for (const origin of ["member", "sample"])
        await expect(
          contributions.locator(`[data-contributions="${origin}-suppressed"]`),
        ).toHaveCount(1);
      // In the data, participation is defined over members, while
      // contributions are a separate block with their own groups and
      // definitions that never use the member denominator.
      const data = await metricsJson(admin, f.origin);
      const circleKeys = ["participated", "activeCircle"] as const;
      for (const key of circleKeys) {
        expect(data.definitions[key]).toContain("divided by members");
        expect(data.learning.values).toHaveProperty(key, null);
      }
      expect(data.definitions.participated).not.toBe(
        data.definitions.activeCircle,
      );
      expect(
        data.contributions.groups.map(
          (group: { origin: string; disclosure: string }) => [
            group.origin,
            group.disclosure,
          ],
        ),
      ).toEqual([
        ["member", "suppressed"],
        ["sample", "suppressed"],
      ]);
      const contributionDefinitions: Record<string, string> =
        data.contributions.definitions;
      expect(Object.keys(contributionDefinitions).length).toBeGreaterThan(0);
      for (const [key, text] of Object.entries(contributionDefinitions)) {
        expect(text).not.toContain("divided by members");
        expect(Object.keys(data.learning.values)).not.toContain(key);
      }

      // Contrast above the 20-member floor: learning moves and nothing else
      // does. Eighteen more accounts bring the total to 25, and four more
      // members report a lesson complete, making five. A measure is shown
      // once it has five members and five outside it.
      const accounts = store(f.pool);
      for (let n = 0; n < 18; n++)
        await accounts.create(randomBytes(32).toString("hex"), {
          background: "explorer",
          goal: "everyday",
        });
      const shownValue = (key: string) =>
        admin.locator(`[data-metric="${key}"]`);
      for (let n = 0; n < 3; n++) await selfAssess(f, await f.member());
      // Four self-assessed members of 24 is still too few to show.
      await admin.goto(f.origin + "/operator/metrics/report");
      await expect(shownValue("members")).toHaveText("20-49");
      await expect(shownValue("selfAssessed")).toHaveText("Suppressed");
      await selfAssess(f, await f.member());
      await admin.goto(f.origin + "/operator/metrics/report");
      await expect(shownValue("members")).toHaveText("20-49");
      await expect(shownValue("selfAssessed")).toHaveText("5-19");
      await expect(shownValue("activated")).toHaveText("5-19");
      // No one joined a circle or contributed: those stay withheld.
      for (const key of ["participated", "activeCircle", "submittedAssignment"])
        await expect(shownValue(key)).toHaveText("Suppressed");
      for (const origin of ["member", "sample"])
        await expect(
          contributions.locator(`[data-contributions="${origin}-suppressed"]`),
        ).toHaveCount(1);
      const moved = await metricsJson(admin, f.origin);
      expect(moved.learning.disclosure).toBe("coarse-band");
      expect(moved.learning.values).toMatchObject({
        selfAssessed: "5-19",
        activated: "5-19",
        participated: null,
        activeCircle: null,
        submittedAssignment: null,
      });
      expect(
        moved.contributions.groups.map(
          (group: { disclosure: string }) => group.disclosure,
        ),
      ).toEqual(["suppressed", "suppressed"]);
    });

    await requiredCheck(3, async () => {
      await admin.goto(f.origin + "/operator/course-agreements");
      await expect(
        admin.getByRole("heading", { name: "Course agreement outcomes" }),
      ).toBeVisible();
      // Conversion is counted over offered agreements, exactly, not over
      // members, lessons or circles.
      await expect(field(admin, "real", "offered")).toHaveText("2");
      await expect(field(admin, "real", "acceptance")).toHaveText(
        "1 of 2 (50%)",
      );
      await expect(field(admin, "real", "waiting")).toHaveText("1");
      await expect(admin.locator("body")).toContainText(
        "Offered counts every agreement, including offers later withdrawn.",
      );
      for (const learningTerm of ["lesson", "circle", "contribution"])
        await expect(admin.locator("main")).not.toContainText(learningTerm);
      // The learner's self-report and the purchase didn't move each other's
      // measure: the learning snapshot still has no conversion figure.
      await admin.goto(f.origin + "/operator/metrics/report");
      await expect(admin.locator("main")).not.toContainText(
        "Accepted, of all offered",
      );
    });
  } finally {
    await f.close();
  }
});

test("[F-ECO-08-B] demo agreements and payments stay out of the real measures and a self-report stays labelled", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    const { admin, realOrigin } = await setUp(f);
    const demo = await f.member(),
      real = await f.member("professional", "work");

    await requiredCheck(1, async () => {
      await offerAndAccept(f, admin, demo, f.origin, "25.00");
      await expect(demo.locator("body")).toContainText("SAMPLE · NOT PAYABLE");
      await offerAndAccept(f, admin, real, realOrigin, REAL_40);
      await expect(real.locator("body")).not.toContainText("SAMPLE");

      await admin.goto(f.origin + "/operator/course-agreements");
      // The demo agreement is in the inputs but only in its labelled group.
      await expect(field(admin, "real", "offered")).toHaveText("1");
      await expect(field(admin, "real", "acceptance")).toHaveText(
        "1 of 1 (100%)",
      );
      await expect(field(admin, "test", "offered")).toHaveText("1");
      await expect(field(admin, "test", "acceptance")).toHaveText(
        "1 of 1 (100%)",
      );
      await expect(
        admin.locator('[data-agreement-group="test"]'),
      ).toContainText("They are never added to the real figures.");
      await expect(admin.locator(".eyebrow").first()).toContainText(
        "NOT A LIVE FIGURE",
      );

      await admin.goto(f.origin + "/operator/invoice-reconciliation");
      await expect(cash(admin, "configured", "invoiced")).toHaveText(
        "CAD 40.00",
      );
      await expect(cash(admin, "sample", "invoiced")).toHaveText("CAD 25.00");
      await expect(
        admin
          .locator('[data-invoice-group="sample"]')
          .getByRole("heading", { level: 2 }),
      ).toHaveText("Sample invoices · Test data");
      await expect(
        admin.locator('[data-invoice-group="sample"]'),
      ).toContainText("These never count towards any other figure.");
    });

    await requiredCheck(2, async () => {
      await selfAssess(f, demo);
      const progress = demo.locator(
        'section[aria-labelledby="reader-progress-title"]',
      );
      await expect(progress).toContainText(
        "No qualified reviewer has assessed this lesson.",
      );

      await admin.goto(f.origin + "/operator/metrics/report");
      const activity = admin.locator(
        'section[aria-labelledby="metrics-activity"]',
      );
      const selfReport = activity
        .locator("dt", { hasText: "Self-assessed lesson completion" })
        .locator("+ dd");
      await expect(selfReport).toContainText(
        "This is not observed skill or formal assessment.",
      );
      await expect(admin.locator("main")).toContainText(
        "A submission or self-report does not establish a qualified review.",
      );
      const json = await admin.request.get(f.origin + "/operator/metrics");
      expect(json.status()).toBe(200);
      const body = await json.json();
      expect(body.scope).toBe("synthetic-local-preview");
      expect(body.definitions.selfAssessed).toContain(
        "not observed skill or formal assessment",
      );
    });
  } finally {
    await f.close();
  }
});

test("[F-BUILD-09-A] demo payments and seeded agreement outcomes are excluded from the real measures", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    const { admin, realOrigin } = await setUp(f);
    const demo = await f.member(),
      real = await f.member("professional", "work"),
      seeded = await f.member("technical", "build");
    const date = (
      await f.pool.query<{ day: string }>(
        "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
      )
    ).rows[0]!.day;

    await requiredCheck(1, async () => {
      const demoInvoice = await offerAndAccept(
        f,
        admin,
        demo,
        f.origin,
        "30.00",
      );
      const realInvoice = await offerAndAccept(
        f,
        admin,
        real,
        realOrigin,
        REAL_50,
      );
      await recordPayment(admin, f.origin, demoInvoice!, "30.00", date);
      await recordPayment(admin, realOrigin, realInvoice!, "20.00", date);

      await admin.goto(f.origin + "/operator/invoice-reconciliation");
      // Collected cash counts only the configured invoice's receipt.
      await expect(cash(admin, "configured", "invoiced")).toHaveText(
        "CAD 50.00",
      );
      await expect(cash(admin, "configured", "receipts")).toHaveText(
        "CAD 20.00",
      );
      await expect(cash(admin, "configured", "net")).toHaveText("CAD 20.00");
      await expect(cash(admin, "configured", "unpaid")).toHaveText("CAD 30.00");
      await expect(cash(admin, "configured", "share")).toHaveText("40%");
      // The demo payment is visible, labelled and kept apart.
      await expect(cash(admin, "sample", "receipts")).toHaveText("CAD 30.00");
      await expect(cash(admin, "sample", "unpaid")).toHaveText("CAD 0.00");
      await expect(admin.locator("body")).not.toContainText(
        "CAD 50.00 collected",
      );
    });

    await requiredCheck(2, async () => {
      // A seeded outcome: the demo listener prepares an agreement that a
      // member accepts and then cancels.
      await offerAndAccept(f, admin, seeded, f.origin, "15.00");
      await seeded.goto(f.origin + "/account/purchases");
      await seeded
        .getByRole("checkbox", { name: /Stop future invoices/ })
        .check();
      await seeded
        .getByRole("button", { name: "Cancel future billing" })
        .click();

      await admin.goto(f.origin + "/operator/course-agreements");
      await expect(field(admin, "real", "offered")).toHaveText("1");
      await expect(field(admin, "real", "acceptance")).toHaveText(
        "1 of 1 (100%)",
      );
      await expect(field(admin, "real", "active")).toHaveText("1");
      await expect(field(admin, "real", "cancellation")).toHaveText(
        "0 of 1 (0%)",
      );
      await expect(field(admin, "test", "offered")).toHaveText("2");
      await expect(field(admin, "test", "acceptance")).toHaveText(
        "2 of 2 (100%)",
      );
      await expect(field(admin, "test", "cancellation")).toHaveText(
        "1 of 2 (50%)",
      );
      const stored = await f.pool.query<{ test: boolean; n: number }>(
        `SELECT (terms->'sample' IS DISTINCT FROM 'false'::jsonb) AS test,count(*)::integer AS n
         FROM simple_invoice_plans GROUP BY 1 ORDER BY 1`,
      );
      expect(stored.rows).toEqual([
        { test: false, n: 1 },
        { test: true, n: 2 },
      ]);
    });
  } finally {
    await f.close();
  }
});
