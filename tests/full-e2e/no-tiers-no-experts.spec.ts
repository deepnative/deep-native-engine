import { formToken } from "../support/form-token.ts";
import { expect, test, type Page } from "@playwright/test";
import { COACHING_OFFERS } from "../../src/offers.ts";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import {
  memberReference,
  offeredPlan,
} from "../support/course-bundle-journey.ts";
import {
  newOperation,
  postForm,
  saveTerms,
  shown,
  storedGrants,
  storedInvoices,
  storedTerms,
  termsSection,
  torontoDay,
  unitsShown,
  type TermsForm,
} from "../support/coaching-terms-journey.ts";
import { staffTrace } from "../support/staff-trace.ts";
import {
  openLearningProfile,
  saveLearningProfile,
} from "../support/learning-profile.ts";

// What can and can't be obtained under the owner's 9 and 10 November 2026
// decisions: there are no tiers and nothing can be bought; qualified tailored
// service is not offered because there are no real experts (#784); and
// coaching exists only as terms an administrator sets for one student, with
// no acceptance step. Sample invoices only; every person is invented.
// Staff sign in here, so traces are off except in a full-release run, which
// needs one per execution: see ../support/staff-trace.ts.
test.use({ trace: staffTrace });

type Fixture = Awaited<ReturnType<typeof reviewedContentFixture>>;
// Everything that would exist if something had been sold or accepted.
async function nothingSold(f: Fixture, reference: string) {
  expect(await storedTerms(f.pool, reference)).toEqual([]);
  expect(await storedGrants(f.pool, reference)).toEqual([]);
  expect(await storedInvoices(f.pool, reference)).toEqual([]);
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM simple_invoice_plans WHERE owner_id=$1",
        [reference],
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM synthetic_entitlement_grants WHERE member_id=$1",
        [reference],
      )
    ).rowCount,
  ).toBe(0);
}
const noWayToBuy = (page: Page) =>
  expect(
    page
      .locator("main")
      .getByRole("button", { name: /buy|purchase|book|upgrade|accept|pay/i }),
  ).toHaveCount(0);
// Asks whether tailored review is available for one domain.
async function checkTailoredReview(page: Page, origin: string, domain: string) {
  await page.goto(origin + "/tailored-review");
  await page.getByLabel("Review domain").selectOption(domain);
  const reply = page.waitForResponse(
    (response) =>
      response.url().endsWith("/tailored-review") &&
      response.request().method() === "POST",
  );
  await page.locator('form[action="/tailored-review"] button').click();
  return (await reply).status();
}

test("[F-BUILD-09-C] no tier can be bought, and capacity and scope are stated as they are", async ({
  browser,
}, info) => {
  test.setTimeout(60_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    const member = await f.member();
    const reference = await memberReference(member, f.origin);

    await requiredCheck(1, async () => {
      // The former tiers are listed only as unavailable history.
      await member.goto(f.origin + "/readiness/offers");
      await expect(member.locator("main")).toContainText(
        "cannot be bought on this page",
      );
      await member
        .getByText("View historical coaching plans (unavailable)")
        .click();
      await expect(member.locator("details")).toContainText(
        "These historical prices and allowances are hypotheses, not available offers.",
      );
      await expect(member.locator("details li")).toHaveCount(
        COACHING_OFFERS.length,
      );
      await expect(
        member.locator('main form[method="post"], main button'),
      ).toHaveCount(0);
      // Sending a purchase anyway reaches nothing: with the member's own
      // valid form token the request passes the form check and finds no
      // purchase route at all.
      const csrf = await member
        .goto(f.origin + "/account/billing")
        .then(() => formToken(member));
      for (const offer of COACHING_OFFERS) {
        const sent = await postForm(member, f.origin, "/readiness/offers", {
          csrf,
          offer: offer.id,
        });
        expect(sent.status()).toBe(404);
      }
      // Capacity is stated as it is: none is verified and nothing is bookable.
      await member.goto(f.origin + "/readiness/tracks");
      await expect(
        member
          .getByRole("listitem")
          .filter({ hasText: "Education · coaching" }),
      ).toContainText("Deliverable service capacity not verified");
      await noWayToBuy(member);
      await member.goto(f.origin + "/availability");
      await expect(member.locator("main")).toContainText(
        "Real expert capacity, paid access, provider notification, calendar/email delivery, cancellation and service fulfillment are unavailable.",
      );
      await noWayToBuy(member);
      await nothingSold(f, reference);
    });

    await requiredCheck(2, async () => {
      // No administrator has agreed a scope: the student's pages say so.
      await member.goto(f.origin + "/account/coaching");
      // #844 STUDENT-01: with no terms there is no terms card at all.
      await expect(termsSection(member)).toHaveCount(0);
      await member.goto(f.origin + "/account/purchases");
      await expect(offeredPlan(member)).toHaveCount(0);
      await noWayToBuy(member);
      // The student can't set terms for themselves.
      const csrf = await member
        .goto(f.origin + "/account/billing")
        .then(() => formToken(member));
      const own = await member.request.post(
        `${f.origin}/operator/coaching/${reference}/terms`,
        {
          headers: { Origin: f.origin },
          form: {
            csrf,
            operationId: newOperation(),
            revision: "0",
            price: "1.00",
            startsOn: await torontoDay(f.pool, 0),
            endsOn: await torontoDay(f.pool, 29),
            renewsOn: await torontoDay(f.pool, 30),
            reviewMinutes: "600",
            coachingSessions: "12",
            aiRequests: "1000",
          },
          maxRedirects: 0,
        },
      );
      expect(own.status()).toBe(403);
      await nothingSold(f, reference);
      await member.goto(f.origin + "/account/coaching");
      await expect(termsSection(member)).toHaveCount(0);
    });
  } finally {
    await f.close();
  }
});

test("[F-ROADMAP-08-C] uncovered tailored service can't be accepted or charged, and no qualified tailored service is offered", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    const member = await f.member("technical", "build");
    const reference = await memberReference(member, f.origin);
    await member.goto(f.origin + "/tailored-review");
    const domains = await member
      .getByLabel("Review domain")
      .locator("option")
      .evaluateAll((options) =>
        options.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
      );
    expect(domains.length).toBeGreaterThan(1);

    await requiredCheck(1, async () => {
      expect(await checkTailoredReview(member, f.origin, domains[0]!)).toBe(
        409,
      );
      await expect(
        member.getByRole("heading", { name: "Tailored review is unavailable" }),
      ).toBeVisible();
      await expect(member.locator("main")).toContainText(
        "No request was accepted or saved, no reviewer was reserved, and no payment or paid access was granted.",
      );
      await noWayToBuy(member);
      await nothingSold(f, reference);
    });

    await requiredCheck(2, async () => {
      // Every domain the page lists gets the same truthful answer.
      for (const domain of domains) {
        expect(await checkTailoredReview(member, f.origin, domain)).toBe(409);
        await expect(member.locator("main")).toContainText(
          "Qualified reviewer coverage not verified",
        );
        await expect(member.locator("main")).toContainText(
          "Requests are not open",
        );
        await noWayToBuy(member);
      }
      // No specialty is shown as available or bookable.
      await member.goto(f.origin + "/readiness/tracks");
      const reviews = member
        .getByRole("listitem")
        .filter({ hasText: "formal review" });
      expect(await reviews.count()).toBeGreaterThan(0);
      for (const row of await reviews.all())
        await expect(row).toContainText(
          "Qualified reviewer coverage not verified",
        );
      await noWayToBuy(member);
      await nothingSold(f, reference);
      // The common foundation stays open.
      await member
        .goto(f.origin + "/tailored-review")
        .then(() => checkTailoredReview(member, f.origin, domains[0]!));
      await member
        .getByRole("link", { name: "Return to your learning path" })
        .click();
      await expect(member).toHaveURL(f.origin + "/learn");
      expect((await member.goto(f.origin + "/lesson"))!.status()).toBe(200);
    });
  } finally {
    await f.close();
  }
});

test("[F-ECO-07-B] an administrator sets the member's terms version; the member has no acceptance step and only that version's dated allowances issue", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    const admin = (await f.staff("platform_admin")).page;
    const member = await f.member("professional", "work");
    const reference = await memberReference(member, f.origin);
    const terms: TermsForm = {
      price: "950.00",
      startsOn: await torontoDay(f.pool, 0),
      endsOn: await torontoDay(f.pool, 29),
      renewsOn: await torontoDay(f.pool, 30),
      reviewMinutes: 60,
      coachingSessions: 3,
      aiRequests: 40,
    };
    const background = async () =>
      (
        await f.pool.query<{ background: string }>(
          "SELECT background FROM learners WHERE id=$1",
          [reference],
        )
      ).rows[0]!.background;

    await requiredCheck(1, async () => {
      await nothingSold(f, reference);
      const sent = await saveTerms(admin, f.origin, reference, terms);
      expect(await storedTerms(f.pool, reference)).toEqual([
        expect.objectContaining({
          version: 1,
          priceCents: 95000,
          startsOn: terms.startsOn,
          endsOn: terms.endsOn,
          renewsOn: terms.renewsOn,
          reviewMinutes: 60,
          coachingSessions: 3,
          aiRequests: 40,
        }),
      ]);
      await expect(termsSection(admin)).toContainText(
        "Current terms, version 1:",
      );
      // The member reads the same terms and has nothing to accept.
      await member.goto(f.origin + "/account/coaching");
      await expect(termsSection(member)).toContainText(
        "Your administrator set these terms.",
      );
      await expect(shown(member, "coaching-terms", "Price")).toHaveText(
        "CAD 950.00",
      );
      await expect(termsSection(member).locator("form")).toHaveCount(0);
      await expect(
        member
          .locator("main")
          .getByRole("button", { name: /accept|agree|confirm/i }),
      ).toHaveCount(0);
      // The member can't save or replace a version themselves.
      const csrf = await formToken(member);
      expect(
        (
          await postForm(
            member,
            f.origin,
            `/operator/coaching/${reference}/terms`,
            { ...sent, csrf, operationId: newOperation(), revision: "1" },
          )
        ).status(),
      ).toBe(403);
      expect(await storedTerms(f.pool, reference)).toHaveLength(1);
    });

    await requiredCheck(2, async () => {
      expect(await storedGrants(f.pool, reference)).toEqual([
        {
          version: 1,
          category: "review_minutes",
          quantity: 60,
          available: 60,
          startsOn: terms.startsOn,
          endsOn: terms.endsOn,
          usable: true,
        },
        {
          version: 1,
          category: "study_requests",
          quantity: 40,
          available: 40,
          startsOn: terms.startsOn,
          endsOn: terms.endsOn,
          usable: true,
        },
      ]);
      await member.goto(f.origin + "/account/coaching");
      await expect(
        shown(member, "coaching-allowances", "Expert review time"),
      ).toHaveText("60 of 60 minutes left, 0 held, 0 used");
      await expect(
        shown(member, "coaching-allowances", "AI requests"),
      ).toHaveText("40 of 40 left, 0 held, 0 used");
      // The member's professional background is not an upgrade: changing
      // direction leaves the terms and the units exactly as they were.
      expect(await background()).toBe("professional");
      await member.goto(f.origin + "/learn");
      await openLearningProfile(member);
      await member.getByLabel("Your starting point").selectOption("technical");
      await saveLearningProfile(member);
      // The change of background really was saved before anything is compared.
      await expect.poll(background).toBe("technical");
      await member.goto(f.origin + "/readiness/offers");
      await expect(member.locator("main")).toContainText(
        "A professional background never assigns the Professional coaching package.",
      );
      expect(await storedTerms(f.pool, reference)).toHaveLength(1);
      expect(await storedGrants(f.pool, reference)).toHaveLength(2);
      expect(await storedInvoices(f.pool, reference)).toEqual([]);
      expect(await unitsShown(member, f.origin, "review_minutes")).toEqual({
        usable: "60",
        future: "0",
      });
      expect(await unitsShown(member, f.origin, "study_requests")).toEqual({
        usable: "40",
        future: "0",
      });
      // No other kind of unit appeared.
      expect(
        (
          await f.pool.query<{ category: string }>(
            "SELECT DISTINCT category FROM synthetic_entitlement_grants WHERE member_id=$1 ORDER BY 1",
            [reference],
          )
        ).rows.map((row) => row.category),
      ).toEqual(["review_minutes", "study_requests"]);
    });
  } finally {
    await f.close();
  }
});
