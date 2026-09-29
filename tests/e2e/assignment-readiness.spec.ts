import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

function sample(id: string, title: string): DraftContent {
  return {
    id,
    version: 1,
    kind: "lesson",
    origin: "curated",
    title,
    body: "Invented source text for a local learning exercise.",
    owner: "Synthetic editor",
    sources: "Original invented example",
    rights: "Owned local sample",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric: null,
    rubricVersion: null,
  };
}

async function publish(draft: DraftContent) {
  const auth = authorizationStore(pool);
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
  const catalog = catalogStore(pool);
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, draft.id, draft.version)).toBe(true);
  expect(await catalog.approve(reviewer, draft.id, draft.version, true)).toBe(
    true,
  );
  expect(await catalog.publish(editor, draft.id, draft.version)).toBe(true);
}

async function onboard(page: Page, background: string, goal: string) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

test("[L83] three learning backgrounds follow an exact prerequisite before choosing a synthetic assignment", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90_000);
  const desktop = info.project.name === "desktop-chromium";
  const sourceId = desktop ? "SYN-850" : "SYN-852";
  const assignmentId = desktop ? "SYN-851" : "SYN-853";
  const sourceTitle = `Invented prerequisite ${sourceId}`;
  const assignmentTitle = `Invented guided practice ${assignmentId}`;
  const detailPath = `/assignments/readiness/${assignmentId}?version=1`;
  await publish(sample(sourceId, sourceTitle));
  await publish({
    ...sample(assignmentId, assignmentTitle),
    kind: "assignment",
    prerequisites: "",
    structuredPrerequisites: {
      schemaVersion: 1,
      all: [{ kind: "lesson", id: sourceId, version: 1, activity: "started" }],
    },
  });

  const backgrounds = [
    ["explorer", "everyday"],
    ["professional", "work"],
    ["technical", "build"],
  ] as const;
  for (const [index, [background, goal]] of backgrounds.entries()) {
    const context =
      index === 0
        ? page.context()
        : await browser.newContext({
            baseURL: "http://127.0.0.1:4317",
            viewport: page.viewportSize()!,
            isMobile: !desktop,
            hasTouch: !desktop,
          });
    const learnerPage = index === 0 ? page : await context.newPage();
    try {
      await onboard(learnerPage, background, goal);
      const csrf = await learnerPage
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      const choices = learnerPage.getByRole("region", {
        name: "Choose a practice assignment",
      });
      await expect(choices).not.toContainText(assignmentTitle);
      const before = await pool.query(
        "SELECT count(*)::integer AS count FROM lesson_activity WHERE content_id=$1",
        [sourceId],
      );
      const preparation = learnerPage.getByRole("link", {
        name: `Prepare ${assignmentTitle}`,
      });
      await expect(preparation).toBeVisible();
      await preparation.focus();
      await learnerPage.keyboard.press("Enter");
      await expect(learnerPage).toHaveURL(
        new RegExp(`${assignmentId}\\?version=1$`),
      );
      await expect(
        learnerPage.getByRole("heading", {
          name: `Prepare ${assignmentTitle}`,
        }),
      ).toBeVisible();
      await expect(learnerPage.getByText("Not started")).toBeVisible();
      await expect(
        learnerPage.getByRole("button", { name: /start.*attempt/i }),
      ).toHaveCount(0);
      const after = await pool.query(
        "SELECT count(*)::integer AS count FROM lesson_activity WHERE content_id=$1",
        [sourceId],
      );
      expect(after.rows[0].count).toBe(before.rows[0].count);

      const forged = await learnerPage.request.post("/assignments/select", {
        headers: { origin: "http://127.0.0.1:4317" },
        form: {
          csrf,
          content_id: assignmentId,
          content_version: "1",
        },
      });
      expect(forged.status()).toBe(409);

      const source = learnerPage.getByRole("link", {
        name: `Open prerequisite lesson: ${sourceTitle}`,
      });
      await source.focus();
      await learnerPage.keyboard.press("Enter");
      await expect(learnerPage).toHaveURL(
        new RegExp(`${sourceId}\\?version=1$`),
      );
      await expect(
        learnerPage.getByRole("heading", { name: sourceTitle }),
      ).toBeVisible();
      await learnerPage.goto(detailPath);
      await expect(learnerPage.getByText("Not started")).toBeVisible();
      await learnerPage.goto(`/library/${sourceId}?version=1`);
      await learnerPage
        .getByRole("button", { name: "Start this lesson" })
        .click();
      await learnerPage.goto(detailPath);
      await expect(learnerPage.getByText("Started")).toBeVisible();
      await learnerPage
        .getByRole("link", { name: "Return to your learning path" })
        .click();
      await expect(choices).toContainText(assignmentTitle);
      await choices
        .getByRole("button", { name: `Choose ${assignmentTitle}` })
        .click();
      await expect(choices).toContainText("Your chosen sample");
      const width = await learnerPage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      );
      expect(width).toBe(true);
    } finally {
      if (index !== 0) await context.close();
    }
  }

  await publish({ ...sample(sourceId, `Updated ${sourceTitle}`), version: 2 });
  await page.goto(detailPath);
  await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: `Open prerequisite lesson: ${sourceTitle}`,
    }),
  ).toHaveCount(0);
  const staleSource = await page.request.get(`/library/${sourceId}?version=1`);
  expect(staleSource.status()).toBe(409);
  await page.goto("/learn");
  const staleChoice = await page.request.post("/assignments/select", {
    headers: { origin: "http://127.0.0.1:4317" },
    form: {
      csrf: await page.locator('input[name="csrf"]').first().inputValue(),
      content_id: assignmentId,
      content_version: "1",
    },
  });
  expect(staleChoice.status()).toBe(409);
});
