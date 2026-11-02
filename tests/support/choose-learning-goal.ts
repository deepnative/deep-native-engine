import type { Page } from "@playwright/test";

export async function chooseLearningGoal(page: Page, goal: string) {
  if (await page.locator(".path-choices").count()) {
    await page
      .locator(`input[type="radio"][name="goal"][value="${goal}"]`)
      .check();
  } else {
    await page.getByLabel("What would you like to do?").selectOption(goal);
  }
}
