import { test, expect, type Page } from "@playwright/test";
import { addDays, dayLabel } from "../../src/coaching-values.ts";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";

// #832 slice B (owner, 12 November 2026): an administrator sets each
// student's billing period; the student reports hours per period and a
// period is invoiced only after it ends. Synthetic staff credentials stay
// out of traces; every person, rate and hour is invented.
test.use({ trace: "off" });
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("[L339] PERIOD832-01/02/03/04/10 an administrator sets a two-week billing period; the student reports per period, only the ended period is invoiced, and a new length waits for the next period", async ({
  browser,
}, info) => {
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    const today = (
      await f.pool.query<{ today: string }>(
        "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today",
      )
    ).rows[0]!.today;
    const day = (offset: number) => addDays(today, offset);
    // Two weeks from 20 days ago: one period has ended, one is running.
    const ended = `${dayLabel(day(-20))} to ${dayLabel(day(-7))}`,
      running = `${dayLabel(day(-6))} to ${dayLabel(day(7))}`;

    // 1. The student registers and, with no billing period, reports by month.
    const s = await f.member();
    await s.goto(f.origin + "/account");
    const id = await s.locator("code").first().innerText();
    await s.goto(f.origin + "/account/coaching");
    await expect(s.getByLabel("Calendar month (UTC)")).toBeVisible();
    await expect(
      s.getByRole("heading", { name: "Your billing period" }),
    ).toHaveCount(0);

    // 2. The administrator sets the rate, then the billing period: two weeks
    //    is preselected and the first period's start date is asked for.
    const a = (await f.staff("platform_admin")).page;
    await a.goto(`${f.origin}/operator/coaching/${id}`);
    await a.getByLabel("Hourly rate (CAD)").fill("120.00");
    await a.getByLabel("Effective month").fill(day(-400).slice(0, 7));
    await a.getByRole("button", { name: "Save hourly rate" }).click();
    const billing = a.getByRole("region", { name: "Billing period" });
    await expect(billing).toContainText(
      "No billing period is set, so this student reports hours by calendar month.",
    );
    await expect(a.getByLabel("Billing period length")).toHaveValue("14");
    await a.getByLabel("First period starts on (UTC date)").fill(day(-20));
    await a.getByRole("button", { name: "Save billing period" }).click();
    await expect(billing).toContainText(
      `This student’s billing period: 2 weeks, from ${dayLabel(day(-20))}.`,
    );
    await expect(billing).toContainText(
      `A new length applies from ${dayLabel(day(8))}, the day after the current period ends.`,
    );
    await expect(a.getByLabel("First period starts on (UTC date)")).toHaveCount(
      0,
    );
    expect(await noSidewaysScroll(a)).toBe(true);
    await a.screenshot({
      path: info.outputPath("admin-billing-period.png"),
      fullPage: true,
    });

    // 3. The student now picks a period: the running one is open, and the
    //    one that ended is offered. They report 10 hours for the ended one.
    await s.goto(f.origin + "/account/coaching");
    await expect(
      s.getByRole("region", { name: "Your billing period" }),
    ).toContainText(`2 weeks, from ${dayLabel(day(-20))}`);
    const picker = s.locator('select[name="month"]');
    await expect(picker.locator("option")).toHaveText([
      `${running} (current)`,
      ended,
    ]);
    await expect(s.getByRole("heading", { name: running })).toBeVisible();
    const report = async (period: string, hours: string) => {
      await picker.selectOption({ label: period });
      await s.getByRole("button", { name: "Open period" }).click();
      await s.getByLabel("Whole hours").fill(hours);
      await s.getByLabel("Additional minutes").fill("0");
      await s
        .getByLabel("Invoice recipient name")
        .fill("Invented period student");
      await s
        .getByLabel("Invoice email")
        .fill("period-student@example.invalid");
      await s.getByRole("button", { name: "Save coaching draft" }).click();
      await s
        .getByRole("checkbox", { name: /I confirm this saved duration/ })
        .check();
      await s.getByRole("button", { name: "Request coaching invoice" }).click();
      await expect(s.getByText("Status: Awaiting review")).toBeVisible();
    };
    await report(ended, "10");
    await expect(s.getByRole("heading", { name: ended })).toBeVisible();
    await report(`${running} (current)`, "5");
    const saved = s.locator("table.coaching-months");
    await expect(saved.getByRole("columnheader").first()).toHaveText("Period");
    await expect(saved.getByRole("row")).toHaveCount(3);
    await expect(saved).toContainText(running);
    await expect(saved).toContainText(ended);
    await expect(saved).toContainText("CAD 1200.00");
    expect(await noSidewaysScroll(s)).toBe(true);
    await s.screenshot({
      path: info.outputPath("student-periods.png"),
      fullPage: true,
    });

    // 4. Both periods await review. The running one cannot be invoiced yet.
    await a.goto(f.origin + "/operator/coaching");
    const pending = a
      .locator("section.portal-card")
      .filter({ has: a.getByRole("heading", { name: "Pending periods" }) });
    await expect(pending.getByRole("link")).toHaveText([
      `Sample learner · ${ended}`,
      `Sample learner · ${running}`,
    ]);
    await pending
      .getByRole("link", { name: `Sample learner · ${running}` })
      .click();
    await expect(
      a.getByText(
        `This period ends on ${dayLabel(day(7))}. Its invoice can be issued from ${dayLabel(day(8))} (UTC date)`,
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      a.getByRole("button", { name: "Issue coaching invoice" }),
    ).toHaveCount(0);

    // 5. The ended period is invoiced, and the invoice names its dates.
    await a.goto(f.origin + "/operator/coaching");
    await pending
      .getByRole("link", { name: `Sample learner · ${ended}` })
      .click();
    await a
      .getByRole("checkbox", {
        name: /I reviewed this exact submitted revision/,
      })
      .check();
    await a.getByRole("button", { name: "Issue coaching invoice" }).click();
    await expect(
      a.getByRole("heading", { name: "Invoice", exact: true }),
    ).toBeVisible();
    await expect(a.locator(".invoice-document")).toContainText(
      `Billing period: ${ended}`,
    );
    await expect(a.locator(".invoice-document")).toContainText(
      `Coaching · ${day(-20)} to ${day(-7)}`,
    );
    await expect(a.locator(".invoice-document")).toContainText("CAD 1200.00");
    expect(await noSidewaysScroll(a)).toBe(true);

    // 6. The administrator chooses one week. It starts when the running
    //    period ends, and nothing the student saved changes.
    await a.goto(`${f.origin}/operator/coaching/${id}`);
    await a.getByLabel("Billing period length").selectOption("7");
    await a.getByRole("button", { name: "Save billing period" }).click();
    await expect(billing).toContainText(
      `2 weeks, from ${dayLabel(day(-20))}; then 1 week from ${dayLabel(day(8))}`,
    );
    await s.goto(f.origin + "/account/coaching");
    await expect(
      s.getByRole("region", { name: "Your billing period" }),
    ).toContainText(`then 1 week from ${dayLabel(day(8))}`);
    await expect(picker.locator("option")).toHaveText([
      `${running} (current)`,
      ended,
    ]);
    await expect(saved.getByRole("row")).toHaveCount(3);
    await expect(saved).toContainText("Invoiced · CAD 1200.00 due");
    await saved.getByRole("link", { name: "View invoice" }).click();
    await expect(s.locator(".invoice-document")).toContainText(
      `Billing period: ${ended}`,
    );
    expect(await noSidewaysScroll(s)).toBe(true);

    // 7. Change history names who set the billing period, twice.
    await a.goto(f.origin + "/operator/changes");
    await expect(
      a.getByText(
        `set the coaching billing period for Sample learner, starting ${day(-20)}.`,
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      a.getByText(
        `set the coaching billing period for Sample learner, starting ${day(8)}.`,
        { exact: false },
      ),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});
