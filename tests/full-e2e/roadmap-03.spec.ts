import { expect, test, type Page } from "@playwright/test";
import { requiredCheck } from "../support/required-check.ts";
import { testPool } from "../support/database.ts";
import {
  grantBalance,
  grantCoachMinutes,
  heldSlots,
  slotForm,
  slotWorld,
  submitTogether,
} from "../support/sample-slot-journey.ts";

// These run on the product's sample holds: windows from a coach whose registry
// entry carries an invented qualification, held against seeded test minutes.
// The product labels a hold "not a booking", so nothing here is a real booking,
// a qualified provider or a payment.
const pool = testPool();
test.afterAll(async () => pool.end());

const lockSlot =
  "SELECT 1 FROM expert_availability_slots WHERE id=$1 FOR UPDATE";
const lockGrant =
  "SELECT 1 FROM synthetic_entitlement_grants WHERE id=$1 FOR UPDATE";
const refusal = "No new sample hold was created by this request";

async function expectHeld(page: Page, slotId: string) {
  await expect(page).toHaveURL(/\/availability\/holds\/[0-9a-f-]{36}$/);
  await expect(page.locator('dt:text-is("State") + dd')).toHaveText("held");
  await expect(page.locator('dt:text-is("Slot") + dd')).toHaveText(slotId);
}

async function reserveEvents(grantId: string) {
  return (
    await pool.query(
      "SELECT 1 FROM synthetic_entitlement_events WHERE grant_id=$1 AND operation='reserve'",
      [grantId],
    )
  ).rowCount;
}

test("[F-ROADMAP-03-A] two members race for the last qualified slot; the loser keeps nothing and can recover", async ({
  browser,
}, info) => {
  test.setTimeout(60_000);
  const world = await slotWorld(pool, browser, info);
  try {
    const lastSlot = await world.slot();
    const first = await world.member();
    const second = await world.member();
    // Each member has exactly one remaining coach unit (one 60-minute grant).
    const firstGrant = await grantCoachMinutes(pool, first.id);
    const secondGrant = await grantCoachMinutes(pool, second.id);
    for (const { page } of [first, second]) {
      await page.goto("/availability");
      await expect(slotForm(page, lastSlot)).toBeVisible();
    }
    const [firstResponse, secondResponse] = await submitTogether(
      pool,
      { sql: lockSlot, id: lastSlot },
      [
        { page: first.page, slotId: lastSlot },
        { page: second.page, slotId: lastSlot },
      ],
    );
    const statuses = [firstResponse!.status(), secondResponse!.status()];
    const firstWon = statuses[0] === 303;
    const winner = firstWon ? first : second;
    const loser = firstWon ? second : first;
    const winnerGrant = firstWon ? firstGrant : secondGrant;
    const loserGrant = firstWon ? secondGrant : firstGrant;

    await requiredCheck(1, async () => {
      expect([...statuses].sort()).toEqual([303, 409]);
      await expectHeld(winner.page, lastSlot);
      const holds = await pool.query(
        "SELECT member_id,state FROM synthetic_slot_holds WHERE slot_id=$1",
        [lastSlot],
      );
      expect(holds.rows).toEqual([{ member_id: winner.id, state: "held" }]);
      expect(await grantBalance(pool, winnerGrant)).toEqual({
        available: 0,
        reserved: 60,
      });
      expect(await reserveEvents(winnerGrant)).toBe(1);
    });

    await requiredCheck(2, async () => {
      // The refusal says nothing was created and why it may have happened.
      await expect(loser.page.getByRole("alert")).toContainText(refusal);
      await expect(loser.page.getByRole("alert")).toContainText(
        "The slot, session or matching test allowance may be unavailable",
      );
      // No phantom reservation: no hold, no receipt, no reserve event, and the
      // loser's unit is still whole.
      expect(await heldSlots(pool, loser.id)).toEqual([]);
      expect(
        (
          await pool.query(
            "SELECT 1 FROM synthetic_member_hold_receipts WHERE member_id=$1",
            [loser.id],
          )
        ).rowCount,
      ).toBe(0);
      expect(await reserveEvents(loserGrant)).toBe(0);
      expect(await grantBalance(pool, loserGrant)).toEqual({
        available: 60,
        reserved: 0,
      });
      // The recovery link leads back to availability, where the unit is still
      // offered against a window that opens later.
      await loser.page
        .getByRole("link", { name: "Inspect your current sample receipts" })
        .click();
      await expect(loser.page).toHaveURL(/\/availability$/);
      // The taken slot is no longer offered to the loser.
      await expect(slotForm(loser.page, lastSlot)).toHaveCount(0);
      await loser.page.goto("/member/test-units");
      const coach = loser.page.locator(
        '[data-test-unit-category="coach_minutes"]',
      );
      await expect(coach.locator('[data-field="usable"]')).toHaveText("60");
      await expect(coach.locator('[data-field="held"]')).toHaveText("0");
      const laterSlot = await world.slot();
      await loser.page.goto("/availability");
      await slotForm(loser.page, laterSlot)
        .getByRole("button", { name: "Reserve sample hold" })
        .click();
      await expectHeld(loser.page, laterSlot);
      expect(await grantBalance(pool, loserGrant)).toEqual({
        available: 0,
        reserved: 60,
      });
    });
  } finally {
    await world.cleanup();
  }
});

test("[F-ROADMAP-03-B] three devices race one member's last unit; one reservation commits and the balance stays non-negative", async ({
  browser,
}, info) => {
  test.setTimeout(60_000);
  const world = await slotWorld(pool, browser, info);
  try {
    const slots = [await world.slot(), await world.slot(), await world.slot()];
    const member = await world.member();
    const lastUnit = await grantCoachMinutes(pool, member.id);
    const devices = [
      member.page,
      await world.secondDevice(member),
      await world.secondDevice(member),
    ];
    for (const [index, page] of devices.entries()) {
      await page.goto("/availability");
      await expect(slotForm(page, slots[index]!)).toBeVisible();
    }
    const responses = await submitTogether(
      pool,
      { sql: lockGrant, id: lastUnit },
      devices.map((page, index) => ({ page, slotId: slots[index]! })),
    );
    const statuses = responses.map((response) => response.status());
    const won = statuses.indexOf(303);

    await requiredCheck(1, async () => {
      expect([...statuses].sort()).toEqual([303, 409, 409]);
      await expectHeld(devices[won]!, slots[won]!);
      for (const [index, page] of devices.entries())
        if (index !== won)
          await expect(page.getByRole("alert")).toContainText(refusal);
      expect(await heldSlots(pool, member.id)).toEqual([slots[won]]);
      expect(await reserveEvents(lastUnit)).toBe(1);
    });

    await requiredCheck(2, async () => {
      expect(await grantBalance(pool, lastUnit)).toEqual({
        available: 0,
        reserved: 60,
      });
      // The member's own balance page agrees and shows nothing below zero.
      await member.page.goto("/member/test-units");
      const coach = member.page.locator(
        '[data-test-unit-category="coach_minutes"]',
      );
      await expect(coach.locator('[data-field="usable"]')).toHaveText("0");
      await expect(coach.locator('[data-field="held"]')).toHaveText("60");
      // A still-free slot is no longer offered against the spent unit.
      const free = slots.find((_, index) => index !== won)!;
      await member.page.goto("/availability");
      await expect(slotForm(member.page, free)).toHaveCount(0);
      await expect(member.page.locator("body")).toContainText(
        "No matching current test allowance has 60 available minutes",
      );
      expect(await grantBalance(pool, lastUnit)).toEqual({
        available: 0,
        reserved: 60,
      });
      expect(await heldSlots(pool, member.id)).toEqual([slots[won]]);
      // The database itself refuses a negative counter.
      await expect(
        pool.query(
          "UPDATE synthetic_entitlement_grants SET available=available-60,reserved=reserved+60 WHERE id=$1",
          [lastUnit],
        ),
      ).rejects.toThrow(/check constraint/);
    });
  } finally {
    await world.cleanup();
  }
});
