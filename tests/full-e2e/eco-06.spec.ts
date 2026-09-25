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
  id: string;
  background: "explorer" | "professional";
  goal: "everyday" | "work";
  goalName: string;
  title: string;
  body: string;
  reflection: string;
};

async function publishLessons(paths: Path[]) {
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
  for (const path of paths) {
    const draft: DraftContent = {
      id: path.id,
      version: 1,
      kind: "lesson",
      origin: "curated",
      title: path.title,
      body: path.body,
      owner: "Synthetic test editor",
      sources: "Original invented study example",
      rights: "Owned local sample",
      goals: [path.goal],
      backgrounds: [path.background],
      domains: [],
      prerequisites: "None",
      minimumExperience: "new",
      rubric: null,
      rubricVersion: null,
    };
    expect(await catalog.createDraft(editor, draft)).toBe(true);
    expect(await catalog.submit(editor, path.id, 1)).toBe(true);
    expect(await catalog.approve(reviewer, path.id, 1, true)).toBe(true);
    expect(await catalog.publish(editor, path.id, 1)).toBe(true);
    const published = await pool.query(
      "SELECT version,state,body FROM content_versions WHERE id=$1",
      [path.id],
    );
    expect(published.rows).toEqual([
      { version: 1, state: "published", body: path.body },
    ]);
  }
}

async function onboard(page: Page, path: Path) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(path.background);
  await page.getByLabel("What would you like to do?").selectOption(path.goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

async function memberId(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (entry) => entry.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const tokenHash = createHash("sha256").update(cookie!.value).digest("hex");
  const member = await pool.query<{ id: string }>(
    "SELECT id FROM learners WHERE token_hash=$1",
    [tokenHash],
  );
  expect(member.rowCount).toBe(1);
  return member.rows[0]!.id;
}

async function reflect(page: Page, path: Path) {
  await page.goto("/library");
  await expect(page.getByRole("link", { name: path.title })).toBeVisible();
  await page.getByRole("link", { name: path.title }).click();
  await page
    .getByRole("link", { name: "Try a locally simulated study reflection" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Study reflection" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: `Source: ${path.id} · version 1` }),
  ).toBeVisible();
  await expect(page.locator("pre.content-text")).toHaveText(path.body);
  await expect(
    page.getByText(`Your current goal: ${path.goalName}.`),
  ).toBeVisible();
  await expect(page.getByText("No career path is required.")).toBeVisible();
  await expect(
    page.getByText(
      "No live AI provider, paid allowance or formal reviewer is connected.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /buy|book|purchase|interview|contract/i }),
  ).toHaveCount(0);
  await page.getByLabel("Your short reflection").fill(path.reflection);
  await page.getByLabel("I used only invented or sample information.").check();
  await page.getByRole("button", { name: "Compare with source" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Compare your reflection with the source",
    }),
  ).toBeVisible();
  await expect(page.getByText(`Your words: ${path.reflection}`)).toBeVisible();
  await expect(
    page.getByText(`Return to ${path.id} · version 1 above.`, { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("not a competence assessment", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Your reflection was not saved or sent to an AI provider", {
      exact: false,
    }),
  ).toBeVisible();
}

test("[F-ECO-06-A] two noncareer learners use source-specific local study", async ({
  browser,
}, info) => {
  const suffix = info.project.name === "desktop-chromium" ? "901" : "902";
  const general: Path = {
    id: `GEN-${suffix}`,
    background: "explorer",
    goal: "everyday",
    goalName: "Understand AI and try something useful",
    title: `Invented everyday study ${suffix}`,
    body: "Compare an invented meal plan with its source before sharing a suggestion.",
    reflection:
      "I would check the invented meal plan source before sharing it.",
  };
  const professional: Path = {
    id: `PRO-${suffix}`,
    background: "professional",
    goal: "work",
    goalName: "Make everyday work clearer",
    title: `Invented work study ${suffix}`,
    body: "Compare invented meeting notes with the original agenda before summarizing.",
    reflection: "I would check the invented meeting agenda before summarizing.",
  };
  const generalContext = await browser.newContext({ baseURL: origin });
  const professionalContext = await browser.newContext({ baseURL: origin });
  try {
    await publishLessons([general, professional]);
    const generalPage = await generalContext.newPage();
    const professionalPage = await professionalContext.newPage();
    await onboard(generalPage, general);
    await onboard(professionalPage, professional);
    expect(await memberId(generalContext)).not.toBe(
      await memberId(professionalContext),
    );

    await requiredCheck(1, async () => {
      await reflect(generalPage, general);
      await generalPage.goto(`/library/${general.id}/study`);
      await expect(generalPage.getByText(general.reflection)).toHaveCount(0);
    });
    await requiredCheck(2, async () => {
      await reflect(professionalPage, professional);
      await professionalPage.goto(`/library/${general.id}/study`);
      await expect(professionalPage.getByText(general.reflection)).toHaveCount(
        0,
      );
      await expect(
        professionalPage.getByText(professional.reflection),
      ).toHaveCount(0);
    });
  } finally {
    await generalContext.close();
    await professionalContext.close();
  }
});
