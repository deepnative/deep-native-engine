import { test, expect } from "@playwright/test";
import { store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
test.afterAll(() => pool.end());
for (const [index, [background, goal, workflow]] of [
  ["technical", "build", "WF-001"],
  ["professional", "work", "WF-002"],
  ["explorer", "everyday", "WF-003"],
].entries()) {
  test(`[L${236 + index}] WFR114-01/02/03 ${background} reads reviewed workflow metadata and keeps old private feedback separate`, async ({
    page,
    context,
    browser,
  }, info) => {
    await page.goto("/");
    await page.getByLabel("Your starting point").selectOption(background!);
    await page.getByLabel("What would you like to do?").selectOption(goal!);
    await page.getByRole("button", { name: "Start my learning path" }).click();
    await expect(page).toHaveURL(/\/learn$/);
    await page.goto(`/workflows/${workflow}?version=2`);
    await expect(
      page.getByText("ORDINARY REVIEWED WORKFLOW · VERSION 2"),
    ).toBeVisible();
    await expect(
      page.getByText(
        "No new license granted; repository-authored educational examples, with third-party and member rights separate",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "2026-10-27 manual input/output comparison; no AI call or software test execution",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "2026-11-27 or earlier when source requirements or supported environment change",
      ),
    ).toBeVisible();
    await expect(
      page.getByLabel("Select and copy the synthetic workflow text"),
    ).toHaveAttribute("readonly", "");
    await expect(
      page.getByRole("link", { name: "Download Markdown text" }),
    ).toHaveAttribute("href", `/workflows/${workflow}/download?version=2`);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("reviewed-workflow.png"),
      fullPage: true,
    });
    const memberCookie = (await context.cookies()).find(
      (c) => c.name === "dne_preview",
    );
    if (!memberCookie) throw Error("Invented member session required");
    const session = await store(pool).session(memberCookie.value);
    if (session.kind !== "active") throw Error("Active member required");
    const previous = `Invented ${background} note retained from version one`;
    const current = `Invented ${background} note for reviewed version two`;
    // Model an existing note from before this source release; ordinary UI creates the new note.
    await pool.query(
      "INSERT INTO workflow_feedback(member_id,workflow_id,workflow_version,note,revision) VALUES($1,$2,1,$3,3)",
      [session.learner.id, workflow, previous],
    );
    await page
      .getByRole("link", { name: "Save private feedback about this version" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Historical version notes" }),
    ).toBeVisible();
    await expect(page.getByText(previous, { exact: true })).toBeVisible();
    await expect(
      page.getByLabel("Your private feedback on version 2"),
    ).toHaveValue("");
    await page.getByLabel("Your private feedback on version 2").fill(current);
    await page
      .getByLabel("I am saving private feedback using only invented text")
      .check();
    await page.getByRole("button", { name: "Save private feedback" }).click();
    await expect(page.getByRole("status")).toContainText("saved privately");
    await page.reload();
    await expect(
      page.getByLabel("Your private feedback on version 2"),
    ).toHaveValue(current);
    await expect(page.getByText(previous, { exact: true })).toBeVisible();
    const exported = await context.request.get("/api/member/export");
    expect(exported.status()).toBe(200);
    expect((await exported.json()).records.workflowFeedback).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflowId: workflow,
          workflowVersion: 1,
          revision: 3,
          note: previous,
        }),
        expect.objectContaining({
          workflowId: workflow,
          workflowVersion: 2,
          revision: 1,
          note: current,
        }),
      ]),
    );
    const device = info.project.use;
    const outsider = await browser.newContext({
      viewport: device.viewport,
      userAgent: device.userAgent,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
    });
    try {
      const other = await outsider.newPage();
      await other.goto(new URL("/", page.url()).href);
      await other.getByLabel("Your starting point").selectOption("explorer");
      await other
        .getByLabel("What would you like to do?")
        .selectOption("everyday");
      await other
        .getByRole("button", { name: "Start my learning path" })
        .click();
      await other.goto(
        new URL(
          `/workflow-feedback/${workflow}?member_id=${session.learner.id}`,
          page.url(),
        ).href,
      );
      await expect(
        other.getByLabel("Your private feedback on version 2"),
      ).toHaveValue("");
      await expect(other.locator("body")).not.toContainText(previous);
      await expect(other.locator("body")).not.toContainText(current);
    } finally {
      await outsider.close();
    }
    await page.getByLabel("Remove my private note for version 1").check();
    await page
      .getByRole("button", { name: "Withdraw version 1 feedback" })
      .click();
    await expect(page.getByText(previous, { exact: true })).toHaveCount(0);
    await expect(
      page.getByLabel("Your private feedback on version 2"),
    ).toHaveValue(current);
    await page.screenshot({
      path: info.outputPath("separate-private-history.png"),
      fullPage: true,
    });
  });
}
