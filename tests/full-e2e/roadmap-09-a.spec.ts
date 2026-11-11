import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { availabilityStore } from "../../src/availability.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { COOKIE } from "../../src/session.ts";
import { memberSlotHolds } from "../../src/slot-holds.ts";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import { memberReference } from "../support/course-bundle-journey.ts";
import { staffTrace } from "../support/staff-trace.ts";

// The booking exception the product can show is a member's held sample slot
// whose coach became unavailable: sample holds with test minutes, never real
// bookings. An operator resolves it on the staff page. Staff credentials stay
// out of traces; every person, slot and minute is invented.
test.use({ trace: staffTrace });

async function coachGrants(pool: Pool, memberId: string) {
  return (
    await pool.query<{
      id: string;
      quantity: number;
      available: number;
      starts_at: Date;
      expires_at: Date;
    }>(
      `SELECT id,quantity,available,starts_at,expires_at FROM synthetic_entitlement_grants
       WHERE member_id=$1 AND category='coach_minutes' ORDER BY created_at,id`,
      [memberId],
    )
  ).rows;
}
async function events(pool: Pool, grantId: string) {
  return (
    await pool.query<{ id: string; operation: string; quantity: number }>(
      `SELECT id,operation,quantity,reservation_id,result_id,created_at
       FROM synthetic_entitlement_events WHERE grant_id=$1 ORDER BY created_at,id`,
      [grantId],
    )
  ).rows;
}
const cancelForm = (page: Page, slotId: string) =>
  page
    .getByRole("listitem")
    .filter({ hasText: slotId })
    .locator('form[action$="/cancel"]');
// One entry under "Recent staff cancellations", found by its slot.
const cancellation = (page: Page, slotId: string) =>
  page
    .getByRole("listitem")
    .filter({ has: page.locator("dd", { hasText: slotId }) });
const entry = (page: Page, slotId: string, label: string) =>
  cancellation(page, slotId)
    .locator("dt")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator("+ dd");

test("[F-ROADMAP-09-A] an operator resolves a held sample slot whose coach is unavailable, and the credit adjustment and the coach's time stay on record", async ({
  browser,
}, info) => {
  test.setTimeout(60_000);
  const f = await reviewedContentFixture(browser, info);
  try {
    const admin = await f.staff("platform_admin"),
      operator = await f.staff("operator"),
      [coach, backup] = await Promise.all([f.staff("coach"), f.staff("coach")]);
    const record = randomUUID();
    const roster = (id: string, staffId: string, other: string) =>
      f.pool.query(
        `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,
           loaded_cost_cents,capacity_minutes,committed_minutes,backup_staff_id,
           qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
         VALUES($1,$2,'coach','education','coaching',clock_timestamp()-interval '1 hour',
           clock_timestamp()+interval '30 days',12000,300,60,$3,'INVENTED-QUAL-09A',
           'INVENTED-AGREE-09A','INVENTED-CONFLICT-09A',$4,clock_timestamp()-interval '1 minute')`,
        [id, staffId, other, admin.id],
      );
    await roster(record, coach.id, backup.id);
    await roster(randomUUID(), backup.id, coach.id);
    const startsAt = new Date(
      Math.floor((Date.now() + 3 * 86_400_000) / 60000) * 60000,
    );
    const laterStartsAt = new Date(+startsAt + 7_200_000);
    const slots = availabilityStore(f.pool);
    const slotId = (await slots.create(
      operator.token,
      record,
      startsAt,
      new Date(+startsAt + 3_600_000),
    ))!;
    const laterSlotId = (await slots.create(
      operator.token,
      record,
      laterStartsAt,
      new Date(+laterStartsAt + 3_600_000),
    ))!;
    expect(slotId && laterSlotId).toBeTruthy();

    const member = await f.member();
    const memberId = await memberReference(member, f.origin);
    const grantId = await syntheticLedger(f.pool).grant(
      memberId,
      "coach_minutes",
      60,
      randomUUID(),
      {
        startsAt: new Date(Date.now() - 3_600_000).toISOString(),
        expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      },
    );
    const memberToken = (await member.context().cookies()).find(
      (cookie) => cookie.name === COOKIE,
    )!.value;
    // The member's own hold request with one of their test credits, then
    // their receipt page for it.
    const hold = async (slot: string, credit: string) => {
      const requestId = randomUUID();
      await memberSlotHolds(f.pool).request(
        memberToken,
        slot,
        credit,
        requestId,
      );
      const url = `${f.origin}/availability/holds/${requestId}`;
      await member.goto(url);
      await expect(member.locator('dt:text-is("State") + dd')).toHaveText(
        "held",
      );
      return url;
    };
    const receipt = await hold(slotId, grantId);
    const [original] = await coachGrants(f.pool, memberId);
    const before = await events(f.pool, grantId);
    expect(before.map((event) => event.operation)).toEqual([
      "grant",
      "reserve",
    ]);

    // The coach's own booked time before the exception.
    const mine = coach.page.locator('[data-my-record="0"]');
    await coach.page.goto(f.origin + "/review/my-time");
    await expect(mine.locator('[data-field="0.held"]')).toHaveText("1");
    await expect(mine.locator('[data-field="0.slots"]')).toHaveText("120 min");
    await expect(mine.locator('[data-field="0.room"]')).toHaveText("120 min");
    await expect(
      mine.locator('[data-held-slots="0"] time').first(),
    ).toHaveAttribute("datetime", startsAt.toISOString());

    await requiredCheck(1, async () => {
      // Only staff who may resolve it can see or use the page.
      expect(
        (await member.goto(f.origin + "/operator/sample-holds"))!.status(),
      ).toBe(403);
      await expect(member.locator("body")).not.toContainText(slotId);

      const staff = operator.page;
      await staff.goto(f.origin + "/operator/sample-holds");
      await cancelForm(staff, slotId)
        .getByLabel("Reason")
        .selectOption("coach-unavailable");
      await cancelForm(staff, slotId)
        .getByRole("button", { name: "Cancel sample hold as staff" })
        .click();
      await expect(staff.getByRole("status")).toContainText(
        "Sample hold cancelled. One replacement credit was added.",
      );

      // The adjustment: one replacement credit with the original dates, and
      // the original credit's history appended to, never rewritten.
      const grants = await coachGrants(f.pool, memberId);
      expect(grants).toHaveLength(2);
      const replacement = grants.find((grant) => grant.id !== grantId)!;
      expect(replacement).toMatchObject({ quantity: 60, available: 60 });
      expect(replacement.starts_at).toEqual(original!.starts_at);
      expect(replacement.expires_at).toEqual(original!.expires_at);
      const after = await events(f.pool, grantId);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(
        after
          .slice(before.length)
          .map((event) => event.operation)
          .sort(),
      ).toEqual(["adjust", "release"]);
      await member.goto(receipt);
      await expect(member.locator("main")).toContainText(
        "Staff cancelled this sample hold: the coach is unavailable.",
      );
      await expect(member.locator("main")).toContainText(
        "Your earlier history is kept.",
      );
      await expect(
        member
          .locator("dt")
          .filter({ hasText: /^Replacement credit$/ })
          .locator("+ dd"),
      ).toHaveText("60 test minutes");

      // The staff record of the exception: the window, the reason, who
      // cancelled and the credit. It is still there on a fresh read.
      await staff.goto(f.origin + "/operator/sample-holds");
      await expect(cancelForm(staff, slotId)).toHaveCount(0);
      await expect(
        entry(staff, slotId, "Window").locator("time").first(),
      ).toHaveAttribute("datetime", startsAt.toISOString());
      await expect(entry(staff, slotId, "Reason")).toHaveText(
        "The coach is unavailable",
      );
      await expect(entry(staff, slotId, "Cancelled")).toContainText("by you");
      await expect(entry(staff, slotId, "Replacement credit")).toHaveText(
        "60 test minutes",
      );
      const firstRecord = await cancellation(staff, slotId).innerText();
      // Another authorized staff member reads the same record, not as their own.
      await admin.page.goto(f.origin + "/operator/sample-holds");
      await expect(entry(admin.page, slotId, "Cancelled")).toContainText(
        "by another staff member",
      );
      await expect(entry(admin.page, slotId, "Reason")).toHaveText(
        "The coach is unavailable",
      );

      // The coach's time: nothing is held any more, and the window is open again.
      await coach.page.goto(f.origin + "/review/my-time");
      await expect(mine.locator('[data-field="0.held"]')).toHaveText("0");
      await expect(mine.locator('[data-held-slots="0"]')).toHaveText(
        "No slot is held.",
      );
      await expect(mine.locator('[data-field="0.slots"]')).toHaveText(
        "120 min",
      );
      await expect(mine.locator('[data-field="0.room"]')).toHaveText("120 min");

      // A second exception is a second record; the first stays as written.
      await hold(laterSlotId, replacement.id);
      await coach.page.reload();
      await expect(mine.locator('[data-field="0.held"]')).toHaveText("1");
      await expect(
        mine.locator('[data-held-slots="0"] time').first(),
      ).toHaveAttribute("datetime", laterStartsAt.toISOString());
      await staff.goto(f.origin + "/operator/sample-holds");
      await cancelForm(staff, laterSlotId)
        .getByLabel("Reason")
        .selectOption("scheduling-error");
      await cancelForm(staff, laterSlotId)
        .getByRole("button", { name: "Cancel sample hold as staff" })
        .click();
      await staff.goto(f.origin + "/operator/sample-holds");
      await expect(entry(staff, laterSlotId, "Reason")).toHaveText(
        "The window was listed in error",
      );
      expect(await cancellation(staff, slotId).innerText()).toBe(firstRecord);
      expect(await events(f.pool, grantId)).toEqual(after);
      expect(
        (await events(f.pool, replacement.id)).map((e) => e.operation).sort(),
      ).toEqual(["adjust", "grant", "release", "reserve"]);
      expect(await coachGrants(f.pool, memberId)).toHaveLength(3);
      await coach.page.reload();
      await expect(mine.locator('[data-field="0.held"]')).toHaveText("0");
    });
  } finally {
    await f.close();
  }
});
