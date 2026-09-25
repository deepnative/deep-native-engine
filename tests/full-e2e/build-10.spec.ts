import { createHash } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

async function memberId(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (item) => item.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const hash = createHash("sha256").update(cookie!.value).digest("hex");
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM learners WHERE token_hash=$1",
    [hash],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0]!.id;
}

async function startMember(page: Page) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

test("[F-BUILD-10-B] invalid input recovers and an empty member gets an honest next action", async ({
  page,
  context,
  browser,
}) => {
  let ownerId = "";
  await requiredCheck(1, async () => {
    await page.goto("/");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await page
      .getByLabel("What would you like to do?")
      .selectOption("everyday");
    await page.getByLabel("Time zone (optional)").fill("Mars/Olympus");
    await page.getByLabel("I'll use invented or sample information").check();
    await page.getByRole("button", { name: "Start my learning path" }).click();
    await expect(page.getByRole("alert")).toContainText("time zone");
    await expect(page).not.toHaveURL(/\/learn$/);

    const cookie = (await context.cookies()).find(
      (item) => item.name === "dne_preview",
    );
    expect(cookie).toBeDefined();
    const hash = createHash("sha256").update(cookie!.value).digest("hex");
    const uncreated = await pool.query(
      "SELECT id FROM learners WHERE token_hash=$1",
      [hash],
    );
    expect(uncreated.rowCount).toBe(0);

    await page.getByLabel("Your starting point").selectOption("explorer");
    await page
      .getByLabel("What would you like to do?")
      .selectOption("everyday");
    await page.getByLabel("Time zone (optional)").fill("America/Toronto");
    await page.getByLabel("I'll use invented or sample information").check();
    await page.getByRole("button", { name: "Start my learning path" }).click();
    await expect(page).toHaveURL(/\/learn$/);
    ownerId = await memberId(context);

    await page.getByRole("link", { name: "Open lesson" }).click();
    const instruction =
      "Using only an invented brief, draft three practical actions and name missing information.";
    await page.getByLabel("Your instruction to AI").fill(instruction);
    await page.getByLabel("How will you check the result?").fill("Check notes");
    await page.getByLabel("I checked the context").check();
    await page.getByRole("button", { name: "Complete exercise" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "How will you check the result?",
    );
    await expect(page.getByLabel("Your instruction to AI")).toHaveValue(
      instruction,
    );
    const correction = page.getByLabel("How will you check the result?");
    await expect(correction).toHaveValue("Check notes");
    await expect(correction).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Your draft is saved")).toHaveCount(0);
    const absent = await pool.query(
      "SELECT completed_at FROM exercises WHERE learner_id=$1",
      [ownerId],
    );
    expect(absent.rowCount).toBe(0);

    await correction.fill(
      "Compare each action to the invented brief, verify sources and correct unsupported claims.",
    );
    await page.getByLabel("I checked the context").check();
    await page.getByRole("button", { name: "Complete exercise" }).click();
    await expect(
      page.getByText("Exercise completed", { exact: true }),
    ).toBeVisible();
    const completed = await pool.query<{ completed_at: Date | null }>(
      "SELECT completed_at FROM exercises WHERE learner_id=$1",
      [ownerId],
    );
    expect(completed.rowCount).toBe(1);
    expect(completed.rows[0]!.completed_at).not.toBeNull();
  });

  await requiredCheck(2, async () => {
    const other = await browser.newContext({ baseURL: origin });
    try {
      const otherPage = await other.newPage();
      await startMember(otherPage);
      const outsiderId = await memberId(other);
      expect(outsiderId).not.toBe(ownerId);
      await otherPage.goto(`/progress?member_id=${ownerId}`);
      await expect(
        otherPage.getByRole("heading", {
          name: "Your private learning activity",
        }),
      ).toBeVisible();
      await expect(
        otherPage.getByText(
          "No learning activity has been saved in this preview yet",
        ),
      ).toBeVisible();
      await expect(otherPage.locator("main ol > li")).toHaveCount(0);
      await expect(otherPage.getByText("Self-reported complete")).toHaveCount(
        0,
      );
      const outsiderRows = await pool.query(
        "SELECT lesson_id FROM exercises WHERE learner_id=$1",
        [outsiderId],
      );
      expect(outsiderRows.rowCount).toBe(0);
      await otherPage
        .getByRole("link", { name: "Open your starter plan" })
        .click();
      await expect(otherPage).toHaveURL(/\/learn$/);
      await expect(otherPage.getByRole("progressbar")).toHaveAttribute(
        "value",
        "0",
      );
      const ownerRows = await pool.query(
        "SELECT lesson_id FROM exercises WHERE learner_id=$1 AND completed_at IS NOT NULL",
        [ownerId],
      );
      expect(ownerRows.rowCount).toBe(1);
    } finally {
      await other.close();
    }
  });
});
