import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { start } from "../../src/runtime.ts";
import { COOKIE } from "../../src/session.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";
import {
  fillCriterion,
  grantedReviewer,
} from "../support/sample-feedback-journey.ts";

const pool = testPool();
const firstRubric = "First rubric: name the source of each invented claim.";
const secondRubric = "Second rubric: name the source and one missing detail.";
let running: Awaited<ReturnType<typeof start>>, root: string;

// Assignment feedback is off by default, so these run on their own listener with
// that setting on. The hosted site does not enable it (#545).
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dne94-rubric-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: root,
    DNE_ASSIGNMENT_HANDOFF: "enabled",
  });
});
test.afterAll(async () => {
  await running?.close();
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});

async function publishedAssignment() {
  const auth = authorizationStore(pool),
    catalog = catalogStore(pool);
  const editor = randomBytes(32).toString("hex"),
    approver = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 3_600_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(approver, "reviewer", expiry);
  const letters = Array.from(randomBytes(3), (byte) =>
    String.fromCharCode(65 + (byte % 26)),
  ).join("");
  const number = String(randomBytes(2).readUInt16BE() % 1000).padStart(3, "0");
  const id = `RP${letters}-${number}`;
  const first: DraftContent = {
    id,
    version: 1,
    kind: "assignment",
    origin: "curated",
    title: `Invented rubric project ${id}`,
    body: "First brief: compare two invented meeting notes.",
    owner: "Synthetic curriculum editor",
    sources: "Original invented brief",
    rights: "Owned synthetic example",
    goals: ["work"],
    backgrounds: ["professional"],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric: firstRubric,
    rubricVersion: 1,
  };
  const publish = async (draft: DraftContent) => {
    expect(await catalog.createDraft(editor, draft)).toBe(true);
    expect(await catalog.submit(editor, id, draft.version)).toBe(true);
    expect(await catalog.approve(approver, id, draft.version, true)).toBe(true);
    expect(await catalog.publish(editor, id, draft.version)).toBe(true);
  };
  await publish(first);
  const second: DraftContent = {
    ...first,
    version: 2,
    body: "Second brief: compare three invented meeting notes.",
    rubric: secondRubric,
    rubricVersion: 2,
  };
  return {
    first,
    second,
    editor,
    approver,
  };
}

// A staff browser on this spec's own listener. Only the staff identity is
// seeded; everything it does goes through the editor pages.
async function staffPage(browser: Browser, token: string) {
  const context = await browser.newContext({ baseURL: running.origin });
  await context.addCookies([
    {
      name: COOKIE,
      value: token,
      url: running.origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  return { context, page: await context.newPage() };
}

async function saveDraft(page: Page, draft: DraftContent) {
  await page.goto("/editor/library");
  await page.getByLabel("Content ID").fill(draft.id);
  await page.getByLabel("Version", { exact: true }).fill(String(draft.version));
  await page.getByLabel("Kind").selectOption(draft.kind);
  await page.getByLabel("Title").fill(draft.title);
  await page.getByLabel("Body").fill(draft.body);
  await page.getByLabel("Owner").fill(draft.owner);
  await page.getByLabel("Sources").fill(draft.sources);
  await page.getByLabel("Rights").fill(draft.rights);
  for (const goal of draft.goals)
    await page.locator(`input[name="goals"][value="${goal}"]`).check();
  for (const background of draft.backgrounds)
    await page
      .locator(`input[name="backgrounds"][value="${background}"]`)
      .check();
  await page
    .getByLabel("Legacy prerequisite (optional)")
    .fill(draft.prerequisites);
  await page.getByLabel("Assignment rubric (optional)").fill(draft.rubric!);
  await page
    .getByLabel("Rubric version (required with rubric)")
    .fill(String(draft.rubricVersion));
  await page.getByRole("button", { name: "Save draft" }).click();
}

// Version 2 goes out the way staff do it: the editor saves and submits a
// draft, a different reviewer approves it, and the editor publishes it.
async function publishSecondThroughPages(
  browser: Browser,
  work: Awaited<ReturnType<typeof publishedAssignment>>,
) {
  const path = `/editor/library/${work.second.id}/2`;
  const editor = await staffPage(browser, work.editor);
  const approver = await staffPage(browser, work.approver);
  try {
    await saveDraft(editor.page, work.second);
    await expect(editor.page).toHaveURL(new RegExp(`${path}$`));
    await expect(editor.page.getByText("Versioned rubric 2")).toBeVisible();
    await editor.page.locator(`form[action="${path}/submit"] button`).click();
    await approver.page.goto(path);
    const approval = approver.page.locator(`form[action="${path}/approve"]`);
    await approval.locator('input[name="rights_confirmed"]').check();
    await approval.getByRole("button").click();
    await expect(
      approver.page.locator("p.eyebrow").filter({
        hasText: "APPROVED · VERSION 2",
      }),
    ).toBeVisible();
    await editor.page.goto(path);
    await editor.page.locator(`form[action="${path}/publish"] button`).click();
    await expect(
      editor.page.locator("p.eyebrow").filter({
        hasText: "PUBLISHED · VERSION 2",
      }),
    ).toBeVisible();
  } finally {
    await editor.context.close();
    await approver.context.close();
  }
}

async function onboard(page: Page) {
  await page.goto(`${running.origin}/`);
  await page.getByLabel("Display name").fill("Sample learner");
  await page.getByLabel("Your starting point").selectOption("professional");
  await chooseLearningGoal(page, "work");
  await page
    .getByRole("button", { name: "Start my learning path", exact: true })
    .click();
  const token = (await page.context().cookies()).find(
    (cookie) => cookie.name === COOKIE,
  )!.value;
  const member = await store(pool).session(token);
  if (member.kind !== "active") throw Error("Invented member missing");
  return member.learner.id;
}

async function startAttempt(page: Page, title: string) {
  const choices = page.getByRole("region", {
    name: "Choose a practice assignment",
    exact: true,
  });
  await choices
    .getByRole("button", { name: `Choose ${title}`, exact: true })
    .click();
  await choices
    .getByRole("button", {
      name: "Start or return to this private attempt",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  return page.url();
}

async function submit(page: Page, response: string) {
  await page
    .getByLabel("Your private response", { exact: true })
    .fill(response);
  await page
    .getByLabel("This response is mine to use for private learning", {
      exact: false,
    })
    .check();
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await page
    .getByLabel("Save this exact submitted version.", { exact: false })
    .check();
  await page
    .getByRole("button", { name: "Submit saved version", exact: true })
    .click();
  await expect(page.locator("#submission-1 pre").first()).toHaveText(response);
}

// One member completes version 1 and an assigned reviewer publishes feedback
// through the ordinary pages. Only the reviewer's grant is seeded.
async function reviewedSubmission(page: Page, browser: Browser) {
  const assignment = await publishedAssignment();
  const run = randomBytes(6).toString("hex");
  const response = `An invented team checks each claim ${run}.`;
  const comment = `Name who checks the invented claim ${run}.`;
  const memberId = await onboard(page);
  const attemptUrl = await startAttempt(page, assignment.first.title);
  await expect(page.getByText("Original rubric version 1")).toBeVisible();
  await submit(page, response);

  await page
    .locator("#submission-1")
    .getByRole("link", {
      name: "Prepare feedback for submission 1",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Original rubric · version 1" }),
  ).toBeVisible();
  await page
    .getByLabel("Create a private feedback copy of this submitted version.", {
      exact: false,
    })
    .check();
  await page
    .getByRole("button", { name: "Create private feedback copy", exact: true })
    .click();
  const copyId = (await page
    .locator("[data-assignment-evidence]")
    .getAttribute("data-assignment-evidence"))!;
  await page
    .getByRole("link", {
      name: "Manage private copies and request feedback",
      exact: true,
    })
    .click();
  const item = page
    .locator("li")
    .filter({ has: page.locator(`form[action="/evidence/${copyId}/delete"]`) });
  await item
    .getByLabel("No qualified reviewer is assigned", { exact: false })
    .check();
  await item
    .getByRole("button", {
      name: "Queue for local review consideration",
      exact: true,
    })
    .click();
  await expect(item).toContainText("Submitted locally");
  const submission = await pool.query<{ id: string }>(
    "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
    [copyId],
  );
  expect(submission.rowCount).toBe(1);
  const submissionId = submission.rows[0]!.id;

  const reviewer = await grantedReviewer(
    browser,
    pool,
    running.origin,
    memberId,
    submissionId,
    page.viewportSize(),
  );
  await reviewer.page.goto(`/review/evidence/${copyId}/feedback`);
  await fillCriterion(reviewer.page, "Claim checks", comment, "An invented");
  await reviewer.page
    .getByLabel("Publish saved draft version", { exact: false })
    .check();
  await reviewer.page
    .getByRole("button", { name: "Publish saved feedback", exact: true })
    .click();
  await expect(
    reviewer.page.getByRole("heading", {
      name: "Published assignment feedback",
    }),
  ).toBeVisible();

  const feedbackPath = `${running.origin}/evidence/${copyId}/feedback`;
  return {
    ...assignment,
    memberId,
    attemptUrl,
    copyId,
    submissionId,
    comment,
    feedbackPath,
    reviewer,
    pinnedLine: `assignment ${assignment.first.id} · version 1 · submission 1 · rubric 1`,
  };
}

const pin = async (copyId: string) =>
  (
    await pool.query(
      "SELECT content_id,content_version,rubric_version FROM assignment_evidence_origins WHERE evidence_id=$1",
      [copyId],
    )
  ).rows;
const feedbackRow = async (submissionId: string) =>
  (
    await pool.query(
      "SELECT id,criteria,source_sha256,published_at FROM private_sample_feedback WHERE submission_id=$1",
      [submissionId],
    )
  ).rows;

test("[F-ROADMAP-06-A] feedback on version-one work pins that content and rubric version", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const work = await reviewedSubmission(page, browser);
  try {
    await requiredCheck(1, async () => {
      await page.goto(work.feedbackPath);
      await expect(page.locator("body")).toContainText(work.pinnedLine);
      await expect(page.getByText(work.comment, { exact: true })).toBeVisible();
      expect(await pin(work.copyId)).toEqual([
        {
          content_id: work.first.id,
          content_version: 1,
          rubric_version: 1,
        },
      ]);
    });
    await requiredCheck(2, async () => {
      // The result itself names rubric 1, on the page and in its stored origin.
      const expectPinned = async () => {
        await page.goto(work.feedbackPath);
        await expect(page.locator("body")).toContainText(work.pinnedLine);
        expect(await pin(work.copyId)).toMatchObject([{ rubric_version: 1 }]);
        await page.goto(work.attemptUrl);
        await expect(page.getByText("Original rubric version 1")).toBeVisible();
        await expect(
          page.getByText(firstRubric, { exact: true }),
        ).toBeVisible();
      };
      await expectPinned();

      // An editor cannot replace version 1 with a different rubric.
      const editor = await staffPage(browser, work.editor);
      try {
        await saveDraft(editor.page, { ...work.first, rubric: secondRubric });
        await expect(
          editor.page.getByRole("heading", { name: "Draft not saved" }),
        ).toBeVisible();
      } finally {
        await editor.context.close();
      }
      // Nor can the stored reference or the published rubric be rewritten.
      await expect(
        pool.query(
          "UPDATE assignment_evidence_origins SET rubric_version=2 WHERE evidence_id=$1",
          [work.copyId],
        ),
      ).rejects.toThrow("Assignment origin is immutable");
      await expect(
        pool.query(
          "UPDATE content_versions SET rubric=$3 WHERE id=$1 AND version=$2",
          [work.first.id, 1, secondRubric],
        ),
      ).rejects.toThrow("Released content is immutable");
      await expectPinned();
      await expect(page.getByText(secondRubric)).toHaveCount(0);
      await page.goto(work.feedbackPath);
      // The feedback page says plainly what this record is not.
      await expect(page.locator("body")).toContainText(
        "not a qualification, formal assessment or promise of an outcome",
      );
    });
  } finally {
    await work.reviewer.cleanup();
  }
});

test("[F-ROADMAP-06-B] a second version leaves earlier feedback alone and new members get the current one", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90_000);
  const work = await reviewedSubmission(page, browser);
  const newcomer = await browser.newContext({
    baseURL: running.origin,
    viewport: page.viewportSize(),
    isMobile: info.project.use.isMobile,
    hasTouch: info.project.use.hasTouch,
  });
  try {
    const before = await feedbackRow(work.submissionId);
    expect(before).toHaveLength(1);
    await requiredCheck(1, async () => {
      await publishSecondThroughPages(browser, work);
      expect(await pin(work.copyId)).toEqual([
        {
          content_id: work.first.id,
          content_version: 1,
          rubric_version: 1,
        },
      ]);
      expect(await feedbackRow(work.submissionId)).toEqual(before);
      await page.goto(work.feedbackPath);
      await expect(page.locator("body")).toContainText(work.pinnedLine);
      await expect(page.getByText(work.comment, { exact: true })).toBeVisible();
      await page.goto(work.attemptUrl);
      await expect(page.getByText(firstRubric, { exact: true })).toBeVisible();
      await expect(page.getByText(secondRubric)).toHaveCount(0);
    });
    await requiredCheck(2, async () => {
      const other = await newcomer.newPage();
      await onboard(other);
      await startAttempt(other, work.first.title);
      await expect(other.getByText("Original rubric version 2")).toBeVisible();
      await expect(
        other.getByText(secondRubric, { exact: true }),
      ).toBeVisible();
      await expect(other.getByText(firstRubric)).toHaveCount(0);
      await expect(other.locator("body")).toContainText(
        "Second brief: compare three invented meeting notes.",
      );
    });
  } finally {
    await newcomer.close();
    await work.reviewer.cleanup();
  }
});

test("[F-BUILD-07-A] a revised rubric does not change a completed result", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const work = await reviewedSubmission(page, browser);
  const auth = authorizationStore(pool);
  const expiry = new Date(Date.now() + 3_600_000);
  // There is no staff page for this simulated result record, and it holds free
  // text rather than a numeric score. It stays in the disposable database.
  const adminId = await auth.provisionStaff(
    randomBytes(32).toString("hex"),
    "platform_admin",
    expiry,
  );
  const assessor = randomBytes(32).toString("hex");
  const assessorId = await auth.provisionStaff(assessor, "reviewer", expiry);
  await auth.grantAssignment(
    adminId,
    assessorId,
    work.memberId,
    "reviewer",
    "Invented simulated result",
    expiry,
  );
  try {
    const result = "Invented simulated result: two of three points";
    let assessmentId: string | null = null;
    const assessment = async () =>
      (
        await pool.query(
          "SELECT content_version,rubric_version,mode,result,assessed_at FROM content_assessments WHERE id=$1",
          [assessmentId],
        )
      ).rows;
    // What the member can read of that result: their own export, over HTTP.
    const exportedResult = async () => {
      const exported = await page.request.get(
        `${running.origin}/api/member/export`,
      );
      expect(exported.status()).toBe(200);
      const { records } = (await exported.json()) as {
        records: { contentAssessments: Record<string, unknown>[] };
      };
      return records.contentAssessments.filter(
        (entry) => entry.id === assessmentId,
      );
    };
    await requiredCheck(1, async () => {
      assessmentId = await catalogStore(pool).assess(
        assessor,
        work.memberId,
        work.first.id,
        1,
        result,
      );
      expect(assessmentId).toEqual(expect.any(String));
      expect(await assessment()).toMatchObject([
        { content_version: 1, rubric_version: 1, mode: "simulated", result },
      ]);
      expect(await exportedResult()).toMatchObject([
        {
          contentId: work.first.id,
          contentVersion: 1,
          rubricVersion: 1,
          mode: "simulated",
          result,
        },
      ]);
      await page.goto(work.feedbackPath);
      await expect(page.locator("body")).toContainText(work.pinnedLine);
    });
    await requiredCheck(2, async () => {
      const heldResult = await assessment();
      const heldFeedback = await feedbackRow(work.submissionId);
      const heldExport = await exportedResult();
      expect(heldExport).toHaveLength(1);
      await publishSecondThroughPages(browser, work);
      expect(await assessment()).toEqual(heldResult);
      // The member still reads the same result, rubric 1 and score text.
      expect(await exportedResult()).toEqual(heldExport);
      expect(heldExport[0]).toMatchObject({ rubricVersion: 1, result });
      expect(await feedbackRow(work.submissionId)).toEqual(heldFeedback);
      await page.goto(work.feedbackPath);
      await expect(page.locator("body")).toContainText(work.pinnedLine);
      await expect(page.getByText(work.comment, { exact: true })).toBeVisible();
      await expect(page.locator("body")).not.toContainText("rubric 2");
    });
  } finally {
    await work.reviewer.cleanup();
  }
});
