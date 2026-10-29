import { expect, type Page, type BrowserContext } from "@playwright/test";

export async function starterDraftConflicts(
  page: Page,
  context: BrowserContext,
) {
  await context.clearCookies();
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await page.goto("/lesson");
  const stale = await context.newPage();
  try {
    await stale.goto("/lesson");
    const first = "Use invented details to plan a small community event.";
    const second =
      "Use a different invented plan with <script>sample</script> details.";
    const check =
      "Compare each planned action with the original invented notes.";
    await page.getByLabel("Your instruction to AI").fill(first);
    await page.getByLabel("How will you check the result?").fill(check);
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Your draft is saved");
    await stale.getByLabel("Your instruction to AI").fill(second);
    await stale.getByLabel("How will you check the result?").fill(check);
    await stale
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(
      stale.getByRole("heading", { name: "Draft changed in another tab" }),
    ).toBeVisible();
    await expect(stale.getByLabel("Attempted instruction")).toHaveValue(second);
    await expect(
      stale.getByRole("button", { name: "Save draft", exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel("Your instruction to AI")).toHaveValue(first);
    const [current] = await Promise.all([
      context.waitForEvent("page"),
      stale
        .getByRole("link", {
          name: "Inspect saved lesson (opens in a new tab)",
        })
        .click(),
    ]);
    await expect(current.getByText(first, { exact: true })).toBeVisible();
    await current
      .getByRole("link", { name: "Open your current goal's lesson" })
      .click();
    await expect(current.getByLabel("Your instruction to AI")).toHaveValue(
      first,
    );
    await current.getByLabel("Your instruction to AI").fill(second);
    await current
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await page.reload();
    await expect(page.getByLabel("Your instruction to AI")).toHaveValue(second);
    await expect(stale.getByLabel("Attempted instruction")).toHaveValue(second);
    await current.close();
  } finally {
    await stale.close();
  }

  for (const intent of ["Save draft", "Complete exercise"]) {
    await context.clearCookies();
    await page.goto("/");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await page
      .getByLabel("What would you like to do?")
      .selectOption("everyday");
    await page.getByRole("button", { name: "Start my learning path" }).click();
    await page.goto("/lesson");
    const stale = await context.newPage();
    try {
      await stale.goto("/lesson");
      const first = "Use invented details to plan a small community event.";
      const attempted =
        "A different invented plan retained in the stale browser tab.";
      const check =
        "Compare the planned actions against the invented source notes.";
      await page.getByLabel("Your instruction to AI").fill(first);
      await page.getByLabel("How will you check the result?").fill(check);
      await page
        .getByLabel("I checked the context, task and verification plan")
        .check();
      await page
        .getByRole("button", { name: "Complete exercise", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText(
        "Exercise completed",
      );
      await stale.getByLabel("Your instruction to AI").fill(attempted);
      await stale.getByLabel("How will you check the result?").fill(check);
      await stale
        .getByLabel("I checked the context, task and verification plan")
        .check();
      await stale.getByRole("button", { name: intent, exact: true }).click();
      await expect(
        stale.getByRole("heading", { name: "Draft changed in another tab" }),
      ).toBeVisible();
      await expect(stale.getByLabel("Attempted instruction")).toHaveValue(
        attempted,
      );
      await page.reload();
      await expect(page.getByText(first, { exact: true })).toBeVisible();
      await expect(page.getByText(attempted, { exact: true })).toHaveCount(0);
    } finally {
      await stale.close();
    }
  }
}
