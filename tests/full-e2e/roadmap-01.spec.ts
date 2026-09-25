import { createHash, randomBytes } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

async function publishers() {
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
  return { catalog: catalogStore(pool), editor, reviewer };
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

function sample(
  id: string,
  kind: "lesson" | "assignment",
  title: string,
  prerequisites: string,
): DraftContent {
  return {
    id,
    version: 1,
    kind,
    origin: "curated",
    title,
    body:
      kind === "lesson"
        ? "Compare an invented household decision with the source and note what remains uncertain."
        : "Draft a plain-language check of an invented household AI suggestion.",
    owner: "Synthetic test editor",
    sources: "Original invented household brief",
    rights: "Owned local sample",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites,
    minimumExperience: "new",
    rubric:
      kind === "assignment"
        ? "Check source use, unsupported claims and one next verification step."
        : null,
    rubricVersion: kind === "assignment" ? 1 : null,
  };
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

test("[F-ROADMAP-01-B] publishing content does not assess a learner", async ({
  page,
  context,
}, info) => {
  const suffix = info.project.name === "desktop-chromium" ? "901" : "902";
  const assignmentId = `RMB-${suffix}`;
  const lessonId = `RMB-${info.project.name === "desktop-chromium" ? "911" : "912"}`;
  const assignmentTitle = `Invented everyday source check ${suffix}`;
  const lessonTitle = `Invented follow-up lesson ${suffix}`;
  const actors = await publishers();
  await publish(
    actors,
    sample(
      assignmentId,
      "assignment",
      assignmentTitle,
      "LOCAL-FIRST-EXERCISE-COMPLETE",
    ),
  );
  let ownerId = "";

  await requiredCheck(1, async () => {
    await page.goto("/");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await page
      .getByLabel("What would you like to do?")
      .selectOption("everyday");
    await page.getByLabel("I'll use invented or sample information").check();
    await page.getByRole("button", { name: "Start my learning path" }).click();
    await expect(page).toHaveURL(/\/learn$/);
    ownerId = await memberId(context);
    await expect(page.getByRole("link", { name: "Open lesson" })).toBeVisible();
    await page.getByRole("link", { name: "Open lesson" }).click();
    await expect(page).toHaveURL(/\/lesson$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /buy|purchase|interview|contract/i }),
    ).toHaveCount(0);
  });

  await requiredCheck(2, async () => {
    await page.goto("/learn");
    const choices = page.getByRole("region", {
      name: "Choose a practice assignment",
    });
    await expect(choices).not.toContainText(assignmentTitle);
    await page.getByRole("link", { name: "Open lesson" }).click();
    await page
      .getByLabel("Your instruction to AI")
      .fill("Use an invented household example to suggest a useful next step.");
    await page
      .getByLabel("How will you check the result?")
      .fill(
        "Compare the suggestion with the invented source and check claims.",
      );
    await page
      .getByLabel("I checked the context, task and verification plan")
      .check();
    await page.getByRole("button", { name: "Complete exercise" }).click();
    await expect(
      page.getByText("Exercise completed", { exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Your learning path" }).click();
    await expect(choices).toContainText(assignmentTitle);
    await expect(choices).toContainText(
      "A completed local exercise can satisfy only the explicitly named local prerequisite; it is not a skill assessment.",
    );
    const row = choices.getByRole("listitem").filter({
      hasText: assignmentTitle,
    });
    await expect(row).toContainText("LOCAL-FIRST-EXERCISE-COMPLETE");
    await row.getByRole("link", { name: "Read sample" }).click();
    await expect(
      page.getByRole("heading", { name: assignmentTitle }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Versioned rubric 1" }),
    ).toBeVisible();
    await expect(page.locator("pre.content-text").last()).toHaveText(
      "Check source use, unsupported claims and one next verification step.",
    );
    await page.goto("/learn");
    await choices
      .getByRole("button", { name: `Choose ${assignmentTitle}` })
      .click();
    await expect(choices).toContainText("Your chosen sample");
    const choice = await pool.query(
      "SELECT content_id,content_version FROM learner_assignment_choices WHERE member_id=$1",
      [ownerId],
    );
    expect(choice.rows).toEqual([
      { content_id: assignmentId, content_version: 1 },
    ]);
  });

  await requiredCheck(3, async () => {
    const before = await pool.query(
      "SELECT count(*)::integer AS total FROM content_assessments WHERE member_id=$1",
      [ownerId],
    );
    expect(before.rows[0]?.total).toBe(0);
    await publish(actors, sample(lessonId, "lesson", lessonTitle, "None"));
    const published = await pool.query(
      "SELECT state,version FROM content_versions WHERE id=$1",
      [lessonId],
    );
    expect(published.rows).toEqual([{ state: "published", version: 1 }]);
    const beforeOpen = await pool.query(
      "SELECT count(*)::integer AS total FROM lesson_activity WHERE member_id=$1 AND content_id=$2",
      [ownerId, lessonId],
    );
    expect(beforeOpen.rows[0]?.total).toBe(0);
    await page.goto("/library");
    await page.getByRole("link", { name: lessonTitle }).click();
    await expect(
      page.getByRole("heading", { name: lessonTitle }),
    ).toBeVisible();
    await expect(
      page.getByText("No qualified reviewer has assessed this lesson.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Opened in reader · version 1" }),
    ).toBeVisible();
    const activity = await pool.query(
      "SELECT started_at,self_assessed_at FROM lesson_activity WHERE member_id=$1 AND content_id=$2 AND content_version=1",
      [ownerId, lessonId],
    );
    expect(activity.rows).toEqual([
      { started_at: null, self_assessed_at: null },
    ]);
    const after = await pool.query(
      "SELECT count(*)::integer AS total FROM content_assessments WHERE member_id=$1",
      [ownerId],
    );
    expect(after.rows[0]?.total).toBe(0);
    await page.goto("/learn");
    await expect(page.getByText("Completed · self-assessed")).toBeVisible();
  });
});
