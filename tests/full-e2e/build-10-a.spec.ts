import { createHash } from "node:crypto";
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
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

async function fitsNarrowViewport(page: Page, controls: Locator[]) {
  const documentWidth = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(documentWidth.content).toBeLessThanOrEqual(documentWidth.viewport + 1);
  for (const control of controls) {
    await expect(control).toBeVisible();
    const bounds = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        viewport: window.innerWidth,
      };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(-1);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
  }
}

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 80; step += 1) {
    await page.keyboard.press("Tab");
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      await expect(target).toBeFocused();
      const focus = await target.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          visible: element.matches(":focus-visible"),
          width: parseFloat(style.outlineWidth),
          style: style.outlineStyle,
        };
      });
      expect(focus).toEqual({ visible: true, width: 3, style: "solid" });
      return;
    }
  }
  throw new Error("Keyboard Tab could not reach the named control");
}

test("[F-BUILD-10-A] narrow layout and keyboard-only core learning journey", async ({
  page,
  context,
}) => {
  await requiredCheck(1, async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    const background = page.getByLabel("Your starting point");
    const goal = page.getByLabel("What would you like to do?");
    const synthetic = page.getByLabel(
      "I'll use invented or sample information",
    );
    const start = page.getByRole("button", { name: "Start my learning path" });
    await fitsNarrowViewport(page, [background, goal, synthetic, start]);
    await background.selectOption("explorer");
    await goal.selectOption("everyday");
    await synthetic.check();
    await start.click();
    await expect(page).toHaveURL(/\/learn$/);
    const open = page.getByRole("link", { name: "Open lesson" });
    await fitsNarrowViewport(page, [open]);
    await open.click();
    const instruction = page.getByLabel("Your instruction to AI");
    const verification = page.getByLabel("How will you check the result?");
    const checked = page.getByLabel("I checked the context");
    const complete = page.getByRole("button", { name: "Complete exercise" });
    await fitsNarrowViewport(page, [
      instruction,
      verification,
      checked,
      complete,
    ]);
    await instruction.fill(
      "Use invented event details to propose three practical steps and identify unknowns.",
    );
    await verification.fill(
      "Compare each step to the invented brief and correct any unsupported claim.",
    );
    await checked.check();
    await complete.click();
    await expect(
      page.getByText("Exercise completed", { exact: true }),
    ).toBeVisible();
    const progress = page.getByRole("link", { name: "See your progress" });
    await fitsNarrowViewport(page, [progress]);
    await progress.click();
    await expect(page.getByText("Completed · self-assessed")).toBeVisible();
    const activity = page.getByRole("link", {
      name: "View private learning activity",
    });
    await fitsNarrowViewport(page, [activity]);
    await activity.click();
    await fitsNarrowViewport(page, [
      page.getByRole("heading", { name: "Your private learning activity" }),
      page.getByText("starter exercise · version 1 · Self-reported complete"),
    ]);
    const owner = await memberId(context);
    const saved = await pool.query(
      "SELECT completed_at FROM exercises WHERE learner_id=$1",
      [owner],
    );
    expect(saved.rowCount).toBe(1);
    expect(saved.rows[0]!.completed_at).not.toBeNull();
  });

  await requiredCheck(2, async () => {
    await context.clearCookies();
    await page.goto("/");
    const background = page.getByLabel("Your starting point");
    await tabTo(page, background);
    await page.keyboard.press("e");
    await expect(background).toHaveValue("explorer");
    const goal = page.getByLabel("What would you like to do?");
    await tabTo(page, goal);
    await page.keyboard.press("u");
    await expect(goal).toHaveValue("everyday");
    const synthetic = page.getByLabel(
      "I'll use invented or sample information",
    );
    await tabTo(page, synthetic);
    await page.keyboard.press("Space");
    await expect(synthetic).toBeChecked();
    await tabTo(
      page,
      page.getByRole("button", { name: "Start my learning path" }),
    );
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/learn$/);
    await tabTo(page, page.getByRole("link", { name: "Open lesson" }));
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Plan a small community event" }),
    ).toBeVisible();
    await tabTo(page, page.getByLabel("Your instruction to AI"));
    await page.keyboard.type(
      "Use invented notes to draft an accessible three-step community event plan.",
    );
    await tabTo(page, page.getByLabel("How will you check the result?"));
    await page.keyboard.type(
      "Compare the plan to the invented notes and flag any unsupported detail.",
    );
    await tabTo(page, page.getByLabel("I checked the context"));
    await page.keyboard.press("Space");
    await tabTo(page, page.getByRole("button", { name: "Complete exercise" }));
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("Exercise completed", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No AI or qualified reviewer has assessed it."),
    ).toBeVisible();
    await tabTo(page, page.getByRole("link", { name: "See your progress" }));
    await page.keyboard.press("Enter");
    await expect(page.getByText("Completed · self-assessed")).toBeVisible();
    await tabTo(
      page,
      page.getByRole("link", { name: "View private learning activity" }),
    );
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Your private learning activity" }),
    ).toBeVisible();
    await expect(
      page.getByText("starter exercise · version 1 · Self-reported complete"),
    ).toBeVisible();
    const owner = await memberId(context);
    const saved = await pool.query(
      "SELECT completed_at FROM exercises WHERE learner_id=$1",
      [owner],
    );
    expect(saved.rowCount).toBe(1);
    expect(saved.rows[0]!.completed_at).not.toBeNull();
  });
});
