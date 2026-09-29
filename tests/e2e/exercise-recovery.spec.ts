import { createHash } from "node:crypto";
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { testPool } from "../support/database.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

async function startLesson(page: Page, background: string, goal: string) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await page.getByRole("link", { name: "Open lesson" }).click();
}

async function learnerId(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (item) => item.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const tokenHash = createHash("sha256").update(cookie!.value).digest("hex");
  const result = await pool.query(
    "SELECT id FROM learners WHERE token_hash=$1",
    [tokenHash],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0].id as string;
}

async function rejectExerciseUpdate(id: string) {
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await pool.query(
    `CREATE FUNCTION dne_test_reject_exercise_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.learner_id = '${id}'::uuid THEN
          RAISE EXCEPTION 'synthetic exercise update fault';
        END IF;
        RETURN NEW;
      END $$`,
  );
  await pool.query(
    "CREATE TRIGGER dne_test_reject_exercise_update BEFORE UPDATE ON exercises FOR EACH ROW EXECUTE FUNCTION dne_test_reject_exercise_update()",
  );
}

async function allowExerciseUpdate() {
  await pool.query(
    "DROP TRIGGER IF EXISTS dne_test_reject_exercise_update ON exercises",
  );
  await pool.query("DROP FUNCTION IF EXISTS dne_test_reject_exercise_update()");
}

async function selectByKeyboard(page: Page, field: Locator, value: string) {
  for (let step = 0; step < 30; step += 1) {
    await page.keyboard.press("Tab");
    if (await field.evaluate((element) => element === document.activeElement)) {
      break;
    }
  }
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("readonly", "");
  await page.keyboard.press("ControlOrMeta+A");
  const selection = await field.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    return [textarea.selectionStart, textarea.selectionEnd];
  });
  expect(selection).toEqual([0, value.length]);
}

test("[L84] three learner backgrounds can copy an uncertain exercise write and inspect the prior draft", async ({
  page,
  context,
}) => {
  for (const [background, goal] of [
    ["explorer", "everyday"],
    ["professional", "work"],
    ["technical", "build"],
  ] as const) {
    await context.clearCookies();
    await startLesson(page, background, goal);
    const id = await learnerId(context);
    const priorInstruction = `Use invented ${background} notes to draft a short plan with two steps.`;
    const priorVerification = `Compare each step with the invented ${background} notes.`;
    await page.getByLabel("Your instruction to AI").fill(priorInstruction);
    await page
      .getByLabel("How will you check the result?")
      .fill(priorVerification);
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByLabel("Your instruction to AI")).toHaveValue(
      priorInstruction,
    );

    const attemptedInstruction = `Use invented ${background} notes <script>window.compromised=true</script> to make a revised plan.`;
    const attemptedVerification = `Check the revised ${background} plan against the invented source; mark unsupported claims.`;
    await page.getByLabel("Your instruction to AI").fill(attemptedInstruction);
    await page
      .getByLabel("How will you check the result?")
      .fill(attemptedVerification);
    await page.getByLabel("I checked the context").check();

    try {
      await rejectExerciseUpdate(id);
      const requests: string[] = [];
      const recordRequest = (request: { method(): string; url(): string }) => {
        if (request.url().endsWith("/exercise"))
          requests.push(request.method());
      };
      context.on("request", recordRequest);
      try {
        const responsePromise = page.waitForResponse(
          (response) =>
            response.url().endsWith("/exercise") &&
            response.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Complete exercise" }).click();
        expect((await responsePromise).status()).toBe(503);
        await expect(
          page.getByRole("heading", { name: "Save outcome unknown" }),
        ).toBeVisible();
        await expect(page.getByRole("alert")).toBeVisible();
        const instruction = page.getByLabel("Attempted instruction");
        const verification = page.getByLabel("Attempted way to check");
        await expect(instruction).toHaveValue(attemptedInstruction);
        await expect(verification).toHaveValue(attemptedVerification);
        expect(
          await page.evaluate(() => Object.hasOwn(window, "compromised")),
        ).toBe(false);
        await selectByKeyboard(page, instruction, attemptedInstruction);
        await selectByKeyboard(page, verification, attemptedVerification);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);

        const inspect = page.getByRole("link", {
          name: "Inspect saved lesson (opens in a new tab)",
        });
        await expect(inspect).toHaveAttribute("target", "_blank");
        await expect(inspect).toHaveAttribute("rel", /noopener/);
        const popupPromise = page.waitForEvent("popup");
        await inspect.focus();
        await page.keyboard.press("Enter");
        const saved = await popupPromise;
        await saved.waitForLoadState();
        await expect(saved).toHaveURL(/\/lesson$/);
        await expect(saved.getByLabel("Your instruction to AI")).toHaveValue(
          priorInstruction,
        );
        await expect(
          saved.getByLabel("How will you check the result?"),
        ).toHaveValue(priorVerification);
        await expect(
          saved.getByRole("button", { name: "Complete exercise" }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Save outcome unknown" }),
        ).toBeVisible();
        await expect(instruction).toHaveValue(attemptedInstruction);
        await expect(verification).toHaveValue(attemptedVerification);
        expect(requests).toEqual(["POST"]);
        await saved.close();

        const persisted = await pool.query(
          "SELECT instruction,verification,completed_at FROM exercises WHERE learner_id=$1",
          [id],
        );
        expect(persisted.rows).toMatchObject([
          {
            instruction: priorInstruction,
            verification: priorVerification,
            completed_at: null,
          },
        ]);
      } finally {
        context.off("request", recordRequest);
      }
    } finally {
      await allowExerciseUpdate();
    }
  }
});
