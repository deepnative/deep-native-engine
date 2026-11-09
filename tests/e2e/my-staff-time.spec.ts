import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { availabilityStore } from "../../src/availability.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { COOKIE } from "../../src/session.ts";
import { memberSlotHolds } from "../../src/slot-holds.ts";
import { hash } from "../../src/store.ts";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
// Staff credentials remain outside browser traces and captures.
test.use({ trace: "off" });

test("[L324] MYTIME-01/02/05/06/07 a staff member sees only their own held slot and room left", async ({
  browser,
}, info) => {
  const f = await reviewedContentFixture(browser, info);
  try {
    const admin = await f.staff("platform_admin"),
      operator = await f.staff("operator"),
      [coach, backup] = await Promise.all([f.staff("coach"), f.staff("coach")]);
    const record = randomUUID();
    const insert = (
      id: string,
      staffId: string,
      other: string,
      capacity: number,
    ) =>
      f.pool.query(
        `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,
           loaded_cost_cents,capacity_minutes,committed_minutes,backup_staff_id,
           qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
         VALUES($1,$2,'coach','education','coaching',clock_timestamp()-interval '1 hour',
           clock_timestamp()+interval '30 days',123456,$3,60,$4,'INVENTED-QUAL-L324',
           'INVENTED-AGREE-L324','INVENTED-CONFLICT-L324',$5,clock_timestamp()-interval '1 minute')`,
        [id, staffId, capacity, other, admin.id],
      );
    await insert(record, coach.id, backup.id, 300);
    await insert(randomUUID(), backup.id, coach.id, 120);
    const startsAt = new Date(
      Math.floor((Date.now() + 3 * 86_400_000) / 60000) * 60000,
    );
    const slots = availabilityStore(f.pool);
    const heldSlot = await slots.create(
      operator.token,
      record,
      startsAt,
      new Date(+startsAt + 3_600_000),
    );
    await slots.create(
      operator.token,
      record,
      new Date(+startsAt + 7_200_000),
      new Date(+startsAt + 10_800_000),
    );
    const member = await f.member();
    const memberToken = (await member.context().cookies()).find(
      (cookie) => cookie.name === COOKIE,
    )!.value;
    const memberId = (
      await f.pool.query<{ id: string }>(
        "SELECT id FROM learners WHERE token_hash=$1",
        [hash(memberToken)],
      )
    ).rows[0]!.id;
    const grant = await syntheticLedger(f.pool).grant(
      memberId,
      "coach_minutes",
      60,
      randomUUID(),
      {
        startsAt: new Date(Date.now() - 3_600_000).toISOString(),
        expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      },
    );
    await memberSlotHolds(f.pool).request(
      memberToken,
      heldSlot!,
      grant,
      randomUUID(),
    );

    const page = coach.page;
    await page.goto(f.origin + "/staff");
    await page
      .getByRole("link", { name: "My booked time", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "My booked time", level: 1 }),
    ).toBeVisible();
    const mine = page.locator('[data-my-record="0"]');
    await expect(page.locator("[data-my-record]")).toHaveCount(1);
    // 300 declared - 60 committed - two open 60-minute slots.
    await expect(mine.locator('[data-field="0.room"]')).toHaveText("120 min");
    await expect(mine.locator('[data-field="0.slots"]')).toHaveText("120 min");
    await expect(mine.locator('[data-field="0.held"]')).toHaveText("1");
    await expect(
      mine.locator('[data-held-slots="0"] time').first(),
    ).toHaveAttribute("datetime", startsAt.toISOString());
    await expect(page.locator("main")).toContainText(
      "Queued review or support requests are not available time",
    );
    const text = (await page.locator("main").textContent()) ?? "";
    for (const secret of [
      memberId,
      grant,
      heldSlot!,
      record,
      coach.id,
      "L324",
      "1234.56",
    ])
      expect(text).not.toContain(secret);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("my-staff-time.png"),
      fullPage: true,
    });

    // MYTIME-06: the backup sees only their own record, with nothing held.
    await backup.page.goto(f.origin + "/review/my-time");
    await expect(backup.page.locator("[data-my-record]")).toHaveCount(1);
    await expect(backup.page.locator('[data-field="0.held"]')).toHaveText("0");
    // MYTIME-05: staff without a record, and a member, see no figures.
    await operator.page.goto(f.origin + "/review/my-time");
    await expect(
      operator.page.locator('[data-my-records="none"]'),
    ).toBeVisible();
    const denied = await member.goto(f.origin + "/review/my-time");
    expect(denied?.status()).toBe(403);
    await expect(member.locator("main")).not.toContainText(/\d+ min/);
  } finally {
    await f.close();
  }
});
