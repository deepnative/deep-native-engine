import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { syntheticLedger } from "../../src/ledger.ts";
import { COOKIE } from "../../src/session.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import { memberReference } from "../support/course-bundle-journey.ts";

// "Funded support" here is what the product has: a member holds their own
// support test minutes for one private support request, and an operator with
// an exact grant records the effort. Test minutes only; no paid plan, no
// qualified support and no promised response time. Staff credentials stay out
// of traces; every person, request and minute is invented.
test.use({ trace: "off" });

const CATEGORIES = ["support_minutes", "coach_minutes", "review_minutes"];
// Each grant's balance, with its ledger events summed by kind of operation.
async function balances(pool: Pool, memberId: string) {
  const rows = (
    await pool.query<{
      category: string;
      available: number;
      reserved: number;
      consumed: number;
      events: string;
    }>(
      `SELECT g.category,g.available,g.reserved,g.consumed,
        (SELECT string_agg(o.operation||':'||o.minutes,',' ORDER BY o.operation)
           FROM (SELECT e.operation,sum(e.quantity) AS minutes FROM synthetic_entitlement_events e
                 WHERE e.grant_id=g.id GROUP BY e.operation) o) AS events
       FROM synthetic_entitlement_grants g WHERE g.member_id=$1`,
      [memberId],
    )
  ).rows;
  return Object.fromEntries(
    rows.map(({ category, ...rest }) => [category, rest]),
  );
}
async function units(member: Page, origin: string, category: string) {
  await member.goto(origin + "/member/test-units");
  const row = member.locator(`[data-test-unit-category="${category}"]`);
  return {
    usable: await row.locator('[data-field="usable"]').innerText(),
    held: await row.locator('[data-field="held"]').innerText(),
  };
}
async function hold(member: Page, origin: string, requestId: string) {
  await member.goto(`${origin}/support/${requestId}`);
  await member.getByLabel("Maximum support and preparation minutes").fill("20");
  await member
    .getByLabel(
      "Hold this ceiling from my existing private support test minutes",
    )
    .check();
  await member
    .getByRole("button", { name: "Hold support test minutes", exact: true })
    .click();
  await expect(
    member.getByRole("status").filter({ hasText: "support test minutes held" }),
  ).toHaveText("20 support test minutes held");
}
const field = (page: Page, name: string) =>
  page.locator(`[data-support-time] [data-field="support.${name}"]`);
const label = (page: Page, name: string) =>
  page
    .locator("[data-support-time] dt")
    .filter({ has: page.locator(`+ dd[data-field="support.${name}"]`) });

test("[F-ROADMAP-07-C] held support minutes come from the support category once, and staff capacity shows the time they reserve", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const f = await reviewedContentFixture(browser, info);
  try {
    const admin = await f.staff("platform_admin"),
      operator = await f.staff("operator");
    const support = supportRequestStore(f.pool);
    const member = await f.member();
    const memberId = await memberReference(member, f.origin);
    const memberToken = (await member.context().cookies()).find(
      (cookie) => cookie.name === COOKIE,
    )!.value;
    const expiry = new Date(Date.now() + 3_600_000);
    // 40 support minutes, and other kinds of minutes that must stay untouched.
    for (const [category, quantity] of [
      ["support_minutes", 40],
      ["coach_minutes", 60],
      ["review_minutes", 30],
    ] as const)
      await syntheticLedger(f.pool).grant(
        memberId,
        category,
        quantity,
        randomUUID(),
        {
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: expiry.toISOString(),
        },
      );
    const request = async (subject: string) => {
      const intake = await support.create(memberToken, {
        idempotencyKey: randomUUID(),
        subject,
        body: "Invented private request text for a browser test.",
      });
      if (!("receipt" in intake)) throw Error("Missing support request");
      return intake.receipt.requestId;
    };
    const allocation = async (requestId: string) => {
      const receipt = await support.time!.receipt(memberToken, requestId);
      if (receipt.kind !== "ready" || !receipt.value)
        throw Error("Missing held support minutes");
      return receipt.value.allocationId;
    };
    const grantOperator = async (requestId: string, allocationId: string) => {
      const granted = await support.time!.grant(admin.token, {
        requestId,
        allocationId,
        staffId: operator.id,
        role: "operator",
        idempotencyKey: randomUUID(),
        startsAt: new Date(Date.now() - 60_000),
        expiresAt: expiry,
      });
      if (!("grantId" in granted)) throw Error("Missing exact time grant");
    };
    const first = await request("Invented first support request");
    const untouched = {
      coach_minutes: {
        available: 60,
        reserved: 0,
        consumed: 0,
        events: "grant:60",
      },
      review_minutes: {
        available: 30,
        reserved: 0,
        consumed: 0,
        events: "grant:30",
      },
    };

    await requiredCheck(1, async () => {
      await hold(member, f.origin, first);
      expect(await balances(f.pool, memberId)).toEqual({
        support_minutes: {
          available: 20,
          reserved: 20,
          consumed: 0,
          events: "grant:40,reserve:20",
        },
        ...untouched,
      });
      expect(await units(member, f.origin, "support_minutes")).toEqual({
        usable: "20",
        held: "20",
      });

      // The operator with the exact grant records 10 support and 5
      // preparation minutes; the other 5 held minutes go back.
      await grantOperator(first, await allocation(first));
      const staff = operator.page;
      await staff.goto(f.origin + "/operator/support-time");
      await staff
        .getByRole("link", { name: `Support test allocation · ${first}` })
        .click();
      await staff
        .getByLabel("Begin this private invented support effort")
        .check();
      await staff
        .getByRole("button", { name: "Begin support test effort", exact: true })
        .click();
      await expect(staff.getByRole("status")).toContainText("State: begun");
      const start = new Date(Date.now() - 3_600_000),
        end = new Date(+start + 600_000),
        prepEnd = new Date(+end + 300_000);
      await staff
        .getByLabel("Support start (UTC)", { exact: true })
        .fill(start.toISOString());
      await staff
        .getByLabel("Support end (UTC)", { exact: true })
        .fill(end.toISOString());
      await staff
        .getByLabel("Preparation start (UTC, optional)")
        .fill(end.toISOString());
      await staff
        .getByLabel("Preparation end (UTC, optional)")
        .fill(prepEnd.toISOString());
      await staff.getByLabel("Record these invented intervals once").check();
      await staff
        .getByRole("button", { name: "Record and settle test effort" })
        .click();
      await expect(staff.getByRole("status")).toContainText("State: completed");
      await expect(
        staff.getByText("Confirmed ceiling: 20. Consumed: 15. Released: 5.", {
          exact: true,
        }),
      ).toBeVisible();
      await staff.reload();
      await expect(
        staff.getByRole("button", { name: "Record and settle test effort" }),
      ).toHaveCount(0);

      // Consumed once, from support minutes only.
      const after = await balances(f.pool, memberId);
      expect(after.support_minutes).toMatchObject({
        available: 25,
        reserved: 0,
        consumed: 15,
      });
      expect(after.support_minutes!.events).toBe(
        "consume:15,grant:40,release:5,reserve:20",
      );
      expect(after.coach_minutes).toEqual(untouched.coach_minutes);
      expect(after.review_minutes).toEqual(untouched.review_minutes);
      await member.goto(`${f.origin}/support/${first}`);
      await expect(
        member.getByText(
          "Confirmed ceiling: 20. Consumed: 15. Released: 5. State: completed.",
          { exact: true },
        ),
      ).toBeVisible();
      expect(await units(member, f.origin, "support_minutes")).toEqual({
        usable: "25",
        held: "0",
      });
      for (const category of CATEGORIES.slice(1))
        expect((await units(member, f.origin, category)).held).toBe("0");
    });

    await requiredCheck(2, async () => {
      // A member can't read staff capacity.
      expect(
        (await member.goto(f.origin + "/operator/staff-capacity"))!.status(),
      ).toBe(403);
      const second = await request("Invented second support request");
      await hold(member, f.origin, second);
      const capacity = admin.page;
      const read = () => capacity.goto(f.origin + "/operator/staff-capacity");

      // The new booking holds 20 minutes, counted once, with nobody on it yet.
      await read();
      await expect(label(capacity, "open")).toHaveText("Open support time (1)");
      await expect(field(capacity, "open")).toHaveText("20 min");
      await expect(label(capacity, "waiting")).toHaveText(
        "Waiting for an operator (1)",
      );
      await expect(field(capacity, "waiting")).toHaveText("20 min");
      await expect(field(capacity, "granted")).toHaveText("0 min");
      await expect(field(capacity, "operators")).toHaveText("0");
      // The first, settled booking is counted as used time, not as open time.
      await expect(field(capacity, "completed")).toHaveText("1");
      await expect(field(capacity, "used")).toHaveText("10 min");
      await expect(field(capacity, "preparation")).toHaveText("5 min");
      expect((await balances(f.pool, memberId)).support_minutes).toMatchObject({
        available: 5,
        reserved: 20,
        consumed: 15,
      });

      // Giving an operator the booking moves it from waiting to granted. It
      // is still one booking of 20 minutes.
      await grantOperator(second, await allocation(second));
      await read();
      await expect(field(capacity, "open")).toHaveText("20 min");
      await expect(label(capacity, "granted")).toHaveText(
        "Granted to an operator (1)",
      );
      await expect(field(capacity, "granted")).toHaveText("20 min");
      await expect(field(capacity, "operators")).toHaveText("1");
      await expect(field(capacity, "waiting")).toHaveText("0 min");
      // Support is shown apart and adds nothing to coaching or review.
      await expect(
        capacity.locator('[data-field="coaching.available"]'),
      ).toHaveText("Not recorded");
      await expect(capacity.locator("[data-review-time]")).toContainText(
        "No review time to compare.",
      );

      // The member cancels the unstarted booking: the time is free again.
      await member.goto(`${f.origin}/support/${second}`);
      await member.getByLabel("Cancel this unstarted allocation").check();
      await member
        .getByRole("button", { name: "Cancel unstarted support allocation" })
        .click();
      await expect(
        member.getByText("State: cancelled.", { exact: false }),
      ).toBeVisible();
      await read();
      await expect(label(capacity, "open")).toHaveText("Open support time (0)");
      await expect(field(capacity, "open")).toHaveText("0 min");
      await expect(field(capacity, "granted")).toHaveText("0 min");
      await expect(field(capacity, "completed")).toHaveText("1");
      await expect(field(capacity, "used")).toHaveText("10 min");
      expect((await balances(f.pool, memberId)).support_minutes).toMatchObject({
        available: 25,
        reserved: 0,
        consumed: 15,
      });
    });
  } finally {
    await f.close();
  }
});
