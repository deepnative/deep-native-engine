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
async function rejectAttemptUpdates(id: string) {
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await pool.query(
    `CREATE FUNCTION test_reject_attempt_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${id}'::uuid THEN
          RAISE EXCEPTION 'synthetic attempt write fault';
        END IF;
        RETURN NEW;
      END $$`,
  );
  await pool.query(
    "CREATE TRIGGER test_reject_attempt_update BEFORE UPDATE ON assignment_attempts FOR EACH ROW EXECUTE FUNCTION test_reject_attempt_update()",
  );
}
async function allowAttemptUpdates() {
  await pool.query(
    "DROP TRIGGER IF EXISTS test_reject_attempt_update ON assignment_attempts",
  );
  await pool.query("DROP FUNCTION IF EXISTS test_reject_attempt_update()");
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
  await expect(
    stale.getByText("Another tab saved a newer revision", { exact: false }),
  ).toBeVisible();
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

test("[L51] a general learner can copy a failed save and recover without claiming a write", async ({
  page,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-976" : "SYN-977";
  const title = `Invented recovery exercise ${id}`;
  const actors = await publishers();
  await publish(actors, sample(id, 1, title));
  await onboard(page, "explorer", "everyday");
  const attemptId = await chooseAndStart(page, title);
  const unsaved = "I can copy this invented response after a storage fault.";
  await page.getByLabel("Private sample response").fill(unsaved);
  await page.getByLabel("I used only invented or sample information").check();
  await rejectAttemptUpdates(attemptId);
  try {
    await page.getByRole("button", { name: "Save private draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Save outcome unknown" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Response to copy before leaving this page"),
    ).toHaveValue(unsaved);
    await expect(
      page.getByRole("button", { name: "Save private draft" }),
    ).toHaveCount(0);
    const unchanged = await pool.query(
      "SELECT response,revision,saved_at FROM assignment_attempts WHERE id=$1",
      [attemptId],
    );
    expect(unchanged.rows).toMatchObject([
      { response: "", revision: 1, saved_at: null },
    ]);
  } finally {
    await allowAttemptUpdates();
  }
  const copied = await page
    .getByLabel("Response to copy before leaving this page")
    .inputValue();
  await page.getByRole("link", { name: "Reload this attempt" }).click();
  await page.getByLabel("Private sample response").fill(copied);
  await page.getByLabel("I used only invented or sample information").check();
  await page.getByRole("button", { name: "Save private draft" }).click();
  await expect(page.getByLabel("Private sample response")).toHaveValue(unsaved);
  const laterText = "A second invented response after my session expired.";
  await page.getByLabel("Private sample response").fill(laterText);
  await page.getByLabel("I used only invented or sample information").check();
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP WHERE id=(SELECT member_id FROM assignment_attempts WHERE id=$1)",
    [attemptId],
  );
  await page.getByRole("button", { name: "Save private draft" }).click();
  await expect(
    page.getByRole("heading", { name: "Session expired" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Response to copy before leaving this page"),
  ).toHaveValue(laterText);
  const saved = await pool.query(
    "SELECT response,revision FROM assignment_attempts WHERE id=$1",
    [attemptId],
  );
  expect(saved.rows).toMatchObject([{ response: unsaved, revision: 2 }]);
});

test("[L52] an IT learner checks an uncertain local submission before retrying", async ({
  page,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-978" : "SYN-979";
  const title = `Invented technical recovery ${id}`;
  const actors = await publishers();
  await publish(actors, {
    ...sample(id, 1, title),
    goals: ["build"],
    backgrounds: ["technical"],
  });
  await onboard(page, "technical", "build");
  const attemptId = await chooseAndStart(page, title);
  const response =
    "A saved synthetic technical response for uncertain submission.";
  await page.getByLabel("Private sample response").fill(response);
  await page.getByLabel("I used only invented or sample information").check();
  await page.getByRole("button", { name: "Save private draft" }).click();
  await rejectAttemptUpdates(attemptId);
  try {
    await page.getByLabel("Submit this saved version locally").check();
    await page
      .getByRole("button", { name: "Submit saved version locally" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Submission outcome unknown" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Response to copy before leaving this page"),
    ).toHaveValue(response);
    await expect(
      page.getByRole("button", { name: "Submit saved version locally" }),
    ).toHaveCount(0);
    const unchanged = await pool.query(
      "SELECT count(*)::integer AS n,max(submitted_at) AS submitted_at FROM assignment_attempts WHERE id=$1",
      [attemptId],
    );
    expect(unchanged.rows[0]).toMatchObject({ n: 1, submitted_at: null });
  } finally {
    await allowAttemptUpdates();
  }
  await page.getByRole("link", { name: "Reload this attempt" }).click();
  await expect(page.getByText("private draft saved")).toBeVisible();
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  const revision = await page
    .locator('input[name="revision"]')
    .first()
    .inputValue();
  await page.getByLabel("Submit this saved version locally").check();
  await page
    .getByRole("button", { name: "Submit saved version locally" })
    .click();
  await expect(
    page.getByText(/Assignment version 1 .* submitted locally/),
  ).toBeVisible();
  const replay = await page.request.post(
    `${origin}/assignments/attempts/${attemptId}/submit`,
    {
      form: { csrf, revision, confirm: "yes", response_snapshot: response },
      headers: { Origin: origin },
      maxRedirects: 0,
    },
  );
  expect(replay.status()).toBe(409);
  const rows = await pool.query(
    "SELECT count(*)::integer AS n FROM assignment_attempts WHERE id=$1 AND submitted_at IS NOT NULL",
    [attemptId],
  );
  expect(rows.rows[0].n).toBe(1);
});
