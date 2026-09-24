import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => {
  await pool.end();
});

async function onboard(
  page: Page,
  background: "explorer" | "professional" | "technical",
  goal: "everyday" | "work" | "build",
) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

async function syntheticLesson(id: string) {
  const auth = authorizationStore(pool),
    catalog = catalogStore(pool);
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
  const draft: DraftContent = {
    id,
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: `Invented learning sample ${id}`,
    body: "Use only invented details. Compare any AI suggestion with the original sample before using it.",
    owner: "Synthetic test editor",
    sources: "Original invented text",
    rights: "Owned sample",
    goals: ["everyday", "work", "build"],
    backgrounds: ["explorer", "professional", "technical"],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
  };
  const publish = async (version: number) => {
    expect(await catalog.createDraft(editor, { ...draft, version })).toBe(true);
    expect(await catalog.submit(editor, id, version)).toBe(true);
    expect(await catalog.approve(reviewer, id, version, true)).toBe(true);
    expect(await catalog.publish(editor, id, version)).toBe(true);
  };
  await publish(1);
  return { catalog, editor, publish };
}

test("[L42] exploratory reader distinguishes opening, start and self-report after reload and goal change", async ({
  page,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-911" : "SYN-912";
  await syntheticLesson(id);
  await onboard(page, "explorer", "everyday");
  await page.goto(`/library/${id}`);
  await expect(
    page.getByRole("heading", { name: `Invented learning sample ${id}` }),
  ).toBeVisible();
  await expect(
    page.getByText("Readable sample text · synthetic local preview"),
  ).toBeVisible();
  await expect(
    page.getByRole("status").getByText("Opened in reader", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("No qualified reviewer has assessed this lesson."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start this lesson" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").getByText("Started", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("I have finished reading this sample lesson").check();
  await page
    .getByRole("button", { name: "Mark self-assessed complete" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("status")
      .getByText("Self-assessed complete", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole("status")
      .getByText("Self-assessed complete", { exact: false }),
  ).toBeVisible();
  await page.goto("/learn");
  await page.getByLabel("What would you like to do?").selectOption("work");
  await page.getByRole("button", { name: "Save my direction" }).click();
  await page.goto("/library");
  await expect(
    page.getByRole("heading", { name: "Your private lesson history" }),
  ).toBeVisible();
  await expect(
    page.getByText(`${id} · version 1 · Self-assessed complete`, {
      exact: false,
    }),
  ).toBeVisible();
});

test("[L43] professional and IT sessions keep versioned activity private through replacement and retirement", async ({
  browser,
  page,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-913" : "SYN-914";
  const { catalog, editor, publish } = await syntheticLesson(id);
  const other = await browser.newContext({ baseURL: origin });
  try {
    await onboard(page, "professional", "work");
    const otherPage = await other.newPage();
    await onboard(otherPage, "technical", "build");
    const otherCsrf = await otherPage
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    await page.goto(`/library/${id}`);
    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    await otherPage.goto("/library");
    await expect(
      otherPage.getByText("No sample lesson has been opened"),
    ).toBeVisible();
    const otherWrite = await otherPage.request.post(`/library/${id}/progress`, {
      headers: { Origin: origin },
      form: { csrf: otherCsrf, content_version: "1", intent: "start" },
    });
    expect(otherWrite.status()).toBe(409);
    const forged = await page.request.post(`/library/${id}/progress`, {
      headers: { Origin: origin },
      form: { csrf: "wrong", content_version: "1", intent: "start" },
    });
    expect(forged.status()).toBe(403);
    await publish(2);
    const stale = await page.request.post(`/library/${id}/progress`, {
      headers: { Origin: origin },
      form: { csrf, content_version: "1", intent: "start" },
    });
    expect(stale.status()).toBe(409);
    await page.goto("/library");
    await expect(
      page.getByText(`${id} · version 1 · Opened in reader`, { exact: false }),
    ).toContainText("unavailable");
    await page.goto(`/library/${id}`);
    await expect(
      page.getByRole("status").getByText("Opened in reader · version 2"),
    ).toBeVisible();
    expect(await catalog.retire(editor, id)).toBe(true);
    await page.goto(`/library/${id}`);
    await expect(
      page.getByRole("heading", { name: "Content unavailable" }),
    ).toBeVisible();
    await page.goto("/library");
    await expect(
      page.getByText(`${id} · version 2 · Opened in reader`, { exact: false }),
    ).toContainText("unavailable");
    await otherPage.reload();
    await expect(
      otherPage.getByText("No sample lesson has been opened"),
    ).toBeVisible();
  } finally {
    await other.close();
  }
});
