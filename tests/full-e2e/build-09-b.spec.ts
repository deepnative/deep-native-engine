import { expect, test } from "@playwright/test";
import { COACHING_OFFERS } from "../../src/offers.ts";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import {
  memberReference,
  offeredPlan,
  prepareBundle,
  storedPlans,
} from "../support/course-bundle-journey.ts";
import { staffTrace } from "../support/staff-trace.ts";

// What a member can buy here is a course bundle an administrator prepared from
// published lessons; the historical higher-tier coaching plans are unpublished
// hypotheses with no purchase path at all. This case tries both: the
// higher-tier plans offer nothing to accept, and a prepared offer whose course
// is retired before acceptance is refused. Sample invoices only; no money.
// Staff sign in here, so traces are off except in a full-release run, which
// needs one per execution: see ../support/staff-trace.ts.
test.use({ trace: staffTrace });

test("[F-BUILD-09-B] an unpublished offer cannot be bought: higher tiers have no purchase path and a retired course's offer is refused", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    const { editor } = await f.publishFixture();
    const member = await f.member();
    const admin = (await f.staff("platform_admin")).page;
    const reference = await memberReference(member, f.origin);

    await requiredCheck(1, async () => {
      // The higher tiers are listed only as unavailable history.
      await member.goto(f.origin + "/readiness/offers");
      await member
        .getByText("View historical coaching plans (unavailable)")
        .click();
      const historical = member.locator("details li");
      await expect(historical).toHaveCount(COACHING_OFFERS.length);
      await expect(
        member.locator('main form[method="post"], main button'),
      ).toHaveCount(0);

      // A course bundle is prepared, then one of its courses is retired.
      await prepareBundle(f, admin, reference, {
        amounts: [
          ["FND-001", "20.00"],
          ["FND-003", "30.00"],
        ],
        cadence: "one_time",
        tax: "0.00",
      });
      await member.goto(f.origin + "/account/purchases");
      const plan = offeredPlan(member);
      await expect(plan).toHaveCount(1);
      // The member fills in the form while it is still open.
      await plan
        .getByLabel("Invoice recipient name")
        .fill("Invented provisional student");
      await plan
        .getByLabel("Invoice email")
        .fill("invented-provisional@example.invalid");
      await plan
        .getByRole("checkbox", { name: /I accept these exact courses/ })
        .check();

      await editor.page.goto(f.origin + "/editor/library/FND-003/2");
      await editor.page
        .getByRole("button", { name: "Retire published versions" })
        .click();
      await expect(editor.page).toHaveURL(f.origin + "/editor/library");

      // Submitting the form opened before retirement is refused.
      await plan
        .getByRole("button", { name: "Accept courses and create invoice" })
        .click();
      await expect(
        member.getByRole("heading", { name: "Invoice request not confirmed" }),
      ).toBeVisible();
      const [stored] = await storedPlans(f, reference);
      expect(stored!.state).toBe("offered");
      expect(
        (
          await f.pool.query(
            "SELECT 1 FROM simple_invoices WHERE owner_id=$1",
            [reference],
          )
        ).rowCount,
      ).toBe(0);

      // Reopened, the offer says why it can't be accepted and offers no form.
      await member.goto(f.origin + "/account/purchases");
      const article = member.locator(`#plan-${stored!.id}`);
      await expect(article).toContainText(
        "This proposal can no longer be accepted: FND-003 is not currently offered.",
      );
      await expect(
        article.getByRole("button", { name: /Accept courses/ }),
      ).toHaveCount(0);
      await expect(member.locator("body")).toContainText("No invoices yet.");
    });
  } finally {
    await f.close();
  }
});
