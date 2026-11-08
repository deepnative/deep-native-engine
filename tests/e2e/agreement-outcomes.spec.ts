import { expect, test } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { store } from "../../src/store.ts";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
// Staff credentials remain outside browser traces and captures.
test.use({ trace: "off" });

test("[L319] AGREE-01/02/03/04/06/07 an administrator reads course agreement outcomes with test agreements apart", async ({
  browser,
}, info) => {
  const f = await reviewedContentFixture(browser, info);
  try {
    const admin = await f.staff("platform_admin");
    const owners: string[] = [];
    const members = store(f.pool);
    for (let i = 0; i < 3; i++) {
      const token = randomBytes(32).toString("hex");
      await members.create(token, { background: "explorer", goal: "everyday" });
      const session = await members.session(token);
      if (session.kind !== "active") throw Error("Invented member missing");
      owners.push(session.learner.id);
    }
    const ids: string[] = [];
    const insert = async (
      owner: string,
      state: "offered" | "active" | "cancelled",
      accepted: boolean,
      sample: boolean,
    ) => {
      const id = randomUUID();
      ids.push(id);
      await f.pool.query(
        `INSERT INTO simple_invoice_plans(id,owner_id,workspace_id,terms,state,accepted_at,recipient_name,recipient_email)
         VALUES($1,$2,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          owner,
          {
            cadence: "one_time",
            sample,
            courses: [{ id: "ZAG-319", amountCents: 31900 }],
          },
          state,
          accepted ? new Date() : null,
          accepted ? "Invented Agreement Recipient" : null,
          accepted ? "invented-agreement@example.invalid" : null,
        ],
      );
    };
    await insert(owners[0]!, "active", true, false);
    await insert(owners[0]!, "cancelled", false, false);
    await insert(owners[1]!, "cancelled", true, false);
    await insert(owners[1]!, "offered", false, false);
    await insert(owners[2]!, "active", true, true);

    const page = admin.page;
    await page.goto(f.origin + "/staff");
    await page
      .getByRole("link", { name: "Course agreement outcomes", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Course agreement outcomes",
        level: 1,
      }),
    ).toBeVisible();
    const real = page.locator('[data-agreement-group="real"]');
    await expect(real.locator('[data-field="real.offered"]')).toHaveText("4");
    await expect(real.locator('[data-field="real.acceptance"]')).toHaveText(
      "2 of 4 (50%)",
    );
    await expect(real.locator('[data-field="real.withdrawn"]')).toHaveText("1");
    await expect(real.locator('[data-field="real.cancellation"]')).toHaveText(
      "1 of 2 (50%)",
    );
    const sample = page.locator('[data-agreement-group="test"]');
    await expect(sample.locator('[data-field="test.offered"]')).toHaveText("1");
    await expect(sample.locator('[data-field="test.acceptance"]')).toHaveText(
      "1 of 1 (100%)",
    );
    const text = (await page.locator("main").textContent()) ?? "";
    for (const secret of [
      ...ids,
      ...owners,
      "Invented Agreement Recipient",
      "invented-agreement@example.invalid",
      "ZAG-319",
      "319.00",
    ])
      expect(text).not.toContain(secret);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("course-agreements.png"),
      fullPage: true,
    });
    const operator = await f.staff("operator");
    const denied = await operator.page.goto(
      f.origin + "/operator/course-agreements",
    );
    expect(denied?.status()).toBe(403);
    await expect(operator.page.locator("main")).not.toContainText(/ of \d+ \(/);
  } finally {
    await f.close();
  }
});
