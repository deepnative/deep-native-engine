import { expect, test, type Page } from "@playwright/test";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import { slotJourney } from "../support/fixture-slot-journey.ts";
import { staffTrace } from "../support/staff-trace.ts";

// Sessions under the owner's 10 November 2026 decisions: there is no
// cancellation or no-show policy (students contact info@deepnative.io), and no
// fixed 45-minute call plus 15-minute preparation split. The sessions here are
// sample holds with test minutes, never real bookings; no real expert is
// involved. Staff credentials stay out of traces; everything is invented.
test.use({ trace: staffTrace });

const NO_POLICY =
  "There is no cancellation or no-show policy for sessions. To ask about one, contact info@deepnative.io.";
const state = (page: Page) => page.locator('dt:text-is("State") + dd');
const cancellations = (
  f: Awaited<ReturnType<typeof reviewedContentFixture>>,
  memberId: string,
) =>
  f.pool
    .query<{ reason: string }>(
      "SELECT reason FROM sample_hold_staff_cancellations WHERE member_id=$1 ORDER BY cancelled_at",
      [memberId],
    )
    .then((result) => result.rows.map((row) => row.reason));

test("[F-ROADMAP-03-C] with no cancellation or no-show policy, a student is told to contact staff, a staff cancellation records one credit, and a missed session only ends", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const f = await reviewedContentFixture(browser, info);
  try {
    const j = await slotJourney(f);
    const [original] = await j.credits();
    let replacementId = "";

    await requiredCheck(1, async () => {
      const receipt = await j.hold(j.slotIds[0]!, j.grantId);
      // The student reads that there is no policy, and whom to ask.
      await expect(j.member.locator("main")).toContainText(NO_POLICY);
      await expect(
        j.member.locator('main a[href="mailto:info@deepnative.io"]'),
      ).toBeVisible();
      await expect(j.member.locator("main")).not.toContainText(
        /cancellation window|hours before|late cancellation fee/i,
      );
      const before = await j.events(j.grantId);
      expect(before.map((event) => event.operation)).toEqual([
        "grant",
        "reserve",
      ]);

      // Staff cancel it at the student's request.
      const sent = await j.staffCancel(
        j.operator.page,
        j.slotIds[0]!,
        "member-request",
      );
      const credits = await j.credits();
      expect(credits).toHaveLength(2);
      const replacement = credits.find((credit) => credit.id !== j.grantId)!;
      replacementId = replacement.id;
      expect(replacement).toMatchObject({ quantity: 60, available: 60 });
      expect(replacement.starts_at).toEqual(original!.starts_at);
      expect(replacement.expires_at).toEqual(original!.expires_at);
      // The same request again records nothing more.
      const replay = await j.operator.page.request.post(
        f.origin + sent.action,
        {
          headers: { Origin: f.origin },
          form: sent.fields,
          maxRedirects: 0,
        },
      );
      expect(await replay.text()).toContain(
        "This cancellation was already recorded. No second credit was added.",
      );
      expect(await j.credits()).toHaveLength(2);
      expect(await cancellations(f, j.memberId)).toEqual(["member-request"]);
      // History is appended to, never rewritten.
      const after = await j.events(j.grantId);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(
        after
          .slice(before.length)
          .map((event) => event.operation)
          .sort(),
      ).toEqual(["adjust", "release"]);
      await j.member.goto(receipt);
      await expect(state(j.member)).toHaveText("cancelled by staff");
      await expect(j.member.locator("main")).toContainText(
        "Staff cancelled this sample hold: you asked staff to cancel it.",
      );
      await expect(j.member.locator("main")).toContainText(
        "Your earlier history is kept.",
      );
      await expect(j.member.locator("main")).toContainText(NO_POLICY);
    });

    await requiredCheck(2, async () => {
      const receipt = await j.hold(j.slotIds[1]!, replacementId);
      const held = await j.events(replacementId);
      expect(held.map((event) => event.operation)).toEqual([
        "grant",
        "reserve",
      ]);
      // Stands in for the student not turning up: the hold's own deadline
      // passes. Only this hold's deadline moves, in this fixture database.
      await f.pool.query(
        "UPDATE synthetic_slot_holds SET expires_at=clock_timestamp()-interval '1 second' WHERE member_id=$1 AND state='held'",
        [j.memberId],
      );
      await j.member.goto(receipt);
      await expect(state(j.member)).toHaveText("expired");
      await expect(j.member.locator("main")).toContainText(
        "This temporary hold has expired.",
      );
      await expect(j.member.locator("main")).toContainText(NO_POLICY);
      // Nothing is charged or forfeited: the minutes are back, once.
      const [, replacement] = await j.credits();
      expect(replacement).toMatchObject({
        quantity: 60,
        available: 60,
        reserved: 0,
        consumed: 0,
      });
      const ended = await j.events(replacementId);
      expect(ended.slice(0, held.length)).toEqual(held);
      expect(ended.slice(held.length).map((event) => event.operation)).toEqual([
        "release",
      ]);
      // No no-show outcome exists anywhere, and reading again changes nothing.
      expect(await cancellations(f, j.memberId)).toEqual(["member-request"]);
      await j.member.reload();
      await expect(state(j.member)).toHaveText("expired");
      expect(await j.events(replacementId)).toEqual(ended);
      expect(await j.credits()).toHaveLength(2);
      await j.operator.page.goto(f.origin + "/operator/sample-holds");
      await expect(j.operator.page.locator("main")).not.toContainText(
        /no-show/i,
      );
      await expect(
        j.operator.page.getByText("No sample hold is currently held."),
      ).toBeVisible();
    });
  } finally {
    await f.close();
  }
});

test("[F-ROADMAP-03-D] a coach's failure gives one replacement credit, and the session's time is counted once with no call and preparation split", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const f = await reviewedContentFixture(browser, info);
  try {
    const j = await slotJourney(f);
    const [original] = await j.credits();
    let replacementId = "";

    await requiredCheck(1, async () => {
      const receipt = await j.hold(j.slotIds[0]!, j.grantId);
      const sent = await j.staffCancel(
        j.operator.page,
        j.slotIds[0]!,
        "coach-unavailable",
      );
      const credits = await j.credits();
      expect(credits).toHaveLength(2);
      const replacement = credits.find((credit) => credit.id !== j.grantId)!;
      replacementId = replacement.id;
      expect(replacement).toMatchObject({ quantity: 60, available: 60 });
      expect(replacement.starts_at).toEqual(original!.starts_at);
      expect(replacement.expires_at).toEqual(original!.expires_at);
      expect((await j.events(replacementId)).map((e) => e.operation)).toEqual([
        "grant",
      ]);
      const replay = await j.operator.page.request.post(
        f.origin + sent.action,
        {
          headers: { Origin: f.origin },
          form: sent.fields,
          maxRedirects: 0,
        },
      );
      expect(await replay.text()).toContain("No second credit was added.");
      expect(await j.credits()).toHaveLength(2);
      await j.member.goto(receipt);
      await expect(j.member.locator("main")).toContainText(
        "Staff cancelled this sample hold: the coach is unavailable.",
      );
      await expect(
        j.member
          .locator("dt")
          .filter({ hasText: /^Replacement credit$/ })
          .locator("+ dd"),
      ).toHaveText("60 test minutes");
    });

    await requiredCheck(2, async () => {
      // The student holds the other session with the replacement credit.
      const receipt = await j.hold(j.slotIds[1]!, replacementId);
      // One figure for the session on the student's receipt.
      await expect(
        j.member
          .locator("dt")
          .filter({ hasText: /^Reserved test quantity$/ })
          .locator("+ dd"),
      ).toHaveText("60 minutes");
      expect((await j.credits())[1]).toMatchObject({
        available: 0,
        reserved: 60,
      });

      // The coach's own booked time: one held session, each open slot once.
      const coach = j.coach.page;
      await coach.goto(f.origin + "/review/my-time");
      const mine = coach.locator('[data-my-record="0"]');
      await expect(mine.locator('[data-field="0.held"]')).toHaveText("1");
      await expect(mine.locator('[data-held-slots="0"] li')).toHaveCount(1);
      await expect(
        mine.locator('[data-held-slots="0"] time').first(),
      ).toHaveAttribute("datetime", j.starts[1]!.toISOString());
      // 300 declared - 60 committed - two open 60-minute slots.
      await expect(mine.locator('[data-field="0.slots"]')).toHaveText(
        "120 min",
      );
      await expect(mine.locator('[data-field="0.room"]')).toHaveText("120 min");

      // Staff capacity counts the same session once.
      const admin = j.admin.page;
      await admin.goto(f.origin + "/operator/staff-capacity");
      await expect(admin.locator('[data-field="coaching.held"]')).toHaveText(
        "1",
      );
      // Both coaches' records: the coach's two slots, the backup's none.
      await expect(admin.locator('[data-field="coaching.slots"]')).toHaveText(
        "120 min",
      );
      // Nowhere is the session split into call and preparation minutes.
      for (const page of [j.member, coach, admin]) {
        if (page === j.member) await page.goto(receipt);
        const text = await page.locator("main").innerText();
        expect(text).not.toMatch(/\b45\b[^.]{0,20}(min|call)/i);
        expect(text).not.toMatch(/\b15\b[^.]{0,20}prepar/i);
        expect(text).not.toMatch(/call minutes/i);
      }
      // Reading changed nothing.
      await coach.reload();
      await expect(mine.locator('[data-field="0.held"]')).toHaveText("1");
      expect((await j.credits())[1]).toMatchObject({
        available: 0,
        reserved: 60,
      });
    });
  } finally {
    await f.close();
  }
});
