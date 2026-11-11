import { createHash, randomBytes } from "node:crypto";
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { browserOrigin as origin } from "../support/browser-origin.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";
import { grantedReviewer } from "../support/sample-feedback-journey.ts";

const pool = testPool();
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

async function fitsNarrowViewport(page: Page, controls: Locator[]) {
  const documentWidth = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(documentWidth.content).toBeLessThanOrEqual(documentWidth.viewport + 1);
  for (const control of controls) {
    await expect(control).toBeVisible();
    const bounds = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        viewport: window.innerWidth,
      };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(-1);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
  }
}

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 80; step += 1) {
    await page.keyboard.press("Tab");
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      await expect(target).toBeFocused();
      const focus = await target.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          visible: element.matches(":focus-visible"),
          width: parseFloat(style.outlineWidth),
          style: style.outlineStyle,
        };
      });
      expect(focus).toEqual({ visible: true, width: 3, style: "solid" });
      return;
    }
  }
  throw new Error("Keyboard Tab could not reach the named control");
}

// The member-to-reviewer part of the journey: an invented sample the member
// saves and queues, and the page its assigned reviewer works on.
const SAMPLE = "An invented volunteer rota lists three small tasks.";
const QUOTE = "three small tasks";
const evidenceControls = (page: Page) => ({
  title: page.getByLabel("Sample title"),
  sample: page.getByLabel("Invented text sample"),
  rights: page.getByLabel(
    "I created this invented sample and have the right to store it.",
  ),
  consent: page.getByLabel(
    "I explicitly allow this sample to be considered for private review",
    { exact: false },
  ),
  save: page.getByRole("button", { name: "Save private text sample" }),
});
const queueControls = (page: Page, title: string) => {
  const item = page.getByRole("listitem").filter({ hasText: title });
  return {
    item,
    acknowledge: item.getByLabel("No qualified reviewer is assigned", {
      exact: false,
    }),
    queue: item.getByRole("button", {
      name: "Queue for local review consideration",
    }),
  };
};
const reviewerControls = (page: Page) => ({
  label: page.getByLabel("Criterion 1 label", { exact: true }),
  comment: page.getByLabel("Criterion 1 comment", { exact: true }),
  quote: page.getByLabel("Criterion 1 exact source quote", { exact: true }),
  save: page.getByRole("button", { name: "Save private feedback draft" }),
});
const siteLearningLink = (page: Page) =>
  page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Learning", exact: true });
// A test-only scanner result marks the member's saved sample clean.
async function scanClean(owner: string, title: string) {
  const row = await pool.query<{ id: string }>(
    "SELECT id FROM evidence_objects WHERE owner_principal_id=$1 AND original_name=$2",
    [owner, title],
  );
  expect(row.rowCount).toBe(1);
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
    "test-only-scanner-secret",
  );
  expect(await evidence.transitionQuarantine(row.rows[0]!.id, "clean")).toBe(
    true,
  );
  return row.rows[0]!.id;
}
async function queuedSubmission(evidenceId: string) {
  const submitted = await pool.query<{ id: string; status: string }>(
    "SELECT id,status FROM evidence_review_submissions WHERE evidence_id=$1",
    [evidenceId],
  );
  expect(submitted.rows).toHaveLength(1);
  expect(submitted.rows[0]!.status).toBe("queued");
  return submitted.rows[0]!.id;
}

test("[F-BUILD-10-A] narrow layout and keyboard-only core learning journey", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(120_000);
  await requiredCheck(1, async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page
      .getByLabel("Display name", { exact: true })
      .fill("Narrow learner");
    const background = page.getByLabel("Your starting point");
    const goal = page.getByRole("radio", {
      name: "Understand AI and try something useful",
      exact: true,
    });
    await expect(page.locator('input[name="synthetic"]')).toHaveCount(0);
    const start = page.getByRole("button", { name: "Start my learning path" });
    await fitsNarrowViewport(page, [background, goal, start]);
    await background.selectOption("explorer");
    await goal.check();
    await start.click();
    await expect(page).toHaveURL(/\/learn$/);
    const open = page.getByRole("link", { name: "Open lesson" });
    await fitsNarrowViewport(page, [open]);
    await open.click();
    const instruction = page.getByLabel("Your instruction to AI");
    const verification = page.getByLabel("How will you check the result?");
    const checked = page.getByLabel("I checked the context");
    const complete = page.getByRole("button", { name: "Complete exercise" });
    await fitsNarrowViewport(page, [
      instruction,
      verification,
      checked,
      complete,
    ]);
    await instruction.fill(
      "Use invented event details to propose three practical steps and identify unknowns.",
    );
    await verification.fill(
      "Compare each step to the invented brief and correct any unsupported claim.",
    );
    await checked.check();
    await complete.click();
    await expect(
      page.getByText("Exercise completed", { exact: true }),
    ).toBeVisible();
    const progress = page.getByRole("link", { name: "See your progress" });
    await fitsNarrowViewport(page, [progress]);
    await progress.click();
    await expect(page.getByText("Completed · self-assessed")).toBeVisible();
    const activity = page.getByRole("link", {
      name: "View private learning activity",
    });
    await fitsNarrowViewport(page, [activity]);
    await activity.click();
    await fitsNarrowViewport(page, [
      page.getByRole("heading", { name: "Your private learning activity" }),
      page.getByText("starter exercise · version 1 · Self-reported complete"),
    ]);
    const owner = await memberId(context);
    const saved = await pool.query(
      "SELECT completed_at FROM exercises WHERE learner_id=$1",
      [owner],
    );
    expect(saved.rowCount).toBe(1);
    expect(saved.rows[0]!.completed_at).not.toBeNull();

    // The site navigation fits at this width and leads back to the path.
    await fitsNarrowViewport(page, [siteLearningLink(page)]);
    await siteLearningLink(page).click();
    await expect(page).toHaveURL(/\/learn$/);
    const manage = page.getByRole("link", { name: "Manage private evidence" });
    await fitsNarrowViewport(page, [manage]);
    await manage.click();
    // The member saves a sample and queues it for review at this width.
    const title = `narrow-${randomBytes(4).toString("hex")}.txt`;
    const form = evidenceControls(page);
    await fitsNarrowViewport(page, Object.values(form));
    await form.title.fill(title);
    await form.sample.fill(SAMPLE);
    await form.rights.check();
    await form.consent.check();
    await form.save.click();
    const evidenceId = await scanClean(owner, title);
    await page.reload();
    const queued = queueControls(page, title);
    await fitsNarrowViewport(page, [queued.acknowledge, queued.queue]);
    await queued.acknowledge.check();
    await queued.queue.click();
    await expect(queued.item).toContainText(
      "Submitted locally; no qualified review is connected",
    );
    await fitsNarrowViewport(page, [queued.item]);
    // The assigned reviewer's working page fits the same width.
    const reviewer = await grantedReviewer(
      browser,
      pool,
      origin,
      owner,
      await queuedSubmission(evidenceId),
      { width: 375, height: 812 },
    );
    try {
      await reviewer.page.goto(`/review/evidence/${evidenceId}/feedback`);
      await expect(reviewer.page.locator("details pre")).toHaveText(SAMPLE);
      await fitsNarrowViewport(reviewer.page, [
        reviewer.page.getByRole("heading", { name: "Review private sample" }),
        ...Object.values(reviewerControls(reviewer.page)),
      ]);
    } finally {
      await reviewer.cleanup();
    }
  });

  await requiredCheck(2, async () => {
    await context.clearCookies();
    await page.goto("/");
    const name = page.getByLabel("Display name", { exact: true });
    await tabTo(page, name);
    await page.keyboard.type("Keyboard learner");
    const background = page.getByLabel("Your starting point");
    await tabTo(page, background);
    await page.keyboard.press("e");
    await expect(background).toHaveValue("explorer");
    const goal = page.getByRole("radio", {
      name: "Understand AI and try something useful",
      exact: true,
    });
    await tabTo(page, goal);
    await page.keyboard.press("Space");
    await expect(goal).toBeChecked();
    await expect(page.locator('input[name="synthetic"]')).toHaveCount(0);
    await tabTo(
      page,
      page.getByRole("button", { name: "Start my learning path" }),
    );
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/learn$/);
    await tabTo(page, page.getByRole("link", { name: "Open lesson" }));
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Plan a small community event" }),
    ).toBeVisible();
    await tabTo(page, page.getByLabel("Your instruction to AI"));
    await page.keyboard.type(
      "Use invented notes to draft an accessible three-step community event plan.",
    );
    await tabTo(page, page.getByLabel("How will you check the result?"));
    await page.keyboard.type(
      "Compare the plan to the invented notes and flag any unsupported detail.",
    );
    await tabTo(page, page.getByLabel("I checked the context"));
    await page.keyboard.press("Space");
    await tabTo(page, page.getByRole("button", { name: "Complete exercise" }));
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("Exercise completed", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No AI or qualified reviewer has assessed it."),
    ).toBeVisible();
    await tabTo(page, page.getByRole("link", { name: "See your progress" }));
    await page.keyboard.press("Enter");
    await expect(page.getByText("Completed · self-assessed")).toBeVisible();
    await tabTo(
      page,
      page.getByRole("link", { name: "View private learning activity" }),
    );
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Your private learning activity" }),
    ).toBeVisible();
    await expect(
      page.getByText("starter exercise · version 1 · Self-reported complete"),
    ).toBeVisible();
    const owner = await memberId(context);
    const saved = await pool.query(
      "SELECT completed_at FROM exercises WHERE learner_id=$1",
      [owner],
    );
    expect(saved.rowCount).toBe(1);
    expect(saved.rows[0]!.completed_at).not.toBeNull();

    // By keyboard alone: site navigation, then saving and queuing a sample.
    await tabTo(page, siteLearningLink(page));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/learn$/);
    await tabTo(
      page,
      page.getByRole("link", { name: "Manage private evidence" }),
    );
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Your private evidence" }),
    ).toBeVisible();
    const title = `keyboard-${randomBytes(4).toString("hex")}.txt`;
    const form = evidenceControls(page);
    await tabTo(page, form.title);
    await page.keyboard.type(title);
    await tabTo(page, form.sample);
    await page.keyboard.type(SAMPLE);
    await tabTo(page, form.rights);
    await page.keyboard.press("Space");
    await tabTo(page, form.consent);
    await page.keyboard.press("Space");
    await tabTo(page, form.save);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("listitem").filter({ hasText: title }),
    ).toBeVisible();
    const evidenceId = await scanClean(owner, title);
    await page.reload();
    const queued = queueControls(page, title);
    await tabTo(page, queued.acknowledge);
    await page.keyboard.press("Space");
    await tabTo(page, queued.queue);
    await page.keyboard.press("Enter");
    await expect(queued.item).toContainText(
      "Submitted locally; no qualified review is connected",
    );
    // The assigned reviewer writes and saves a feedback draft by keyboard.
    const submissionId = await queuedSubmission(evidenceId);
    const reviewer = await grantedReviewer(
      browser,
      pool,
      origin,
      owner,
      submissionId,
      page.viewportSize(),
    );
    try {
      await reviewer.page.goto(`/review/evidence/${evidenceId}/feedback`);
      const draft = reviewerControls(reviewer.page);
      await tabTo(reviewer.page, draft.label);
      await reviewer.page.keyboard.type("Task list");
      await tabTo(reviewer.page, draft.comment);
      await reviewer.page.keyboard.type("Name who does each invented task.");
      await tabTo(reviewer.page, draft.quote);
      await reviewer.page.keyboard.type(QUOTE);
      await tabTo(reviewer.page, draft.save);
      await reviewer.page.keyboard.press("Enter");
      await expect(
        reviewer.page.getByRole("button", { name: "Publish saved feedback" }),
      ).toBeVisible();
      const drafts = await pool.query(
        "SELECT id FROM private_sample_feedback WHERE submission_id=$1",
        [submissionId],
      );
      expect(drafts.rowCount).toBe(1);
    } finally {
      await reviewer.cleanup();
    }
  });
});
