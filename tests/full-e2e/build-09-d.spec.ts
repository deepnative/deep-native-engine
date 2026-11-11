import { expect, test } from "@playwright/test";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import {
  acceptBundle,
  memberReference,
  offeredPlan,
  prepareBundle,
  storedPlans,
  utcToday,
} from "../support/course-bundle-journey.ts";
import { staffTrace } from "../support/staff-trace.ts";

// The approved versioned offer is a course-billing proposal an administrator
// prepares from published lesson versions. Sample invoices only: no provider,
// no money. A course bundle carries prices and terms but no quota, so the
// quota part of this case is limited to the course list and cadence.
test.use({ trace: staffTrace });

test("[F-BUILD-09-D] an accepted course bundle's displayed price and terms equal the stored agreement and do not drift", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    await f.publishFixture();
    const member = await f.member();
    const admin = (await f.staff("platform_admin")).page;
    const reference = await memberReference(member, f.origin);
    await prepareBundle(f, admin, reference, {
      amounts: [
        ["FND-001", "12.50"],
        ["FND-002", "40.00"],
      ],
      cadence: "one_time",
      tax: "1.75",
    });
    const today = await utcToday(f);
    let accepted: Awaited<ReturnType<typeof storedPlans>>[number];

    await requiredCheck(1, async () => {
      await member.goto(f.origin + "/account/purchases");
      const plan = offeredPlan(member);
      const lines = plan.locator("ul > li");
      await expect(lines).toHaveCount(2);
      await expect(lines.nth(0)).toContainText("FND-001 version 2 · CAD 12.50");
      await expect(lines.nth(1)).toContainText("FND-002 version 2 · CAD 40.00");
      await expect(plan).toContainText(
        `One-time invoice · starts ${today} · tax CAD 1.75`,
      );
      await expect(plan).toContainText("Total: CAD 54.25");
      const issuer = (await plan
        .locator("p", { hasText: "Invoice issuer:" })
        .textContent())!
        .replace("Invoice issuer:", "")
        .trim();
      const instructions = (await plan
        .locator(".invoice-instructions")
        .textContent())!.trim();
      const [offered] = await storedPlans(f, reference);
      expect(offered!.state).toBe("offered");

      const invoiceId = await acceptBundle(member, "one_time");
      const [stored] = await storedPlans(f, reference);
      accepted = stored!;
      expect(accepted.id).toBe(offered!.id);
      expect(accepted.state).toBe("active");
      // The stored agreement is exactly what the member was shown.
      expect(
        accepted.terms.courses.map(({ id, version, amountCents }) => ({
          id,
          version,
          amountCents,
        })),
      ).toEqual([
        { id: "FND-001", version: 2, amountCents: 1250 },
        { id: "FND-002", version: 2, amountCents: 4000 },
      ]);
      expect(accepted.terms).toMatchObject({
        cadence: "one_time",
        startsOn: today,
        taxCents: 175,
        issuer,
        instructions,
      });
      expect(accepted.terms).toEqual(offered!.terms);
      const invoice = (
        await f.pool.query<{ total: string; plan: string }>(
          "SELECT total_cents::text AS total,plan_id AS plan FROM simple_invoices WHERE id=$1",
          [invoiceId],
        )
      ).rows[0]!;
      expect(invoice).toEqual({ total: "5425", plan: accepted.id });
    });

    await requiredCheck(2, async () => {
      // A later, different proposal for the same courses is a separate offer.
      await prepareBundle(f, admin, reference, {
        amounts: [["FND-001", "99.00"]],
        cadence: "one_time",
        tax: "0.00",
      });
      const plans = await storedPlans(f, reference);
      expect(plans).toHaveLength(2);
      expect(plans[0]).toEqual(accepted);
      expect(plans[1]!.state).toBe("offered");
      // The database refuses to rewrite accepted terms.
      await expect(
        f.pool.query(
          "UPDATE simple_invoice_plans SET terms=jsonb_set(terms,'{taxCents}','0') WHERE id=$1",
          [accepted.id],
        ),
      ).rejects.toThrow("Course billing terms are immutable");
      expect((await storedPlans(f, reference))[0]).toEqual(accepted);

      // The member still sees the accepted terms, not the newer proposal's.
      await member.goto(f.origin + "/account/purchases");
      const kept = member.locator(`#plan-${accepted.id}`);
      await expect(kept).toContainText("FND-001 version 2 · CAD 12.50");
      await expect(kept).toContainText("FND-002 version 2 · CAD 40.00");
      await expect(kept).toContainText("Total: CAD 54.25");
      await expect(kept).not.toContainText("99.00");
      await expect(
        member.getByRole("listitem").filter({ hasText: "CAD 54.25" }),
      ).toHaveCount(1);
    });
  } finally {
    await f.close();
  }
});
