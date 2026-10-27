import { test, expect, type Page } from "@playwright/test";
import {
  reviewedAssignments,
  reviewedAssignmentImportStore,
} from "../../src/reviewed-assignments.ts";
import { reviewedContentFixture as fixture } from "../support/reviewed-content-browser.ts";

// Staff credentials are invented, private setup and are excluded from traces.
test.use({ trace: "off" });

async function importAssignments(page: Page, origin: string) {
  await page.goto(origin + "/editor/library");
  await page
    .getByLabel("Import the two reviewed assignments as drafts.")
    .check();
  await page
    .getByRole("button", { name: "Import two reviewed assignment drafts" })
    .click();
}
async function publishFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const actors = await f.publishFixture();
  expect(
    await reviewedAssignmentImportStore(f.pool).import(actors.editor.token),
  ).toBe("imported");
  for (const item of await reviewedAssignments()) {
    expect(await actors.catalog.submit(actors.editor.token, item.id, 2)).toBe(
      true,
    );
    expect(
      await actors.catalog.approve(actors.reviewer.token, item.id, 2, true),
    ).toBe(true);
    expect(await actors.catalog.publish(actors.editor.token, item.id, 2)).toBe(
      true,
    );
  }
  return actors;
}
async function prepare(member: Page, origin: string, assignment: string) {
  await member.goto(origin + "/learn");
  await member
    .getByRole("link", { name: `Prepare ${assignment}`, exact: true })
    .click();
  const checklist = member.url();
  await expect(member.getByRole("status")).toContainText("not yet available");
  for (const id of ["FND-002", "FND-003"]) {
    await member.locator(`a[href="/library/${id}?version=2"]`).click();
    await expect(member.getByRole("status")).toContainText(
      "Opened in reader · version 2",
    );
    await member.goto(checklist);
    await expect(member.getByRole("status")).toContainText("not yet available");
    await member.locator(`a[href="/library/${id}?version=2"]`).click();
    await member.getByRole("button", { name: "Start this lesson" }).click();
    await member
      .getByLabel("I have finished reading this lesson; this is my own report.")
      .check();
    await member
      .getByRole("button", { name: "Mark self-assessed complete" })
      .click();
    await member.goto(checklist);
  }
  await expect(member.getByRole("status")).toContainText("available to choose");
  await member
    .getByRole("button", { name: "Choose this sample assignment" })
    .click();
}
async function save(member: Page, text: string) {
  await member
    .getByRole("button", { name: "Start or return to this private attempt" })
    .click();
  const url = member.url();
  await member.getByLabel("Private sample response").fill(text);
  await member.getByLabel("I used only invented or sample information").check();
  await member.getByRole("button", { name: "Save private draft" }).click();
  await expect(
    member.getByText("private draft saved", { exact: false }),
  ).toBeVisible();
  await member.reload();
  await expect(member.getByLabel("Private sample response")).toHaveValue(text);
  return url;
}

test("[L233] ASN103-01 editors import two ordinary assignment drafts and distinct source-rights review precedes publication", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info);
  try {
    const { editor, reviewer } = await f.publishFixture();
    const originals = (
      await f.pool.query(
        "SELECT * FROM content_versions WHERE version=1 ORDER BY id",
      )
    ).rows;
    await importAssignments(reviewer.page, f.origin);
    await expect(
      reviewer.page.getByRole("heading", {
        name: "Assignment import unconfirmed",
      }),
    ).toBeVisible();
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM content_versions WHERE kind='assignment' AND version=2",
        )
      ).rowCount,
    ).toBe(0);
    await importAssignments(editor.page, f.origin);
    await importAssignments(editor.page, f.origin);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM content_versions WHERE kind='assignment' AND version=2 AND state='draft' AND NOT requires_qualified_signoff",
        )
      ).rowCount,
    ).toBe(2);
    const member = await f.member();
    await expect(
      member.getByRole("region", { name: "Choose a practice assignment" }),
    ).toContainText("No published assignment");
    for (const item of await reviewedAssignments()) {
      const url = `${f.origin}/editor/library/${item.id}/2`;
      await editor.page.goto(url);
      await editor.page
        .getByRole("button", { name: "Publish reviewed assignment" })
        .click();
      await expect(
        editor.page.getByRole("heading", { name: "Content state unchanged" }),
      ).toBeVisible();
      await editor.page.goto(url);
      await editor.page
        .getByRole("button", { name: "Submit for review" })
        .click();
      await reviewer.page.goto(url);
      const csrf = await reviewer.page
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      expect(
        (
          await reviewer.page.request.post(url + "/approve", {
            headers: { origin: f.origin },
            form: { csrf },
          })
        ).status(),
      ).toBe(409);
      await reviewer.page.reload();
      await reviewer.page
        .getByLabel(
          "I checked the sources and rights for this ordinary educational assignment.",
        )
        .check();
      await reviewer.page
        .getByRole("button", { name: "Approve editorial review" })
        .click();
      await expect(
        reviewer.page.getByText("APPROVED · VERSION 2"),
      ).toBeVisible();
      await editor.page.goto(url);
      await editor.page
        .getByRole("button", { name: "Publish reviewed assignment" })
        .click();
      await expect(
        editor.page.getByText("PUBLISHED · VERSION 2"),
      ).toBeVisible();
    }
    expect(
      (
        await f.pool.query(
          "SELECT * FROM content_versions WHERE version=1 ORDER BY id",
        )
      ).rows,
    ).toEqual(originals);
    await member.goto(f.origin + "/library/ASN-002");
    await expect(
      member.getByText("REVIEWED ASSIGNMENT · PUBLISHED · VERSION 2"),
    ).toBeVisible();
    await expect(
      member.getByText("Ordinary reviewed assignment with an invented brief", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      member.getByRole("button", { name: "Start this lesson" }),
    ).toHaveCount(0);
    const layout = await member.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(layout.scroll).toBeLessThanOrEqual(layout.width);
    await member.screenshot({
      path: info.outputPath("reviewed-assignment-reader.png"),
      fullPage: true,
    });
  } finally {
    await f.close();
  }
});

test("[L234] ASN103-02 all backgrounds follow exact preparation then save and submit a private noncoding assignment", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info);
  try {
    await publishFixture(f);
    const assignment = (await reviewedAssignments())[1]!;
    for (const [background, goal] of [
      ["explorer", "everyday"],
      ["professional", "work"],
      ["technical", "build"],
    ]) {
      const member = await f.member(background, goal);
      await expect(
        member.getByRole("button", { name: `Choose ${assignment.title}` }),
      ).toHaveCount(0);
      await prepare(member, f.origin, assignment.title);
      const text = `Invented ${background} meeting: Nia checks the draft by Thursday. Verify the owner and date against the supplied brief; keep unsupported details unknown.`;
      const url = await save(member, text);
      await member.getByLabel("Submit this saved version locally").check();
      await member
        .getByRole("button", { name: "Submit saved version locally" })
        .click();
      await expect(
        member.getByText(/Assignment version 2 .* submitted locally/),
      ).toBeVisible();
      await member.reload();
      await expect(member.locator("main")).toContainText(text);
      await member.screenshot({
        path: info.outputPath(`assignment-${background}-saved.png`),
        fullPage: true,
      });
      const other = await f.member(background, goal);
      await other.goto(url);
      await expect(
        other.getByRole("heading", { name: "Attempt unavailable" }),
      ).toBeVisible();
      await expect(other.locator("main")).not.toContainText(text);
    }
  } finally {
    await f.close();
  }
});

test("[L235] ASN103-03 changed goals and retired preparation preserve exact prior work and offer a useful next action", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info);
  try {
    const { editor } = await publishFixture(f);
    const assignments = await reviewedAssignments();
    const member = await f.member("explorer", "build");
    await prepare(member, f.origin, assignments[0]!.title);
    const text =
      "Invented signup checks: verify one missing-field case and one valid-email case against the brief, without writing code.";
    const url = await save(member, text);
    await member.goto(f.origin + "/learn");
    await member
      .getByLabel("What would you like to do?")
      .selectOption("everyday");
    await member.getByRole("button", { name: "Save my direction" }).click();
    await expect(
      member.getByRole("button", { name: `Choose ${assignments[0]!.title}` }),
    ).toHaveCount(0);
    await expect(
      member.getByRole("button", { name: `Choose ${assignments[1]!.title}` }),
    ).toBeVisible();
    await member.goto(url);
    await expect(
      member.getByText("cannot be edited", { exact: false }),
    ).toBeVisible();
    await expect(member.locator("main")).toContainText(text);
    await editor.page.goto(f.origin + "/editor/library/FND-003/2");
    await editor.page
      .getByRole("button", { name: "Retire published versions" })
      .click();
    await member.goto(f.origin + "/learn");
    await expect(
      member.getByRole("button", { name: `Choose ${assignments[1]!.title}` }),
    ).toHaveCount(0);
    await member
      .getByRole("link", {
        name: `Prepare ${assignments[1]!.title}`,
        exact: true,
      })
      .click();
    await expect(member.getByRole("status")).toContainText("not yet available");
    await expect(member.locator("main")).toContainText("Unavailable");
    await expect(
      member.getByRole("link", { name: "Return to your learning path" }),
    ).toBeVisible();
    await member.goto(url);
    await expect(member.locator("main")).toContainText(text);
    await expect(
      member.getByText("Assignment version 2", { exact: false }),
    ).toBeVisible();
    await member.screenshot({
      path: info.outputPath("retained-assignment-after-direction-change.png"),
      fullPage: true,
    });
  } finally {
    await f.close();
  }
});
