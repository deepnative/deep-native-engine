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

test("[L48] general learner saves, submits and deletes only a private synthetic assignment attempt", async ({
  page,
  browser,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-970" : "SYN-971";
  const title = `Invented everyday project ${id}`;
  const actors = await publishers();
  await publish(actors, sample(id, 1, title));
  await onboard(page, "explorer", "everyday");
  const attemptId = await chooseAndStart(page, title);
  await expect(page.getByText("started only")).toBeVisible();
  await page
    .getByLabel("Private sample response")
    .fill(
      "I will make a small invented plan and compare it with the sample brief.",
    );
  await page.getByLabel("I used only invented or sample information").check();
  await page.getByRole("button", { name: "Save private draft" }).click();
  await expect(page.getByText("private draft saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Private sample response")).toHaveValue(
    "I will make a small invented plan and compare it with the sample brief.",
  );
  const other = await browser.newContext({ baseURL: origin });
  try {
    const otherPage = await other.newPage();
    await onboard(otherPage, "professional", "work");
    await otherPage.goto(`/assignments/attempts/${attemptId}`);
    await expect(
      otherPage.getByRole("heading", { name: "Attempt unavailable" }),
    ).toBeVisible();
    await expect(otherPage.getByText("small invented plan")).toHaveCount(0);
  } finally {
    await other.close();
  }
  await page.getByLabel("Submit this saved version locally").check();
  await page
    .getByRole("button", { name: "Submit saved version locally" })
    .click();
  await expect(
    page.getByText(/Assignment version 1 .* submitted locally/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save private draft" }),
  ).toHaveCount(0);
  await page.getByLabel("Delete this private attempt").check();
  await page.getByRole("button", { name: "Delete attempt" }).click();
  await expect(
    page.getByText("No private assignment attempts yet"),
  ).toBeVisible();
});

test("[L49] professional keeps an old private draft when goal and published version change", async ({
  page,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-972" : "SYN-973";
  const title = `Invented professional workflow ${id}`;
  const actors = await publishers();
  await publish(actors, {
    ...sample(id, 1, title),
    goals: ["work"],
    backgrounds: ["professional"],
  });
  await onboard(page, "professional", "work");
  const oldAttempt = await chooseAndStart(page, title);
  await page
    .getByLabel("Private sample response")
    .fill("An invented draft remains private after changing my goal.");
  await page.getByLabel("I used only invented or sample information").check();
  await page.getByRole("button", { name: "Save private draft" }).click();
  await page.goto("/learn");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByRole("button", { name: "Save my direction" }).click();
  await page.goto(`/assignments/attempts/${oldAttempt}`);
  await expect(page.getByText("cannot be edited")).toBeVisible();
  await expect(
    page.getByText("An invented draft remains private"),
  ).toBeVisible();
  await page.goto("/learn");
  await page.getByLabel("What would you like to do?").selectOption("work");
  await page.getByRole("button", { name: "Save my direction" }).click();
  await publish(actors, {
    ...sample(id, 2, title),
    goals: ["work"],
    backgrounds: ["professional"],
  });
  await page.goto(`/assignments/attempts/${oldAttempt}`);
  await expect(page.getByText("cannot be edited")).toBeVisible();
  await page.goto("/learn");
  const newer = await chooseAndStart(page, title);
  expect(newer).not.toBe(oldAttempt);
  expect(await actors.catalog.retire(actors.editor, id)).toBe(true);
  await page.reload();
  await expect(page.getByText("cannot be edited")).toBeVisible();
});

test("[L50] IT learner's stale tab and unconfirmed submission cannot overwrite saved work", async ({
  page,
  context,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-974" : "SYN-975";
  const title = `Invented technical review ${id}`;
  const actors = await publishers();
  await publish(actors, {
    ...sample(id, 1, title),
    goals: ["build"],
    backgrounds: ["technical"],
  });
  await onboard(page, "technical", "build");
  await chooseAndStart(page, title);
  const stale = await context.newPage();
  await stale.goto(page.url());
  await page
    .getByLabel("Private sample response")
    .fill("A synthetic technical review with enough detail to submit.");
  await page.getByLabel("I used only invented or sample information").check();
  await page.getByRole("button", { name: "Save private draft" }).click();
  await stale
    .getByLabel("Private sample response")
    .fill("This second tab should not silently overwrite the saved response.");
  await stale.getByLabel("I used only invented or sample information").check();
  await stale.getByRole("button", { name: "Save private draft" }).click();
  await expect(stale.getByText("Your draft was not saved")).toBeVisible();
  await expect(
    stale.getByText("This second tab should not silently overwrite"),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Private sample response")).toHaveValue(
    "A synthetic technical review with enough detail to submit.",
  );
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  const revision = await page
    .locator('input[name="revision"]')
    .first()
    .inputValue();
  const response = await page.request.post(`${page.url()}/submit`, {
    form: { csrf, revision },
    headers: { Origin: origin },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(422);
  await expect(
    page.getByRole("button", { name: "Submit saved version locally" }),
  ).toBeVisible();
  await stale.close();
});
