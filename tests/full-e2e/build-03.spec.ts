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

const pool = testPool();
test.afterAll(async () => pool.end());

const lockSlot =
  "SELECT 1 FROM expert_availability_slots WHERE id=$1 FOR UPDATE";
const lockGrant =
  "SELECT 1 FROM synthetic_entitlement_grants WHERE id=$1 FOR UPDATE";

async function expectHeldReceipt(page: Page, slotId: string) {
  await expect(page).toHaveURL(/\/availability\/holds\/[0-9a-f-]{36}$/);
  await expect(
    page.getByText("SAMPLE HOLD — NOT A BOOKING", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('dt:text-is("State") + dd')).toHaveText("held");
  await expect(page.locator('dt:text-is("Slot") + dd')).toHaveText(slotId);
}

async function expectRefused(page: Page) {
  await expect(page.getByRole("alert")).toContainText(
    "No new sample hold was created by this request",
  );
}

test("[F-BUILD-03-A] two members race for one sample slot and exactly one holds it", async ({
  browser,
}, info) => {
  test.setTimeout(60_000);
  const world = await slotWorld(pool, browser, info);
  try {
    const slotId = await world.slot();
    const first = await world.member();
    const second = await world.member();
    const firstGrant = await grantCoachMinutes(pool, first.id);
    const secondGrant = await grantCoachMinutes(pool, second.id);
    for (const { page } of [first, second]) {
      await page.goto("/availability");
      await expect(slotForm(page, slotId)).toBeVisible();
    }

    await requiredCheck(1, async () => {
      const [firstResponse, secondResponse] = await submitTogether(
        pool,
        { sql: lockSlot, id: slotId },
        [
          { page: first.page, slotId },
          { page: second.page, slotId },
        ],
      );
      const statuses = [firstResponse!.status(), secondResponse!.status()];
      expect([...statuses].sort()).toEqual([303, 409]);
      const firstWon = statuses[0] === 303;
      const winner = firstWon ? first : second;
      const loser = firstWon ? second : first;

      await expectHeldReceipt(winner.page, slotId);
      await expectRefused(loser.page);
      const holds = await pool.query(
        "SELECT member_id,state FROM synthetic_slot_holds WHERE slot_id=$1",
        [slotId],
      );
      expect(holds.rows).toEqual([{ member_id: winner.id, state: "held" }]);
      expect(
        await grantBalance(pool, firstWon ? firstGrant : secondGrant),
      ).toEqual({ available: 0, reserved: 60 });
      expect(
        await grantBalance(pool, firstWon ? secondGrant : firstGrant),
      ).toEqual({ available: 60, reserved: 0 });
      // The loser's request left no receipt, and the winner's stays private.
      expect(
        (
          await pool.query(
            "SELECT 1 FROM synthetic_member_hold_receipts WHERE member_id=$1",
            [loser.id],
          )
        ).rowCount,
      ).toBe(0);
      const receipt = await loser.page.goto(
        new URL(winner.page.url()).pathname,
      );
      expect(receipt!.status()).toBe(404);
      await expect(loser.page.locator("body")).not.toContainText(slotId);
    });
  } finally {
    await world.cleanup();
  }
});

test("[F-BUILD-03-B] two attempts race for one member's final credit and exactly one reserves it", async ({
  browser,
}, info) => {
  test.setTimeout(60_000);
  const world = await slotWorld(pool, browser, info);
  try {
    const firstSlot = await world.slot();
    const secondSlot = await world.slot();
    const member = await world.member();
    const grantId = await grantCoachMinutes(pool, member.id);
    const otherDevice = await world.secondDevice(member);
    for (const page of [member.page, otherDevice]) {
      await page.goto("/availability");
      await expect(slotForm(page, firstSlot)).toBeVisible();
      await expect(slotForm(page, secondSlot)).toBeVisible();
    }

    await requiredCheck(1, async () => {
      const [firstResponse, secondResponse] = await submitTogether(
        pool,
        { sql: lockGrant, id: grantId },
        [
          { page: member.page, slotId: firstSlot },
          { page: otherDevice, slotId: secondSlot },
        ],
      );
      const statuses = [firstResponse!.status(), secondResponse!.status()];
      expect([...statuses].sort()).toEqual([303, 409]);
      const firstWon = statuses[0] === 303;
      const wonSlot = firstWon ? firstSlot : secondSlot;
      const lostSlot = firstWon ? secondSlot : firstSlot;

      await expectHeldReceipt(firstWon ? member.page : otherDevice, wonSlot);
      await expectRefused(firstWon ? otherDevice : member.page);
      expect(await heldSlots(pool, member.id)).toEqual([wonSlot]);
      expect(await grantBalance(pool, grantId)).toEqual({
        available: 0,
        reserved: 60,
      });
      expect(
        (
          await pool.query(
            "SELECT 1 FROM synthetic_entitlement_events WHERE grant_id=$1 AND operation='reserve'",
            [grantId],
          )
        ).rowCount,
      ).toBe(1);

      // With no minutes left the other slot offers nothing, though it is free.
      await member.page.goto("/availability");
      await expect(slotForm(member.page, lostSlot)).toHaveCount(0);
      // A fresh credit makes that same slot reservable, so the refusal above
      // came from the spent credit and not from the slot.
      const freshGrant = await grantCoachMinutes(pool, member.id);
      await member.page.reload();
      await slotForm(member.page, lostSlot)
        .getByRole("button", { name: "Reserve sample hold" })
        .click();
      await expectHeldReceipt(member.page, lostSlot);
      expect(await grantBalance(pool, freshGrant)).toEqual({
        available: 0,
        reserved: 60,
      });
    });
  } finally {
    await world.cleanup();
  }
});

test("[F-BUILD-03-D] the race loser can recover and the withdrawn winner's history stays auditable", async ({
  browser,
}, info) => {
  test.setTimeout(60_000);
  const world = await slotWorld(pool, browser, info);
  try {
    const racedSlot = await world.slot();
    const otherSlot = await world.slot();
    const first = await world.member();
    const second = await world.member();
    const firstGrant = await grantCoachMinutes(pool, first.id);
    const secondGrant = await grantCoachMinutes(pool, second.id);
    for (const { page } of [first, second]) await page.goto("/availability");
    const [firstResponse] = await submitTogether(
      pool,
      { sql: lockSlot, id: racedSlot },
      [
        { page: first.page, slotId: racedSlot },
        { page: second.page, slotId: racedSlot },
      ],
    );
    const firstWon = firstResponse!.status() === 303;
    const winner = firstWon ? first : second;
    const loser = firstWon ? second : first;
    const winnerGrant = firstWon ? firstGrant : secondGrant;
    const loserGrant = firstWon ? secondGrant : firstGrant;
    await expectHeldReceipt(winner.page, racedSlot);

    await requiredCheck(1, async () => {
      await expectRefused(loser.page);
      // Nothing to undo: the failed attempt reserved nothing.
      expect(await heldSlots(pool, loser.id)).toEqual([]);
      expect(await grantBalance(pool, loserGrant)).toEqual({
        available: 60,
        reserved: 0,
      });
      await loser.page
        .getByRole("link", { name: "Inspect your current sample receipts" })
        .click();
      await expect(loser.page).toHaveURL(/\/availability$/);
      // The taken slot is gone, and an open one is still offered.
      await expect(slotForm(loser.page, racedSlot)).toHaveCount(0);
      await slotForm(loser.page, otherSlot)
        .getByRole("button", { name: "Reserve sample hold" })
        .click();
      await expectHeldReceipt(loser.page, otherSlot);
      expect(await heldSlots(pool, loser.id)).toEqual([otherSlot]);
    });

    await requiredCheck(2, async () => {
      const events = () =>
        pool
          .query<{ id: string; operation: string }>(
            `SELECT * FROM synthetic_entitlement_events
             WHERE grant_id=$1 ORDER BY created_at,id`,
            [winnerGrant],
          )
          .then((result) => result.rows);
      const before = await events();
      expect(before.map((event) => event.operation)).toEqual([
        "grant",
        "reserve",
      ]);

      const receiptPath = new URL(winner.page.url()).pathname;
      await winner.page
        .getByRole("button", { name: "Withdraw sample hold" })
        .click();
      await expect(
        winner.page.getByText("You withdrew this sample hold.", {
          exact: false,
        }),
      ).toBeVisible();
      await expect(winner.page.locator('dt:text-is("State") + dd')).toHaveText(
        "released",
      );

      // The receipt and original events remain; the withdrawal only adds one.
      await winner.page.goto(receiptPath);
      await expect(winner.page.locator('dt:text-is("State") + dd')).toHaveText(
        "released",
      );
      await expect(winner.page.locator('dt:text-is("Slot") + dd')).toHaveText(
        racedSlot,
      );
      const after = await events();
      expect(after.slice(0, before.length)).toEqual(before);
      expect(
        after.slice(before.length).map((event) => event.operation),
      ).toEqual(["release"]);

      // The member can take the same history away in their own export.
      const exported = await winner.page.request.get("/api/member/export");
      expect(exported.status()).toBe(200);
      const { records } = (await exported.json()) as {
        records: Record<string, { grantId: string; [key: string]: unknown }[]>;
      };
      expect(
        records
          .testUnitEvents!.filter((event) => event.grantId === winnerGrant)
          .map((event) => event.operation)
          .sort(),
      ).toEqual(["grant", "release", "reserve"]);
      expect(
        records
          .testUnitReservations!.filter((row) => row.grantId === winnerGrant)
          .map((row) => row.state),
      ).toEqual(["released"]);

      // The slot and the minutes are free again, and only the owner sees this.
      expect(await grantBalance(pool, winnerGrant)).toEqual({
        available: 60,
        reserved: 0,
      });
      await winner.page.goto("/availability");
      await expect(slotForm(winner.page, racedSlot)).toBeVisible();
      expect((await loser.page.goto(receiptPath))!.status()).toBe(404);
    });
  } finally {
    await world.cleanup();
  }
});
