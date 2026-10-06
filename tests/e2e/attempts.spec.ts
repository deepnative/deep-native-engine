import { readFile } from "node:fs/promises";
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
  const waitingText =
    "An invented replacement that expires while the draft row is locked.";
  await page.getByLabel("Private sample response").fill(waitingText);
  await page.getByLabel("I used only invented or sample information").check();
  const beforeWait = await pool.query(
    "SELECT * FROM assignment_attempts WHERE id=$1",
    [attemptId],
  );
  const holder = await pool.connect();
  let saving: Promise<void> | undefined;
  try {
    await holder.query("BEGIN");
    const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    await holder.query(
      "SELECT id FROM assignment_attempts WHERE id=$1 FOR UPDATE",
      [attemptId],
    );
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '3.5 seconds' WHERE id=(SELECT member_id FROM assignment_attempts WHERE id=$1)",
      [attemptId],
    );
    saving = Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/assignments/attempts/${attemptId}/save`) &&
          response.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Save private draft" }).click(),
    ]).then(([response]) => {
      expect(response.status()).toBe(409);
    });
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              `SELECT 1 FROM pg_stat_activity waiter CROSS JOIN principals p
       WHERE p.id=(SELECT member_id FROM assignment_attempts WHERE id=$2)
         AND waiter.state='active' AND waiter.wait_event_type='Lock'
         AND $1::integer=ANY(pg_blocking_pids(waiter.pid))
         AND position('FROM assignment_attempts a' in waiter.query)>0
         AND waiter.xact_start<p.expires_at AND p.expires_at<=clock_timestamp()`,
              [holderPid, attemptId],
            )
          ).rowCount,
        { timeout: 6_000, intervals: [10, 20, 50] },
      )
      .toBe(1);
    await holder.query("COMMIT");
    await saving;
    await expect(
      page.getByRole("heading", { name: "Attempt unavailable" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Response to copy before leaving this page"),
    ).toHaveValue(waitingText);
    await expect(
      page.getByRole("button", { name: "Save private draft" }),
    ).toHaveCount(0);
    expect(
      (
        await pool.query("SELECT * FROM assignment_attempts WHERE id=$1", [
          attemptId,
        ])
      ).rows,
    ).toEqual(beforeWait.rows);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM assignment_submission_snapshots WHERE attempt_id=$1",
          [attemptId],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  } finally {
    await holder.query("ROLLBACK");
    await Promise.allSettled(saving ? [saving] : []);
    holder.release();
  }
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '1 day' WHERE id=(SELECT member_id FROM assignment_attempts WHERE id=$1)",
    [attemptId],
  );
  await page.getByRole("link", { name: "Reload this attempt" }).click();
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

test("[L66] a member privately revises a submitted synthetic assignment without losing prior work", async ({
  page,
  browser,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-994" : "SYN-995";
  const title = `Invented revisable assignment ${id}`;
  const actors = await publishers();
  await publish(actors, sample(id, 1, title));
  await onboard(page, "explorer", "everyday");
  const attemptId = await chooseAndStart(page, title);
  const first =
    "My first invented answer compares a plan with the sample brief.";
  await page.getByLabel("Private sample response").fill(first);
  await page.getByLabel("I used only invented or sample information").check();
  await page.getByRole("button", { name: "Save private draft" }).click();
  await page.getByLabel("Submit this saved version locally").check();
  await page
    .getByRole("button", { name: "Submit saved version locally" })
    .click();
  const history = page.getByRole("region", {
    name: "Private local submission history",
  });
  await expect(history).toContainText("Submission 1");
  await expect(history).toContainText(first);
  await page.getByLabel("Start a new private revision").check();
  await page.getByRole("button", { name: "Revise privately" }).click();
  await expect(page.getByLabel("Private sample response")).toHaveValue("");
  await expect(history).toContainText(first);
  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    const other = await otherContext.newPage();
    await onboard(other, "explorer", "everyday");
    await other.goto(`/assignments/attempts/${attemptId}`);
    await expect(
      other.getByRole("heading", { name: "Attempt unavailable" }),
    ).toBeVisible();
    expect(
      (await (await other.request.get("/api/member/export")).json()).records
        .assignmentSubmissions,
    ).toEqual([]);
  } finally {
    await otherContext.close();
  }
  const second = "My second invented answer corrects the source comparison.";
  await page.getByLabel("Private sample response").fill(second);
  await page.getByLabel("I used only invented or sample information").check();
  await page.getByRole("button", { name: "Save private draft" }).click();
  await page.getByLabel("Submit this saved version locally").check();
  await page
    .getByRole("button", { name: "Submit saved version locally" })
    .click();
  await expect(history).toContainText("Submission 1");
  await expect(history).toContainText("Submission 2");
  await expect(history).toContainText(first);
  await expect(history).toContainText(second);
  const exported = await (await page.request.get("/api/member/export")).json();
  expect(exported.version).toBe("local-member-records-v22");
  expect(exported.records.assignmentSubmissions).toMatchObject([
    { attemptId, sequence: 1, response: first },
    { attemptId, sequence: 2, response: second },
  ]);
  expect(await actors.catalog.retire(actors.editor, id)).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Revise privately" }),
  ).toHaveCount(0);
  await expect(history).toContainText(first);
  await expect(history).toContainText(second);
  await page.getByLabel("Delete this private attempt").check();
  await page.getByRole("button", { name: "Delete attempt" }).click();
  await expect(
    page.getByText("No private assignment attempts yet"),
  ).toBeVisible();
  const remaining = await pool.query(
    "SELECT count(*)::integer AS n FROM assignment_submission_snapshots WHERE attempt_id=$1",
    [attemptId],
  );
  expect(remaining.rows[0].n).toBe(0);
});

test("[L85] three learner backgrounds compare only their own immutable private submissions", async ({
  page,
  browser,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-960" : "SYN-961";
  const title = `Invented comparison assignment ${id}`;
  const actors = await publishers();
  await publish(actors, sample(id, 1, title));
  const cases = [
    { background: "explorer", goal: "everyday" },
    { background: "professional", goal: "work" },
    { background: "technical", goal: "build" },
  ];
  const retained: {
    id: string;
    context: Awaited<ReturnType<typeof browser.newContext>>;
  }[] = [];
  try {
    for (const [index, entry] of cases.entries()) {
      const context = await browser.newContext({
        baseURL: origin,
        viewport: page.viewportSize() ?? undefined,
      });
      retained.push({ id: "", context });
      const learner = await context.newPage();
      await onboard(learner, entry.background, entry.goal);
      const attemptId = await chooseAndStart(learner, title);
      retained[index]!.id = attemptId;
      const first = `Invented ${entry.background} first line\nKeep this line`;
      const second = `Invented ${entry.background} second line\nKeep this line`;
      for (const answer of [first, second]) {
        if (answer === second) {
          await learner.getByLabel("Start a new private revision").check();
          await learner
            .getByRole("button", { name: "Revise privately" })
            .click();
        }
        await learner.getByLabel("Private sample response").fill(answer);
        await learner
          .getByLabel("I used only invented or sample information")
          .check();
        await learner
          .getByRole("button", { name: "Save private draft" })
          .click();
        await learner.getByLabel("Submit this saved version locally").check();
        await learner
          .getByRole("button", { name: "Submit saved version locally" })
          .click();
      }
      const history = learner.getByRole("region", {
        name: "Private local submission history",
      });
      await expect(history).toContainText(first);
      await expect(history).toContainText(second);
      await learner
        .getByRole("link", { name: "Compare private submissions" })
        .focus();
      await learner.keyboard.press("Enter");
      await expect(
        learner.getByRole("heading", { name: "Compare private submissions" }),
      ).toBeVisible();
      await expect(
        learner.getByRole("region", { name: "Original submissions" }),
      ).toContainText(first);
      await expect(
        learner.getByRole("region", { name: "Original submissions" }),
      ).toContainText(second);
      await expect(
        learner.getByRole("region", { name: "Text changes" }),
      ).toContainText("Removed");
      await expect(
        learner.getByRole("region", { name: "Text changes" }),
      ).toContainText("Added");
      expect(
        await learner.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await learner.getByLabel("From submission").focus();
      await expect(learner.getByLabel("From submission")).toBeFocused();
      await learner.getByLabel("From submission").selectOption("2");
      await expect(learner.getByLabel("From submission")).toHaveValue("2");
      await learner.keyboard.press("Tab");
      await expect(learner.getByLabel("To submission")).toBeFocused();
      await learner.getByLabel("To submission").selectOption("1");
      await expect(learner.getByLabel("To submission")).toHaveValue("1");
      await learner.keyboard.press("Tab");
      await expect(
        learner.getByRole("button", { name: "Compare submissions" }),
      ).toBeFocused();
      await learner.keyboard.press("Enter");
      await expect(
        learner.getByRole("heading", { name: /From submission 2/ }),
      ).toBeVisible();
      const outsider = retained[0]!.context.pages()[0]!;
      if (index > 0) {
        const foreign = await outsider.request.get(
          `/assignments/attempts/${attemptId}/compare?from=1&to=2`,
        );
        expect(foreign.status()).toBe(404);
        expect(await foreign.text()).not.toContain(second);
      }
    }
    expect(await actors.catalog.retire(actors.editor, id)).toBe(true);
    for (const entry of retained) {
      const learner = entry.context.pages()[0]!;
      await learner.reload();
      await expect(
        learner.getByRole("region", { name: "Original submissions" }),
      ).toBeVisible();
      expect(
        (await (await learner.request.get("/api/member/export")).json()).records
          .assignmentSubmissions,
      ).toHaveLength(2);
    }
  } finally {
    await Promise.all(retained.map((entry) => entry.context.close()));
  }
});

test("[L88] private simulated portfolio statements pin submitted versions across learner backgrounds", async ({
  page,
  browser,
}, info) => {
  const actors = await publishers();
  const id = info.project.name === "desktop-chromium" ? "SYN-884" : "SYN-885";
  const title = `Invented portfolio statement ${id}`;
  await publish(actors, sample(id, 1, title));
  for (const [background, goal] of [
    ["explorer", "everyday"],
    ["professional", "work"],
    ["technical", "build"],
  ]) {
    const context = await browser.newContext({
      baseURL: origin,
      viewport: page.viewportSize() ?? undefined,
    });
    try {
      const learner = await context.newPage();
      await onboard(learner, background!, goal!);
      const attemptId = await chooseAndStart(learner, title);
      const answers = [
        `Invented ${background} first <script>alert("sample")</script> response.`,
        `Invented ${background} second response and revised verification.`,
      ];
      for (const [index, answer] of answers.entries()) {
        if (index) {
          await learner.getByLabel("Start a new private revision").check();
          await learner
            .getByRole("button", { name: "Revise privately" })
            .click();
        }
        await learner.getByLabel("Private sample response").fill(answer);
        await learner
          .getByLabel("I used only invented or sample information")
          .check();
        await learner
          .getByRole("button", { name: "Save private draft" })
          .click();
        await learner.getByLabel("Submit this saved version locally").check();
        await learner
          .getByRole("button", { name: "Submit saved version locally" })
          .click();
      }
      await expect(
        learner.getByRole("region", {
          name: "Private local submission history",
        }),
      ).toContainText("Submission 2");
      await learner.reload();
      await expect(
        learner.getByText(
          "These submitted versions and their portfolio statements are simulated, self-authored and unreviewed.",
          { exact: false },
        ),
      ).toBeVisible();
      for (const sequence of [1, 2]) {
        const link = learner.getByRole("link", {
          name: `Download simulated portfolio statement for submission ${sequence}`,
        });
        await link.focus();
        await expect(link).toBeFocused();
        const downloadPromise = learner.waitForEvent("download");
        await learner.keyboard.press("Enter");
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe(
          `simulated-portfolio-submission-${sequence}.html`,
        );
        const html = await readFile((await download.path())!, "utf8");
        expect(html).toContain("SIMULATED · SELF-AUTHORED · UNREVIEWED");
        expect(html).toContain(`submission ${sequence}`);
        expect(html).toContain(
          `Invented ${background} ${sequence === 1 ? "first" : "second"}`,
        );
        expect(html).not.toContain(
          `Invented ${background} ${sequence === 1 ? "second" : "first"}`,
        );
        expect(html).not.toContain("<script>");
      }
      const outsider = await browser.newContext({ baseURL: origin });
      try {
        const other = await outsider.newPage();
        await onboard(other, "explorer", "everyday");
        const denied = await other.request.get(
          `/assignments/attempts/${attemptId}/portfolio/1`,
        );
        expect(denied.status()).toBe(404);
        expect(await denied.text()).not.toContain(
          `Invented ${background} first`,
        );
      } finally {
        await outsider.close();
      }
      await learner
        .getByLabel("Delete this private attempt and all its submissions")
        .check();
      await learner
        .getByRole("button", { name: "Delete attempt", exact: true })
        .click();
      const deleted = await learner.request.get(
        `/assignments/attempts/${attemptId}/portfolio/1`,
      );
      expect(deleted.status()).toBe(404);
      expect(await deleted.text()).not.toContain(
        `Invented ${background} first`,
      );
    } finally {
      await context.close();
    }
  }
});

test("[L100] a workspace deletion withholds private assignment history while other members remain isolated", async ({
  page,
  browser,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-956" : "SYN-955";
  const title = `Private deletion-bound history ${id}`;
  const actors = await publishers();
  await publish(actors, sample(id, 1, title));
  await onboard(page, "explorer", "everyday");
  const attemptId = await chooseAndStart(page, title);
  await page
    .getByLabel("Private sample response")
    .fill("An invented private history that must be hidden during deletion.");
  await page.getByLabel("I used only invented or sample information").check();
  await page.getByRole("button", { name: "Save private draft" }).click();
  await page.goto("/assignments/attempts");
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  const outsider = await browser.newContext({ baseURL: origin });
  try {
    const other = await outsider.newPage();
    await onboard(other, "professional", "work");
    await other.goto("/assignments/attempts");
    await expect(
      other.getByText("No private assignment attempts yet"),
    ).toBeVisible();
    await expect(other.getByText(title)).toHaveCount(0);
    const before = (
      await pool.query("SELECT * FROM assignment_attempts WHERE id=$1", [
        attemptId,
      ])
    ).rows;
    await pool.query(
      "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
      [before[0].member_id],
    );
    for (const path of ["/assignments/attempts", "/progress"]) {
      const result = await page.goto(path);
      expect(result?.status()).toBe(403);
      await expect(
        page.getByRole("heading", {
          name:
            path === "/progress"
              ? "Progress unavailable"
              : "Assignment history unavailable",
        }),
      ).toBeVisible();
      await expect(page.getByText(title)).toHaveCount(0);
      await expect(page.locator(`a[href*="${attemptId}"]`)).toHaveCount(0);
      await expect(
        page.getByText("No private assignment attempts yet"),
      ).toHaveCount(0);
    }
    expect(
      (
        await pool.query("SELECT * FROM assignment_attempts WHERE id=$1", [
          attemptId,
        ])
      ).rows,
    ).toEqual(before);
  } finally {
    await outsider.close();
  }
});
