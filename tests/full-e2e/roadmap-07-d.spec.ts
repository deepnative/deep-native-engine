import { expect, test } from "@playwright/test";
import { GOALS, exercise } from "../../src/content.ts";
import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import {
  acceptBundle,
  memberReference,
  offeredPlan,
  prepareBundle,
  storedPlans,
} from "../support/course-bundle-journey.ts";
import { staffTrace } from "../support/staff-trace.ts";

// "Training" is the member's own completed starter exercise. The renewal is a
// second course bundle the administrator prepares after the first was
// accepted; the rate is the administrator-set monthly coaching rate; contract
// outcomes are the member's own private career-planning records. Sample
// invoices only; no provider, no money, no verified outcome.
test.use({ trace: staffTrace });

test("[F-ROADMAP-07-D] after training a goal change updates next actions, only an explicit acceptance renews, and no contract or rate increase appears", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    await f.publishFixture();
    const admin = (await f.staff("platform_admin")).page;
    const member = await f.member("explorer", "everyday");
    const reference = await memberReference(member, f.origin);
    const invoiceCount = async () =>
      (
        await f.pool.query("SELECT 1 FROM simple_invoices WHERE owner_id=$1", [
          reference,
        ])
      ).rowCount;

    // First phase: a one-time bundle the member explicitly accepted.
    await prepareBundle(f, admin, reference, {
      amounts: [["FND-001", "15.00"]],
      cadence: "one_time",
      tax: "0.00",
    });
    await member.goto(f.origin + "/account/purchases");
    await acceptBundle(member, "one_time");
    // The administrator's agreed coaching rate before any training.
    await admin.goto(`${f.origin}/operator/coaching/${reference}`);
    await admin.getByLabel("Hourly rate (CAD)").fill("85.00");
    await admin.getByRole("button", { name: "Save hourly rate" }).click();

    // Training: the member completes the starter exercise for their goal.
    await member.goto(f.origin + "/learn");
    await member.getByRole("link", { name: "Open lesson" }).click();
    await member
      .getByLabel("Your instruction to AI")
      .fill(
        "Using only the sample details, create a short plan with clear actions and flag any missing information.",
      );
    await member
      .getByLabel("How will you check the result?")
      .fill(
        "Compare every detail against the supplied sample, check the limits, and correct any unsupported claims.",
      );
    await member.getByLabel("I checked the context").check();
    await member.getByRole("button", { name: "Complete exercise" }).click();
    await expect(
      member.getByText("Exercise completed", { exact: true }),
    ).toBeVisible();

    await requiredCheck(1, async () => {
      const plan = member.getByRole("region", { name: "Your starter plan" });
      await member.goto(f.origin + "/learn");
      await expect(plan).toContainText(`Focus: ${exercise("everyday").title}`);
      await expect(plan).toContainText(
        "Starter exercise completed for your current goal",
      );

      await member.goto(f.origin + "/account");
      await chooseLearningGoal(member, "work");
      await member
        .getByRole("button", { name: "Save my profile", exact: true })
        .click();
      await expect(member).toHaveURL(f.origin + "/learn");
      await expect(member.locator(".dashboard-head .lead")).toHaveText(
        GOALS.work,
      );
      await expect(plan).toContainText(`Focus: ${exercise("work").title}`);
      // The next actions start again for the new goal: no completion is
      // carried over, and the earlier goal's exercise is no longer the focus.
      await expect(plan).not.toContainText(
        "Starter exercise completed for your current goal",
      );
      await expect(plan).toContainText("Read Give AI a clear starting point.");
      await expect(plan).not.toContainText(exercise("everyday").title);
      await member.getByRole("link", { name: "Open lesson" }).click();
      await expect(
        member.getByRole("heading", { name: exercise("work").title }),
      ).toBeVisible();
      // The earlier completion is kept in the member's own activity.
      await member.goto(f.origin + "/progress");
      await expect(member.locator("main")).toContainText(
        `Self-reported completeRecorded goal: ${GOALS.everyday}.`,
      );
    });

    await requiredCheck(2, async () => {
      // A renewal proposal changes nothing until the member accepts it: not
      // the goal change above, not the recurring run.
      await prepareBundle(f, admin, reference, {
        amounts: [["FND-002", "20.00"]],
        cadence: "one_time",
        tax: "0.00",
      });
      const [first, renewal] = await storedPlans(f, reference);
      expect(first!.state).toBe("active");
      expect(renewal!.state).toBe("offered");
      await member.goto(f.origin + "/account");
      await chooseLearningGoal(member, "build");
      await member
        .getByRole("button", { name: "Save my profile", exact: true })
        .click();
      await admin.goto(f.origin + "/operator/invoices");
      await admin
        .getByRole("button", { name: "Generate due recurring invoices" })
        .click();
      expect((await storedPlans(f, reference))[1]!.state).toBe("offered");
      expect(await invoiceCount()).toBe(1);
      await member.goto(f.origin + "/account/purchases");
      await expect(offeredPlan(member)).toHaveAttribute(
        "id",
        `plan-${renewal!.id}`,
      );
      await expect(offeredPlan(member)).toContainText("FND-002 version 2");

      await acceptBundle(member, "one_time");
      const plans = await storedPlans(f, reference);
      expect(plans.map((plan) => plan.state)).toEqual(["active", "active"]);
      expect(await invoiceCount()).toBe(2);
      // Accepting the renewal never rewrites the first agreement.
      expect(plans[0]!.terms).toEqual(first!.terms);
    });

    await requiredCheck(3, async () => {
      // The coaching rate is still the administrator's original version.
      await member.goto(f.origin + "/account/coaching");
      await expect(member.locator("body")).toContainText(
        "Applicable rate: CAD 85.00 per hour · version 1",
      );
      expect(
        (
          await f.pool.query(
            "SELECT cents,version FROM coaching_rates WHERE owner_id=$1",
            [reference],
          )
        ).rows,
      ).toEqual([{ cents: 8500, version: 1 }]);
      // Training created no contract or outcome record: career planning is
      // still off, and the member is told contracts aren't needed to learn.
      await member.goto(f.origin + "/career");
      await expect(member.locator("main")).toContainText(
        "Career, opportunity and contract records are off.",
      );
      await expect(member.locator("main")).toContainText(
        "Ordinary learning and projects do not need a client, contract or job title.",
      );
      expect(
        (
          await f.pool.query(
            "SELECT 1 FROM career_entries WHERE member_id=$1",
            [reference],
          )
        ).rowCount,
      ).toBe(0);
      await member.goto(f.origin + "/progress");
      await expect(member.locator("main")).not.toContainText(
        /verified contract|rate increase|certified/i,
      );
    });
  } finally {
    await f.close();
  }
});
