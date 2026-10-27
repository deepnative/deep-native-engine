import { test, expect, type Page } from "@playwright/test";
import { app } from "../../src/app.ts";
import { type Goal } from "../../src/content.ts";
import { COOKIE } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";

const pool = testPool();
const members = store(pool);
test.beforeAll(() => migrate(pool));
test.afterAll(() => pool.end());

async function fixture(page: Page, goal: Goal) {
  let origin = "http://127.0.0.1:0";
  const server = await listenLoopback(
    app(members, {
      get origin() {
        return origin;
      },
      secret: "synthetic-guidance-browser",
    }),
  );
  const binding = server.address();
  if (!binding || typeof binding === "string")
    throw Error("Loopback unavailable");
  origin = `http://127.0.0.1:${binding.port}`;
  let id: string | undefined;
  return {
    origin,
    async onboard() {
      await page.goto(origin);
      await page.getByLabel("Your starting point").selectOption("explorer");
      await page.getByLabel("What would you like to do?").selectOption(goal);
      await page
        .getByRole("button", { name: "Start my learning path" })
        .click();
      await expect(page).toHaveURL(`${origin}/learn`);
      const token = (await page.context().cookies()).find(
        (cookie) => cookie.name === COOKIE,
      )?.value;
      if (!token) throw Error("Synthetic member cookie unavailable");
      const session = await members.session(token);
      if (session.kind !== "active")
        throw Error("Synthetic member unavailable");
      id = session.learner.id;
      return id;
    },
    async close() {
      await closeLoopback(server);
      if (id) await pool.query("DELETE FROM principals WHERE id=$1", [id]);
    },
  };
}

const journeys = [
  {
    id: "L242",
    goal: "everyday",
    wrong: "b",
    correct: "a",
    transfer: "b",
    source: "12 volunteers and two hours on Saturday",
    correction: "The note says 12.",
    hint: "The note gives no place or start time.",
    transferFeedback: "This preserves the note's uncertainty.",
    nextGoal: "work",
    nextSource: "Sam will write the checklist",
  },
  {
    id: "L243",
    goal: "work",
    wrong: "a",
    correct: "b",
    transfer: "c",
    source: "Sam will write the checklist",
    correction: "The note explicitly gives Sam this task.",
    hint: "Look for a new job or deadline",
    transferFeedback: "This keeps the missing decision visible",
    nextGoal: "build",
    nextSource: "No tests have been run.",
  },
  {
    id: "L244",
    goal: "build",
    wrong: "a",
    correct: "c",
    transfer: "a",
    source: "No tests have been run.",
    correction: "The requirements cannot establish a test result.",
    hint: "It does not tell us what happened in a test.",
    transferFeedback: "absence of an observed result",
    nextGoal: "everyday",
    nextSource: "12 volunteers and two hours on Saturday",
  },
] as const;

for (const journey of journeys)
  test(`[${journey.id}] GUIDE-01/02/03/04/06/07 ${journey.goal} member learns, corrects, applies and returns to saved work`, async ({
    page,
  }) => {
    const f = await fixture(page, journey.goal);
    try {
      const id = await f.onboard();
      await page
        .getByRole("link", { name: "Open lesson", exact: true })
        .click();
      await page
        .getByRole("link", { name: "Start with a guided example" })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Turn a vague request into a useful one",
        }),
      ).toBeVisible();
      await expect(page.locator(".guidance-source")).toContainText(
        journey.source,
      );
      await expect(
        page.locator(".guidance-steps li[aria-current=step]"),
      ).toHaveText("1 Example");
      await page.screenshot({
        path: `artifacts/guidance-${journey.goal}-example-${test.info().project.name}.png`,
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.getByRole("link", { name: "Try a quick check" }).click();
      await page.goBack();
      await expect(
        page.getByRole("heading", { name: "Why this works" }),
      ).toBeVisible();
      await page.goForward();
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Check the facts", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "Go to your writing exercise" })
        .click();
      const instruction = `Use the invented ${journey.goal} brief to make a practical plan. Keep unknown details open.`;
      const verification =
        "Compare every number, owner and date with the original brief.";
      await page.getByLabel("Your instruction to AI").fill(instruction);
      await page
        .getByLabel("How will you check the result?")
        .fill(verification);
      await page
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      const draft = await members.progress(id);
      expect(draft).toMatchObject({
        instruction,
        verification,
        completed_at: null,
      });
      await page
        .getByRole("link", { name: "Revisit the guided example" })
        .click();
      await page.getByRole("link", { name: "Try a quick check" }).click();
      await page.locator(`input[name=choice][value=${journey.wrong}]`).check();
      await page
        .getByRole("button", { name: "Check answer", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText(journey.correction);
      await page.getByText("Give me a hint", { exact: true }).click();
      await expect(page.locator("details[open]")).toContainText(journey.hint);
      await page.screenshot({
        path: `artifacts/guidance-${journey.goal}-correction-${test.info().project.name}.png`,
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page
        .locator(`input[name=choice][value=${journey.correct}]`)
        .check();
      await page
        .getByRole("button", { name: "Check again", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText(
        "That's the right check",
      );
      await page.getByRole("link", { name: "Try a new situation" }).click();
      await expect(
        page.getByRole("heading", { name: "Try a new situation", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".guidance-source")).not.toContainText(
        journey.source,
      );
      await page
        .locator(`input[name=choice][value=${journey.transfer}]`)
        .check();
      await page
        .getByRole("button", { name: "Check answer", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText(
        journey.transferFeedback,
      );
      expect(await members.progress(id)).toEqual(draft);
      await page.getByRole("link", { name: "Write your own request" }).click();
      await expect(page.getByLabel("Your instruction to AI")).toHaveValue(
        instruction,
      );
      await expect(
        page.getByLabel("How will you check the result?"),
      ).toHaveValue(verification);
      await page.getByLabel("I checked the context").check();
      await page
        .getByRole("button", { name: "Complete exercise", exact: true })
        .click();
      await page.reload();
      await expect(
        page.getByText("Exercise completed", { exact: true }),
      ).toBeVisible();
      const completed = await members.progress(id);
      expect(completed?.completed_at).toBeInstanceOf(Date);
      await page.goto(`${f.origin}/lesson/guide/practise`);
      const profile = await page.context().newPage();
      try {
        await profile.goto(`${f.origin}/learn`);
        await profile
          .getByLabel("What would you like to do?")
          .selectOption(journey.nextGoal);
        await profile
          .getByRole("button", { name: "Save my direction", exact: true })
          .click();
        await expect(
          profile.getByLabel("What would you like to do?"),
        ).toHaveValue(journey.nextGoal);
      } finally {
        await profile.close();
      }
      await page
        .locator(`input[name=choice][value=${journey.correct}]`)
        .check();
      const response = page.waitForResponse(
        (r) =>
          r.url() === `${f.origin}/lesson/guide/check` &&
          r.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Check answer", exact: true })
        .click();
      expect((await response).status()).toBe(409);
      await expect(
        page.getByRole("heading", {
          name: "Your lesson direction has changed",
        }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "Open your current lesson guide" })
        .click();
      await expect(page.locator(".guidance-source")).toContainText(
        journey.nextSource,
      );
      await page
        .getByRole("link", { name: "Go to your writing exercise" })
        .click();
      await expect(
        page.getByRole("region", { name: "Retained starter exercises" }),
      ).toContainText(instruction);
      const { rows: history } = await pool.query<{
        instruction: string;
        completed_at: Date | null;
      }>(
        "SELECT instruction, completed_at FROM exercises WHERE learner_id=$1",
        [id],
      );
      expect(
        history.some(
          (row) => row.instruction === instruction && row.completed_at !== null,
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
