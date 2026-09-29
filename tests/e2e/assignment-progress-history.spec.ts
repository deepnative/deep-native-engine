import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

function sample(id: string, version: number, title: string): DraftContent {
  return {
    id,
    version,
    kind: "assignment",
    origin: "curated",
    title,
    body: "Use invented details and check the outcome against this sample brief.",
    owner: "Synthetic editor",
    sources: "Original invented brief",
    rights: "Owned sample",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric: "Compare the answer with the source.",
    rubricVersion: 1,
  };
}
async function publishers() {
  const auth = authorizationStore(pool);
  const editor = randomBytes(32).toString("hex"),
    reviewer = randomBytes(32).toString("hex");
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
  return { catalog, editor, reviewer };
}
async function publish(
  actors: Awaited<ReturnType<typeof publishers>>,
  draft: DraftContent,
) {
  expect(await actors.catalog.createDraft(actors.editor, draft)).toBe(true);
  expect(
    await actors.catalog.submit(actors.editor, draft.id, draft.version),
  ).toBe(true);
  expect(
    await actors.catalog.approve(
      actors.reviewer,
      draft.id,
      draft.version,
      true,
    ),
  ).toBe(true);
  expect(
    await actors.catalog.publish(actors.editor, draft.id, draft.version),
  ).toBe(true);
}
async function onboard(page: Page, background: string, goal: string) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
}
async function chooseAndStart(page: Page, title: string) {
  const choices = page.getByRole("region", {
    name: "Choose a practice assignment",
  });
  await choices.getByRole("button", { name: `Choose ${title}` }).click();
  await choices
    .getByRole("button", { name: "Start or return to this private attempt" })
    .click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  return page.url().split("/").at(-1)!;
}
test.use({ trace: "on" });

test("[L91] retained assignment submissions stay separate, exact and private on progress", async ({
  browser,
}, info) => {
  const actors = await publishers();
  for (const [index, background, goal] of [
    [0, "explorer", "everyday"],
    [1, "professional", "work"],
    [2, "technical", "build"],
  ] as const) {
    const id = `SYN-${(info.project.name === "desktop-chromium" ? 860 : 870) + index}`;
    const title = `Invented progress history ${id}`;
    await publish(actors, sample(id, 1, title));
    const context = await browser.newContext({ baseURL: origin });
    try {
      const learner = await context.newPage();
      await onboard(learner, background, goal);
      const attemptId = await chooseAndStart(learner, title);
      const first = `First invented submission for ${background} with source checks.`;
      const second = `Second invented submission for ${background} with revised checks.`;
      for (const response of [first, second]) {
        await learner.getByLabel("Private sample response").fill(response);
        await learner
          .getByLabel("I used only invented or sample information")
          .check();
        await learner
          .getByRole("button", { name: "Save private draft" })
          .click();
        await learner.getByLabel("Submit this saved version locally").check();
        await learner
          .getByRole("button", { name: "Submit saved version locally" })
          .click();
        await learner.getByLabel("Start a new private revision").check();
        await learner.getByRole("button", { name: "Revise privately" }).click();
      }
      const draft = `Unsubmitted invented current draft for ${background}.`;
      await learner.getByLabel("Private sample response").fill(draft);
      await learner
        .getByLabel("I used only invented or sample information")
        .check();
      await learner.getByRole("button", { name: "Save private draft" }).click();
      await learner.goto("/progress");
      await learner.reload();
      const rows = learner.locator("main ol > li").filter({ hasText: title });
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText("version 1 · Submission 1");
      await expect(rows.nth(1)).toContainText("version 1 · Submission 2");
      await expect(rows.nth(0)).toContainText(
        /submitted locally; no qualified review · 20\d\d-/,
      );
      await expect(rows.nth(1)).toContainText(
        /submitted locally; no qualified review · 20\d\d-/,
      );
      await expect(rows.nth(2)).toContainText("Current revision draft saved");
      await expect(learner.locator("main")).not.toContainText(first);
      await expect(learner.locator("main")).not.toContainText(second);
      await expect(learner.locator("main")).not.toContainText(draft);
      const firstLink = rows.nth(0).getByRole("link", {
        name: "Open this private activity",
      });
      await expect(firstLink).toHaveAttribute(
        "href",
        `/assignments/attempts/${attemptId}?version=1&submission=1#submission-1`,
      );
      await firstLink.focus();
      await expect(firstLink).toBeFocused();
      await learner.keyboard.press("Enter");
      await expect(learner).toHaveURL(/version=1&submission=1#submission-1$/);
      await expect(learner.locator("#submission-1")).toContainText(first);
      await expect(learner.locator("#submission-1")).not.toContainText(second);
      await learner.goto(
        `/assignments/attempts/${attemptId}?version=2&submission=1#submission-1`,
      );
      await expect(
        learner.getByRole("heading", { name: "Attempt unavailable" }),
      ).toBeVisible();
      await learner.goto("/learn");
      await learner
        .getByLabel("What would you like to do?")
        .selectOption(goal === "work" ? "everyday" : "work");
      await learner.getByRole("button", { name: "Save my direction" }).click();
      await publish(actors, sample(id, 2, `${title} replacement`));
      await learner.goto("/progress");
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText("version 1");
      await expect(rows.nth(0)).toContainText("Historical assignment version");
      expect(await actors.catalog.retire(actors.editor, id)).toBe(true);
      await learner.reload();
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0).getByRole("link")).toHaveAttribute(
        "href",
        `/assignments/attempts/${attemptId}?version=1&submission=1#submission-1`,
      );
      await expect(rows.nth(1).getByRole("link")).toHaveAttribute(
        "href",
        `/assignments/attempts/${attemptId}?version=1&submission=2#submission-2`,
      );
      await rows.nth(0).getByRole("link").click();
      await expect(learner).toHaveURL(/version=1&submission=1#submission-1$/);
      await expect(learner.locator("#submission-1")).toContainText(first);
      await expect(learner.locator("#submission-1")).not.toContainText(second);
      await learner.goto("/progress");
      const outsider = await browser.newContext({ baseURL: origin });
      try {
        const other = await outsider.newPage();
        await onboard(other, "explorer", "everyday");
        await other.goto(
          `/assignments/attempts/${attemptId}?version=1&submission=1`,
        );
        await expect(
          other.getByRole("heading", { name: "Attempt unavailable" }),
        ).toBeVisible();
        await other.goto("/progress");
        await expect(other.locator("main")).not.toContainText(title);
      } finally {
        await outsider.close();
      }
      await learner.goto(`/assignments/attempts/${attemptId}`);
      await learner.getByLabel("Delete this private attempt").check();
      await learner.getByRole("button", { name: "Delete attempt" }).click();
      await learner.goto("/progress");
      await expect(learner.locator("main")).not.toContainText(title);
    } finally {
      await context.close();
    }
  }
});
