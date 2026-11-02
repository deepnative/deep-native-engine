import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { testPool } from "../support/database.ts";

const pool = testPool();
test.afterAll(async () => {
  await pool.end();
});

async function onboard(page: Page) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("professional");
  await chooseLearningGoal(page, "work");
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}
async function saveSample(page: Page, name: string, text: string) {
  await page.getByLabel("Sample title").fill(name);
  await page.getByLabel("Invented text sample").fill(text);
  await page.getByLabel("I created this invented sample").check();
  await page.getByLabel("I explicitly allow this sample").check();
  await page.getByRole("button", { name: "Save private text sample" }).click();
}
async function saved(prefix: string) {
  return Number(
    (
      await pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM evidence_objects WHERE original_name LIKE $1",
        [`${prefix}%`],
      )
    ).rows[0]!.n,
  );
}

test("[L278] a member over the upload budget keeps their typed sample and saves it after waiting", async ({
  page,
}) => {
  const prefix = `admit-${randomBytes(6).toString("hex")}`;
  await onboard(page);
  await page.goto("/evidence");
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  // Nine earlier uploads in this window; the tenth goes through the page.
  for (let i = 1; i <= 9; i++) {
    const response = await page.request.post("/evidence", {
      headers: { Origin: new URL(page.url()).origin },
      form: {
        csrf,
        name: `${prefix}-${i}.txt`,
        sample: "An earlier invented sample.",
        rights_confirmed: "yes",
        private_review_consent: "yes",
      },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
  }
  await page.reload();
  await saveSample(page, `${prefix}-10.txt`, "The tenth invented sample.");
  await expect(page).toHaveURL(/\/evidence$/);
  await expect(
    page.getByRole("heading", { name: `${prefix}-10.txt` }),
  ).toBeVisible();

  await saveSample(page, `${prefix}-kept.txt`, "Invented text I typed.");
  await expect(
    page.getByText(
      /Wait \d+ seconds?, then upload again\. Saved evidence is unchanged\./,
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Sample title")).toHaveValue(
    `${prefix}-kept.txt`,
  );
  await expect(page.getByLabel("Invented text sample")).toHaveValue(
    "Invented text I typed.",
  );
  await expect(
    page.getByRole("heading", { name: `${prefix}-10.txt` }),
  ).toBeVisible();
  expect(await saved(prefix)).toBe(10);

  // Move only this member's window into the past, as if ten minutes passed.
  const aged = await pool.query(
    `UPDATE upload_admission_windows w SET window_start=w.window_start-interval '10 minutes'
     FROM evidence_objects e
     WHERE e.original_name=$1 AND w.pool='member' AND w.principal_id=e.owner_principal_id`,
    [`${prefix}-10.txt`],
  );
  expect(aged.rowCount).toBe(1);
  await page.getByLabel("I created this invented sample").check();
  await page.getByLabel("I explicitly allow this sample").check();
  await page.getByRole("button", { name: "Save private text sample" }).click();
  await expect(page).toHaveURL(/\/evidence$/);
  await expect(
    page.getByRole("heading", { name: `${prefix}-kept.txt` }),
  ).toBeVisible();
  expect(await saved(prefix)).toBe(11);
});
