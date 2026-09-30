import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

async function tabTo(page: Page, target: ReturnType<Page["getByRole"]>) {
  for (let step = 0; step < 80; step += 1) {
    await page.keyboard.press("Tab");
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      await expect(target).toBeFocused();
      return;
    }
  }
  throw new Error(
    "Exact-version private activity link was not keyboard reachable",
  );
}

test("[L89] retained starter versions remain private, exact and text-free after withdrawal", async ({
  page,
  context,
  browser,
}) => {
  for (const [background, goal] of [
    ["explorer", "everyday"],
    ["professional", "work"],
    ["technical", "build"],
  ] as const) {
    await page.goto("/");
    await page.getByLabel("Your starting point").selectOption(background);
    await page.getByLabel("What would you like to do?").selectOption(goal);
    await page.getByLabel("I'll use invented or sample information").check();
    await page.getByRole("button", { name: "Start my learning path" }).click();
    await page.goto("/lesson");
    await page
      .getByLabel("Your instruction to AI")
      .fill(
        "Use invented details to propose a clear plan and identify what remains unknown.",
      );
    await page
      .getByLabel("How will you check the result?")
      .fill(
        "Compare the invented details with every proposed step before using the plan.",
      );
    await page.getByLabel("I checked the context").check();
    await page.getByRole("button", { name: "Complete exercise" }).click();
    const cookie = (await context.cookies()).find(
      (item) => item.name === "dne_preview",
    )!;
    const hash = createHash("sha256").update(cookie.value).digest("hex");
    const member = await pool.query<{ id: string }>(
      "SELECT id FROM learners WHERE token_hash=$1",
      [hash],
    );
    const ownerId = member.rows[0]!.id;
    await pool.query(
      `INSERT INTO exercises(learner_id,workspace_id,lesson_id,lesson_version,instruction,verification,completed_at,goal_at_start)
       VALUES($1,$1,'clear-instructions',2,'Version two invented private words','Version two invented check',clock_timestamp(),$2),
             ($1,$1,'clear-instructions',3,'Version three invented private words','Version three invented check',clock_timestamp(),$2)`,
      [ownerId, goal],
    );
    await page.goto("/lesson");
    const second = page
      .getByRole("listitem")
      .filter({ hasText: "Earlier starter exercise · version 2" });
    await second
      .getByLabel("Withdraw both saved text fields for version 2")
      .check();
    await second
      .getByRole("button", { name: "Withdraw completed exercise text" })
      .click();
    await page.goto("/progress");
    await page.reload();
    const rows = page.locator("main ol > li");
    await expect(rows).toHaveCount(3);
    for (const version of [1, 2, 3]) {
      await expect(
        rows.filter({ hasText: `starter exercise · version ${version}` }),
      ).toHaveCount(1);
    }
    const withdrawn = rows.filter({ hasText: "starter exercise · version 2" });
    await expect(withdrawn).toContainText(
      "Self-reported complete; text withdrawn",
    );
    await expect(page.locator("main")).not.toContainText(
      "Version two invented private words",
    );
    const exactLink = withdrawn.getByRole("link", {
      name: "Open this private activity",
    });
    await expect(exactLink).toHaveAttribute(
      "href",
      `/lesson?version=2&goal=${goal}#starter-version-2-${goal}`,
    );
    await tabTo(page, exactLink);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(
      new RegExp(`/lesson\\?version=2&goal=${goal}#starter-version-2-${goal}$`),
    );
    await expect(page.locator(`#starter-version-2-${goal}`)).toContainText(
      "Saved exercise text withdrawn",
    );
    await expect(page.locator(`#starter-version-2-${goal}`)).not.toContainText(
      "Version two invented private words",
    );
    await page.goto("/progress");
    const third = rows.filter({ hasText: "starter exercise · version 3" });
    await third
      .getByRole("link", { name: "Open this private activity" })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/lesson\\?version=3&goal=${goal}#starter-version-3-${goal}$`),
    );
    await expect(page.locator(`#starter-version-3-${goal}`)).toContainText(
      "Version three invented private words",
    );
    await page.goto("/learn");
    await page
      .getByLabel("What would you like to do?")
      .selectOption(goal === "work" ? "build" : "work");
    await page.getByRole("button", { name: "Save my direction" }).click();
    await page.goto("/progress");
    await expect(rows).toHaveCount(3);
    await expect(
      rows.filter({ hasText: "starter exercise · version 2" }),
    ).toContainText("text withdrawn");

    const outsider = await browser.newContext({ baseURL: origin });
    try {
      const otherPage = await outsider.newPage();
      await otherPage.goto("/");
      await otherPage
        .getByLabel("Your starting point")
        .selectOption("explorer");
      await otherPage
        .getByLabel("What would you like to do?")
        .selectOption("everyday");
      await otherPage
        .getByLabel("I'll use invented or sample information")
        .check();
      await otherPage
        .getByRole("button", { name: "Start my learning path" })
        .click();
      await otherPage.goto(`/progress?member_id=${ownerId}`);
      await expect(otherPage.locator("main ol > li")).toHaveCount(0);
      const missing = await otherPage.request.get("/lesson?version=2");
      expect(missing.status()).toBe(404);
      expect(await missing.text()).not.toContain(
        "Version three invented private words",
      );
    } finally {
      await outsider.close();
    }
    await page.goto("/learn");
    await page.getByLabel("Delete my local preview").check();
    await page.getByRole("button", { name: "Delete this preview" }).click();
    expect(
      (
        await pool.query("SELECT count(*) FROM exercises WHERE learner_id=$1", [
          ownerId,
        ])
      ).rows[0]!.count,
    ).toBe("0");
    await context.addCookies([cookie]);
    await page.goto("/progress");
    await expect(
      page.getByRole("heading", { name: "Your private learning activity" }),
    ).toHaveCount(0);
    await context.clearCookies();
  }
});
