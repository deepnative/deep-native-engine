import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { signIn } from "../support/local-ai-journey.ts";
import { staffTrace } from "../support/staff-trace.ts";
import { requiredCheck } from "../support/required-check.ts";
import {
  grantBalance,
  grantCoachMinutes,
  heldSlots,
  slotForm,
  slotOrigin,
  slotWorld,
  submitTogether,
} from "../support/sample-slot-journey.ts";

const pool = testPool();
test.afterAll(async () => pool.end());
// An operator signs in here, so traces are off except in a full-release run,
// which needs one per execution: see ../support/staff-trace.ts.
test.use({ trace: staffTrace });

const lockSlot =
  "SELECT 1 FROM expert_availability_slots WHERE id=$1 FOR UPDATE";

type Grant = { id: string; starts_at: Date; expires_at: Date };
async function coachGrants(memberId: string) {
  return (
    await pool.query<Grant & { available: number; quantity: number }>(
      `SELECT id,starts_at,expires_at,available,quantity FROM synthetic_entitlement_grants
       WHERE member_id=$1 AND category='coach_minutes' ORDER BY created_at,id`,
      [memberId],
    )
  ).rows;
}
async function events(grantId: string) {
  return (
    await pool.query<{ id: string; operation: string; quantity: number }>(
      `SELECT id,operation,quantity,reservation_id,result_id,created_at
       FROM synthetic_entitlement_events WHERE grant_id=$1 ORDER BY created_at,id`,
      [grantId],
    )
  ).rows;
}
function cancelForm(page: Page, slotId: string) {
  return page
    .getByRole("listitem")
    .filter({ hasText: slotId })
    .locator('form[action$="/cancel"]');
}
async function formFields(form: ReturnType<typeof cancelForm>) {
  return {
    action: (await form.getAttribute("action"))!,
    fields: Object.fromEntries(
      await form
        .locator("input[type=hidden]")
        .evaluateAll((inputs) =>
          inputs.map((input) => [
            (input as HTMLInputElement).name,
            (input as HTMLInputElement).value,
          ]),
        ),
    ) as Record<string, string>,
  };
}

test("[F-BUILD-03-C] staff cancel the race winner's sample hold and one replacement credit with the original dates is available", async ({
  browser,
}, info) => {
  test.setTimeout(60_000);
  const world = await slotWorld(pool, browser, info);
  const operatorToken = randomBytes(32).toString("hex");
  const operatorId = await authorizationStore(pool).provisionStaff(
    operatorToken,
    "operator",
    new Date(Date.now() + 86_400_000),
  );
  const staff = await browser.newContext({ baseURL: slotOrigin });
  try {
    const slotId = await world.slot();
    // A second open window gives the loser a current member form to borrow from.
    await world.slot();
    const first = await world.member();
    const second = await world.member();
    const firstGrant = await grantCoachMinutes(pool, first.id);
    const secondGrant = await grantCoachMinutes(pool, second.id);
    for (const { page } of [first, second]) await page.goto("/availability");
    const [firstResponse] = await submitTogether(
      pool,
      { sql: lockSlot, id: slotId },
      [
        { page: first.page, slotId },
        { page: second.page, slotId },
      ],
    );
    const firstWon = firstResponse!.status() === 303;
    const winner = firstWon ? first : second;
    const loser = firstWon ? second : first;
    const winnerGrant = firstWon ? firstGrant : secondGrant;
    await expect(winner.page.locator('dt:text-is("State") + dd')).toHaveText(
      "held",
    );
    const receiptPath = new URL(winner.page.url()).pathname;
    const [original] = await coachGrants(winner.id);
    expect(original!.id).toBe(winnerGrant);
    const before = await events(winnerGrant);
    expect(before.map((event) => event.operation)).toEqual([
      "grant",
      "reserve",
    ]);

    await requiredCheck(1, async () => {
      // A member cannot see or use staff cancellation, and learns nothing.
      const denied = await loser.page.goto("/operator/sample-holds");
      expect(denied!.status()).toBe(403);
      await expect(loser.page.locator("body")).not.toContainText(slotId);

      const staffPage = await staff.newPage();
      await signIn(staffPage, operatorToken, slotOrigin);
      const staleTab = await staff.newPage();
      for (const page of [staffPage, staleTab]) {
        await page.goto("/operator/sample-holds");
        await expect(cancelForm(page, slotId)).toBeVisible();
      }
      const submitted = await formFields(cancelForm(staffPage, slotId));
      const stale = await formFields(cancelForm(staleTab, slotId));

      const memberCsrf = await loser.page
        .goto("/availability")
        .then(() =>
          loser.page.locator('input[name="csrf"]').first().inputValue(),
        );
      const forged = await loser.page.request.post(submitted.action, {
        headers: { Origin: slotOrigin },
        form: {
          ...submitted.fields,
          csrf: memberCsrf,
          reason: "coach-unavailable",
        },
        maxRedirects: 0,
      });
      expect(forged.status()).toBe(403);
      expect(await forged.text()).not.toContain(slotId);
      expect(await heldSlots(pool, winner.id)).toEqual([slotId]);

      await cancelForm(staffPage, slotId)
        .getByLabel("Reason")
        .selectOption("coach-unavailable");
      await cancelForm(staffPage, slotId)
        .getByRole("button", { name: "Cancel sample hold as staff" })
        .click();
      await expect(staffPage.getByRole("status")).toContainText(
        "Sample hold cancelled. One replacement credit was added.",
      );

      // Exactly one replacement credit, dated like the credit it replaces.
      const grants = await coachGrants(winner.id);
      expect(grants).toHaveLength(2);
      const replacement = grants.find((grant) => grant.id !== winnerGrant)!;
      expect(replacement).toMatchObject({ quantity: 60, available: 60 });
      expect(replacement.starts_at).toEqual(original!.starts_at);
      expect(replacement.expires_at).toEqual(original!.expires_at);
      expect(await grantBalance(pool, winnerGrant)).toEqual({
        available: 0,
        reserved: 0,
      });

      // History is appended to, never rewritten.
      const after = await events(winnerGrant);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(
        after
          .slice(before.length)
          .map((event) => event.operation)
          .sort(),
      ).toEqual(["adjust", "release"]);
      expect((await events(replacement.id)).map((e) => e.operation)).toEqual([
        "grant",
      ]);

      // A replay of the same form and a stale second form add nothing.
      const replay = await staffPage.request.post(submitted.action, {
        headers: { Origin: slotOrigin },
        form: { ...submitted.fields, reason: "coach-unavailable" },
        maxRedirects: 0,
      });
      expect(replay.status()).toBe(200);
      expect(await replay.text()).toContain(
        "This cancellation was already recorded. No second credit was added.",
      );
      await cancelForm(staleTab, slotId)
        .getByLabel("Reason")
        .selectOption("scheduling-error");
      const staleResponse = staleTab.waitForResponse(
        (response) =>
          response.url().endsWith(stale.action) &&
          response.request().method() === "POST",
      );
      await cancelForm(staleTab, slotId)
        .getByRole("button", { name: "Cancel sample hold as staff" })
        .click();
      expect((await staleResponse).status()).toBe(409);
      await expect(staleTab.getByRole("status")).toContainText(
        "This hold changed since the page was opened. Nothing was cancelled or credited.",
      );
      expect(await coachGrants(winner.id)).toHaveLength(2);
      expect(
        (
          await pool.query(
            "SELECT 1 FROM sample_hold_staff_cancellations WHERE member_id=$1",
            [winner.id],
          )
        ).rowCount,
      ).toBe(1);

      // The member sees why, and the replacement's dates, on their receipt.
      await winner.page.goto(receiptPath);
      await expect(winner.page.locator('dt:text-is("State") + dd')).toHaveText(
        "cancelled by staff",
      );
      await expect(winner.page.locator("body")).toContainText(
        "Staff cancelled this sample hold: the coach is unavailable.",
      );
      await expect(
        winner.page.locator('dt:text-is("Replacement credit") + dd'),
      ).toHaveText("60 test minutes");
      await expect(
        winner.page.locator('dt:text-is("Replacement valid from") + dd time'),
      ).toHaveAttribute("datetime", original!.starts_at.toISOString());
      await expect(
        winner.page.locator('dt:text-is("Replacement valid until") + dd time'),
      ).toHaveAttribute("datetime", original!.expires_at.toISOString());

      // The slot is open again and the replacement credit holds it.
      await winner.page.goto("/availability");
      await slotForm(winner.page, slotId)
        .getByRole("button", { name: "Reserve sample hold" })
        .click();
      await expect(winner.page.locator('dt:text-is("State") + dd')).toHaveText(
        "held",
      );
      expect(await heldSlots(pool, winner.id)).toEqual([slotId]);
      expect(await grantBalance(pool, replacement.id)).toEqual({
        available: 0,
        reserved: 60,
      });
    });
  } finally {
    await staff.close();
    await world.cleanup();
    await pool.query("DELETE FROM principals WHERE id=$1", [operatorId]);
  }
});
