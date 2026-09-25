import { createHash } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

async function onboard(page: Page, specialty: "security" | "analysis") {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("technical");
  await page
    .getByLabel("What would you like to do?")
    .selectOption(specialty === "security" ? "build" : "work");
  await page
    .getByRole("group", { name: "IT specialties (optional)" })
    .getByLabel(
      specialty === "security" ? "Cybersecurity" : "Business analysis",
    )
    .check();
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
  await expect(
    page.getByRole("region", { name: "Your starter plan" }),
  ).toBeVisible();
}

async function member(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (item) => item.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const tokenHash = createHash("sha256").update(cookie!.value).digest("hex");
  const result = await pool.query<{
    id: string;
    background: string;
    goal: string;
    it_roles: string[];
  }>("SELECT id,background,goal,it_roles FROM learners WHERE token_hash=$1", [
    tokenHash,
  ]);
  expect(result.rowCount).toBe(1);
  return result.rows[0]!;
}

async function complete(page: Page, instruction: string) {
  await page.getByLabel("Your instruction to AI").fill(instruction);
  await page
    .getByLabel("How will you check the result?")
    .fill(
      "Compare each suggestion with the invented brief and mark unsupported details.",
    );
  await page.getByLabel("I checked the context").check();
  await page.getByRole("button", { name: "Complete exercise" }).click();
  await expect(
    page.getByText("Exercise completed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No AI or qualified reviewer has assessed it."),
  ).toBeVisible();
}

test("[F-BUILD-01-A] cybersecurity learner uses common local foundation without specialist purchase", async ({
  page,
  context,
}) => {
  await requiredCheck(1, async () => {
    await onboard(page, "security");
    const owner = await member(context);
    expect(owner).toMatchObject({
      background: "technical",
      goal: "build",
      it_roles: ["security"],
    });
    await page.getByRole("link", { name: "Open lesson" }).click();
    await expect(
      page.getByRole("heading", { name: "Review a sign-up flow" }),
    ).toBeVisible();
    await complete(
      page,
      "Using the invented sign-up flow, suggest invalid-input and privacy checks without using real accounts.",
    );
    const saved = await pool.query<{
      lesson_id: string;
      lesson_version: number;
      completed_at: Date | null;
    }>(
      "SELECT lesson_id,lesson_version,completed_at FROM exercises WHERE learner_id=$1",
      [owner.id],
    );
    expect(saved.rows).toMatchObject([
      { lesson_id: "clear-instructions", lesson_version: 1 },
    ]);
    expect(saved.rows[0]!.completed_at).not.toBeNull();
    const paid = await pool.query(
      "SELECT id FROM synthetic_entitlement_grants WHERE member_id=$1",
      [owner.id],
    );
    expect(paid.rowCount).toBe(0);
    await page.goto("/readiness/tracks");
    await expect(
      page.getByRole("listitem").filter({ hasText: "Cybersecurity" }),
    ).toContainText("in preparation");
    await expect(
      page.getByRole("button", { name: /book|buy|purchase/i }),
    ).toHaveCount(0);
  });
});

test("[F-BUILD-01-B] business-analysis learner completes a noncoding local exercise", async ({
  page,
  context,
}) => {
  await requiredCheck(1, async () => {
    await onboard(page, "analysis");
    const owner = await member(context);
    expect(owner).toMatchObject({
      background: "technical",
      goal: "work",
      it_roles: ["analysis"],
    });
    await page.getByRole("link", { name: "Open lesson" }).click();
    await expect(
      page.getByRole("heading", { name: "Turn meeting notes into next steps" }),
    ).toBeVisible();
    await expect(page.getByText("Sam will write the checklist")).toBeVisible();
    await complete(
      page,
      "Turn the invented meeting notes into a plain-language action list with owners, dates, and missing details.",
    );
    await page.reload();
    await expect(
      page.getByText("Exercise completed", { exact: true }),
    ).toBeVisible();
    const saved = await pool.query<{
      goal_at_start: string;
      lesson_id: string;
      lesson_version: number;
      completed_at: Date | null;
    }>(
      "SELECT goal_at_start,lesson_id,lesson_version,completed_at FROM exercises WHERE learner_id=$1",
      [owner.id],
    );
    expect(saved.rows).toMatchObject([
      {
        goal_at_start: "work",
        lesson_id: "clear-instructions",
        lesson_version: 1,
      },
    ]);
    expect(saved.rows[0]!.completed_at).not.toBeNull();
    const paid = await pool.query(
      "SELECT id FROM synthetic_entitlement_grants WHERE member_id=$1",
      [owner.id],
    );
    expect(paid.rowCount).toBe(0);
    await page.goto("/readiness/tracks");
    await expect(
      page.getByRole("listitem").filter({ hasText: "Business analysis" }),
    ).toContainText("in preparation");
    await expect(
      page.getByRole("button", { name: /book|buy|purchase/i }),
    ).toHaveCount(0);
  });
});
