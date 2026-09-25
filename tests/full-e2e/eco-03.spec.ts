import { createHash, randomBytes } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

function assignment(
  id: string,
  version: number,
  title: string,
  goal: "everyday" | "work" | "build",
): DraftContent {
  return {
    id,
    version,
    kind: "assignment",
    origin: "curated",
    title,
    body: "Use invented details and check the answer against this sample brief.",
    owner: "Synthetic test editor",
    sources: "Original invented brief",
    rights: "Owned sample",
    goals: [goal],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric: `Compare the invented answer with version ${version} of the brief.`,
    rubricVersion: version,
  };
}

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

async function onboard(page: Page, goal: "everyday" | "work" | "build") {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("professional");
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

async function learnerId(context: BrowserContext) {
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

async function saveDraft(page: Page, response: string) {
  await page.getByLabel("Private sample response").fill(response);
  await page.getByLabel("I used only invented or sample information").check();
  await page.getByRole("button", { name: "Save private draft" }).click();
  await expect(page.getByText("private draft saved")).toBeVisible();
}

async function changeGoal(page: Page, goal: "everyday" | "work" | "build") {
  await page.goto("/learn");
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByRole("button", { name: "Save my direction" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

async function rejectAttemptUpdates(id: string) {
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await pool.query(
    `CREATE FUNCTION eco03_reject_attempt_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${id}'::uuid THEN
          RAISE EXCEPTION 'synthetic attempt write fault';
        END IF;
        RETURN NEW;
      END $$`,
  );
  await pool.query(
    "CREATE TRIGGER eco03_reject_attempt_update BEFORE UPDATE ON assignment_attempts FOR EACH ROW EXECUTE FUNCTION eco03_reject_attempt_update()",
  );
}

async function allowAttemptUpdates() {
  await pool.query(
    "DROP TRIGGER IF EXISTS eco03_reject_attempt_update ON assignment_attempts",
  );
  await pool.query("DROP FUNCTION IF EXISTS eco03_reject_attempt_update()");
}

test("[F-ECO-03-A] changed goal preserves the owner's private versioned evidence", async ({
  page,
  context,
  browser,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "ECA-301" : "ECA-302";
  const title = `Invented professional practice ${id}`;
  const response = `Private invented response for ${id}; keep the old version.`;
  const actors = await publishers();
  await publish(actors, assignment(id, 1, title, "work"));
  await onboard(page, "work");
  const ownerId = await learnerId(context);
  const attemptId = await chooseAndStart(page, title);
  await saveDraft(page, response);

  await requiredCheck(1, async () => {
    await changeGoal(page, "everyday");
    await page.goto(`/assignments/attempts/${attemptId}`);
    await expect(page.getByText(response)).toBeVisible();
    await expect(
      page.getByText("cannot be edited", { exact: false }),
    ).toBeVisible();
    const outsider = await browser.newContext({ baseURL: origin });
    try {
      const otherPage = await outsider.newPage();
      await onboard(otherPage, "everyday");
      await otherPage.goto(`/assignments/attempts/${attemptId}`);
      await expect(
        otherPage.getByRole("heading", { name: "Attempt unavailable" }),
      ).toBeVisible();
      await expect(otherPage.getByText(response)).toHaveCount(0);
    } finally {
      await outsider.close();
    }
  });

  await requiredCheck(2, async () => {
    await publish(actors, assignment(id, 2, title, "work"));
    await page.reload();
    await expect(
      page.getByText("Assignment version 1", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText(response)).toBeVisible();
    const saved = await pool.query(
      `SELECT a.member_id,a.content_version,a.goal_at_start,a.response,
              cv.rubric_version,cv.rubric
       FROM assignment_attempts a JOIN content_versions cv
         ON cv.id=a.content_id AND cv.version=a.content_version
       WHERE a.id=$1`,
      [attemptId],
    );
    expect(saved.rows).toMatchObject([
      {
        member_id: ownerId,
        content_version: 1,
        goal_at_start: "work",
        response,
        rubric_version: 1,
        rubric: "Compare the invented answer with version 1 of the brief.",
      },
    ]);
  });
});

test("[F-ECO-03-B] returning member resumes old work and sees only new-goal choices", async ({
  page,
  context,
  browser,
}, info) => {
  const desktop = info.project.name === "desktop-chromium";
  const oldId = desktop ? "ECB-311" : "ECB-312";
  const newId = desktop ? "ECB-313" : "ECB-314";
  const oldTitle = `Invented work sample ${oldId}`;
  const newTitle = `Invented everyday sample ${newId}`;
  const response = `Private retained work for ${oldId}; it should still be readable.`;
  const actors = await publishers();
  await publish(actors, assignment(oldId, 1, oldTitle, "work"));
  await publish(actors, assignment(newId, 1, newTitle, "everyday"));
  await onboard(page, "work");
  const oldAttempt = await chooseAndStart(page, oldTitle);
  await saveDraft(page, response);
  await changeGoal(page, "everyday");
  const previewCookie = (await context.cookies()).find(
    (cookie) => cookie.name === "dne_preview",
  );
  expect(previewCookie).toBeDefined();
  expect(previewCookie!.expires).toBeGreaterThan(Date.now() / 1000);
  let returningContext: BrowserContext | undefined;
  let returningPage: Page | undefined;
  try {
    await requiredCheck(1, async () => {
      // A new browser context represents a later return with only the existing,
      // unexpired member session. No elapsed clock time is simulated.
      await context.close();
      returningContext = await browser.newContext({ baseURL: origin });
      await returningContext.addCookies([previewCookie!]);
      returningPage = await returningContext.newPage();
      await returningPage.goto("/assignments/attempts");
      await expect(
        returningPage.getByRole("link", { name: oldTitle }),
      ).toBeVisible();
      await returningPage.getByRole("link", { name: oldTitle }).click();
      await expect(returningPage).toHaveURL(
        new RegExp(`/assignments/attempts/${oldAttempt}$`),
      );
      await expect(returningPage.getByText(response)).toBeVisible();
      await expect(
        returningPage.getByText("Assignment version 1", { exact: false }),
      ).toBeVisible();
      await expect(
        returningPage.getByText("cannot be edited", { exact: false }),
      ).toBeVisible();

      const outsider = await browser.newContext({ baseURL: origin });
      try {
        const outsiderPage = await outsider.newPage();
        await onboard(outsiderPage, "everyday");
        await outsiderPage.goto(`/assignments/attempts/${oldAttempt}`);
        await expect(
          outsiderPage.getByRole("heading", { name: "Attempt unavailable" }),
        ).toBeVisible();
        await expect(outsiderPage.getByText(response)).toHaveCount(0);
      } finally {
        await outsider.close();
      }
    });

    await requiredCheck(2, async () => {
      await returningPage!.goto("/learn");
      const choices = returningPage!.getByRole("region", {
        name: "Choose a practice assignment",
      });
      await expect(
        choices.getByRole("button", { name: `Choose ${oldTitle}` }),
      ).toHaveCount(0);
      await expect(
        choices.getByRole("button", { name: `Choose ${newTitle}` }),
      ).toBeVisible();
      const newAttempt = await chooseAndStart(returningPage!, newTitle);
      expect(newAttempt).not.toBe(oldAttempt);
      const retained = await pool.query(
        "SELECT content_id,content_version,response FROM assignment_attempts WHERE id=$1",
        [oldAttempt],
      );
      expect(retained.rows).toMatchObject([
        { content_id: oldId, content_version: 1, response },
      ]);
    });
  } finally {
    await returningContext?.close();
  }
});

test("[F-ECO-03-C] empty new-goal path and failed save give an honest recovery", async ({
  page,
}, info) => {
  const desktop = info.project.name === "desktop-chromium";
  const oldId = desktop ? "ECC-321" : "ECC-322";
  const newId = desktop ? "ECC-323" : "ECC-324";
  const oldTitle = `Invented work sample ${oldId}`;
  const newTitle = `Invented technical sample ${newId}`;
  const actors = await publishers();
  await publish(actors, assignment(oldId, 1, oldTitle, "work"));
  await onboard(page, "work");
  const oldAttempt = await chooseAndStart(page, oldTitle);
  await saveDraft(page, `Private old work for ${oldId}.`);
  await changeGoal(page, "build");

  await requiredCheck(1, async () => {
    await expect(
      page.getByText("No published assignment currently fits your goal", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Continue with the local foundation lesson or revise your direction.",
        {
          exact: false,
        },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "Exercises completed" }),
    ).toHaveAttribute("value", "0");
    await page.goto(`/assignments/attempts/${oldAttempt}`);
    await expect(
      page.getByText("cannot be edited", { exact: false }),
    ).toBeVisible();
  });

  await publish(actors, assignment(newId, 1, newTitle, "build"));
  await page.goto("/learn");
  const attemptId = await chooseAndStart(page, newTitle);
  const saved = `First invented response for ${newId}; safely saved before the fault.`;
  const unsaved = `Second invented response for ${newId}; copy and recover it.`;
  await saveDraft(page, saved);
  await requiredCheck(2, async () => {
    await rejectAttemptUpdates(attemptId);
    try {
      await page.getByLabel("Private sample response").fill(unsaved);
      await page
        .getByLabel("I used only invented or sample information")
        .check();
      await page.getByRole("button", { name: "Save private draft" }).click();
      await expect(
        page.getByRole("heading", { name: "Save outcome unknown" }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Response to copy before leaving this page"),
      ).toHaveValue(unsaved);
      const unchanged = await pool.query(
        "SELECT response,revision FROM assignment_attempts WHERE id=$1",
        [attemptId],
      );
      expect(unchanged.rows).toMatchObject([{ response: saved, revision: 2 }]);
    } finally {
      await allowAttemptUpdates();
    }
    const copied = await page
      .getByLabel("Response to copy before leaving this page")
      .inputValue();
    await page.getByRole("link", { name: "Reload this attempt" }).click();
    await expect(page.getByLabel("Private sample response")).toHaveValue(saved);
    await saveDraft(page, copied);
    await expect(page.getByLabel("Private sample response")).toHaveValue(
      unsaved,
    );
  });
  expect(await actors.catalog.retire(actors.editor, newId)).toBe(true);
});
