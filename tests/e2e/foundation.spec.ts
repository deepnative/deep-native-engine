import { test, expect, type Page } from "@playwright/test";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
import { store } from "../../src/store.ts";
import { reviewedContentFixture as fixture } from "../support/reviewed-content-browser.ts";

// Invented staff sign-in credentials must not be retained in network traces.
test.use({ trace: "off" });
async function importFromLibrary(page: Page, origin: string) {
  await page.goto(origin + "/editor/library");
  await page.getByLabel("Import the six reviewed lessons as drafts.").check();
  await page
    .getByRole("button", { name: "Import six reviewed foundation drafts" })
    .click();
}

test("[L230] FOUND-01/02 editor imports six drafts and a distinct reviewer checks rights before ordinary publication", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info);
  try {
    const editor = await f.staff("editor"),
      reviewer = await f.staff("reviewer");
    const originals = (
      await f.pool.query("SELECT * FROM content_versions ORDER BY id,version")
    ).rows;
    await importFromLibrary(reviewer.page, f.origin);
    await expect(
      reviewer.page.getByRole("heading", {
        name: "Foundation import unconfirmed",
      }),
    ).toBeVisible();
    expect(
      (await f.pool.query("SELECT 1 FROM content_versions WHERE version=2"))
        .rowCount,
    ).toBe(0);
    await importFromLibrary(editor.page, f.origin);
    await expect(editor.page).toHaveURL(f.origin + "/editor/library");
    await importFromLibrary(editor.page, f.origin);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM content_versions WHERE version=2 AND state='draft' AND NOT requires_qualified_signoff",
        )
      ).rowCount,
    ).toBe(6);
    const member = await f.member();
    await member.goto(f.origin + "/library");
    await expect(
      member.getByText("No published content matches"),
    ).toBeVisible();
    await editor.page.goto(f.origin + "/editor/library/FND-001/2");
    await editor.page
      .getByRole("button", { name: "Publish reviewed lesson" })
      .click();
    await expect(
      editor.page.getByRole("heading", { name: "Content state unchanged" }),
    ).toBeVisible();
    for (const item of await reviewedFoundation()) {
      const url = `${f.origin}/editor/library/${item.id}/2`;
      await editor.page.goto(url);
      await editor.page
        .getByRole("button", { name: "Submit for review" })
        .click();
      await reviewer.page.goto(url);
      if (item.id === "FND-001") {
        const csrf = await reviewer.page
          .locator('input[name="csrf"]')
          .first()
          .inputValue();
        const denied = await reviewer.page.request.post(url + "/approve", {
          headers: { origin: f.origin },
          form: { csrf },
        });
        expect(denied.status()).toBe(409);
      }
      await reviewer.page
        .getByLabel(
          "I checked the sources and rights for this ordinary educational lesson.",
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
        .getByRole("button", { name: "Publish reviewed lesson" })
        .click();
      await expect(
        editor.page.getByText("PUBLISHED · VERSION 2"),
      ).toBeVisible();
    }
    expect(
      (
        await f.pool.query(
          "SELECT * FROM content_versions WHERE version=1 ORDER BY id,version",
        )
      ).rows,
    ).toEqual(originals);
    await member.goto(f.origin + "/library");
    await expect(
      member.locator('[aria-label="Published content"] li'),
    ).toHaveCount(6);
    await member.locator('a[href="/library/FND-001"]').click();
    await expect(
      member.getByText("REVIEWED FOUNDATION · PUBLISHED · VERSION 2"),
    ).toBeVisible();
    await member.screenshot({
      path: info.outputPath("reviewed-foundation-reader.png"),
      fullPage: true,
    });
  } finally {
    await f.close();
  }
});

test("[L231] FOUND-03/04 all three backgrounds read six lessons and retain private opened, started and self-reported facts", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info);
  try {
    await f.publishFixture();
    for (const [background, goal] of [
      ["explorer", "everyday"],
      ["professional", "work"],
      ["technical", "build"],
    ]) {
      const member = await f.member(background, goal);
      await member.goto(f.origin + "/library");
      await expect(
        member.getByText("No lesson has been opened for this account yet."),
      ).toBeVisible();
      for (const item of await reviewedFoundation()) {
        await member.goto(f.origin + "/library");
        await member.locator(`a[href="/library/${item.id}"]`).click();
        await expect(
          member.getByText("Ordinary foundation education", { exact: false }),
        ).toBeVisible();
        await expect(member.getByRole("status")).toContainText(
          "Opened in reader · version 2",
        );
        await expect(
          member.getByRole("button", { name: "Mark self-assessed complete" }),
        ).toHaveCount(0);
      }
      await member.goto(f.origin + "/library/FND-001?version=2");
      const denied = await member.request.post(
        f.origin + "/library/FND-001/progress",
        {
          headers: { origin: f.origin },
          form: {
            csrf: "wrong",
            content_version: "2",
            intent: "complete",
            confirm: "yes",
          },
        },
      );
      expect(denied.status()).toBe(403);
      const layout = await member.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
      await member.screenshot({
        path: info.outputPath(`foundation-${background}-reader.png`),
        fullPage: true,
      });
      await member.getByRole("button", { name: "Start this lesson" }).click();

      await expect(member.getByRole("status")).toContainText(
        "Started · version 2",
      );
      await member
        .getByLabel(
          "I have finished reading this lesson; this is my own report.",
        )
        .check();
      await member
        .getByRole("button", { name: "Mark self-assessed complete" })
        .click();
      await expect(member.getByRole("status")).toContainText(
        "Self-assessed complete · version 2",
      );
      await member.reload();
      await expect(member.getByRole("status")).toContainText(
        "Self-assessed complete · version 2",
      );
      await member.goto(f.origin + "/learn");
      await member
        .getByLabel("What would you like to do?")
        .selectOption(goal === "work" ? "everyday" : "work");
      await member.getByRole("button", { name: "Save my direction" }).click();
      await member.goto(f.origin + "/library");
      const history = member.locator(
        'section[aria-labelledby="reading-history-title"]',
      );
      await expect(history.locator("li")).toHaveCount(6);
      await expect(history).toContainText(
        "FND-001 · version 2 · Self-assessed complete",
      );
      await expect(
        history.locator('a[href="/library/FND-001?version=2"]'),
      ).toHaveCount(1);
    }
  } finally {
    await f.close();
  }
});

test("[L232] FOUND-01/02/04 cached history refuses replacement, retirement preserves facts, and revoked editors cannot replay import", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info);
  try {
    const { editor, reviewer, catalog } = await f.publishFixture(),
      member = await f.member();

    await member.goto(f.origin + "/library/FND-001");
    const layout = await member.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));

    await member.screenshot({
      path: info.outputPath("foundation-before-start.png"),
      fullPage: true,
    });
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);

    await member.getByRole("button", { name: "Start this lesson" }).click();

    await member.goto(f.origin + "/library");
    const old = member.locator('a[href="/library/FND-001?version=2"]');
    await expect(old).toBeVisible();
    const next = {
      ...(await reviewedFoundation())[0]!,
      version: 3,
      body: "An explicitly authored replacement for this invented check.",
    };
    expect(await catalog.createDraft(editor.token, next)).toBe(true);
    await catalog.submit(editor.token, next.id, 3);
    await catalog.approve(reviewer.token, next.id, 3, true);
    await catalog.publish(editor.token, next.id, 3);
    await old.click();
    await expect(
      member.getByRole("heading", { name: "Content version unavailable" }),
    ).toBeVisible();
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM lesson_activity WHERE content_version=3",
        )
      ).rowCount,
    ).toBe(0);
    await member.goto(f.origin + "/library");
    await expect(
      member.getByText(
        "This version is unavailable; your history remains saved",
      ),
    ).toBeVisible();
    await member.locator('a[href="/library/FND-001"]').click();
    await expect(member.getByRole("status")).toContainText(
      "Opened in reader · version 3",
    );
    await catalog.retire(editor.token, "FND-001");
    await member.reload();
    await expect(
      member.getByRole("heading", { name: "Content unavailable" }),
    ).toBeVisible();
    await importFromLibrary(editor.page, f.origin);
    await expect(
      editor.page.getByRole("heading", {
        name: "Foundation import unconfirmed",
      }),
    ).toBeVisible();
    await editor.page.goto(f.origin + "/editor/library");
    const csrf = await editor.page
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    await f.pool.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [editor.id],
    );
    const denied = await editor.page.request.post(
      f.origin + "/editor/library/foundation",
      { headers: { origin: f.origin }, form: { csrf, confirm: "yes" } },
    );
    expect(denied.status()).toBe(403);
    const token = (await member.context().cookies()).find(
      (x) => x.name === "dne_preview",
    )!.value;
    const session = await store(f.pool).session(token);
    if (session.kind !== "active") throw Error("Member unavailable");
    const history = await store(f.pool).lessonActivities(session.learner.id);
    expect(history).toHaveLength(2);
    expect(history.every((x) => !x.available)).toBe(true);
    expect(
      history.find((x) => x.contentVersion === 2)?.startedAt,
    ).not.toBeNull();
  } finally {
    await f.close();
  }
});
