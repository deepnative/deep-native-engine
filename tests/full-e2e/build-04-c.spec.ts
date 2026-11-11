import { expect, test } from "@playwright/test";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
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

// The "standard continuation" is the agreement the product actually arranges:
// a monthly course bundle an administrator prepares for one member. Its start
// date is its acceptance window. Sample invoices only; no provider, no money.
// Staff sign in here, so traces are off except in a full-release run, which
// needs one per execution: see ../support/staff-trace.ts.
test.use({ trace: staffTrace });

// Stands in for the acceptance window passing: the offered start moves two
// months back, so two monthly periods would already be due. Only this isolated
// fixture database is touched; the terms guard is restored in the transaction.
async function twoMonthsLater(pool: Pool, planId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE simple_invoice_plans DISABLE TRIGGER simple_invoice_terms_immutable",
    );
    await client.query(
      `UPDATE simple_invoice_plans SET terms=jsonb_set(terms,'{startsOn}',
         to_jsonb(to_char((terms->>'startsOn')::date-interval '2 months','YYYY-MM-DD')))
       WHERE id=$1`,
      [planId],
    );
    await client.query(
      "ALTER TABLE simple_invoice_plans ENABLE TRIGGER simple_invoice_terms_immutable",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function invoices(pool: Pool, ownerId: string) {
  return (
    await pool.query<{ plan_id: string; cycle: number }>(
      "SELECT plan_id,cycle FROM simple_invoices WHERE owner_id=$1 ORDER BY cycle",
      [ownerId],
    )
  ).rows;
}

test("[F-BUILD-04-C] a monthly offer accepted after its start date cannot activate or bill missed months; only a separately accepted replacement starts", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    await f.publishFixture();
    const admin = (await f.staff("platform_admin")).page;
    const member = await f.member();
    const reference = await memberReference(member, f.origin);
    await prepareBundle(f, admin, reference, {
      amounts: [["FND-001", "15.00"]],
      cadence: "monthly",
      tax: "0.00",
    });
    const [late] = await storedPlans(f, reference);
    await twoMonthsLater(f.pool, late!.id);
    const startedOn = (await storedPlans(f, reference))[0]!.terms.startsOn;

    await requiredCheck(1, async () => {
      // The member is told the offer closed and has nothing to accept.
      await member.goto(f.origin + "/account/purchases");
      const card = member.locator(`#plan-${late!.id}`);
      await expect(card).toContainText(`starts ${startedOn}`);
      await expect(card.getByRole("status")).toContainText(
        `Acceptance closed on ${startedOn}.`,
      );
      await expect(card.getByRole("status")).toContainText(
        "will not bill any past month",
      );
      await expect(offeredPlan(member)).toHaveCount(0);

      // A direct acceptance with this account's own form token is refused.
      await member.goto(f.origin + "/account/billing");
      const csrf = await member
        .locator('input[name="csrf"]')
        .first()
        .getAttribute("value");
      const refused = await member.request.post(
        `${f.origin}/account/purchases/plans/${late!.id}/accept`,
        {
          form: {
            csrf: csrf!,
            operationId: randomUUID(),
            revision: String(late!.revision),
            name: "Invented provisional student",
            email: "invented-provisional@example.invalid",
            confirm: "accept",
          },
          headers: { Origin: f.origin },
          maxRedirects: 0,
        },
      );
      expect(refused.status()).toBe(409);

      // The monthly run bills none of the missed months.
      await admin.goto(f.origin + "/operator/invoices");
      await admin
        .getByRole("button", { name: "Generate due recurring invoices" })
        .click();
      expect((await storedPlans(f, reference))[0]!.state).toBe("offered");
      expect(await invoices(f.pool, reference)).toEqual([]);
      await member.goto(f.origin + "/account/purchases");
      await expect(
        member.locator("h2", { hasText: "Your invoices" }).locator("+ ul li"),
      ).toHaveCount(0);
    });

    await requiredCheck(2, async () => {
      // The administrator prepares a new proposal; only that one can start,
      // and only once the member explicitly accepts it.
      await prepareBundle(f, admin, reference, {
        amounts: [["FND-001", "15.00"]],
        cadence: "monthly",
        tax: "0.00",
      });
      const replacement = (await storedPlans(f, reference)).find(
        (plan) => plan.id !== late!.id,
      )!;
      expect(replacement.state).toBe("offered");
      expect(await invoices(f.pool, reference)).toEqual([]);
      await member.goto(f.origin + "/account/purchases");
      await expect(offeredPlan(member)).toHaveCount(1);
      await expect(offeredPlan(member)).toHaveAttribute(
        "id",
        `plan-${replacement.id}`,
      );
      await acceptBundle(member, "monthly");
      await admin.goto(f.origin + "/operator/invoices");
      await admin
        .getByRole("button", { name: "Generate due recurring invoices" })
        .click();
      const plans = await storedPlans(f, reference);
      expect(plans.find((plan) => plan.id === late!.id)!.state).toBe("offered");
      expect(plans.find((plan) => plan.id === replacement.id)!.state).toBe(
        "active",
      );
      expect(await invoices(f.pool, reference)).toEqual([
        { plan_id: replacement.id, cycle: 0 },
      ]);
      await member.goto(f.origin + "/account/purchases");
      await expect(member.locator(`#plan-${late!.id}`)).toContainText(
        "Acceptance closed",
      );
      await expect(
        member.locator("h2", { hasText: "Your invoices" }).locator("+ ul li"),
      ).toHaveCount(1);
    });
  } finally {
    await f.close();
  }
});
