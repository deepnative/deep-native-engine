import { createHash } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

async function startGeneralLearner(page: Page) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

async function learnerId(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (item) => item.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const tokenHash = createHash("sha256").update(cookie!.value).digest("hex");
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM learners WHERE token_hash=$1",
    [tokenHash],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0]!.id;
}

async function completeNoncodingExercise(page: Page, instruction: string) {
  await page.getByRole("link", { name: "Open lesson" }).click();
  await expect(
    page.getByRole("heading", { name: "Plan a small community event" }),
  ).toBeVisible();
  await page.getByLabel("Your instruction to AI").fill(instruction);
  await page
    .getByLabel("How will you check the result?")
    .fill(
      "Compare each proposed action with the invented event brief and check the time limit.",
    );
  await page.getByLabel("I checked the context").check();
  await page.getByRole("button", { name: "Complete exercise" }).click();
  await expect(
    page.getByText("Exercise completed", { exact: true }),
  ).toBeVisible();
}

test("[F-ECO-01-A] exploratory member enters foundation without employment, IT approval or coaching", async ({
  page,
  context,
}) => {
  await requiredCheck(1, async () => {
    await startGeneralLearner(page);
    const id = await learnerId(context);
    const result = await pool.query(
      `SELECT l.background, l.goal, l.it_roles, p.kind
       FROM learners l JOIN principals p ON p.id=l.id WHERE l.id=$1`,
      [id],
    );
    expect(result.rows[0]).toMatchObject({
      background: "explorer",
      goal: "everyday",
      it_roles: [],
      kind: "member",
    });
  });
  await requiredCheck(2, async () => {
    await expect(
      page.getByRole("region", { name: "Your starter plan" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Open lesson" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /buy|purchase|accept offer/i }),
    ).toHaveCount(0);
  });
});

test("[F-ECO-01-B] general learner completes a noncoding foundation exercise", async ({
  page,
  context,
}) => {
  await startGeneralLearner(page);
  const instruction =
    "Using the invented event details, make a short accessible plan with three actions.";
  await requiredCheck(1, async () => {
    await completeNoncodingExercise(page, instruction);
    await expect(
      page.getByText("No AI or qualified reviewer has assessed it."),
    ).toBeVisible();
    const id = await learnerId(context);
    const result = await pool.query(
      "SELECT instruction, completed_at FROM exercises WHERE learner_id=$1",
      [id],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].instruction).toBe(instruction);
    expect(result.rows[0].completed_at).not.toBeNull();
  });
});

test("[F-ECO-01-C] completed progress persists for owner and stays private from another member", async ({
  page,
  context,
  browser,
}) => {
  await startGeneralLearner(page);
  const instruction =
    "Private invented event plan for the owner only; keep this sample text separate.";
  await completeNoncodingExercise(page, instruction);
  const ownerId = await learnerId(context);
  await requiredCheck(1, async () => {
    await page.getByRole("link", { name: "See your progress" }).click();
    await page.reload();
    await expect(
      page.getByRole("progressbar", { name: "Exercises completed" }),
    ).toHaveAttribute("value", "1");
  });

  await requiredCheck(2, async () => {
    const outsider = await browser.newContext({ baseURL: origin });
    try {
      const otherPage = await outsider.newPage();
      await startGeneralLearner(otherPage);
      const outsiderId = await learnerId(outsider);
      expect(outsiderId).not.toBe(ownerId);
      await otherPage.goto(`/learn?learner_id=${ownerId}`);
      await expect(
        otherPage.getByRole("progressbar", { name: "Exercises completed" }),
      ).toHaveAttribute("value", "0");
      await otherPage.goto(`/lesson?learner_id=${ownerId}`);
      await expect(otherPage.getByText(instruction)).toHaveCount(0);
      const rows = await pool.query(
        "SELECT learner_id FROM exercises WHERE learner_id=ANY($1::uuid[])",
        [[ownerId, outsiderId]],
      );
      expect(rows.rows.map((row) => row.learner_id)).toEqual([ownerId]);
    } finally {
      await outsider.close();
    }
  });
});
