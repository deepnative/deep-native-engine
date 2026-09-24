import { expect, test, type Locator, type Page } from "@playwright/test";

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

test("[L53] three learner paths retain visible keyboard focus, actionable errors and circle state", async ({
  page,
  context,
}) => {
  for (const [background, goal, circle, backgroundKeys, goalKey] of [
    ["explorer", "everyday", "Everyday AI practice", ["e"], "u"],
    ["professional", "work", "Clearer professional work", ["w"], "m"],
    ["technical", "build", "Technical AI practice", ["w", "w"], "i"],
  ] as const) {
    await context.clearCookies();
    await page.goto("/");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await tabTo(page, skip);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);

    const startingPoint = page.getByLabel("Your starting point");
    await tabTo(page, startingPoint);
    for (const key of backgroundKeys) await page.keyboard.press(key);
    await expect(startingPoint).toHaveValue(background);
    const direction = page.getByLabel("What would you like to do?");
    await tabTo(page, direction);
    await page.keyboard.press(goalKey);
    await expect(direction).toHaveValue(goal);
    const sample = page.getByLabel("I'll use invented or sample information");
    await tabTo(page, sample);
    await page.keyboard.press("Space");
    await expect(sample).toBeChecked();
    const start = page.getByRole("button", { name: "Start my learning path" });
    await tabTo(page, start);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/learn$/);

    const lesson = page.getByRole("link", { name: "Open lesson" });
    await tabTo(page, lesson);
    await page.keyboard.press("Enter");
    const instruction = page.getByLabel("Your instruction to AI");
    const verification = page.getByLabel("How will you check the result?");
    await tabTo(page, instruction);
    await page.keyboard.type(
      "Use only invented notes to make a short plan with actions and unknowns.",
    );
    await tabTo(page, verification);
    await page.keyboard.type("Check notes");
    const checked = page.getByLabel("I checked the context");
    await tabTo(page, checked);
    await page.keyboard.press("Space");
    const complete = page.getByRole("button", { name: "Complete exercise" });
    await tabTo(page, complete);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toContainText(
      "How will you check the result?",
    );
    await expect(verification).toHaveAttribute("aria-invalid", "true");
    await expect(verification).toHaveValue("Check notes");
    const errorLink = page.getByRole("link", {
      name: /How will you check the result\?/,
    });
    await tabTo(page, errorLink);
    await page.keyboard.press("Enter");
    await expect(verification).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(
      "Compare each action to the invented notes and correct unsupported claims.",
    );
    await tabTo(page, checked);
    await page.keyboard.press("Space");
    await tabTo(page, complete);
    await page.keyboard.press("Enter");
    await expect(page.getByText("Exercise completed")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Exercise completed")).toBeVisible();

    const circles = page.getByRole("link", { name: "Local circles" });
    await tabTo(page, circles);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Explore learning circles" }),
    ).toBeVisible();
    const join = page.getByRole("button", { name: `Join ${circle}` });
    await tabTo(page, join);
    await page.keyboard.press("Enter");
    await expect(page.getByText("You joined this local circle")).toBeVisible();
    await page.reload();
    await expect(page.getByText("You joined this local circle")).toBeVisible();
    const leave = page.getByRole("button", { name: `Leave ${circle}` });
    await tabTo(page, leave);
    await page.keyboard.press("Enter");
    await expect(join).toBeVisible();
  }
});
