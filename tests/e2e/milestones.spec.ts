import { test, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4317";

async function onboard(
  page: Page,
  background: string,
  goal: string,
  timezone = "",
) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  if (timezone) await page.getByLabel("Time zone (optional)").fill(timezone);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await page.getByRole("link", { name: "Plan goals and milestones" }).click();
  await expect(page).toHaveURL(/\/milestones$/);
}

async function create(
  page: Page,
  goal: string,
  milestone: string,
  options: { reminder?: boolean; complete?: boolean } = {},
) {
  const form = page.locator('form[action="/milestones"]');
  await form.getByLabel("Learning or project goal").fill(goal);
  await form.getByLabel("Practical milestone").fill(milestone);
  await form
    .getByLabel("Evidence note (sample information only)")
    .fill("I checked the invented source details and found one uncertainty.");
  await form
    .getByLabel("Next action")
    .fill("Compare the next invented example");
  if (options.reminder) {
    await form.getByLabel("Local reminder date (optional)").fill("2028-02-29");
    await form.getByLabel("Local reminder time (optional)").fill("14:30");
  } else {
    await form.getByLabel("Local reminder date (optional)").fill("");
    await form.getByLabel("Local reminder time (optional)").fill("");
  }
  if (options.complete)
    await form.getByLabel(/Mark this milestone complete/).check();
  await form.getByLabel(/I used only invented or sample information/).check();
  await form.getByRole("button", { name: "Save private milestone" }).click();
}

test("[L35] general learner saves a private noncoding milestone and revises direction", async ({
  page,
  browser,
}) => {
  const title = "Compare invented neighborhood plans";
  await onboard(page, "explorer", "everyday");
  await expect(page.getByText("No milestones yet")).toBeVisible();
  await create(page, "Plan a useful local project", title, { reminder: true });
  await expect(page.getByRole("alert")).toContainText("Set your time zone");
  await expect(page.getByText("No milestones yet")).toBeVisible();
  await create(page, "Plan a useful local project", title);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const other = await browser.newContext({ baseURL: origin });
  try {
    const outsider = await other.newPage();
    await onboard(outsider, "explorer", "everyday");
    await expect(outsider.getByText(title)).toHaveCount(0);
  } finally {
    await other.close();
  }
  await page.getByRole("link", { name: "Return to learning" }).click();
  await page.getByLabel("What would you like to do?").selectOption("work");
  await page.getByRole("button", { name: "Save my direction" }).click();
  await page.getByRole("link", { name: "Plan goals and milestones" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
});

test("[L36] professional's local reminder and edit survive reload while stale tabs fail", async ({
  page,
  context,
}) => {
  const title = "Turn invented meeting notes into actions";
  await onboard(page, "professional", "work", "America/Toronto");
  await create(page, "Improve meeting follow-through", title, {
    reminder: true,
  });
  const item = page.locator(".milestone-list li").filter({ hasText: title });
  await expect(item).toContainText("2028-02-29 at 14:30 (America/Toronto)");
  await expect(item).toContainText("shown here only");
  const stale = await context.newPage();
  await stale.goto("/milestones");
  const editor = item.locator("details");
  await editor.locator("summary").click();
  await editor
    .getByLabel("Next action")
    .fill("Review the invented owners and dates");
  await editor.getByLabel(/I used only invented or sample information/).check();
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(item).toContainText("Review the invented owners and dates");
  const staleEditor = stale.locator(".milestone-list li details");
  await staleEditor.locator("summary").click();
  await staleEditor.getByLabel("Next action").fill("Overwrite from stale tab");
  await staleEditor
    .getByLabel(/I used only invented or sample information/)
    .check();
  await staleEditor.getByRole("button", { name: "Save changes" }).click();
  await expect(
    stale.getByRole("heading", { name: "Milestone unchanged" }),
  ).toBeVisible();
  await page.reload();
  await expect(item).toContainText("Review the invented owners and dates");
  await expect(item).not.toContainText("Overwrite from stale tab");
  await item.getByLabel("Delete this private milestone and its note").check();
  await item.getByRole("button", { name: "Delete milestone" }).click();
  await expect(page.getByText("No milestones yet")).toBeVisible();
});

test("[L37] IT learner's self-reported progress cannot be forged or edited by another member", async ({
  page,
  browser,
}) => {
  const title = "Review invented sign-up requirements";
  await onboard(page, "technical", "build");
  await create(page, "Improve a sample QA workflow", title, { complete: true });
  await expect(page.locator(".milestone-list li")).toContainText(
    "complete · self-reported",
  );
  await expect(page.getByText(/NO OUTBOUND REMINDERS/i)).toBeVisible();
  const ownCsrf = await page.locator('input[name="csrf"]').first().inputValue();
  const other = await browser.newContext({ baseURL: origin });
  try {
    const outsider = await other.newPage();
    await onboard(outsider, "professional", "work");
    await create(
      outsider,
      "Plan a synthetic meeting",
      "Different member milestone",
    );
    const action = await outsider
      .locator(".milestone-list li details form")
      .getAttribute("action");
    const form = {
      csrf: ownCsrf,
      version: "1",
      goal_title: "Forged goal",
      milestone_title: "Forged milestone",
      evidence_note: "I checked this invented detail against another sample.",
      next_action: "Overwrite someone else's work",
      sample_only: "yes",
    };
    const denied = await page.request.post(action!, {
      headers: { origin },
      form,
    });
    expect(denied.status()).toBe(409);
    await outsider.reload();
    await expect(
      outsider.getByRole("heading", { name: "Different member milestone" }),
    ).toBeVisible();
    await expect(outsider.getByText("Forged milestone")).toHaveCount(0);
    const csrfDenied = await page.request.post(action!, {
      headers: { origin },
      form: { ...form, csrf: "invalid" },
    });
    expect(csrfDenied.status()).toBe(403);
  } finally {
    await other.close();
  }
});
