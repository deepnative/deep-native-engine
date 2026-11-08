import { expect, type Page } from "@playwright/test";
import type { reviewedContentFixture } from "./reviewed-content-browser.ts";

type Fixture = Awaited<ReturnType<typeof reviewedContentFixture>>;
export type Cadence = "one_time" | "monthly";

export async function memberReference(member: Page, origin: string) {
  await member.goto(origin + "/account");
  const reference = await member.locator("code").first().textContent();
  if (!reference) throw Error("Student reference missing");
  return reference;
}

export async function utcToday(f: Fixture) {
  return (
    await f.pool.query<{ day: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
    )
  ).rows[0]!.day;
}

// An administrator prepares a course-billing proposal for one learner on the
// billing page, from published lesson versions only.
export async function prepareBundle(
  f: Fixture,
  admin: Page,
  reference: string,
  terms: {
    amounts: readonly (readonly [string, string])[];
    cadence: Cadence;
    tax: string;
  },
) {
  await admin.goto(f.origin + "/operator/invoices");
  await admin.getByLabel("Learner", { exact: true }).selectOption(reference);
  for (const [id, amount] of terms.amounts) {
    await admin.locator(`input[name="courses"][value='["${id}",2]']`).check();
    await admin.locator(`input[name="amount_${id}_2"]`).fill(amount);
  }
  await admin
    .getByLabel("Billing", { exact: true })
    .selectOption(terms.cadence);
  await admin.getByLabel("Starts on (UTC date)").fill(await utcToday(f));
  await admin
    .getByLabel("Configured tax amount per invoice (CAD)")
    .fill(terms.tax);
  await admin
    .getByRole("button", { name: "Prepare course billing proposal" })
    .click();
  await expect(admin.locator("body")).not.toContainText("could not");
}

export function offeredPlan(member: Page) {
  return member
    .locator('article[id^="plan-"]')
    .filter({ has: member.getByRole("button", { name: /Accept courses/ }) });
}

export async function acceptBundle(member: Page, cadence: Cadence) {
  const plan = offeredPlan(member);
  await expect(plan).toHaveCount(1);
  await plan
    .getByLabel("Invoice recipient name")
    .fill("Invented provisional student");
  await plan
    .getByLabel("Invoice email")
    .fill("invented-provisional@example.invalid");
  await plan
    .getByRole("checkbox", {
      name:
        cadence === "monthly"
          ? /I accept these exact courses and monthly recurring/
          : /I accept these exact courses and one-time/,
    })
    .check();
  await plan
    .getByRole("button", { name: "Accept courses and create invoice" })
    .click();
  await expect(
    member.getByRole("heading", { name: "Invoice", exact: true }),
  ).toBeVisible();
  return member.url().split("/").at(-1)!;
}

export async function storedPlans(f: Fixture, ownerId: string) {
  return (
    await f.pool.query<{
      id: string;
      terms: {
        courses: { id: string; version: number; amountCents: number }[];
        cadence: Cadence;
        startsOn: string;
        taxCents: number;
        issuer: string;
        instructions: string;
        sample: boolean;
      };
      state: string;
      revision: number;
    }>(
      "SELECT id,terms,state,revision FROM simple_invoice_plans WHERE owner_id=$1 ORDER BY created_at",
      [ownerId],
    )
  ).rows;
}
