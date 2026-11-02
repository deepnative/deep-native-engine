import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { PREPARED_SAMPLES } from "../../src/prepared-sample-values.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
test.afterAll(async () => {
  await pool.end();
});

test("[L279] a member over the upload budget keeps a refused provided copy and repeats it after waiting", async ({
  page,
}) => {
  const prefix = `copy-admit-${randomBytes(6).toString("hex")}`;
  const example = PREPARED_SAMPLES[0]!;
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await chooseLearningGoal(page, "everyday");
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
  await page.goto("/evidence");
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  // Ten earlier uploads use this member's whole window.
  for (let i = 1; i <= 10; i++) {
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

  await page
    .getByRole("link", { name: "Use a prepared invented sample", exact: true })
    .click();
  const chosen = page.locator(`[data-prepared-template="${example.id}"]`);
  await chosen
    .getByLabel("I understand this is a provided invented example", {
      exact: false,
    })
    .check();
  await chosen
    .getByLabel("I separately permit private review of my copy", {
      exact: false,
    })
    .check();
  await chosen
    .getByRole("button", { name: "Create my private provided copy" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Provided copy needs attention" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Wait \d+ seconds?, then upload again\. Saved evidence is unchanged\./,
    ),
  ).toBeVisible();
  const repeat = page.getByRole("button", {
    name: "Repeat this original copy instruction",
  });
  await expect(repeat).toBeVisible();
  const copies = async () =>
    Number(
      (
        await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM provided_evidence_origins o
           JOIN evidence_objects e ON e.id=o.evidence_id
           WHERE e.owner_principal_id=(SELECT owner_principal_id FROM evidence_objects WHERE original_name=$1)`,
          [`${prefix}-1.txt`],
        )
      ).rows[0]!.n,
    );
  expect(await copies()).toBe(0);

  // Move only this member's window into the past, as if ten minutes passed.
  const aged = await pool.query(
    `UPDATE upload_admission_windows w SET window_start=w.window_start-interval '10 minutes'
     FROM evidence_objects e
     WHERE e.original_name=$1 AND w.pool='member' AND w.principal_id=e.owner_principal_id`,
    [`${prefix}-1.txt`],
  );
  expect(aged.rowCount).toBe(1);
  await page
    .getByLabel("I understand this is a provided invented example", {
      exact: false,
    })
    .check();
  await page
    .getByLabel("I separately permit private review of my copy", {
      exact: false,
    })
    .check();
  await repeat.click();
  await expect(
    page.getByRole("heading", { name: "Your provided-copy receipt" }),
  ).toBeVisible();
  await expect(
    page.getByText("Your exact private provided copy was saved."),
  ).toBeVisible();
  expect(await copies()).toBe(1);
});
