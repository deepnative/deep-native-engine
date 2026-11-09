import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
// Staff credentials remain outside browser traces and captures.
test.use({ trace: "off" });

test("[L317] CAP-01/02/03/08/09 staff compare declared capacity without counting unverified records", async ({
  browser,
}, info) => {
  const f = await reviewedContentFixture(browser, info);
  try {
    const admin = await f.staff("platform_admin");
    const [a, b, c] = await Promise.all([
      f.staff("coach"),
      f.staff("coach"),
      f.staff("coach"),
    ]);
    const insert = (
      staffId: string,
      backup: string,
      capacity: number,
      committed: number,
      verified: boolean,
    ) =>
      f.pool.query(
        `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,
           loaded_cost_cents,capacity_minutes,committed_minutes,backup_staff_id,
           qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
         VALUES($1,$2,'coach','education','coaching',clock_timestamp()-interval '1 hour',
           clock_timestamp()+interval '30 days',123456,$3,$4,$5,'INVENTED-QUAL-L317',
           'INVENTED-AGREE-L317','INVENTED-CONFLICT-L317',$6::uuid,
           CASE WHEN $6::uuid IS NULL THEN NULL ELSE clock_timestamp()-interval '1 minute' END)`,
        [
          randomUUID(),
          staffId,
          capacity,
          committed,
          backup,
          verified ? admin.id : null,
        ],
      );
    await insert(a.id, b.id, 300, 60, true);
    await insert(b.id, a.id, 120, 0, true);
    await insert(c.id, a.id, 480, 0, false);

    const operator = await f.staff("operator");
    const page = operator.page;
    await page.goto(f.origin + "/staff");
    await page
      .getByRole("link", { name: "Staff capacity", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Staff capacity", level: 1 }),
    ).toBeVisible();
    const coaching = page.locator('[data-capacity-group="coaching"]');
    // CAP-03: 300 - 60 + 120 available on the two verified records.
    await expect(
      coaching.locator('[data-field="coaching.covered"]'),
    ).toHaveText("2");
    await expect(
      coaching.locator('[data-field="coaching.available"]'),
    ).toHaveText("360 min");
    // CAP-02: the unverified record keeps its minutes apart.
    await expect(
      coaching.locator('[data-field="coaching.unverified"]'),
    ).toHaveText("480 min declared, 0 min committed");
    await expect(coaching).toContainText("not qualified coverage");
    // CAP-01: no formal-review records, so availability is not recorded.
    await expect(
      page.locator('[data-field="formal-review.available"]'),
    ).toHaveText("Not recorded");
    await expect(
      page.locator("[data-review-time]").getByRole("status"),
    ).toHaveText("No review time to compare.");
    // CAP-09: no staff identifier, reference or cost is shown.
    const text = (await page.locator("main").textContent()) ?? "";
    for (const secret of [a.id, admin.id, "L317", "1234.56", "1,234.56"])
      expect(text).not.toContain(secret);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("staff-capacity.png"),
      fullPage: true,
    });
    // CAP-08: a coach is refused and sees no figures.
    const denied = await a.page.goto(f.origin + "/operator/staff-capacity");
    expect(denied?.status()).toBe(403);
    await expect(a.page.locator("main")).not.toContainText(/\d+ min/);
  } finally {
    await f.close();
  }
});
