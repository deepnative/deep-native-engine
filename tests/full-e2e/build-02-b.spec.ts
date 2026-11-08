import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";
import {
  fillCriterion,
  grantedReviewer,
  onboardProfessional,
  publishSavedFeedback,
  queuedSample,
  sha256,
} from "../support/sample-feedback-journey.ts";
import { browserOrigin as origin } from "../support/browser-origin.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

test("[F-BUILD-02-B] an assigned reviewer's published feedback references only the authorized pinned version", async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  const run = randomBytes(6).toString("hex");
  const pinnedText = `An invented team checks each factual claim ${run}.`;
  const otherText = `A separate invented sample about budget notes ${run}.`;
  const comment = `Name who checks each claim in the invented notes ${run}.`;
  await onboardProfessional(page);
  const pinned = await queuedSample(
    page,
    pool,
    `pinned-${run}.txt`,
    pinnedText,
  );
  const other = await queuedSample(page, pool, `other-${run}.txt`, otherText);
  const reviewer = await grantedReviewer(
    browser,
    pool,
    origin,
    pinned.owner,
    pinned.submissionId,
    page.viewportSize(),
  );
  try {
    await requiredCheck(1, async () => {
      // The same member's other queued sample is not covered by the exact grant.
      const otherPath = `/review/evidence/${other.id}/feedback`;
      expect((await reviewer.page.goto(otherPath))!.status()).toBe(403);
      await expect(reviewer.page.locator("body")).not.toContainText(otherText);

      await reviewer.page.goto(`/review/evidence/${pinned.id}/feedback`);
      await expect(reviewer.page.locator("details pre")).toHaveText(pinnedText);
      await expect(reviewer.page.locator("body")).not.toContainText(otherText);

      // A quote from outside the authorized version cannot be attached to it.
      await fillCriterion(reviewer.page, "Claim checks", comment, otherText);
      await expect(
        reviewer.page.getByRole("button", { name: "Publish saved feedback" }),
      ).toHaveCount(0);
      expect(
        (
          await pool.query(
            "SELECT id FROM private_sample_feedback WHERE submission_id=$1",
            [pinned.submissionId],
          )
        ).rowCount,
      ).toBe(0);

      await reviewer.page.goto(`/review/evidence/${pinned.id}/feedback`);
      await fillCriterion(
        reviewer.page,
        "Claim checks",
        comment,
        "An invented team",
      );
      await publishSavedFeedback(reviewer.page);

      const published = await pool.query(
        `SELECT f.submission_id,f.reviewer_id,f.source_sha256,f.source_revision,
                f.criteria->0->>'quote' AS quote
         FROM private_sample_feedback f
         WHERE f.submission_id = ANY($1) AND f.published_at IS NOT NULL`,
        [[pinned.submissionId, other.submissionId]],
      );
      expect(published.rows).toEqual([
        {
          submission_id: pinned.submissionId,
          reviewer_id: reviewer.reviewerId,
          source_sha256: sha256(pinnedText),
          source_revision: 1,
          quote: "An invented team",
        },
      ]);

      await page.goto(`/evidence/${pinned.id}/feedback`);
      const article = page.locator("article").filter({
        has: page.getByRole("heading", { name: "Published sample feedback" }),
      });
      await expect(article).toContainText("source version 1");
      await expect(article.locator("blockquote")).toHaveText(
        "An invented team",
      );
      await expect(article).toContainText(comment);
      await expect(article).not.toContainText(otherText);

      await page.goto(`/evidence/${other.id}/feedback`);
      await expect(
        page.getByText("No published feedback is available for this sample."),
      ).toBeVisible();
      await expect(page.locator("body")).not.toContainText(comment);
    });
  } finally {
    await reviewer.cleanup();
  }
});
