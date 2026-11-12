import { test, expect, type Page } from "@playwright/test";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";

// #832 slice A (owner, 12 November 2026): an administrator can change hours a
// student saved or submitted, with a reason, and cannot enter new hours.
// Synthetic staff credentials stay out of traces; every person, rate, hour
// and reason is invented.
test.use({ trace: "off" });
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("[L338] OVR832-01/03/06/07/08 an administrator changes a student's submitted hours with a reason; the student sees it and the invoice uses the changed figure", async ({
  browser,
}, info) => {
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    // 1. The student registers; their reference is on My account.
    const s = await f.member();
    await s.goto(f.origin + "/account");
    const id = await s.locator("code").first().innerText();

    // 2. Before the student saves hours, the administrator is offered no way
    //    to enter them, and sets the agreed rate.
    const a = (await f.staff("platform_admin")).page;
    await a.goto(`${f.origin}/operator/coaching/${id}`);
    await expect(
      a.getByText(
        "The student has not saved hours for this month. An administrator cannot enter new hours for a student; once the student saves hours, you can change them here.",
      ),
    ).toBeVisible();
    await expect(a.getByRole("button", { name: "Change hours" })).toHaveCount(
      0,
    );
    await a.getByLabel("Hourly rate (CAD)").fill("120.00");
    await a.getByRole("button", { name: "Save hourly rate" }).click();
    await expect(
      a.getByText("Applicable rate: CAD 120.00 per hour"),
    ).toBeVisible();

    // 3. The student saves 10 hours and requests the invoice.
    await s.goto(f.origin + "/account/coaching");
    await s.getByLabel("Whole hours").fill("10");
    await s.getByLabel("Additional minutes").fill("0");
    await s
      .getByLabel("Invoice recipient name")
      .fill("Invented override student");
    await s
      .getByLabel("Invoice email")
      .fill("override-student@example.invalid");
    await s.getByRole("button", { name: "Save coaching draft" }).click();
    await s
      .getByRole("checkbox", { name: /I confirm this saved duration/ })
      .check();
    await s.getByRole("button", { name: "Request coaching invoice" }).click();
    await expect(s.getByText("Status: Awaiting review")).toBeVisible();

    // 4. The administrator must give a reason, then changes 10 hours to 8.
    await a.reload();
    await expect(
      a.getByRole("heading", { name: "Change this student’s hours" }),
    ).toBeVisible();
    await expect(a.getByLabel("Whole hours")).toHaveValue("10");
    await a.getByLabel("Whole hours").fill("8");
    await a.getByRole("button", { name: "Change hours" }).click();
    // The browser holds the form until a reason is typed.
    await expect(a.getByLabel("Reason for the change")).toBeFocused();
    await expect(a.getByText("Status: submitted · revision 2")).toBeVisible();
    await a
      .getByLabel("Reason for the change")
      .fill("Invented: two sessions were cancelled");
    await a.getByRole("button", { name: "Change hours" }).click();
    await expect(
      a.getByRole("heading", { name: "Hours changed by an administrator" }),
    ).toBeVisible();
    await expect(a.locator("ul.hours-changes li")).toContainText(
      "from 10 hours 0 minutes to 8 hours 0 minutes",
    );
    await expect(a.locator("ul.hours-changes li")).toContainText(
      "Reason: Invented: two sessions were cancelled",
    );
    await expect(a.getByText("Status: submitted · revision 3")).toBeVisible();
    await expect(
      a.getByText(
        /8 hours 0 minutes · CAD 120\.00 per hour · rate version 1 · subtotal CAD 960\.00/,
      ),
    ).toBeVisible();
    expect(await noSidewaysScroll(a)).toBe(true);
    await a.screenshot({
      path: info.outputPath("admin-changed-hours.png"),
      fullPage: true,
    });

    // 5. The student sees the earlier figure, the new one and the reason,
    //    without the administrator, on the page and in Download my records.
    await s.goto(f.origin + "/account/coaching");
    await expect(
      s.getByText(
        "An administrator changed the hours you reported here. Your earlier figure is kept below.",
      ),
    ).toBeVisible();
    await expect(s.locator("ul.hours-changes li")).toContainText(
      "from 10 hours 0 minutes to 8 hours 0 minutes",
    );
    await expect(s.locator("ul.hours-changes li")).toContainText(
      "Reason: Invented: two sessions were cancelled",
    );
    await expect(s.locator("ul.hours-changes li")).not.toContainText("by ");
    await expect(s.locator("table.coaching-months")).toContainText(
      "8h changed by an administrator",
    );
    await expect(s.getByRole("button", { name: "Change hours" })).toHaveCount(
      0,
    );
    expect(await noSidewaysScroll(s)).toBe(true);
    await s.screenshot({
      path: info.outputPath("student-sees-change.png"),
      fullPage: true,
    });
    const exported = await (
      await s.request.get(f.origin + "/api/member/export")
    ).json();
    expect(exported.records.coachingHoursOverrides).toMatchObject([
      {
        previousMinutes: 600,
        minutes: 480,
        reason: "Invented: two sessions were cancelled",
        stateWhenChanged: "submitted",
      },
    ]);

    // 6. The invoice is issued on the changed figure.
    await a
      .getByRole("checkbox", {
        name: /I reviewed this exact submitted revision/,
      })
      .check();
    await a.getByRole("button", { name: "Issue coaching invoice" }).click();
    await expect(
      a.getByRole("heading", { name: "Invoice", exact: true }),
    ).toBeVisible();
    await expect(a.locator(".invoice-document")).toContainText("960.00");

    // 7. An issued month offers no change; Change history names the change.
    await a.goto(`${f.origin}/operator/coaching/${id}`);
    await expect(a.getByText(/Status: invoiced/)).toBeVisible();
    await expect(a.getByRole("button", { name: "Change hours" })).toHaveCount(
      0,
    );
    await a.goto(f.origin + "/operator/changes");
    await expect(
      a.getByText(
        /changed the coaching hours Sample learner reported for \d{4}-\d{2}\./,
      ),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});
