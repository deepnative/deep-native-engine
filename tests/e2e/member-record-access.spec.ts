import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
// Staff credentials remain outside browser traces and captures.
test.use({ trace: "off" });

test("[L328] RECACCESS-01/03/04/07 a member lets an operator download one kind of record, sees the download and stops it", async ({
  browser,
}, info) => {
  const f = await reviewedContentFixture(browser, info);
  try {
    const member = await f.member();
    await member.goto(f.origin + "/account");
    const reference = (await member.locator("code").first().textContent())!;
    await f.pool.query(
      `INSERT INTO learning_milestones(id,member_id,goal_title,milestone_title,next_action)
       VALUES($1,$2,'Invented L328 goal','Invented L328 milestone','Invented next step')`,
      [randomUUID(), reference],
    );
    await f.pool.query(
      `INSERT INTO support_requests(id,member_id,workspace_id,intake_key,subject,body)
       VALUES($1,$2,$2,$3,'Invented L328 subject','Invented L328 support body')`,
      [randomUUID(), reference, randomUUID()],
    );

    // The member finds the permission from Who can see my work.
    await member
      .getByRole("link", { name: "Who can see my work", exact: true })
      .click();
    await member
      .getByRole("link", { name: "Allow or stop operator downloads" })
      .click();
    await expect(
      member.getByRole("heading", {
        name: "Let operators download my records",
        level: 1,
      }),
    ).toBeVisible();
    await expect(member.locator("main")).toContainText(reference);
    await member.getByRole("radio", { name: /^Learning records/ }).check();
    await member.getByRole("button", { name: "Allow for 7 days" }).click();
    await expect(
      member.locator('[data-record-access="learning"]'),
    ).toContainText("No downloads yet.");
    expect(
      await member.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);

    // The operator downloads the learning records, and nothing else.
    const operator = (await f.staff("operator")).page;
    await operator.goto(f.origin + "/staff");
    await operator
      .getByRole("link", {
        name: "Download a member's records (with their permission)",
      })
      .click();
    await operator.getByLabel("Student reference").fill(reference);
    await operator.getByLabel("Records").selectOption("learning");
    const [download] = await Promise.all([
      operator.waitForEvent("download"),
      operator.getByRole("button", { name: "Download records" }).click(),
    ]);
    const saved = info.outputPath("learning.json");
    await download.saveAs(saved);
    const payload = JSON.parse(await readFile(saved, "utf8"));
    expect(payload).toMatchObject({
      version: "operator-member-records-v1",
      reference,
      scope: "learning",
      page: { complete: true },
    });
    expect(payload.records.milestones).toEqual([
      expect.objectContaining({ milestoneTitle: "Invented L328 milestone" }),
    ]);
    expect(JSON.stringify(payload)).not.toContain("Invented L328 support body");

    // Support requests weren't allowed, so nothing is downloaded.
    await operator.goto(f.origin + "/operator/member-records");
    await operator.getByLabel("Student reference").fill(reference);
    await operator.getByLabel("Records").selectOption("support");
    await operator.getByRole("button", { name: "Download records" }).click();
    await expect(
      operator.getByRole("heading", { name: "Download refused" }),
    ).toBeVisible();
    await expect(operator.locator("main")).not.toContainText(
      "Invented L328 support body",
    );

    // The member sees the one download, without who made it, and stops it.
    await member.reload();
    await expect(
      member.locator('[data-record-access="learning"]'),
    ).toContainText("Downloaded once.");
    await member.goto(f.origin + "/account/sharing/staff-access");
    await expect(member.locator("main")).toContainText(
      "An operator downloaded your learning records, with your permission.",
    );
    await member.goto(f.origin + "/account/record-access");
    await member
      .getByRole("button", {
        name: "Stop operators downloading my learning records",
      })
      .click();
    await expect(member.locator("main")).toContainText(
      "Operators can't download any of your records right now.",
    );
    await expect(member.locator("main")).toContainText("You stopped it on");
    await member.screenshot({
      path: info.outputPath("record-access.png"),
      fullPage: true,
    });

    // Once stopped, the same download is refused.
    await operator.goto(f.origin + "/operator/member-records");
    await operator.getByLabel("Student reference").fill(reference);
    await operator.getByLabel("Records").selectOption("learning");
    await operator.getByRole("button", { name: "Download records" }).click();
    await expect(
      operator.getByRole("heading", { name: "Download refused" }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});
