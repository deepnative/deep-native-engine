import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import {
  test,
  expect,
  devices,
  type Page,
  type BrowserContext,
} from "@playwright/test";
import { programEnrollmentFixture } from "../support/program-enrollment-recovery-server.ts";
import { PROGRAM_PATH } from "../../src/program-values.ts";

// Finite staff entry and one-use email capabilities never enter saved traces.
test.use({ trace: "off" });
async function account(page: Page, background: string, goal: string) {
  await page.getByLabel("Display name").fill("Sample learner");
  await page.getByLabel("Your starting point").selectOption(background);
  await chooseLearningGoal(page, goal);
  await page.getByRole("button", { name: "Start my learning path" }).click();
}
async function choose(page: Page, origin: string) {
  await page.goto(origin + PROGRAM_PATH);
  await page.getByLabel(/Choose this exact local program and term/).check();
  await page
    .getByRole("button", { name: "Choose local program", exact: true })
    .click();
}
async function confirm(page: Page) {
  await page
    .getByLabel(/Enroll this current account in the local simulation/)
    .check();
  await page
    .getByRole("button", { name: "Confirm local enrollment", exact: true })
    .click();
}
// #121 PROGWD-01..03: a member withdraws from their program term on My
// courses. It's dated and separate from deleting the account.
test("[L336] PROGWD-01..03 a member withdraws from the program term and keeps the receipt", async ({
  page,
  browser,
}, info) => {
  const f = await programEnrollmentFixture();
  const contexts: BrowserContext[] = [];
  try {
    await f.publish();
    const admin = await f.staff("platform_admin");
    const operatorContext = await browser.newContext(
      info.project.name === "mobile-chromium"
        ? devices["Pixel 7"]!
        : devices["Desktop Chrome"]!,
    );
    contexts.push(operatorContext);
    const operator = await operatorContext.newPage();
    await operator.goto(f.origin + "/staff/sign-in");
    await operator
      .getByLabel("Trusted local staff credential")
      .fill(admin.token);
    await operator
      .getByRole("button", { name: "Sign in to staff tools", exact: true })
      .click();
    await operator.goto(f.origin + "/operator/programs");
    await operator.getByLabel("Open this exact local inventory only.").check();
    await operator
      .getByRole("button", { name: "Open local term", exact: true })
      .click();
    await choose(page, f.origin);
    await page
      .getByRole("link", { name: "create a new learning account deliberately" })
      .click();
    await account(page, "professional", "work");
    await confirm(page);
    await expect(
      page.getByRole("heading", { name: "My courses", exact: true }),
    ).toBeVisible();
    await page
      .getByLabel(
        /Withdraw from this term\. My receipt and earlier activity stay/,
      )
      .check();
    await page
      .getByRole("button", { name: "Withdraw from this term", exact: true })
      .click();
    await expect(page).toHaveURL(f.origin + "/my-courses");
    await expect(page.getByRole("status")).toContainText(
      "You withdrew from this term on",
    );
    await expect(
      page.getByRole("button", { name: "Withdraw from this term" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Inspect your receipt" }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("member-withdrew-from-term.png"),
      fullPage: true,
    });
    const download = await page.request.get(
      f.origin +
        (await page
          .getByRole("link", { name: "Download private enrollment JSON" })
          .getAttribute("href"))!,
    );
    expect((await download.json()).enrollment.withdrawnAt).toEqual(
      expect.any(String),
    );
    await page.reload();
    await expect(page.getByRole("status")).toContainText(
      "You withdrew from this term on",
    );
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
    await f.close();
  }
});
