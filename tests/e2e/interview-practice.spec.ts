import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import {
  test,
  expect,
  devices,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { dropAttendanceBrowserDatabase } from "../support/attendance-browser-database.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { start } from "../../src/runtime.ts";
import { migrate } from "../../src/store.ts";

async function noSidewaysScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}
async function publishLesson(pool: Pool, id: string) {
  const auth = authorizationStore(pool),
    catalog = catalogStore(pool),
    editor = randomBytes(32).toString("hex"),
    reviewer = randomBytes(32).toString("hex"),
    until = new Date(Date.now() + 86400000);
  await auth.provisionStaff(editor, "editor", until);
  await auth.provisionStaff(reviewer, "reviewer", until);
  const draft: DraftContent = {
    id,
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: `Invented interview source ${id}`,
    body: "Use only invented details. Check every answer against the supplied sample.",
    owner: "Synthetic editor",
    sources: "Original invented sample",
    rights: "Owned sample",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, id, 1)).toBe(true);
}
test("[L315] INTERVIEW-01/03/07/08 a member chooses optional interview practice, saves an answer and finds it in history", async ({
  browser,
}, info) => {
  test.setTimeout(90000);
  const original = process.env.DNE_TEST_DATABASE_URL;
  if (
    !original ||
    !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(original).pathname)
  )
    throw Error("Missing generated browser database");
  const adminUrl = new URL(original),
    ownUrl = new URL(original),
    name = `dne_test_${randomBytes(16).toString("hex")}`;
  adminUrl.pathname = "/postgres";
  ownUrl.pathname = `/${name}`;
  const control = new Pool({ connectionString: adminUrl.href }),
    pool = new Pool({ connectionString: ownUrl.href });
  const storage = await mkdtemp(join(tmpdir(), "dne200-interview-")),
    contexts: BrowserContext[] = [];
  let running: Awaited<ReturnType<typeof start>> | undefined,
    created = false;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(pool);
    const id = "SYN-731";
    await publishLesson(pool, id);
    running = await start({
      DNE_DATABASE_URL: ownUrl.href,
      DNE_APP_MODE: "test",
      DNE_PORT: "0",
      DNE_PRIVATE_STORAGE_ROOT: storage,
    });
    const origin = running.origin;
    const context = await browser.newContext(
      info.project.name === "mobile-chromium"
        ? devices["Pixel 7"]
        : devices["Desktop Chrome"],
    );
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByLabel("Display name").fill("Sample learner");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(page, "everyday");
    await page
      .getByRole("button", { name: "Start my learning path", exact: true })
      .click();

    // The ordinary practice comes first; interview practice is a separate choice.
    await page.goto(`${origin}/library/${id}/practice-session`);
    await expect(
      page.getByRole("heading", { name: "Optional interview practice" }),
    ).toBeVisible();
    await expect(
      page.getByText("invented interview question about an everyday task"),
    ).toBeVisible();
    await noSidewaysScroll(page);
    const sessions = async () =>
      (
        await pool.query<{ prompt_version: string }>(
          "SELECT prompt_version FROM private_practice_sessions",
        )
      ).rows.map((row) => row.prompt_version);
    expect(await sessions()).toEqual([]);

    await page
      .getByLabel("I want to start private sample interview practice")
      .check();
    await page
      .getByRole("button", { name: "Start or return to interview practice" })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Private practice session",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Purpose: optional interview practice"),
    ).toBeVisible();
    const path = new URL(page.url()).pathname;

    await page
      .getByLabel("Your next sample response")
      .fill("I would check the invented detail against the sample first.");
    await page
      .getByLabel(
        "I used only invented or sample information and want to save this response.",
      )
      .check();
    await page
      .getByRole("button", { name: "Save response and compare" })
      .click();
    const comparison = page.locator("[data-practice-comparison]");
    await expect(comparison).toHaveCount(1);
    await expect(comparison).toContainText(
      "This interview practice doesn't predict hiring, interview results or competence.",
    );
    await noSidewaysScroll(page);

    // Reload keeps it; a repeat start returns the same session.
    await page.reload();
    await expect(page.locator("[data-practice-response]")).toHaveText(
      "I would check the invented detail against the sample first.",
    );
    await page.goto(`${origin}/library/${id}/practice-session`);
    await page
      .getByLabel("I want to start private sample interview practice")
      .check();
    await page
      .getByRole("button", { name: "Start or return to interview practice" })
      .click();
    expect(new URL(page.url()).pathname).toBe(path);

    await page.goto(`${origin}/practice-sessions`);
    await expect(
      page.getByText(
        "Optional interview practice · prompt interview-practice-v1",
      ),
    ).toBeVisible();
    await noSidewaysScroll(page);
    expect(await sessions()).toEqual(["interview-practice-v1"]);
  } finally {
    for (const context of contexts) await context.close();
    await running?.close();
    await pool.end();
    try {
      if (created) await dropAttendanceBrowserDatabase(control, name);
    } finally {
      await control.end();
      await rm(storage, { recursive: true, force: true });
    }
  }
});
