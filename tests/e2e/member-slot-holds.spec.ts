import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { authorizationStore } from "../../src/authorization.ts";
import { availabilityStore } from "../../src/availability.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { hash } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());
async function start(page: Page, context: BrowserContext, background: string) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByLabel("Time zone (optional)").fill("America/Toronto");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  const token = (await context.cookies()).find(
    (x) => x.name === "dne_preview",
  )!.value;
  return (
    await pool.query<{ id: string }>(
      "SELECT id FROM learners WHERE token_hash=$1",
      [hash(token)],
    )
  ).rows[0]!.id;
}
async function clearFault() {
  await pool.query(
    "DROP TRIGGER IF EXISTS reject_e2e_sample_receipt ON synthetic_member_hold_receipts",
  );
  await pool.query("DROP FUNCTION IF EXISTS reject_e2e_sample_receipt()");
}
test("[L93] members reserve only seeded sample minutes and recover private receipts, replay and expiry", async ({
  page,
  context,
  browser,
}, testInfo) => {
  const auth = authorizationStore(pool),
    slots = availabilityStore(pool);
  const adminToken = randomBytes(32).toString("hex"),
    operatorToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 10 * 86_400_000);
  const admin = await auth.provisionStaff(
    adminToken,
    "platform_admin",
    expires,
  );
  const operator = await auth.provisionStaff(
    operatorToken,
    "operator",
    expires,
  );
  const coach = await auth.provisionStaff(
    randomBytes(32).toString("hex"),
    "coach",
    expires,
  );
  const backup = await auth.provisionStaff(
    randomBytes(32).toString("hex"),
    "coach",
    expires,
  );
  const registry = randomUUID(),
    backupRegistry = randomUUID();
  const startsAt = new Date(Date.now() + 3 * 86_400_000),
    endsAt = new Date(startsAt.getTime() + 3600_000);
  const memberIds: string[] = [];
  const other = await browser.newContext({ baseURL: origin });
  const staff = await browser.newContext({ baseURL: origin });
  try {
    await pool.query(
      `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,loaded_cost_cents,capacity_minutes,backup_staff_id,qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
      VALUES($1,$2,'coach','education','coaching',$3,$4,12000,60,$5,'private qualification marker','synthetic agreement','synthetic conflict',$6,CURRENT_TIMESTAMP),
      ($7,$5,'coach','education','coaching',$3,$4,12000,60,$2,'private qualification marker','synthetic agreement','synthetic conflict',$6,CURRENT_TIMESTAMP)`,
      [
        registry,
        coach,
        new Date(Date.now() - 3600_000),
        new Date(endsAt.getTime() + 3600_000),
        backup,
        admin,
        backupRegistry,
      ],
    );
    const slotId = (await slots.create(
      operatorToken,
      registry,
      startsAt,
      endsAt,
    ))!;
    expect(slotId).toBeTruthy();
    const otherPage = await other.newPage();
    memberIds.push(await start(otherPage, other, "explorer"));
    await staff.addCookies([
      { name: "dne_preview", value: adminToken, url: origin },
    ]);
    const staffPage = await staff.newPage();
    for (const background of ["explorer", "professional", "technical"]) {
      await context.clearCookies();
      const memberId = await start(page, context, background);
      memberIds.push(memberId);
      await page.goto("/availability");
      await expect(
        page.getByRole("button", { name: "Reserve sample hold" }),
      ).toHaveCount(0);
      await expect(
        page.getByText("No matching current test allowance", { exact: false }),
      ).toBeVisible();
      expect(
        (
          await pool.query(
            "SELECT * FROM synthetic_entitlement_grants WHERE member_id=$1",
            [memberId],
          )
        ).rowCount,
      ).toBe(0);
      const grantId = await syntheticLedger(pool).grant(
        memberId,
        "coach_minutes",
        60,
        `L93-grant-${randomUUID()}`,
        {
          startsAt: new Date(Date.now() - 3600_000).toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      );
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Reserve sample hold" }),
      ).toBeVisible();
      const csrf = await page.locator('input[name="csrf"]').inputValue();
      const requestId = await page
        .locator('input[name="requestId"]')
        .inputValue();
      const denied = await page.request.post("/availability/holds", {
        headers: { origin },
        form: { csrf, slotId, grantId, requestId, memberId: memberIds[0]! },
      });
      expect(denied.status()).toBe(422);
      await pool.query(
        "CREATE FUNCTION reject_e2e_sample_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt fault'; END $$",
      );
      await pool.query(
        "CREATE TRIGGER reject_e2e_sample_receipt BEFORE INSERT ON synthetic_member_hold_receipts FOR EACH ROW EXECUTE FUNCTION reject_e2e_sample_receipt()",
      );
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/availability/holds") &&
          r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Reserve sample hold" }).click();
      expect((await response).status()).toBe(503);
      await expect(page.getByRole("alert")).toContainText(
        "Do not assume success or failure",
      );
      await clearFault();
      await page
        .getByRole("link", { name: "Inspect this request's receipt" })
        .click();
      await expect(page.getByRole("alert")).toContainText(
        "does not confirm the outcome",
      );
      await page
        .getByRole("link", { name: "Inspect your current sample receipts" })
        .click();
      const stableRequest = await page
        .locator('input[name="requestId"]')
        .inputValue();
      await page.getByRole("button", { name: "Reserve sample hold" }).click();
      await expect(page).toHaveURL(
        `${origin}/availability/holds/${stableRequest}`,
      );
      await expect(
        page.getByText("SAMPLE HOLD — NOT A BOOKING", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("60 minutes", { exact: true })).toBeVisible();
      await expect(page.getByText("held", { exact: true })).toBeVisible();
      await expect(page.locator("body")).not.toContainText(
        "private qualification marker",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.reload();
      await expect(page.getByText("held", { exact: true })).toBeVisible();
      const replay = await page.request.post("/availability/holds", {
        headers: { origin },
        form: { csrf, slotId, grantId, requestId: stableRequest },
        maxRedirects: 0,
      });
      expect(replay.status()).toBe(303);
      expect(replay.headers().location).toBe(
        `/availability/holds/${stableRequest}`,
      );
      expect(
        (
          await pool.query(
            "SELECT operation FROM synthetic_entitlement_events WHERE member_id=$1 AND operation='reserve'",
            [memberId],
          )
        ).rowCount,
      ).toBe(1);
      await otherPage.goto(`/availability/holds/${stableRequest}`);
      await expect(otherPage.getByRole("alert")).toContainText(
        "No receipt is currently visible",
      );
      await expect(otherPage.locator("body")).not.toContainText(
        startsAt.toISOString(),
      );
      await staffPage.goto(`/availability/holds/${stableRequest}`);
      await expect(staffPage).toHaveURL(origin + "/");
      if (background === "explorer")
        await page.screenshot({
          path: `artifacts/sample-hold-${testInfo.project.name}.png`,
          fullPage: true,
        });
      await pool.query(
        "UPDATE synthetic_slot_holds SET expires_at=clock_timestamp()-interval '1 second' WHERE member_id=$1",
        [memberId],
      );
      await page.getByRole("link", { name: "Reload this receipt" }).click();
      await expect(page.getByText("expired", { exact: true })).toBeVisible();
      await page.reload();
      expect(
        (
          await pool.query(
            "SELECT available,reserved,expired FROM synthetic_entitlement_grants WHERE id=$1",
            [grantId],
          )
        ).rows,
      ).toEqual([{ available: 60, reserved: 0, expired: 0 }]);
      expect(
        (
          await pool.query(
            "SELECT operation FROM synthetic_entitlement_events WHERE member_id=$1 AND operation='release'",
            [memberId],
          )
        ).rowCount,
      ).toBe(1);
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [memberId],
      );
      await page.reload();
      await expect(page).toHaveURL(origin + "/");
    }
  } finally {
    await clearFault();
    for (const id of memberIds)
      await pool.query("DELETE FROM principals WHERE id=$1", [id]);
    await pool.query("DELETE FROM expert_registry WHERE id IN ($1,$2)", [
      registry,
      backupRegistry,
    ]);
    await pool.query("DELETE FROM principals WHERE id IN ($1,$2,$3,$4)", [
      admin,
      operator,
      coach,
      backup,
    ]);
    await other.close();
    await staff.close();
  }
});

test("[L94] owner withdraws and reloads a sample hold, safely recovers uncertainty and reuses the released test capacity", async ({
  page,
  context,
  browser,
}, testInfo) => {
  const auth = authorizationStore(pool),
    slots = availabilityStore(pool);
  const adminToken = randomBytes(32).toString("hex"),
    operatorToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 10 * 86400000);
  const admin = await auth.provisionStaff(
      adminToken,
      "platform_admin",
      expires,
    ),
    operator = await auth.provisionStaff(operatorToken, "operator", expires);
  const coach = await auth.provisionStaff(
      randomBytes(32).toString("hex"),
      "coach",
      expires,
    ),
    backup = await auth.provisionStaff(
      randomBytes(32).toString("hex"),
      "coach",
      expires,
    );
  const registry = randomUUID(),
    backupRegistry = randomUUID(),
    startsAt = new Date(Date.now() + 3 * 86400000),
    endsAt = new Date(startsAt.getTime() + 3600000);
  const memberIds: string[] = [];
  const outsider = await browser.newContext({ baseURL: origin }),
    staff = await browser.newContext({ baseURL: origin }),
    anonymous = await browser.newContext({ baseURL: origin });
  const clearWithdrawalFault = async () => {
    await pool.query(
      "DROP TRIGGER IF EXISTS reject_e2e_sample_withdrawal ON synthetic_entitlement_events",
    );
    await pool.query("DROP FUNCTION IF EXISTS reject_e2e_sample_withdrawal()");
  };
  try {
    await pool.query(
      `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,loaded_cost_cents,capacity_minutes,backup_staff_id,qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
      VALUES($1,$2,'coach','education','coaching',$3,$4,12000,60,$5,'synthetic qualification','synthetic agreement','synthetic conflict',$6,CURRENT_TIMESTAMP),
      ($7,$5,'coach','education','coaching',$3,$4,12000,60,$2,'synthetic qualification','synthetic agreement','synthetic conflict',$6,CURRENT_TIMESTAMP)`,
      [
        registry,
        coach,
        new Date(Date.now() - 3600000),
        new Date(endsAt.getTime() + 3600000),
        backup,
        admin,
        backupRegistry,
      ],
    );
    const slotId = (await slots.create(
      operatorToken,
      registry,
      startsAt,
      endsAt,
    ))!;
    expect(slotId).toBeTruthy();
    const owner = await start(page, context, "professional");
    memberIds.push(owner);
    const otherPage = await outsider.newPage();
    memberIds.push(await start(otherPage, outsider, "explorer"));
    const grantId = await syntheticLedger(pool).grant(
      owner,
      "coach_minutes",
      60,
      `L94-${randomUUID()}`,
      {
        startsAt: new Date(Date.now() - 3600000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    );
    await page.goto("/availability");
    await page.getByRole("button", { name: "Reserve sample hold" }).click();
    const receiptPath = new URL(page.url()).pathname;
    const csrf = await page.locator('input[name="csrf"]').inputValue();
    const post = (fields: Record<string, string> = {}) =>
      page.request.post(`${receiptPath}/withdraw`, {
        headers: { origin },
        form: { csrf, ...fields },
        maxRedirects: 0,
      });
    await expect(
      page.getByText("SAMPLE HOLD — NOT A BOOKING", { exact: true }),
    ).toBeVisible();
    const withdrawal = page.getByRole("button", {
      name: "Withdraw sample hold",
    });
    await expect(withdrawal).toBeVisible();
    expect((await post({ category: "review_minutes" })).status()).toBe(422);
    expect((await post({ csrf: "forged" })).status()).toBe(403);
    const otherCsrf = await otherPage
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    expect(
      (
        await outsider.request.post(`${receiptPath}/withdraw`, {
          headers: { origin },
          form: { csrf: otherCsrf },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(409);
    await otherPage.goto(receiptPath);
    await expect(otherPage.getByRole("alert")).toContainText(
      "No receipt is currently visible",
    );
    await expect(otherPage.locator("body")).not.toContainText(
      startsAt.toISOString(),
    );
    await staff.addCookies([
      { name: "dne_preview", value: adminToken, url: origin },
    ]);
    for (const denied of [staff, anonymous]) {
      const deniedPage = await denied.newPage();
      await deniedPage.goto("/");
      const deniedCsrf = await deniedPage
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      expect(
        (
          await denied.request.post(`${receiptPath}/withdraw`, {
            headers: { origin },
            form: { csrf: deniedCsrf },
            maxRedirects: 0,
          })
        ).status(),
      ).toBe(303);
      await deniedPage.goto(receiptPath);
      await expect(deniedPage).toHaveURL(origin + "/");
    }
    await pool.query(
      "CREATE FUNCTION reject_e2e_sample_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='release' THEN RAISE EXCEPTION 'synthetic release fault'; END IF; RETURN NEW; END $$",
    );
    await pool.query(
      "CREATE TRIGGER reject_e2e_sample_withdrawal BEFORE INSERT ON synthetic_entitlement_events FOR EACH ROW EXECUTE FUNCTION reject_e2e_sample_withdrawal()",
    );
    const failed = page.waitForResponse(
      (r) => r.url().endsWith("/withdraw") && r.request().method() === "POST",
    );
    await withdrawal.click();
    expect((await failed).status()).toBe(503);
    await expect(page.getByRole("alert")).toContainText(
      "Do not assume success or failure",
    );
    await clearWithdrawalFault();
    await page
      .getByRole("link", { name: "Inspect this request's receipt" })
      .click();
    await expect(page.getByText("held", { exact: true })).toBeVisible();
    const action = page.getByRole("button", { name: "Withdraw sample hold" });
    await page.getByRole("link", { name: "Skip to content" }).focus();
    for (
      let i = 0;
      i < 10 && !(await action.evaluate((el) => el === document.activeElement));
      i++
    )
      await page.keyboard.press("Tab");
    await expect(action).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(origin + receiptPath);
    await expect(page.getByText("released", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Withdraw sample hold" }),
    ).toHaveCount(0);
    await expect(
      page.getByText("You withdrew this sample hold.", { exact: false }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByText("released", { exact: true })).toBeVisible();
    expect((await post()).status()).toBe(303);
    expect(
      (
        await pool.query(
          "SELECT available,reserved,expired FROM synthetic_entitlement_grants WHERE id=$1",
          [grantId],
        )
      ).rows,
    ).toEqual([{ available: 60, reserved: 0, expired: 0 }]);
    expect(
      (
        await pool.query(
          "SELECT * FROM synthetic_entitlement_events WHERE member_id=$1 AND operation='release'",
          [owner],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/sample-withdrawal-${testInfo.project.name}.png`,
      fullPage: true,
    });
    await page
      .getByRole("link", { name: "Inspect your current sample receipts" })
      .click();
    await page.getByRole("button", { name: "Reserve sample hold" }).click();
    const nextPath = new URL(page.url()).pathname;
    expect(nextPath).not.toBe(receiptPath);
    await expect(page.getByText("held", { exact: true })).toBeVisible();
    expect((await post()).status()).toBe(303);
    await page.reload();
    await expect(page.getByText("held", { exact: true })).toBeVisible();
    expect(
      (
        await pool.query(
          "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
          [grantId],
        )
      ).rows,
    ).toEqual([{ available: 0, reserved: 60 }]);
    await pool.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [owner],
    );
    expect(
      (
        await page.request.post(`${nextPath}/withdraw`, {
          headers: { origin },
          form: { csrf },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(303);
    await page.reload();
    await expect(page).toHaveURL(origin + "/");
    expect(
      (
        await pool.query(
          "SELECT * FROM synthetic_slot_holds WHERE member_id=$1 AND state='held'",
          [owner],
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    await clearWithdrawalFault();
    for (const id of memberIds)
      await pool.query("DELETE FROM principals WHERE id=$1", [id]);
    await pool.query("DELETE FROM expert_registry WHERE id IN ($1,$2)", [
      registry,
      backupRegistry,
    ]);
    await pool.query("DELETE FROM principals WHERE id IN ($1,$2,$3,$4)", [
      admin,
      operator,
      coach,
      backup,
    ]);
    await outsider.close();
    await staff.close();
    await anonymous.close();
  }
});
