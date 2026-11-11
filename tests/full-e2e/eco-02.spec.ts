import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";
import { browserOrigin as origin } from "../support/browser-origin.ts";
import {
  reviewedAssignments,
  reviewedAssignmentImportStore,
} from "../../src/reviewed-assignments.ts";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { staffTrace } from "../support/staff-trace.ts";

// F-ECO-02-B publishes the reviewed assignment pack with staff sessions, so
// traces are off except in a full-release run: see ../support/staff-trace.ts.
test.use({ trace: staffTrace });

const pool = testPool();
test.afterAll(async () => pool.end());

type Path = {
  background: "technical" | "professional";
  goal: "build" | "work";
  lessonId: string;
  assignmentId: string;
  lessonTitle: string;
  assignmentTitle: string;
  lessonBody: string;
  assignmentBody: string;
  rubric: string;
  response: string;
  // An assignment published for the other audience only, as a contrast.
  otherAudience: {
    background: "technical" | "professional";
    goal: "build" | "work";
    assignmentId: string;
    assignmentTitle: string;
  };
};

async function publishPath(path: Path) {
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
  async function publish(draft: DraftContent) {
    expect(await catalog.createDraft(editor, draft)).toBe(true);
    expect(await catalog.submit(editor, draft.id, draft.version)).toBe(true);
    expect(await catalog.approve(reviewer, draft.id, draft.version, true)).toBe(
      true,
    );
    expect(await catalog.publish(editor, draft.id, draft.version)).toBe(true);
  }
  const base = {
    version: 1,
    origin: "curated" as const,
    owner: "Synthetic test editor",
    sources: "Original invented exercise",
    rights: "Owned local sample",
    goals: [path.goal],
    backgrounds: [path.background],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new" as const,
  };
  await publish({
    ...base,
    id: path.lessonId,
    kind: "lesson",
    title: path.lessonTitle,
    body: path.lessonBody,
    rubric: null,
    rubricVersion: null,
  });
  await publish({
    ...base,
    id: path.assignmentId,
    kind: "assignment",
    title: path.assignmentTitle,
    body: path.assignmentBody,
    rubric: path.rubric,
    rubricVersion: 1,
  });
  await publish({
    ...base,
    goals: [path.otherAudience.goal],
    backgrounds: [path.otherAudience.background],
    id: path.otherAudience.assignmentId,
    kind: "assignment",
    title: path.otherAudience.assignmentTitle,
    body: "Invented contrast brief for the other audience only.",
    rubric: "Compare the answer with the invented contrast brief.",
    rubricVersion: 1,
  });
  // The contrast is retired afterwards so later journeys never see it.
  return () => catalog.retire(editor, path.otherAudience.assignmentId);
}

// The product's own metadata value for one term on a library content page.
const detail = (page: Page, term: string) =>
  page.locator(
    `xpath=//dt[normalize-space()="${term}"]/following-sibling::dd[1]`,
  );

async function onboard(
  page: Page,
  background: Path["background"],
  goal: Path["goal"],
) {
  await page.goto("/");
  await page.getByLabel("Display name").fill("Sample learner");
  await page.getByLabel("Your starting point").selectOption(background);
  await chooseLearningGoal(page, goal);
  await page
    .getByText("Personalize your path (optional)", { exact: true })
    .click();
  if (background === "technical")
    await page
      .getByRole("group", { name: "IT specialties (optional)" })
      .getByLabel("Cybersecurity")
      .check();
  else
    await page
      .getByRole("group", { name: "Domains of interest (optional)" })
      .getByLabel("Education")
      .check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

async function memberId(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (item) => item.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const tokenHash = createHash("sha256").update(cookie!.value).digest("hex");
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM learners WHERE token_hash=$1",
    [tokenHash],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0]!.id;
}

async function exercisePath(page: Page, context: BrowserContext, path: Path) {
  const retireContrast = await publishPath(path);
  try {
    await exerciseOwnPath(page, context, path);
  } finally {
    await retireContrast();
  }
}

async function exerciseOwnPath(
  page: Page,
  context: BrowserContext,
  path: Path,
) {
  await onboard(page, path.background, path.goal);
  const ownerId = await memberId(context);

  await requiredCheck(1, async () => {
    // The product ties this lesson to the member's direction: the library
    // filtered to the other audience omits it, the member's own lists it.
    const other = path.otherAudience;
    await page.goto(
      `/library?goal=${other.goal}&background=${other.background}`,
    );
    await expect(
      page.getByRole("heading", { name: "Learning library" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: path.lessonTitle }),
    ).toHaveCount(0);
    await page.goto(`/library?goal=${path.goal}&background=${path.background}`);
    await page.getByRole("link", { name: path.lessonTitle }).click();
    await expect(
      page.getByRole("heading", { name: path.lessonTitle }),
    ).toBeVisible();
    await expect(page.locator("pre.content-text")).toContainText(
      path.lessonBody,
    );
    await expect(page.getByText("Readable sample text")).toBeVisible();
    // The lesson page itself states its audience and that it was reviewed.
    await expect(detail(page, "Goals")).toHaveText(path.goal);
    await expect(detail(page, "Backgrounds")).toHaveText(path.background);
    await expect(detail(page, "Review date")).toHaveText(/\d/);
    await expect(detail(page, "Review date")).not.toHaveText("Pending");
    const published = await pool.query(
      "SELECT state,reviewed_at FROM content_versions WHERE id=$1 AND version=1",
      [path.lessonId],
    );
    expect(published.rows[0]?.state).toBe("published");
    expect(published.rows[0]?.reviewed_at).not.toBeNull();
  });

  await requiredCheck(2, async () => {
    await page.goto("/learn");
    const choices = page.getByRole("region", {
      name: "Choose a practice assignment",
    });
    const row = choices.getByRole("listitem").filter({
      hasText: path.assignmentTitle,
    });
    await expect(row).toBeVisible();
    // The other audience's published assignment is not offered to this member.
    const contrast = await pool.query(
      "SELECT state FROM content_versions WHERE id=$1 AND version=1",
      [path.otherAudience.assignmentId],
    );
    expect(contrast.rows[0]?.state).toBe("published");
    await expect(choices).not.toContainText(path.otherAudience.assignmentTitle);
    await expect(
      choices.getByRole("button", {
        name: `Choose ${path.otherAudience.assignmentTitle}`,
      }),
    ).toHaveCount(0);
    await row.getByRole("link", { name: "Read sample" }).click();
    await expect(
      page.getByRole("heading", { name: path.assignmentTitle }),
    ).toBeVisible();
    await expect(page.locator("pre.content-text").first()).toContainText(
      path.assignmentBody,
    );
    await expect(
      page.getByRole("heading", { name: "Versioned rubric 1" }),
    ).toBeVisible();
    await expect(page.locator("pre.content-text").last()).toContainText(
      path.rubric,
    );
    await page.goto("/learn");
    await choices
      .getByRole("button", { name: `Choose ${path.assignmentTitle}` })
      .click();
    await choices
      .getByRole("button", { name: "Start or return to this private attempt" })
      .click();
    const attemptId = new URL(page.url()).pathname.split("/").at(-1)!;
    await page.getByLabel("Private sample response").fill(path.response);
    await page.getByLabel("I used only invented or sample information").check();
    await page.getByRole("button", { name: "Save private draft" }).click();
    // The attempt's own status line names each state the member reached.
    await expect(
      page.getByText(`goal when started: ${path.goal} · private draft saved`),
    ).toBeVisible();
    await page.getByLabel("Submit this saved version locally").check();
    await page
      .getByRole("button", { name: "Submit saved version locally" })
      .click();
    await expect(
      page.getByText(`goal when started: ${path.goal} · submitted locally`),
    ).toBeVisible();
    const pinned = page.getByRole("region", {
      name: "Original assignment rubric",
    });
    await expect(pinned).toContainText("Original rubric version 1");
    await expect(pinned).toContainText(path.rubric);
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
        content_id: path.assignmentId,
        content_version: 1,
        goal_at_start: path.goal,
        response: path.response,
        rubric: path.rubric,
        rubric_version: 1,
      },
    ]);
    expect(saved.rows[0]?.submitted_at).not.toBeNull();
  });
}

test("[F-ECO-02-A] technical learner reads and locally submits a task-specific assignment", async ({
  page,
  context,
}, info) => {
  const n = info.project.name === "desktop-chromium" ? 1 : 2;
  await exercisePath(page, context, {
    background: "technical",
    goal: "build",
    lessonId: `ECA-20${n}`,
    assignmentId: `ECA-21${n}`,
    lessonTitle: `Invented sign-up review lesson ${n}`,
    assignmentTitle: `Invented sign-up test plan ${n}`,
    lessonBody:
      "Read the invented sign-up requirements and identify privacy-sensitive error states.",
    assignmentBody:
      "Plan test cases for invalid input, account privacy and a successful sign-up.",
    rubric:
      "Check invalid input, account privacy and the successful sign-up path against the invented brief.",
    response:
      "I would test malformed input, private account errors and a successful sign-up using invented accounts.",
    otherAudience: {
      background: "professional",
      goal: "work",
      assignmentId: `ECA-22${n}`,
      assignmentTitle: `Invented non-IT contrast task ${n}`,
    },
  });
});

test("[F-ECO-02-B] non-IT professional reads and locally submits a noncoding assignment", async ({
  page,
  context,
  browser,
}, info) => {
  test.setTimeout(90_000);
  const n = info.project.name === "desktop-chromium" ? 1 : 2;
  await exercisePath(page, context, {
    background: "professional",
    goal: "work",
    lessonId: `ECB-20${n}`,
    assignmentId: `ECB-21${n}`,
    lessonTitle: `Invented meeting actions lesson ${n}`,
    assignmentTitle: `Invented meeting follow-up ${n}`,
    lessonBody:
      "Read the invented meeting notes and identify owners, dates and missing details.",
    assignmentBody:
      "Create a plain-language action list from the invented meeting notes. No code is required.",
    rubric:
      "Check the action owners, dates and missing details against the invented notes; no code is required.",
    response:
      "I would list Sam's checklist and Alex's feedback with dates, then ask about missing details.",
    otherAudience: {
      background: "technical",
      goal: "build",
      assignmentId: `ECB-22${n}`,
      assignmentTitle: `Invented technical contrast task ${n}`,
    },
  });

  // The product's own statement that no coding is required shows only on the
  // reviewed assignment pack, so the same kind of member also reads the
  // reviewed meeting-actions assignment, on a database of its own.
  const f = await reviewedContentFixture(browser, info);
  try {
    const actors = await f.publishFixture();
    expect(
      await reviewedAssignmentImportStore(f.pool).import(actors.editor.token),
    ).toBe("imported");
    for (const item of await reviewedAssignments()) {
      expect(await actors.catalog.submit(actors.editor.token, item.id, 2)).toBe(
        true,
      );
      expect(
        await actors.catalog.approve(actors.reviewer.token, item.id, 2, true),
      ).toBe(true);
      expect(
        await actors.catalog.publish(actors.editor.token, item.id, 2),
      ).toBe(true);
    }
    const member = await f.member("professional", "work");
    const opened = await member.goto(f.origin + "/library/ASN-002?version=2");
    expect(opened!.status()).toBe(200);
    const reading = member.locator("main");
    await expect(reading).toContainText(
      "no formal assessment, coding or paid plan is required.",
    );
    // Nothing on the assignment asks this member to write or submit code.
    await expect(reading).not.toContainText(
      /write (the |some |a )?code|submit (your )?code|pull request|unit tests?/i,
    );
  } finally {
    await f.close();
  }
});

test("[F-ECO-02-C] both audiences retain common preview access and see honest specialist readiness", async ({
  page,
  context,
  browser,
}) => {
  const other = await browser.newContext({ baseURL: origin });
  const registryIds = [randomUUID(), randomUUID()];
  try {
    const otherPage = await other.newPage();
    await requiredCheck(1, async () => {
      await onboard(page, "technical", "build");
      await onboard(otherPage, "professional", "work");
      expect(await memberId(context)).not.toBe(await memberId(other));
      for (const learnerPage of [page, otherPage]) {
        await expect(
          learnerPage.getByRole("region", { name: "Your starter plan" }),
        ).toBeVisible();
        await expect(
          learnerPage.getByRole("link", { name: "Open lesson" }),
        ).toBeVisible();
        await learnerPage.getByRole("link", { name: "Open lesson" }).click();
        await expect(
          learnerPage.getByRole("heading", {
            name: "Give AI a clear starting point",
          }),
        ).toBeVisible();
      }
    });
    await requiredCheck(2, async () => {
      const reviewerGap = "Qualified reviewer coverage not verified";
      const capacityGap = "Deliverable service capacity not verified";
      const track = (learnerPage: Page, name: string) =>
        learnerPage.getByRole("listitem").filter({ hasText: name });
      for (const learnerPage of [page, otherPage]) {
        await learnerPage.goto("/readiness/tracks");
        await expect(
          learnerPage.getByRole("heading", { name: "IT specialty services" }),
        ).toBeVisible();
        await expect(
          learnerPage
            .getByRole("listitem")
            .filter({ hasText: "Cybersecurity" }),
        ).toContainText("in preparation");
        await expect(
          learnerPage
            .getByRole("listitem")
            .filter({ hasText: "Education · coaching" }),
        ).toContainText("in preparation");
        await expect(
          learnerPage.getByText("Tailored service cannot be committed"),
        ).toBeVisible();
        await expect(
          learnerPage.getByRole("button", { name: /book|buy|purchase/i }),
        ).toHaveCount(0);
        // With nothing in the registry the formal-review path names both gaps.
        const formal = track(learnerPage, "Education · formal review");
        await expect(formal).toContainText(reviewerGap);
        await expect(formal).toContainText(capacityGap);
      }

      // Contrast: verified reviewer coverage with a backup for one path only.
      // That path must stop naming those gaps while the others stay as they
      // were, so a page that printed one fixed state for every row would fail.
      const auth = authorizationStore(pool);
      const expires = new Date(Date.now() + 86_400_000);
      const [staffId, backupId, adminId] = [
        await auth.provisionStaff(
          randomBytes(32).toString("hex"),
          "reviewer",
          expires,
        ),
        await auth.provisionStaff(
          randomBytes(32).toString("hex"),
          "reviewer",
          expires,
        ),
        await auth.provisionStaff(
          randomBytes(32).toString("hex"),
          "platform_admin",
          expires,
        ),
      ];
      await pool.query(
        `INSERT INTO expert_registry(
           id,staff_id,staff_role,domain,service_type,starts_at,ends_at,
           loaded_cost_cents,capacity_minutes,committed_minutes,backup_staff_id,
           qualification_ref,agreement_ref,conflict_review_ref
         ) VALUES($1,$2,'reviewer','education','formal-review',
           CURRENT_TIMESTAMP-INTERVAL '1 day',CURRENT_TIMESTAMP+INTERVAL '1 day',
           10000,90,0,$4,'invented demo qualification','invented demo agreement',
           'invented demo conflict review'),
         ($3,$4,'reviewer','education','formal-review',
           CURRENT_TIMESTAMP-INTERVAL '1 day',CURRENT_TIMESTAMP+INTERVAL '1 day',
           10000,90,0,$2,'invented demo qualification','invented demo agreement',
           'invented demo conflict review')`,
        [registryIds[0], staffId, registryIds[1], backupId],
      );
      await pool.query(
        `UPDATE expert_registry SET verified_by=$2,verified_at=CURRENT_TIMESTAMP
         WHERE id=ANY($1::uuid[])`,
        [registryIds, adminId],
      );
      for (const learnerPage of [page, otherPage]) {
        await learnerPage.goto("/readiness/tracks");
        const formal = track(learnerPage, "Education · formal review");
        await expect(formal).toBeVisible();
        await expect(formal).not.toContainText(reviewerGap);
        await expect(formal).not.toContainText(capacityGap);
        const coaching = track(learnerPage, "Education · coaching");
        await expect(coaching).toContainText("in preparation");
        await expect(coaching).toContainText(capacityGap);
        await expect(track(learnerPage, "Cybersecurity")).toContainText(
          "in preparation",
        );
        await expect(
          learnerPage.getByRole("button", { name: /book|buy|purchase/i }),
        ).toHaveCount(0);
      }
    });
  } finally {
    await pool.query("DELETE FROM expert_registry WHERE id=ANY($1::uuid[])", [
      registryIds,
    ]);
    await other.close();
  }
});
