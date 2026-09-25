import { createHash, randomBytes } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

type Path = {
  background: "technical" | "professional";
  goal: "build" | "work";
  lessonId: string;
  assignmentId: string;
  lessonTitle: string;
  assignmentTitle: string;
  lessonBody: string;
  assignmentBody: string;
  rubric: string;
  response: string;
};

async function publishPath(path: Path) {
  const auth = authorizationStore(pool);
  const catalog = catalogStore(pool);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  await auth.provisionStaff(
    editor,
    "editor",
    new Date(Date.now() + 86_400_000),
  );
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  async function publish(draft: DraftContent) {
    expect(await catalog.createDraft(editor, draft)).toBe(true);
    expect(await catalog.submit(editor, draft.id, draft.version)).toBe(true);
    expect(await catalog.approve(reviewer, draft.id, draft.version, true)).toBe(
      true,
    );
    expect(await catalog.publish(editor, draft.id, draft.version)).toBe(true);
  }
  const base = {
    version: 1,
    origin: "curated" as const,
    owner: "Synthetic test editor",
    sources: "Original invented exercise",
    rights: "Owned local sample",
    goals: [path.goal],
    backgrounds: [path.background],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new" as const,
  };
  await publish({
    ...base,
    id: path.lessonId,
    kind: "lesson",
    title: path.lessonTitle,
    body: path.lessonBody,
    rubric: null,
    rubricVersion: null,
  });
  await publish({
    ...base,
    id: path.assignmentId,
    kind: "assignment",
    title: path.assignmentTitle,
    body: path.assignmentBody,
    rubric: path.rubric,
    rubricVersion: 1,
  });
}

async function onboard(
  page: Page,
  background: Path["background"],
  goal: Path["goal"],
) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  if (background === "technical")
    await page
      .getByRole("group", { name: "IT specialties (optional)" })
      .getByLabel("Cybersecurity")
      .check();
  else
    await page
      .getByRole("group", { name: "Domains of interest (optional)" })
      .getByLabel("Education")
      .check();
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

async function memberId(context: BrowserContext) {
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

async function exercisePath(page: Page, context: BrowserContext, path: Path) {
  await publishPath(path);
  await onboard(page, path.background, path.goal);
  const ownerId = await memberId(context);

  await requiredCheck(1, async () => {
    await page.goto("/library");
    await page.getByRole("link", { name: path.lessonTitle }).click();
    await expect(
      page.getByRole("heading", { name: path.lessonTitle }),
    ).toBeVisible();
    await expect(page.locator("pre.content-text")).toContainText(
      path.lessonBody,
    );
    await expect(page.getByText("Readable sample text")).toBeVisible();
    const published = await pool.query(
      "SELECT state,reviewed_at FROM content_versions WHERE id=$1 AND version=1",
      [path.lessonId],
    );
    expect(published.rows[0]?.state).toBe("published");
    expect(published.rows[0]?.reviewed_at).not.toBeNull();
  });

  await requiredCheck(2, async () => {
    await page.goto("/learn");
    const choices = page.getByRole("region", {
      name: "Choose a practice assignment",
    });
    const row = choices.getByRole("listitem").filter({
      hasText: path.assignmentTitle,
    });
    await expect(row).toBeVisible();
    await row.getByRole("link", { name: "Read sample" }).click();
    await expect(
      page.getByRole("heading", { name: path.assignmentTitle }),
    ).toBeVisible();
    await expect(page.locator("pre.content-text").first()).toContainText(
      path.assignmentBody,
    );
    await expect(
      page.getByRole("heading", { name: "Versioned rubric 1" }),
    ).toBeVisible();
    await expect(page.locator("pre.content-text").last()).toContainText(
      path.rubric,
    );
    await page.goto("/learn");
    await choices
      .getByRole("button", { name: `Choose ${path.assignmentTitle}` })
      .click();
    await choices
      .getByRole("button", { name: "Start or return to this private attempt" })
      .click();
    const attemptId = new URL(page.url()).pathname.split("/").at(-1)!;
    await page.getByLabel("Private sample response").fill(path.response);
    await page.getByLabel("I used only invented or sample information").check();
    await page.getByRole("button", { name: "Save private draft" }).click();
    await page.getByLabel("Submit this saved version locally").check();
    await page
      .getByRole("button", { name: "Submit saved version locally" })
      .click();
    await expect(
      page.getByText("NO FORMAL REVIEW", { exact: false }),
    ).toBeVisible();
    const saved = await pool.query(
      `SELECT a.member_id,a.content_id,a.content_version,a.goal_at_start,
              a.response,a.submitted_at,cv.rubric,cv.rubric_version
       FROM assignment_attempts a JOIN content_versions cv
         ON cv.id=a.content_id AND cv.version=a.content_version
       WHERE a.id=$1`,
      [attemptId],
    );
    expect(saved.rows).toMatchObject([
      {
        member_id: ownerId,
        content_id: path.assignmentId,
        content_version: 1,
        goal_at_start: path.goal,
        response: path.response,
        rubric: path.rubric,
        rubric_version: 1,
      },
    ]);
    expect(saved.rows[0]?.submitted_at).not.toBeNull();
  });
}

test("[F-ECO-02-A] technical learner reads and locally submits a task-specific assignment", async ({
  page,
  context,
}, info) => {
  const n = info.project.name === "desktop-chromium" ? 1 : 2;
  await exercisePath(page, context, {
    background: "technical",
    goal: "build",
    lessonId: `ECA-20${n}`,
    assignmentId: `ECA-21${n}`,
    lessonTitle: `Invented sign-up review lesson ${n}`,
    assignmentTitle: `Invented sign-up test plan ${n}`,
    lessonBody:
      "Read the invented sign-up requirements and identify privacy-sensitive error states.",
    assignmentBody:
      "Plan test cases for invalid input, account privacy and a successful sign-up.",
    rubric:
      "Check invalid input, account privacy and the successful sign-up path against the invented brief.",
    response:
      "I would test malformed input, private account errors and a successful sign-up using invented accounts.",
  });
});

test("[F-ECO-02-B] non-IT professional reads and locally submits a noncoding assignment", async ({
  page,
  context,
}, info) => {
  const n = info.project.name === "desktop-chromium" ? 1 : 2;
  await exercisePath(page, context, {
    background: "professional",
    goal: "work",
    lessonId: `ECB-20${n}`,
    assignmentId: `ECB-21${n}`,
    lessonTitle: `Invented meeting actions lesson ${n}`,
    assignmentTitle: `Invented meeting follow-up ${n}`,
    lessonBody:
      "Read the invented meeting notes and identify owners, dates and missing details.",
    assignmentBody:
      "Create a plain-language action list from the invented meeting notes. No code is required.",
    rubric:
      "Check the action owners, dates and missing details against the invented notes; no code is required.",
    response:
      "I would list Sam's checklist and Alex's feedback with dates, then ask about missing details.",
  });
});

test("[F-ECO-02-C] both audiences retain common preview access and see honest specialist readiness", async ({
  page,
  context,
  browser,
}) => {
  const other = await browser.newContext({ baseURL: origin });
  try {
    const otherPage = await other.newPage();
    await requiredCheck(1, async () => {
      await onboard(page, "technical", "build");
      await onboard(otherPage, "professional", "work");
      expect(await memberId(context)).not.toBe(await memberId(other));
      for (const learnerPage of [page, otherPage]) {
        await expect(
          learnerPage.getByRole("region", { name: "Your starter plan" }),
        ).toBeVisible();
        await expect(
          learnerPage.getByRole("link", { name: "Open lesson" }),
        ).toBeVisible();
        await learnerPage.getByRole("link", { name: "Open lesson" }).click();
        await expect(
          learnerPage.getByRole("heading", {
            name: "Give AI a clear starting point",
          }),
        ).toBeVisible();
      }
    });
    await requiredCheck(2, async () => {
      for (const learnerPage of [page, otherPage]) {
        await learnerPage.goto("/readiness/tracks");
        await expect(
          learnerPage.getByRole("heading", { name: "IT specialty services" }),
        ).toBeVisible();
        await expect(
          learnerPage
            .getByRole("listitem")
            .filter({ hasText: "Cybersecurity" }),
        ).toContainText("in preparation");
        await expect(
          learnerPage
            .getByRole("listitem")
            .filter({ hasText: "Education · coaching" }),
        ).toContainText("in preparation");
        await expect(
          learnerPage.getByText("Tailored service cannot be committed"),
        ).toBeVisible();
        await expect(
          learnerPage.getByRole("button", { name: /book|buy|purchase/i }),
        ).toHaveCount(0);
      }
    });
  } finally {
    await other.close();
  }
});
