import { test, expect } from "@playwright/test";

test("[L102] three audiences keep exact private starter practice when changing goals", async ({
  page,
}) => {
  for (const [background, a, b] of [
    ["explorer", "everyday", "work"],
    ["professional", "work", "build"],
    ["technical", "build", "everyday"],
  ] as const) {
    await page.context().clearCookies();
    await page.goto("/");
    await page.getByLabel("Your starting point").selectOption(background);
    await page.getByLabel("What would you like to do?").selectOption(a);
    await page.getByLabel("I'll use invented or sample information").check();
    await page.getByRole("button", { name: "Start my learning path" }).click();
    await page.goto("/lesson");
    const first = `Invented ${background} first goal plan with source checks.`;
    await page.getByLabel("Your instruction to AI").fill(first);
    await page
      .getByLabel("How will you check the result?")
      .fill("Compare every step against the original invented notes.");
    await page.getByLabel("I checked the context").check();
    await page.getByRole("button", { name: "Complete exercise" }).click();
    await page.goto("/learn");
    await page.getByLabel("What would you like to do?").selectOption(b);
    await page.getByRole("button", { name: "Save my direction" }).click();
    await expect(
      page.getByRole("progressbar", { name: "Exercises completed" }),
    ).toHaveAttribute("value", "0");
    await page.getByRole("link", { name: "Open lesson" }).click();
    await expect(page.getByLabel("Your instruction to AI")).toHaveValue("");
    const second = `Invented ${background} second goal plan with a different outcome.`;
    await page.getByLabel("Your instruction to AI").fill(second);
    await page
      .getByLabel("How will you check the result?")
      .fill("Verify the second sample against the supplied invented context.");
    await page.getByLabel("I checked the context").check();
    await page.getByRole("button", { name: "Complete exercise" }).click();
    await page.goto("/progress");
    const firstLink = page.locator(
      `a[href="/lesson?version=1&goal=${a}#starter-version-1-${a}"]`,
    );
    await expect(firstLink).toHaveCount(1);
    await expect(
      page.locator(
        `a[href="/lesson?version=1&goal=${b}#starter-version-1-${b}"]`,
      ),
    ).toHaveCount(1);
    await firstLink.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(
      `**/lesson?version=1&goal=${a}#starter-version-1-${a}`,
      { waitUntil: "load" },
    );
    await expect(page.getByText(first, { exact: true })).toBeVisible();
    await expect(page.locator('form[action="/exercise"]')).toHaveCount(0);
    const withdraw = page.getByLabel(
      "Withdraw both saved text fields for version 1",
    );
    await withdraw.focus();
    await page.keyboard.press("Space");
    await expect(withdraw).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Withdraw completed exercise text" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/lesson$/);
    await page.goto(`/lesson?version=1&goal=${a}`);
    await expect(
      page.getByText("Saved exercise text withdrawn", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText(first, { exact: true })).toHaveCount(0);
    await page.goto(`/lesson?version=1&goal=${b}`);
    await expect(page.getByText(second, { exact: true })).toBeVisible();
    const response = await page.request.get("/api/member/export");
    expect(response.status()).toBe(200);
    const payload = await response.json();
    expect(payload.records.exercises).toHaveLength(2);
    expect(JSON.stringify(payload)).not.toContain(first);
    expect(JSON.stringify(payload)).toContain(second);
    await page.goto("/learn");
    await page.getByLabel("What would you like to do?").selectOption(a);
    await page.getByRole("button", { name: "Save my direction" }).click();
    await expect(
      page.getByRole("progressbar", { name: "Exercises completed" }),
    ).toHaveAttribute("value", "1");
    await page.goto("/lesson");
    await expect(page.locator('form[action="/exercise"]')).toHaveCount(0);
    await expect(page.getByText(first, { exact: true })).toHaveCount(0);
    expect(
      await page
        .locator("body")
        .evaluate((el) => el.scrollWidth <= innerWidth + 1),
    ).toBe(true);
  }
});
