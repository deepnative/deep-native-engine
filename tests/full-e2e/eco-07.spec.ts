import { expect, test, type Page } from "@playwright/test";
import type { Pool } from "pg";
import { COACHING_OFFERS } from "../../src/offers.ts";
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

// Optional services here are what the product actually arranges: course-billing
// agreements an administrator prepares and monthly coaching hours at a rate the
// administrator sets. Sample invoices only; no provider, no money. The historical
// coaching plans stay hypotheses and cannot be bought.
// Staff sign in here, so traces are off except in a full-release run, which
// needs one per execution: see ../support/staff-trace.ts.
test.use({ trace: staffTrace });
// Hosted pages say "Not available"; this local listener names the state.
const unavailable = /Not available|· hypothesis$/;

async function exportedRecords(member: Page, origin: string) {
  const records: Record<string, Record<string, unknown>[]> = {};
  let url = origin + "/api/member/export";
  for (;;) {
    const response = await member.request.get(url);
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      version: string;
      records: Record<string, Record<string, unknown>[]>;
      page: { nextCursor: string | null };
    };
    expect(body.version).toBe("local-member-records-v51");
    for (const [name, rows] of Object.entries(body.records))
      records[name] = [...(records[name] ?? []), ...rows];
    if (!body.page.nextCursor) return records;
    url = `${origin}/api/member/export?cursor=${encodeURIComponent(body.page.nextCursor)}`;
  }
}

// Stands in for a month passing: the agreement's first period moves one month
// back, so its next monthly period is due today. Only this isolated fixture
// database is touched, and the terms guard is restored in the same transaction.
async function oneMonthLater(pool: Pool, planIds: string[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE simple_invoice_plans DISABLE TRIGGER simple_invoice_terms_immutable",
    );
    await client.query(
      `UPDATE simple_invoice_plans SET terms=jsonb_set(terms,'{startsOn}',
         to_jsonb(to_char((terms->>'startsOn')::date-interval '1 month','YYYY-MM-DD')))
       WHERE id=ANY($1::uuid[])`,
      [planIds],
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

async function invoiceCycles(pool: Pool, ownerId: string) {
  return (
    await pool.query<{ cycle: number }>(
      "SELECT cycle FROM simple_invoices WHERE owner_id=$1 ORDER BY cycle",
      [ownerId],
    )
  ).rows.map((row) => row.cycle);
}

test("[F-ECO-07-A] optional coaching shows only the administrator's actual terms, apart from foundation access, with capacity disclosed", async ({
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

    await requiredCheck(1, async () => {
      await member.goto(f.origin + "/readiness/offers");
      await expect(
        member.getByRole("heading", { name: "No-charge foundation access" }),
      ).toBeVisible();
      await expect(member.locator("body")).toContainText(
        "CAD 0.00 for initial foundation access",
      );
      await expect(
        member.getByRole("heading", {
          name: "Optional courses and monthly coaching",
        }),
      ).toBeVisible();
      await expect(member.locator("body")).toContainText(
        "cannot be bought on this page",
      );
      // The historical plans are labelled unavailable, and nothing here can
      // accept or buy one.
      await member
        .getByText("View historical coaching plans (unavailable)")
        .click();
      const historical = member.locator("details li");
      await expect(historical).toHaveCount(COACHING_OFFERS.length);
      for (const item of await historical.all())
        await expect(item).toContainText(unavailable);
      await expect(
        member.locator('main form[method="post"], main button'),
      ).toHaveCount(0);

      // Monthly coaching has no price until the administrator records one.
      await member.goto(f.origin + "/account/coaching");
      await expect(member.locator("body")).toContainText(
        "No rate is set for this month",
      );
      await admin.goto(`${f.origin}/operator/coaching/${reference}`);
      await admin.getByLabel("Hourly rate (CAD)").fill("85.00");
      await admin.getByRole("button", { name: "Save hourly rate" }).click();
      await member.reload();
      await expect(member.locator("body")).toContainText(
        "Applicable rate: CAD 85.00 per hour · version 1",
      );

      // A prepared course bundle shows exactly its own prices, never the
      // historical plan prices.
      await prepareBundle(f, admin, reference, {
        amounts: [["FND-001", "25.00"]],
        cadence: "one_time",
        tax: "0.00",
      });
      await member.goto(f.origin + "/account/purchases");
      const plan = offeredPlan(member);
      await expect(plan.locator("ul > li")).toHaveCount(1);
      await expect(plan).toContainText("FND-001 version 2 · CAD 25.00");
      for (const offer of COACHING_OFFERS)
        await expect(member.locator("main")).not.toContainText(
          `CAD ${(offer.priceCents / 100).toLocaleString("en-CA")}`,
        );
    });

    await requiredCheck(2, async () => {
      // No coach is registered in this fixture, so coaching capacity is shown
      // as unverified and nothing can be booked.
      await member.goto(f.origin + "/readiness/tracks");
      const coaching = member
        .getByRole("listitem")
        .filter({ hasText: "Education · coaching" });
      await expect(coaching).toContainText(
        "Deliverable service capacity not verified",
      );
      await expect(
        member.getByRole("button", { name: /book|buy|purchase/i }),
      ).toHaveCount(0);
      await member.goto(f.origin + "/availability");
      await expect(member.locator("body")).toContainText(
        "Real expert capacity, paid access, provider notification, calendar/email delivery, cancellation and service fulfillment are unavailable.",
      );
      await expect(
        member.getByText("No sample windows can be shown right now."),
      ).toBeVisible();
    });
  } finally {
    await f.close();
  }
});

test("[F-ECO-07-C] cancelling a monthly bundle stops future invoices, the agreement exports, and a background change grants nothing", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    await f.publishFixture();
    const admin = (await f.staff("platform_admin")).page;
    const member = await f.member();
    const other = await f.member();
    const reference = await memberReference(member, f.origin);
    const otherReference = await memberReference(other, f.origin);
    for (const [page, ref] of [
      [member, reference],
      [other, otherReference],
    ] as const) {
      await prepareBundle(f, admin, ref, {
        amounts: [["FND-001", "15.00"]],
        cadence: "monthly",
        tax: "0.00",
      });
      await page.goto(f.origin + "/account/purchases");
      await acceptBundle(page, "monthly");
    }
    const [plan] = await storedPlans(f, reference);
    const [otherPlan] = await storedPlans(f, otherReference);
    const firstInvoice = (
      await f.pool.query<{ id: string }>(
        "SELECT id FROM simple_invoices WHERE plan_id=$1 AND cycle=0",
        [plan!.id],
      )
    ).rows[0]!.id;

    await requiredCheck(1, async () => {
      // There are no cancellation or refund rules; the student is pointed to
      // the service contact (owner decision, 10 Nov 2026).
      await member.goto(f.origin + "/account/coaching");
      const terms = member.locator('section[aria-labelledby="coaching-terms"]');
      await expect(
        terms.getByRole("heading", { name: "Your coaching terms" }),
      ).toBeVisible();
      await expect(terms).toContainText(
        "There are no cancellation or refund rules.",
      );
      await expect(
        terms.getByRole("link", { name: "info@deepnative.io" }),
      ).toHaveAttribute("href", "mailto:info@deepnative.io");

      await member.goto(f.origin + "/account/purchases");
      const card = member.locator(`#plan-${plan!.id}`);
      await expect(card).toContainText("Monthly invoices until cancelled");
      const right = card.getByRole("checkbox", {
        name: "Stop future invoices; retain already issued invoices.",
      });
      await right.check();
      await card.getByRole("button", { name: "Cancel future billing" }).click();
      expect((await storedPlans(f, reference))[0]!.state).toBe("cancelled");
      await member.goto(f.origin + "/account/purchases");
      await expect(member.locator(`#plan-${plan!.id}`)).toContainText(
        "cancelled",
      );
      await expect(
        member
          .locator(`#plan-${plan!.id}`)
          .getByRole("button", { name: "Cancel future billing" }),
      ).toHaveCount(0);

      // A month later both agreements have a period due; only the member who
      // did not cancel is invoiced.
      await oneMonthLater(f.pool, [plan!.id, otherPlan!.id]);
      await admin.goto(f.origin + "/operator/invoices");
      await admin
        .getByRole("button", { name: "Generate due recurring invoices" })
        .click();
      expect(await invoiceCycles(f.pool, reference)).toEqual([0]);
      expect(await invoiceCycles(f.pool, otherReference)).toEqual([0, 1]);
      // The already issued invoice is retained and still opens.
      await member.goto(
        `${f.origin}/account/purchases/invoices/${firstInvoice}`,
      );
      await expect(
        member.getByRole("heading", { name: "Invoice", exact: true }),
      ).toBeVisible();
      await expect(member.locator("body")).toContainText("CAD 15.00");
    });

    await requiredCheck(2, async () => {
      const records = await exportedRecords(member, f.origin);
      expect(records.invoicePlans).toHaveLength(1);
      const exported = records.invoicePlans![0]!;
      const stored = (await storedPlans(f, reference))[0]!;
      expect(exported).toMatchObject({
        id: stored.id,
        terms: stored.terms,
        state: "cancelled",
        revision: stored.revision,
        recipientName: "Invented provisional student",
        recipientEmail: "invented-provisional@example.invalid",
      });
      expect(exported.acceptedAt).toEqual(expect.any(String));
      expect(Object.keys(exported)).not.toContain("createdBy");
      expect(records.invoices!.map((row) => row.id)).toEqual([firstInvoice]);
      // The other member's agreement is not in this export, and vice versa.
      expect(JSON.stringify(records)).not.toContain(otherPlan!.id);
      const theirs = await exportedRecords(other, f.origin);
      expect(theirs.invoicePlans!.map((row) => row.id)).toEqual([
        otherPlan!.id,
      ]);
      expect(JSON.stringify(theirs)).not.toContain(plan!.id);
    });

    await requiredCheck(3, async () => {
      const before = {
        plans: await storedPlans(f, reference),
        invoices: await invoiceCycles(f.pool, reference),
      };
      await member.goto(f.origin + "/account");
      await member.getByLabel("Your starting point").selectOption("technical");
      await member.getByRole("button", { name: "Save my profile" }).click();
      // Wait for the save itself before comparing anything.
      await expect
        .poll(
          async () =>
            (
              await f.pool.query<{ background: string }>(
                "SELECT background FROM learners WHERE id=$1",
                [reference],
              )
            ).rows[0]!.background,
        )
        .toBe("technical");
      // No agreement, invoice or service allowance appears.
      expect(await storedPlans(f, reference)).toEqual(before.plans);
      expect(await invoiceCycles(f.pool, reference)).toEqual(before.invoices);
      expect(
        (
          await f.pool.query(
            "SELECT 1 FROM synthetic_entitlement_grants WHERE member_id=$1",
            [reference],
          )
        ).rowCount,
      ).toBe(0);
      await member.goto(f.origin + "/account/purchases");
      await expect(offeredPlan(member)).toHaveCount(0);
      await member.goto(f.origin + "/readiness/offers");
      await member
        .getByText("View historical coaching plans (unavailable)")
        .click();
      for (const item of await member.locator("details li").all())
        await expect(item).toContainText(unavailable);
    });
  } finally {
    await f.close();
  }
});
