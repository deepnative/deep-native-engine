import { createHash, randomBytes } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

async function memberId(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (item) => item.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const hash = createHash("sha256").update(cookie!.value).digest("hex");
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM learners WHERE token_hash=$1",
    [hash],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0]!.id;
}

test("[F-ROADMAP-08-D] project-management learner submits a noncoding assignment with its own rubric", async ({
  page,
  context,
  browser,
}, info) => {
  const n = info.project.name === "desktop-chromium" ? 1 : 2;
  const lessonId = `PMR-20${n}`;
  const assignmentId = `PMR-21${n}`;
  const lessonTitle = `Invented delivery planning lesson ${n}`;
  const assignmentTitle = `Invented delivery risk register ${n}`;
  const rubric =
    "Check scope, dependencies, risks, named owners and next actions against the invented delivery brief; no code or software implementation is requested.";
  const response =
    "For the invented launch, I would name a scope owner, log the design dependency, assign the schedule risk to Sam and ask Alex to confirm the next action.";
  const auth = authorizationStore(pool);
  const catalog = catalogStore(pool);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editor, "editor", expires);
  await auth.provisionStaff(reviewer, "reviewer", expires);
  const base = {
    version: 1,
    origin: "curated" as const,
    owner: "Synthetic test editor",
    sources: "Original invented delivery brief",
    rights: "Owned local sample",
    goals: ["build" as const],
    backgrounds: ["technical" as const],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new" as const,
  };
  for (const draft of [
    {
      ...base,
      id: lessonId,
      kind: "lesson" as const,
      title: lessonTitle,
      body: "Read the invented project scope, dependencies and owner notes before planning next actions.",
      rubric: null,
      rubricVersion: null,
    },
    {
      ...base,
      id: assignmentId,
      kind: "assignment" as const,
      title: assignmentTitle,
      body: "Write a noncoding risk register for the invented project. Identify owners, dependencies and next actions.",
      rubric,
      rubricVersion: 1,
    },
  ] satisfies DraftContent[]) {
    expect(await catalog.createDraft(editor, draft)).toBe(true);
    expect(await catalog.submit(editor, draft.id, draft.version)).toBe(true);
    expect(await catalog.approve(reviewer, draft.id, draft.version, true)).toBe(
      true,
    );
    expect(await catalog.publish(editor, draft.id, draft.version)).toBe(true);
  }

  await requiredCheck(1, async () => {
    await page.goto("/");
    await page.getByLabel("Your starting point").selectOption("technical");
    await page.getByLabel("What would you like to do?").selectOption("build");
    await page
      .getByRole("group", { name: "IT specialties (optional)" })
      .getByLabel("Project, program and delivery management")
      .check();
    await page.getByLabel("I'll use invented or sample information").check();
    await page.getByRole("button", { name: "Start my learning path" }).click();
    await expect(page).toHaveURL(/\/learn$/);
    const ownerId = await memberId(context);
    const profile = await pool.query<{ it_roles: string[] }>(
      "SELECT it_roles FROM learners WHERE id=$1",
      [ownerId],
    );
    expect(profile.rows[0]?.it_roles).toContain("delivery");

    const choices = page.getByRole("region", {
      name: "Choose a practice assignment",
    });
    const row = choices.getByRole("listitem").filter({
      hasText: assignmentTitle,
    });
    await expect(row).toBeVisible();
    await row.getByRole("link", { name: "Read sample" }).click();
    await expect(
      page.getByRole("heading", { name: assignmentTitle }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Versioned rubric 1" }),
    ).toBeVisible();
    await expect(page.locator("pre.content-text").last()).toContainText(rubric);
    await page.goto("/learn");
    await choices
      .getByRole("button", { name: `Choose ${assignmentTitle}` })
      .click();
    await choices
      .getByRole("button", { name: "Start or return to this private attempt" })
      .click();
    const attemptUrl = page.url();
    const attemptId = new URL(attemptUrl).pathname.split("/").at(-1)!;
    await page.getByLabel("Private sample response").fill(response);
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
        content_id: assignmentId,
        content_version: 1,
        goal_at_start: "build",
        response,
        rubric,
        rubric_version: 1,
      },
    ]);
    expect(saved.rows[0]?.submitted_at).not.toBeNull();
    const grants = await pool.query(
      "SELECT id FROM synthetic_entitlement_grants WHERE member_id=$1",
      [ownerId],
    );
    expect(grants.rowCount).toBe(0);

    const outsider = await browser.newContext({ baseURL: origin });
    try {
      const otherPage = await outsider.newPage();
      await otherPage.goto("/");
      await otherPage
        .getByLabel("Your starting point")
        .selectOption("explorer");
      await otherPage
        .getByLabel("What would you like to do?")
        .selectOption("everyday");
      await otherPage
        .getByLabel("I'll use invented or sample information")
        .check();
      await otherPage
        .getByRole("button", { name: "Start my learning path" })
        .click();
      expect(await memberId(outsider)).not.toBe(ownerId);
      const denied = await otherPage.request.get(attemptUrl);
      expect(denied.status()).toBe(404);
      expect(await denied.text()).not.toContain(response);
    } finally {
      await outsider.close();
    }
    await page.reload();
    await expect(page.locator("pre.content-text")).toContainText(response);
    await expect(
      page.getByText("NO FORMAL REVIEW", { exact: false }),
    ).toBeVisible();
  });
});
