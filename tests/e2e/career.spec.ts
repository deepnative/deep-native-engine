import { test, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4317";

async function onboard(page: Page, background: string, goal: string) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await page
    .getByRole("link", { name: "Explore optional career planning" })
    .click();
}

async function enable(page: Page) {
  await page.getByLabel("Turn on optional private career planning").check();
  await page.getByRole("button", { name: "Turn on career planning" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Career, opportunity and contract plans",
    }),
  ).toBeVisible();
}

test("[L38] general learner keeps common milestones without career fields and can opt in later", async ({
  page,
}) => {
  await onboard(page, "explorer", "everyday");
  await expect(
    page.getByText("Career, opportunity and contract records are off"),
  ).toBeVisible();
  await expect(page.locator('input[name="self_reported_outcome"]')).toHaveCount(
    0,
  );
  await page.getByRole("link", { name: "Return to learning" }).click();
  await page.getByRole("link", { name: "Plan goals and milestones" }).click();
  const milestone = page.locator('form[action="/milestones"]');
  await milestone
    .getByLabel("Learning or project goal")
    .fill("Learn to compare invented plans");
  await milestone
    .getByLabel("Practical milestone")
    .fill("Review two sample plans");
  await milestone.getByLabel("Next action").fill("Compare both sources");
  await milestone
    .getByLabel(/I used only invented or sample information/)
    .check();
  await milestone
    .getByRole("button", { name: "Save private milestone" })
    .click();
  await page.getByRole("link", { name: "Return to learning" }).click();
  await page
    .getByRole("link", { name: "Explore optional career planning" })
    .click();
  await enable(page);
  const record = page.locator('form[action="/career/entries"]');
  await record.getByLabel("Planning kind").selectOption("career");
  await record
    .getByLabel("Private title")
    .fill("Explore an invented future direction");
  await record.getByLabel("Next action").fill("Read a sample role description");
  await record
    .getByLabel("Self-reported outcome (optional)")
    .fill("I may revisit this later");
  await record.getByLabel(/I used only invented or sample information/).check();
  await record.getByRole("button", { name: "Save planning record" }).click();
  await expect(
    page.getByRole("heading", { name: "Explore an invented future direction" }),
  ).toBeVisible();
  await expect(
    page.getByText("I may revisit this later · self-reported, not verified"),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Explore an invented future direction" }),
  ).toBeVisible();
  await page
    .getByLabel(/Delete all optional career records and drafts/)
    .check();
  await page
    .getByRole("button", { name: "Turn off and delete career planning" })
    .click();
  await expect(
    page.getByText("Career, opportunity and contract records are off"),
  ).toBeVisible();
  await page.getByRole("link", { name: "Return to learning" }).click();
  await page.getByRole("link", { name: "Plan goals and milestones" }).click();
  await expect(
    page.getByRole("heading", { name: "Review two sample plans" }),
  ).toBeVisible();
});

test("[L39] professional approves only a current private draft version and can withdraw", async ({
  page,
  context,
}) => {
  await onboard(page, "professional", "work");
  await enable(page);
  const form = page.locator('form[action="/career/drafts"]');
  await form.getByLabel("Draft kind").selectOption("proposal");
  await form.getByLabel("Draft title").fill("Invented operations proposal");
  await form
    .getByLabel("Private draft text")
    .fill(
      "I would compare two invented operations examples and document uncertainty.",
    );
  await form.getByLabel(/I used only invented or sample information/).check();
  await form.getByRole("button", { name: "Save unsent draft" }).click();
  const item = page
    .locator(".career-list li")
    .filter({ hasText: "Invented operations proposal" });
  await expect(item).toContainText("unapproved · unsent");
  const stale = await context.newPage();
  await stale.goto("/career");
  await item.getByLabel(/Approve this exact private draft version/).check();
  await item.getByRole("button", { name: "Approve private draft" }).click();
  await expect(item).toContainText("member approved · unsent");
  const staleItem = stale
    .locator(".career-list li")
    .filter({ hasText: "Invented operations proposal" });
  await staleItem
    .getByLabel(/Approve this exact private draft version/)
    .check();
  await staleItem
    .getByRole("button", { name: "Approve private draft" })
    .click();
  await expect(
    stale.getByRole("heading", { name: "Career planning unchanged" }),
  ).toBeVisible();
  await item.locator("details summary").click();
  await item
    .getByLabel("Private draft text")
    .fill(
      "I revised the invented proposal and added a new sample review step.",
    );
  await item.getByLabel(/I used only invented or sample information/).check();
  await item.getByRole("button", { name: "Save draft changes" }).click();
  await expect(item).toContainText("unapproved · unsent");
  await item.getByLabel(/Approve this exact private draft version/).check();
  await item.getByRole("button", { name: "Approve private draft" }).click();
  await item.getByLabel("Withdraw approval for this draft").check();
  await item.getByRole("button", { name: "Withdraw approval" }).click();
  await expect(item).toContainText("unapproved · unsent");
});

test("[L40] IT member's optional contract notes and renewal draft stay private", async ({
  page,
  browser,
}) => {
  await onboard(page, "technical", "build");
  await enable(page);
  const record = page.locator('form[action="/career/entries"]');
  await record.getByLabel("Planning kind").selectOption("contract");
  await record.getByLabel("Private title").fill("Invented support renewal");
  await record.getByLabel("Next action").fill("Review a sample scope");
  await record.getByLabel(/I used only invented or sample information/).check();
  await record.getByRole("button", { name: "Save planning record" }).click();
  const form = page.locator('form[action="/career/drafts"]');
  await form.getByLabel("Draft kind").selectOption("renewal");
  await form.getByLabel("Draft title").fill("Sample renewal note");
  await form
    .getByLabel("Private draft text")
    .fill(
      "This invented renewal note has no real counterparty or delivery path.",
    );
  await form.getByLabel(/I used only invented or sample information/).check();
  await form.getByRole("button", { name: "Save unsent draft" }).click();
  const action = await page
    .locator(".career-list li")
    .filter({ hasText: "Sample renewal note" })
    .locator('form[action$="/approve"]')
    .getAttribute("action");
  const other = await browser.newContext({ baseURL: origin });
  try {
    const outsider = await other.newPage();
    await onboard(outsider, "explorer", "everyday");
    await enable(outsider);
    await expect(outsider.getByText("Invented support renewal")).toHaveCount(0);
    await expect(outsider.getByText("Sample renewal note")).toHaveCount(0);
    const csrf = await outsider
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    const denied = await outsider.request.post(action!, {
      headers: { origin },
      form: { csrf, version: "1", confirm: "yes" },
    });
    expect(denied.status()).toBe(409);
    const csrfDenied = await page.request.post(action!, {
      headers: { origin },
      form: { csrf: "invalid", version: "1", confirm: "yes" },
    });
    expect(csrfDenied.status()).toBe(403);
  } finally {
    await other.close();
  }
  await expect(page.getByText("NO OUTREACH")).toBeVisible();
});
