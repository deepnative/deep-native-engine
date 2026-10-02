import { test, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4317";

async function begin(page: Page, background: string, goal: string) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await page.getByRole("link", { name: "Open lesson" }).click();
}

test("[L86] three learner backgrounds withdraw completed starter text privately", async ({
  page,
  browser,
}) => {
  for (const [background, goal] of [
    ["explorer", "everyday"],
    ["professional", "work"],
    ["technical", "build"],
  ]) {
    await page.context().clearCookies();
    await begin(page, background!, goal!);
    const instruction = `Invented ${background} private instruction for a sample task`;
    const verification = `Check the invented ${background} result against the sample source`;
    await page.getByLabel("Your instruction to AI").fill(instruction);
    await page.getByLabel("How will you check the result?").fill(verification);
    await page.getByLabel("I checked the context").check();
    await page.getByRole("button", { name: "Complete exercise" }).click();
    await expect(page.getByText(instruction)).toBeVisible();
    const csrf = await page
      .locator(
        'form[action="/exercise/clear-instructions/1/withdraw"] input[name="csrf"]',
      )
      .inputValue();
    const before = await page.request.get("/api/member/export");
    expect(before.status()).toBe(200);
    expect(JSON.stringify(await before.json())).toContain(instruction);
    const otherContext = await browser.newContext({ baseURL: origin });
    const other = await otherContext.newPage();
    await begin(other, "explorer", "everyday");
    await expect(other.locator("main")).not.toContainText(instruction);
    const otherCsrf = await other
      .locator('form[action="/exercise"] input[name="csrf"]')
      .inputValue();
    const foreignWithdrawal = await other.request.post(
      "/exercise/clear-instructions/1/withdraw",
      {
        headers: { Origin: origin },
        form: { csrf: otherCsrf, confirm: "yes" },
      },
    );
    expect(foreignWithdrawal.status()).toBe(404);
    const otherInstruction = `Different member invented exercise for ${background}`;
    await other.getByLabel("Your instruction to AI").fill(otherInstruction);
    await other
      .getByLabel("How will you check the result?")
      .fill("Compare the different member sample with invented notes");
    await other.getByLabel("I checked the context").check();
    await other.getByRole("button", { name: "Complete exercise" }).click();
    const checkbox = page.getByLabel(
      "Withdraw both saved text fields for version 1",
    );
    await checkbox.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("Tab");
    const button = page.getByRole("button", {
      name: "Withdraw completed exercise text",
    });
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/lesson$/);
    await expect(
      page.getByText("Saved exercise text withdrawn", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText(instruction)).toHaveCount(0);
    await expect(page.getByText(verification)).toHaveCount(0);
    await expect(button).toHaveCount(0);
    const after = await page.request.get("/api/member/export");
    expect(after.status()).toBe(200);
    const exported = await after.json();
    expect(exported.version).toBe("local-member-records-v13");
    expect(exported.records.exercises).toMatchObject([
      { instruction: null, verification: null, state: "withdrawn" },
    ]);
    expect(JSON.stringify(exported)).not.toContain(instruction);
    expect(JSON.stringify(exported)).not.toContain(verification);
    await other.reload();
    await expect(other.getByText(otherInstruction)).toBeVisible();
    const otherExport = await other.request.get("/api/member/export");
    expect(otherExport.status()).toBe(200);
    expect(JSON.stringify(await otherExport.json())).toContain(
      otherInstruction,
    );
    await otherContext.close();
    const stale = await page.request.post("/exercise", {
      headers: { Origin: origin },
      form: {
        csrf,
        lesson_id: "clear-instructions",
        lesson_version: "1",
        goal: goal!,
        intent: "complete",
        instruction,
        verification,
        checked: "yes",
      },
    });
    expect(stale.status()).toBe(409);
    expect(await stale.text()).not.toContain(instruction);
    await page.reload();
    await expect(
      page.getByText("Saved exercise text withdrawn", { exact: false }),
    ).toBeVisible();
    expect(
      await page
        .locator("body")
        .evaluate((element) => element.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
});
