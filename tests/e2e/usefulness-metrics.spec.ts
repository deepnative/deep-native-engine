import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.use({ trace: "on" });
test.afterAll(async () => pool.end());

test("[L70] operator sees only a suppressed local usefulness snapshot after a member report", async ({
  page,
  browser,
}, info) => {
  // The browser matrix is serial against a disposable synthetic database.
  await pool.query("DELETE FROM lesson_usefulness");
  const auth = authorizationStore(pool);
  const catalog = catalogStore(pool);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  const operator = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  await auth.provisionStaff(operator, "operator", expiry);
  const lessonId =
    info.project.name === "desktop-chromium" ? "UMR-701" : "UMR-702";
  const draft: DraftContent = {
    id: lessonId,
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: "Invented operator usefulness lesson",
    body: "Choose a practical step using only invented facts.",
    owner: "Synthetic editor",
    sources: "Original invented source",
    rights: "Owned synthetic text",
    goals: ["work"],
    backgrounds: ["professional"],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric: null,
    rubricVersion: null,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, lessonId, 1)).toBe(true);
  expect(await catalog.approve(reviewer, lessonId, 1, true)).toBe(true);
  expect(await catalog.publish(editor, lessonId, 1)).toBe(true);
  const operatorContext = await browser.newContext({ baseURL: origin });
  const reviewerContext = await browser.newContext({ baseURL: origin });
  try {
    await operatorContext.addCookies([
      {
        name: "dne_preview",
        value: operator,
        url: origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    await reviewerContext.addCookies([
      {
        name: "dne_preview",
        value: reviewer,
        url: origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    await page.goto("/");
    await page.getByLabel("Your starting point").selectOption("professional");
    await page.getByLabel("What would you like to do?").selectOption("work");
    await page.getByLabel("I'll use invented or sample information").check();
    await page.getByRole("button", { name: "Start my learning path" }).click();
    const memberToken = (await page.context().cookies(origin)).find(
      (cookie) => cookie.name === "dne_preview",
    )?.value;
    expect(memberToken).toBeTruthy();
    const session = await store(pool).session(memberToken!);
    expect(session.kind).toBe("active");
    if (session.kind !== "active")
      throw new Error("Synthetic member unavailable");
    await page.goto(`/library/${lessonId}`);
    await page.getByRole("button", { name: "Start this lesson" }).click();
    await page.goto(`/library/${lessonId}`);
    await page.getByLabel("I have finished reading this sample lesson").check();
    await page
      .getByRole("button", { name: "Mark self-assessed complete" })
      .click();
    await page
      .getByRole("link", { name: "Report whether this sample helped" })
      .click();
    const answer = page.getByRole("listitem").filter({
      has: page.getByRole("heading", {
        name: "Invented operator usefulness lesson",
      }),
    });
    await answer.getByLabel("Your answer").selectOption("helpful");
    await answer
      .getByLabel("This is my own response about sample learning")
      .check();
    await answer
      .getByRole("button", { name: "Save my usefulness answer" })
      .click();
    await expect(answer).toContainText("Your current answer: Helpful");
    expect((await page.request.get("/operator/metrics")).status()).toBe(403);
    expect(
      (await reviewerContext.request.get("/operator/metrics")).status(),
    ).toBe(403);
    const response = await operatorContext.request.get("/operator/metrics");
    expect(response.status()).toBe(200);
    const report = await response.json();
    expect(report.scope).toBe("synthetic-local-preview");
    expect(report.usefulness).toEqual({
      disclosure: "suppressed",
      helpfulShareBand: null,
    });
    expect(report.definitions.usefulness).toContain("self-reported");
    expect(JSON.stringify(report)).not.toContain(session.learner.id);
    expect(JSON.stringify(report)).not.toContain(lessonId);
    const forged = await operatorContext.request.get(
      `/operator/metrics?member_id=${session.learner.id}&content_id=${lessonId}`,
    );
    expect(forged.status()).toBe(200);
    expect((await forged.json()).usefulness).toEqual(report.usefulness);
    await page.goto("/learn");
    await page.getByLabel("Delete my local preview").check();
    await page.getByRole("button", { name: "Delete this preview" }).click();
    expect(
      (
        await pool.query("SELECT 1 FROM lesson_usefulness WHERE member_id=$1", [
          session.learner.id,
        ])
      ).rowCount,
    ).toBe(0);
    const after = await (
      await operatorContext.request.get("/operator/metrics")
    ).json();
    expect(after.usefulness).toEqual(report.usefulness);
  } finally {
    await reviewerContext.close();
    await operatorContext.close();
  }
});
