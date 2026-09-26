import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

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
  return { catalog, editor };
}

function sample(id: string, title: string): DraftContent {
  return {
    id,
    version: 1,
    kind: "assignment",
    origin: "curated",
    title,
    body: "Use only invented details and check the result against the brief.",
    owner: "Synthetic editor",
    sources: "Original invented exercise",
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

async function onboard(page: Page, background: string, goal: string) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

test("[L32] explorer chooses a private, published noncoding sample and reloads it", async ({
  page,
  browser,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-940" : "SYN-941";
  const title = `Invented community event ${id}`;
  await publish({
    ...sample(id, title),
    goals: ["everyday"],
    backgrounds: ["explorer"],
  });
  await onboard(page, "explorer", "everyday");
  const choices = page.getByRole("region", {
    name: "Choose a practice assignment",
  });
  await expect(choices).toContainText(title);
  await choices
    .getByRole("listitem")
    .filter({ hasText: title })
    .getByRole("link", { name: "Read sample" })
    .click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.goto("/learn");
  await choices.getByRole("button", { name: `Choose ${title}` }).click();
  await expect(choices).toContainText("Your chosen sample");
  await page.reload();
  await expect(choices).toContainText("Your chosen sample");
  const other = await browser.newContext({ baseURL: "http://127.0.0.1:4317" });
  try {
    const anotherPage = await other.newPage();
    await onboard(anotherPage, "explorer", "everyday");
    await expect(
      anotherPage.getByRole("region", {
        name: "Choose a practice assignment",
      }),
    ).not.toContainText("Your chosen sample");
  } finally {
    await other.close();
  }
});

test("[L33] professional sees a domain match only after observed foundation practice", async ({
  page,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-942" : "SYN-943";
  const title = `Invented meeting actions ${id}`;
  await publish({
    ...sample(id, title),
    goals: ["work"],
    backgrounds: ["professional"],
    domains: ["education"],
    minimumExperience: "some",
    prerequisites: "LOCAL-FIRST-EXERCISE-COMPLETE",
  });
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("professional");
  await page.getByLabel("What would you like to do?").selectOption("work");
  await page
    .getByRole("group", { name: "Domains of interest (optional)" })
    .getByLabel("Education")
    .check();
  await page.getByLabel("Experience with AI").selectOption("some");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  const choices = page.getByRole("region", {
    name: "Choose a practice assignment",
  });
  await expect(choices).not.toContainText(title);
  await page.getByRole("link", { name: "Open lesson" }).click();
  await page
    .getByLabel("Your instruction to AI")
    .fill("Use invented meeting notes to propose clear next actions.");
  await page
    .getByLabel("How will you check the result?")
    .fill("Compare owners and dates with the original sample notes.");
  await page
    .getByLabel("I checked the context, task and verification plan")
    .check();
  await page.getByRole("button", { name: "Complete exercise" }).click();
  await page.getByRole("link", { name: "Your learning path" }).click();
  await expect(choices).toContainText(title);
  await choices.getByRole("button", { name: `Choose ${title}` }).click();
  await expect(choices).toContainText("Your chosen sample");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByRole("button", { name: "Save my direction" }).click();
  await expect(choices).toContainText("no longer available");
  await expect(choices).not.toContainText(title);
  await expect(page.getByText("Completed · self-assessed")).toBeVisible();
});

test("[L34] technical learner's self-report and retired content cannot bypass eligibility", async ({
  page,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-944" : "SYN-945";
  const title = `Invented sign-up review ${id}`;
  const { catalog, editor } = await publish({
    ...sample(id, title),
    goals: ["build"],
    backgrounds: ["technical"],
    minimumExperience: "experienced",
  });
  await onboard(page, "technical", "build");
  const choices = page.getByRole("region", {
    name: "Choose a practice assignment",
  });
  await expect(choices).not.toContainText(title);
  await page.getByLabel("Experience with AI").selectOption("experienced");
  await page.getByRole("button", { name: "Save my direction" }).click();
  await expect(choices).toContainText(title);
  await choices.getByRole("button", { name: `Choose ${title}` }).click();
  await expect(choices).toContainText("Your chosen sample");
  expect(await catalog.retire(editor, id)).toBe(true);
  await page.reload();
  await expect(choices).toContainText("no longer available");
  await expect(choices).not.toContainText(title);
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  const response = await page.request.post("/assignments/select", {
    headers: { origin: "http://127.0.0.1:4317" },
    form: { csrf, content_id: id, content_version: "1" },
  });
  expect(response.status()).toBe(409);
});

test("[L63] a version-pinned lesson unlocks only its owner's synthetic assignment", async ({
  page,
  browser,
}, info) => {
  const desktop = info.project.name === "desktop-chromium";
  const lessonId = desktop ? "SYN-950" : "SYN-951";
  const assignmentId = desktop ? "SYN-952" : "SYN-953";
  const title = `Invented source-check practice ${assignmentId}`;
  const { catalog } = await publish({
    ...sample(lessonId, `Invented source lesson ${lessonId}`),
    kind: "lesson",
  });
  await publish({
    ...sample(assignmentId, title),
    prerequisites: "",
    structuredPrerequisites: {
      schemaVersion: 1,
      all: [{ kind: "lesson", id: lessonId, version: 1, activity: "started" }],
    },
  });
  await onboard(page, "explorer", "everyday");
  const choices = page.getByRole("region", {
    name: "Choose a practice assignment",
  });
  await expect(choices).not.toContainText(title);
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  const forged = await page.request.post("/assignments/select", {
    headers: { origin: "http://127.0.0.1:4317" },
    form: { csrf, content_id: assignmentId, content_version: "1" },
  });
  expect(forged.status()).toBe(409);

  await page.goto(`/library/${lessonId}`);
  await page.getByRole("button", { name: "Start this lesson" }).click();
  await page.goto("/learn");
  await expect(choices).toContainText(title);
  await choices.getByRole("button", { name: `Choose ${title}` }).click();
  await expect(choices).toContainText("Your chosen sample");
  await page.reload();
  await expect(choices).toContainText("Your chosen sample");

  const outsider = await browser.newContext({
    baseURL: "http://127.0.0.1:4317",
  });
  try {
    const otherPage = await outsider.newPage();
    await onboard(otherPage, "professional", "work");
    await expect(
      otherPage.getByRole("region", { name: "Choose a practice assignment" }),
    ).not.toContainText(title);
    const otherCsrf = await otherPage
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    const denied = await otherPage.request.post("/assignments/select", {
      headers: { origin: "http://127.0.0.1:4317" },
      form: { csrf: otherCsrf, content_id: assignmentId, content_version: "1" },
    });
    expect(denied.status()).toBe(409);
  } finally {
    await outsider.close();
  }

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
  expect(
    await catalog.createDraft(editor, {
      ...sample(lessonId, `Updated source lesson ${lessonId}`),
      kind: "lesson",
      version: 2,
    }),
  ).toBe(true);
  expect(await catalog.submit(editor, lessonId, 2)).toBe(true);
  expect(await catalog.approve(reviewer, lessonId, 2, true)).toBe(true);
  expect(await catalog.publish(editor, lessonId, 2)).toBe(true);
  await page.reload();
  await expect(choices).toContainText("no longer available");
  await expect(choices).not.toContainText(title);
});
