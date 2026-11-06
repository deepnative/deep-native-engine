import { chooseLearningGoal } from "./choose-learning-goal.ts";
import { createHash, randomBytes } from "node:crypto";
import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import type { Pool } from "pg";
import { authorizationStore } from "./administrator-fixture.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { COOKIE } from "../../src/session.ts";

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export async function onboardProfessional(page: Page) {
  await page.goto("/");
  await page.getByLabel("Display name").fill("Sample learner");
  await page.getByLabel("Your starting point").selectOption("professional");
  await chooseLearningGoal(page, "work");
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

// A member saves an invented text sample through the ordinary form, a test-only
// scanner result marks it clean, and the member queues it for review consideration.
export async function queuedSample(
  page: Page,
  pool: Pool,
  name: string,
  text: string,
) {
  await page.goto("/evidence");
  await page.getByLabel("Sample title").fill(name);
  await page.getByLabel("Invented text sample").fill(text);
  await page.getByLabel("I created this invented sample").check();
  await page.getByLabel("I explicitly allow this sample").check();
  await page.getByRole("button", { name: "Save private text sample" }).click();
  const source = await pool.query<{ id: string; owner: string }>(
    "SELECT id,owner_principal_id AS owner FROM evidence_objects WHERE original_name=$1",
    [name],
  );
  expect(source.rowCount).toBe(1);
  const { id, owner } = source.rows[0]!;
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
    "test-only-scanner-secret",
  );
  expect(await evidence.transitionQuarantine(id, "clean")).toBe(true);
  await page.reload();
  await page
    .getByLabel("No qualified reviewer is assigned", { exact: false })
    .check();
  await page
    .getByRole("button", { name: "Queue for local review consideration" })
    .click();
  const submission = await pool.query<{ id: string }>(
    "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
    [id],
  );
  expect(submission.rowCount).toBe(1);
  return { id, owner, submissionId: submission.rows[0]!.id };
}

// The reviewer has a workspace assignment and one exact grant for one submission.
export async function grantedReviewer(
  browser: Browser,
  pool: Pool,
  origin: string,
  owner: string,
  submissionId: string,
  viewport: { width: number; height: number } | null,
) {
  const auth = authorizationStore(pool);
  const token = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 3_600_000);
  const adminId = await auth.provisionStaff(
    randomBytes(32).toString("hex"),
    "platform_admin",
    expiry,
  );
  const reviewerId = await auth.provisionStaff(token, "reviewer", expiry);
  const assignment = await auth.grantAssignment(
    adminId,
    reviewerId,
    owner,
    "reviewer",
    "Invented browser feedback",
    expiry,
  );
  await auth.grantEvidenceReview(
    adminId,
    reviewerId,
    assignment,
    submissionId,
    "private_sample_feedback_v1",
    expiry,
  );
  const context: BrowserContext = await browser.newContext({
    baseURL: origin,
    viewport,
  });
  await context.addCookies([
    {
      name: COOKIE,
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  return {
    adminId,
    reviewerId,
    context,
    page: await context.newPage(),
    async cleanup() {
      await context.close();
      // The reviewer goes first: its grants, which name the administrator, cascade.
      for (const id of [reviewerId, adminId])
        await pool.query("DELETE FROM principals WHERE id=$1", [id]);
    },
  };
}

export async function fillCriterion(
  reviewer: Page,
  label: string,
  comment: string,
  quote: string,
) {
  await reviewer.getByLabel("Criterion 1 label", { exact: true }).fill(label);
  await reviewer
    .getByLabel("Criterion 1 comment", { exact: true })
    .fill(comment);
  await reviewer
    .getByLabel("Criterion 1 exact source quote", { exact: true })
    .fill(quote);
  await reviewer
    .getByRole("button", { name: "Save private feedback draft" })
    .click();
}

export async function publishSavedFeedback(reviewer: Page) {
  await reviewer.getByRole("checkbox").check();
  await reviewer
    .getByRole("button", { name: "Publish saved feedback" })
    .click();
  await expect(
    reviewer.getByRole("heading", { name: "Published sample feedback" }),
  ).toBeVisible();
}
