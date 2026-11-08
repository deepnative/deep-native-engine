import { expect, test, type Page } from "@playwright/test";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import { memberReference } from "../support/course-bundle-journey.ts";
import {
  grantBalance,
  grantCoachMinutes,
} from "../support/sample-slot-journey.ts";

// The "group clinic" is the product's private practice event: an administrator
// schedules an invented rehearsal, the member registers and permits attendance,
// and the administrator records an actual observation during the real database
// window. It is not a staffed clinic. Coach minutes are seeded test units.
test.use({ trace: "off" });

async function coachMinutes(member: Page, origin: string) {
  const response = await member.request.get(
    origin + "/member/test-units/download",
  );
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    categories: { category: string; [field: string]: unknown }[];
  };
  const row = body.categories.find((item) => item.category === "coach_minutes");
  expect(row).toBeDefined();
  const { granted, usable, held, consumed, expired, adjusted } = row!;
  return { granted, usable, held, consumed, expired, adjusted };
}

test("[F-ROADMAP-07-B] attending one available group practice event creates no private coaching minutes", async ({
  browser,
}, info) => {
  // The real scheduler requires at least two minutes of lead time, and the
  // observation is admitted only once the database clock reaches the window.
  test.setTimeout(240_000);
  const f = await reviewedContentFixture(browser, info, {
    events: true,
    sampleInvoices: true,
  });
  try {
    const staff = (await f.staff("platform_admin")).page;
    const member = await f.member("technical", "build");
    const memberId = await memberReference(member, f.origin);
    const grant = await grantCoachMinutes(f.pool, memberId);
    const before = await coachMinutes(member, f.origin);
    expect(before).toMatchObject({ granted: 60, usable: 60, consumed: 0 });
    const balance = await grantBalance(f.pool, grant);

    await staff.goto(f.origin + "/staff");
    await staff
      .getByRole("link", { name: "Private rehearsal attendance", exact: true })
      .click();
    const administrator = await staff.locator("code").innerText();
    const now = (
      await f.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now;
    const startsAt = new Date(+now + 150_000).toISOString();
    await staff.goto(f.origin + "/staff");
    await staff
      .getByRole("link", { name: "Schedule a private rehearsal", exact: true })
      .click();
    const scheduling = staff.locator(
      'form[action="/operator/event-rehearsals/check"]',
    );
    await scheduling.getByLabel("Start in UTC", { exact: true }).fill(startsAt);
    await scheduling
      .getByRole("button", { name: "Check proposed schedule", exact: true })
      .click();
    await staff
      .getByLabel(
        "I deliberately confirm this exact invented rehearsal schedule.",
        { exact: true },
      )
      .check();
    await staff
      .getByRole("button", { name: "Schedule private rehearsal", exact: true })
      .click();
    const detail = await staff
      .getByRole("link", {
        name: "Open member event detail with your learner access",
        exact: true,
      })
      .getAttribute("href");
    if (!detail) throw Error("Missing scheduled event link");

    await member.goto(f.origin + detail);
    await member
      .getByRole("link", {
        name: "Try local registration rehearsal",
        exact: true,
      })
      .click();
    await member
      .getByLabel(
        "I want to save an invented-data registration; this is not a real appointment.",
        { exact: true },
      )
      .check();
    await member
      .getByRole("button", { name: "Enroll in local rehearsal", exact: true })
      .click();
    await member
      .getByRole("link", { name: "My private attendance receipt", exact: true })
      .click();
    const receipt = member.url();
    await member
      .getByLabel("Selected administrator reference", { exact: true })
      .fill(administrator);
    await member
      .getByRole("button", {
        name: "Check attendance permission",
        exact: true,
      })
      .click();
    await member
      .getByLabel(
        "Permit only this selected administrator to record a present observation for this exact registration during this window.",
        { exact: true },
      )
      .check();
    await member
      .getByRole("button", {
        name: "Save this attendance permission",
        exact: true,
      })
      .click();
    await member
      .getByRole("link", { name: "Open my attendance receipt", exact: true })
      .click();
    const permission = await member.locator("code").innerText();
    await expect
      .poll(
        async () =>
          +(
            await f.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")
          ).rows[0]!.now,
        { timeout: 170_000, intervals: [500] },
      )
      .toBeGreaterThanOrEqual(Date.parse(startsAt));

    await requiredCheck(1, async () => {
      await staff.goto(f.origin + "/operator/event-attendance");
      await staff
        .getByLabel("Member-supplied permission reference", { exact: true })
        .fill(permission);
      await staff
        .getByRole("button", {
          name: "Check exact attendance permission",
          exact: true,
        })
        .click();
      await staff
        .getByLabel(
          "I personally observed this member present in this exact invented local rehearsal. This is not a qualified assessment.",
          { exact: true },
        )
        .check();
      await staff
        .getByRole("button", {
          name: "Record present observation",
          exact: true,
        })
        .click();
      await expect(staff.getByRole("status")).toContainText(
        "Present observation recorded at",
      );
      await member.goto(receipt);
      await expect(
        member
          .getByRole("status")
          .filter({ hasText: "Present observation recorded" }),
      ).toBeVisible();

      // Attendance leaves private coaching untouched: the same coach minutes,
      // nothing held or consumed, and no coaching month or invoice.
      expect(await coachMinutes(member, f.origin)).toEqual(before);
      expect(await grantBalance(f.pool, grant)).toEqual(balance);
      expect(
        (
          await f.pool.query(
            "SELECT 1 FROM synthetic_entitlement_grants WHERE member_id=$1",
            [memberId],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await f.pool.query(
            "SELECT 1 FROM coaching_months WHERE owner_id=$1",
            [memberId],
          )
        ).rowCount,
      ).toBe(0);
      await member.goto(f.origin + "/member/test-units");
      await expect(
        member.locator("section", { hasText: "Coach minutes" }).first(),
      ).toContainText("60 minutes");
      await member.goto(f.origin + "/account/coaching");
      await expect(member.locator("body")).not.toContainText(
        /Submitted snapshot|Invoiced/,
      );
    });
  } finally {
    await f.close();
  }
});
