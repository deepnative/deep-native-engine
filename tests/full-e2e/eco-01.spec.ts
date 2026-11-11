import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { createHash } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";
import { browserOrigin as origin } from "../support/browser-origin.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

async function startGeneralLearner(page: Page) {
  await page.goto("/");
  await page.getByLabel("Display name").fill("Sample learner");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await chooseLearningGoal(page, "everyday");
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
    // The product's own access statement, and no paid step as button or link.
    const paidStep = /\b(buy|purchase|checkout|pay)\b|accept offer/i;
    await expect(
      page.getByText("No-charge foundation access.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /buy|purchase|accept offer/i }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: paidStep })).toHaveCount(0);
    await expect(page.getByRole("link", { name: paidStep })).toHaveCount(0);
    // Entering: the lesson and its exercise form open with no gate in between.
    await page.getByRole("link", { name: "Open lesson" }).click();
    await expect(page).toHaveURL(/\/lesson$/);
    await expect(
      page.getByRole("heading", { name: "Plan a small community event" }),
    ).toBeVisible();
    await expect(page.getByLabel("Your instruction to AI")).toBeEditable();
    await expect(
      page.getByRole("button", { name: "Complete exercise" }),
    ).toBeEnabled();
    await expect(page.getByRole("button", { name: paidStep })).toHaveCount(0);
    await expect(page.getByRole("link", { name: paidStep })).toHaveCount(0);
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
      // Exercise progress has no id-addressable route: every surface resolves
      // the member from the session cookie, so each one is opened as the
      // outsider and must show none of the owner's work.
      await otherPage.goto("/learn");
      await expect(
        otherPage.getByRole("progressbar", { name: "Exercises completed" }),
      ).toHaveAttribute("value", "0");
      await otherPage.goto("/lesson");
      await expect(
        otherPage.getByRole("heading", {
          name: "Plan a small community event",
        }),
      ).toBeVisible();
      await expect(otherPage.getByText(instruction)).toHaveCount(0);
      await expect(otherPage.getByLabel("Your instruction to AI")).toHaveValue(
        "",
      );
      await otherPage.goto("/progress");
      await expect(
        otherPage.getByRole("heading", {
          name: "Your private learning activity",
        }),
      ).toBeVisible();
      await expect(
        otherPage.getByText("No learning activity has been saved", {
          exact: false,
        }),
      ).toBeVisible();
      await expect(otherPage.locator("main")).not.toContainText(
        "Self-reported complete",
      );
      const exported = await otherPage.request.get("/api/member/export");
      expect(exported.status()).toBe(200);
      expect((await exported.json()).profile.id).toBe(outsiderId);
      expect(await exported.text()).not.toContain(instruction);
      // Control: the same surfaces do show the work to its owner.
      await page.goto("/lesson");
      await expect(page.getByText(instruction)).toBeVisible();
      await page.goto("/progress");
      await expect(page.locator("main")).toContainText(
        "Self-reported complete",
      );
      expect(
        await (await page.request.get("/api/member/export")).text(),
      ).toContain(instruction);
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
