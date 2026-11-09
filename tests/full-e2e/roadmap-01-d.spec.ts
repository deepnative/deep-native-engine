import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
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

test("[F-ROADMAP-01-D] revising evidence keeps feedback pinned and the portfolio export says the work was simulated", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90_000);
  const run = randomBytes(6).toString("hex");
  const originalText = `An invented first version naming owners ${run}.`;
  const revisedText = `A revised invented version adding dates ${run}.`;
  const comment = `Add a date for each named owner ${run}.`;
  const name = `original-${run}.txt`;
  const revisedName = `revised-${run}.txt`;
  await onboardProfessional(page);
  const source = await queuedSample(page, pool, name, originalText);
  const reviewer = await grantedReviewer(
    browser,
    pool,
    origin,
    source.owner,
    source.submissionId,
    page.viewportSize(),
  );
  const ownerPath = `/evidence/${source.id}/feedback`;
  try {
    await reviewer.page.goto(`/review/evidence/${source.id}/feedback`);
    await fillCriterion(
      reviewer.page,
      "Named owners",
      comment,
      "An invented first version",
    );
    await publishSavedFeedback(reviewer.page);

    await requiredCheck(1, async () => {
      await page.goto("/evidence");
      await page
        .getByRole("link", { name: `Create a new private revision of ${name}` })
        .click();
      await page.getByLabel("Revised sample title").fill(revisedName);
      await page
        .getByLabel("New invented text", { exact: true })
        .fill(revisedText);
      await page.getByLabel("I created this new invented text").check();
      await page.getByLabel("I separately allow this revision").check();
      await page
        .getByRole("button", { name: "Save new private revision" })
        .click();

      const revised = (
        await pool.query<{ id: string; sha256: string }>(
          "SELECT id,sha256 FROM evidence_objects WHERE original_name=$1",
          [revisedName],
        )
      ).rows[0]!;
      expect(revised.id).not.toBe(source.id);
      expect(revised.sha256).toBe(sha256(revisedText));
      await page.goto("/evidence");
      await expect(
        page.locator("li").filter({
          has: page.getByRole("heading", { name: revisedName }),
        }),
      ).toContainText("Private evidence version 2");

      // The retained feedback row still names the original bytes and version.
      const retained = await pool.query(
        `SELECT f.source_sha256,f.source_revision,s.evidence_id
         FROM private_sample_feedback f
         JOIN evidence_review_submissions s ON s.id=f.submission_id
         WHERE f.published_at IS NOT NULL AND s.evidence_id = ANY($1)`,
        [[source.id, revised.id]],
      );
      expect(retained.rows).toEqual([
        {
          source_sha256: sha256(originalText),
          source_revision: 1,
          evidence_id: source.id,
        },
      ]);

      await page.goto(ownerPath);
      const article = page.locator("article").filter({
        has: page.getByRole("heading", { name: "Published sample feedback" }),
      });
      await expect(article).toContainText("source version 1");
      await expect(article).toContainText(comment);
      await expect(page.locator("details pre")).toHaveText(originalText);
      await expect(page.locator("body")).not.toContainText(revisedText);

      // The earlier grant does not reach the revision.
      expect(
        (await reviewer.page.goto(
          `/review/evidence/${revised.id}/feedback`,
        ))!.status(),
      ).toBe(403);
      await expect(reviewer.page.locator("body")).not.toContainText(
        revisedText,
      );
    });

    await requiredCheck(2, async () => {
      const auth = authorizationStore(pool);
      const catalog = catalogStore(pool);
      const expiry = new Date(Date.now() + 3_600_000);
      const editor = randomBytes(32).toString("hex");
      const editorialReviewer = randomBytes(32).toString("hex");
      await auth.provisionStaff(editor, "editor", expiry);
      await auth.provisionStaff(editorialReviewer, "reviewer", expiry);
      const id =
        info.project.name === "desktop-chromium" ? "RMD-101" : "RMD-102";
      const title = `Invented portfolio assignment ${run}`;
      const draft: DraftContent = {
        id,
        version: 1,
        kind: "assignment",
        origin: "curated",
        title,
        body: "Use invented details and check the outcome against this brief.",
        owner: "Synthetic editor",
        sources: "Original invented brief",
        rights: "Owned sample",
        goals: ["work"],
        backgrounds: ["professional"],
        domains: [],
        prerequisites: "None",
        minimumExperience: "new",
        rubric: "Compare the answer with the source.",
        rubricVersion: 1,
      };
      expect(await catalog.createDraft(editor, draft)).toBe(true);
      expect(await catalog.submit(editor, id, 1)).toBe(true);
      expect(await catalog.approve(editorialReviewer, id, 1, true)).toBe(true);
      expect(await catalog.publish(editor, id, 1)).toBe(true);
      try {
        const answer = `Invented portfolio response ${run}.`;
        await page.goto("/learn");
        const choices = page.getByRole("region", {
          name: "Choose a practice assignment",
        });
        await choices.getByRole("button", { name: `Choose ${title}` }).click();
        await choices
          .getByRole("button", {
            name: "Start or return to this private attempt",
          })
          .click();
        await page.getByLabel("Private sample response").fill(answer);
        await page
          .getByLabel("I used only invented or sample information")
          .check();
        await page.getByRole("button", { name: "Save private draft" }).click();
        await page.getByLabel("Submit this saved version locally").check();
        await page
          .getByRole("button", { name: "Submit saved version locally" })
          .click();
        await expect(
          page.getByText(
            "These submitted versions and their portfolio statements are simulated, self-authored and unreviewed.",
            { exact: false },
          ),
        ).toBeVisible();
        const downloadPromise = page.waitForEvent("download");
        await page
          .getByRole("link", {
            name: "Download simulated portfolio statement for submission 1",
          })
          .click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe(
          "simulated-portfolio-submission-1.html",
        );
        const html = await readFile((await download.path())!, "utf8");
        expect(html).toContain("SIMULATED · SELF-AUTHORED · UNREVIEWED");
        expect(html).toContain(answer);
      } finally {
        // Later journeys count the assignments offered to this audience.
        expect(await catalog.retire(editor, id)).toBe(true);
      }
    });
  } finally {
    await reviewer.cleanup();
  }
});
