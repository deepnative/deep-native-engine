import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { expectReadableAtNarrowWidth } from "../support/narrow-readability.ts";
import { testPool } from "../support/database.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { PROGRAM_PATH } from "../../src/program-values.ts";

const pool = testPool();
test.afterAll(async () => pool.end());
// The reported width: a phone narrower than either project's default device.
test.use({ viewport: { width: 375, height: 812 } });

async function publishAssignment(id: string, title: string) {
  const auth = authorizationStore(pool);
  const catalog = catalogStore(pool);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  const draft: DraftContent = {
    id,
    version: 1,
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
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, id, 1)).toBe(true);
}

async function onboard(page: Page) {
  await page.goto("/");
  await page.getByLabel("Display name").fill("Sample learner");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await chooseLearningGoal(page, "everyday");
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

test("[L294] READABLE-09..12 a phone reader sees readable dates, whole codes and no sideways scrolling", async ({
  page,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-980" : "SYN-981";
  const title = `Invented readable project ${id}`;
  await publishAssignment(id, title);
  await onboard(page);

  // READABLE-09: event times are words with the zone stated, not raw values.
  await page.goto("/events?all=1");
  await expect(
    page.getByText(/Sample schedule: .+ UTC\./).first(),
  ).toBeVisible();
  await expectReadableAtNarrowWidth(page, "/events");

  // READABLE-10: a short code such as FND-003 stays on one line.
  await page.goto("/programs");
  await expect(page.locator("body")).toContainText("FND-003");
  await expectReadableAtNarrowWidth(page, "/programs");
  await page.goto(PROGRAM_PATH);
  await expectReadableAtNarrowWidth(page, PROGRAM_PATH);

  // READABLE-11: long references and URLs wrap only where they must.
  await page.goto("/account");
  await expectReadableAtNarrowWidth(page, "/account");
  await page.goto("/workflows");
  await expectReadableAtNarrowWidth(page, "/workflows");
  await page.goto("/workflows/WF-001");
  await expect(page.locator("body")).toContainText("https://help.openai.com");
  await expectReadableAtNarrowWidth(page, "/workflows/WF-001");

  // READABLE-12: a submission reads the same on its attempt and on progress.
  await page.goto("/learn");
  const choices = page.getByRole("region", {
    name: "Choose a practice assignment",
  });
  await choices.getByRole("button", { name: `Choose ${title}` }).click();
  await choices
    .getByRole("button", { name: "Start or return to this private attempt" })
    .click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const attempt = new URL(page.url()).pathname;
  await page
    .getByLabel("Private sample response")
    .fill("A small invented plan compared with the sample brief.");
  await page.getByLabel("I used only invented or sample information").check();
  await page.getByRole("button", { name: "Save private draft" }).click();
  await expect(page.getByText("private draft saved")).toBeVisible();
  await page.getByLabel("Submit this saved version locally").check();
  await page
    .getByRole("button", { name: "Submit saved version locally" })
    .click();
  await expect(
    page.getByText(/Assignment version 1 .* submitted locally/),
  ).toBeVisible();
  await page.goto(attempt);
  await expect(page.locator("body")).toContainText(
    /\d{1,2}:\d{2} [ap]\.m\. UTC/,
  );
  await expect(page.locator("time[datetime]").first()).toHaveAttribute(
    "datetime",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );
  await expectReadableAtNarrowWidth(page, attempt);
  await page.goto("/progress");
  await expect(page.locator("body")).toContainText(
    /\d{1,2}:\d{2} [ap]\.m\. UTC/,
  );
  await expectReadableAtNarrowWidth(page, "/progress");
});
