import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { store } from "../../src/store.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  support = supportRequestStore(pool),
  auth = authorizationStore(pool),
  ledger = syntheticLedger(pool);
const origin = "http://127.0.0.1:4317";
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
test.afterAll(async () => pool.end());
async function session(page: Page, token: string) {
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: COOKIE,
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}
for (const [index, [background, goal]] of audiences.entries()) {
  test(`[L${130 + index}] ${background} connects exact private support and effort permissions without widening access`, async ({
    page,
  }) => {
    const token = randomBytes(32).toString("hex"),
      admin = randomBytes(32).toString("hex"),
      operator = randomBytes(32).toString("hex"),
      foreign = randomBytes(32).toString("hex"),
      expiry = new Date(Date.now() + 3600000),
      startsAt = new Date(Date.now() - 60000);
    await members.create(token, { background, goal });
    const member = await members.session(token);
    if (member.kind !== "active") throw Error("Missing invented learner");
    const adminId = await auth.provisionStaff(admin, "platform_admin", expiry),
      staffId = await auth.provisionStaff(operator, "operator", expiry),
      foreignId = await auth.provisionStaff(foreign, "operator", expiry);
    try {
      await ledger.grant(
        member.learner.id,
        "support_minutes",
        20,
        randomUUID(),
        { startsAt: startsAt.toISOString(), expiresAt: expiry.toISOString() },
      );
      const intake = await support.create(token, {
        idempotencyKey: randomUUID(),
        subject: "Invented <script> question",
        body: "PRIVATE CONNECTED REQUEST <img src=x onerror=alert(1)>",
      });
      if (!("receipt" in intake)) throw Error("Missing invented request");
      const requestId = intake.receipt.requestId;
      const requestGrant = await support.grant(admin, {
        requestId,
        staffId,
        role: "operator",
        idempotencyKey: randomUUID(),
        startsAt,
        expiresAt: expiry,
      });
      if (!("grantId" in requestGrant))
        throw Error("Missing exact request permission");
      const detail = `/operator/support/${requestId}?grant=${requestGrant.grantId}`;
      for (const denied of [token, admin, foreign]) {
        await session(page, denied);
        expect((await page.goto(detail))!.status()).toBe(403);
      }
      await session(page, operator);
      await page.goto(detail);
      await expect(
        page.getByText("No separately authorized test effort shown", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "PRIVATE CONNECTED REQUEST <img src=x onerror=alert(1)>",
          { exact: true },
        ),
      ).toHaveText("PRIVATE CONNECTED REQUEST <img src=x onerror=alert(1)>");
      await expect(page.locator("main img")).toHaveCount(0);
      await expect(
        page.getByText("Elapsed calendar time", { exact: true }),
      ).toBeVisible();
      const allocated = await support.time!.allocate(
        token,
        requestId,
        randomUUID(),
        20,
      );
      if (!("receipt" in allocated))
        throw Error("Missing exact test allocation");
      await page.reload();
      await expect(
        page.getByText("No separately authorized test effort shown", {
          exact: true,
        }),
      ).toBeVisible();
      const timeGrant = await support.time!.grant(admin, {
        requestId,
        allocationId: allocated.receipt.allocationId,
        staffId,
        role: "operator",
        idempotencyKey: randomUUID(),
        startsAt,
        expiresAt: expiry,
      });
      if (!("grantId" in timeGrant))
        throw Error("Missing separate effort permission");
      await page.goto("/operator/support");
      const link = page.getByRole("link", {
        name: `Open separately authorized test effort receipt · ${allocated.receipt.allocationId}`,
        exact: true,
      });
      await expect(link).toBeVisible();
      await expect(
        page.getByText(
          "20 support test minutes held; 0 consumed; 0 released. Confirmed ceiling: 20. State: allocated.",
          { exact: true },
        ),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await link.focus();
      await expect(link).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(
        new RegExp(`/operator/support-time/${requestId}`),
      );
      await expect(
        page.getByText("PRIVATE CONNECTED REQUEST", { exact: false }),
      ).toHaveCount(0);
      await page
        .getByLabel("Begin this private invented support effort")
        .check();
      await page
        .getByRole("button", { name: "Begin support test effort", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText("State: begun");
      await page.goto(detail);
      await expect(
        page.getByText(
          "20 support test minutes held; 0 consumed; 0 released. Confirmed ceiling: 20. State: begun.",
          { exact: true },
        ),
      ).toBeVisible();
      await page
        .getByRole("link", {
          name: `Open separately authorized test effort receipt · ${allocated.receipt.allocationId}`,
          exact: true,
        })
        .click();
      const start = new Date(Date.now() - 600000);
      await page
        .getByLabel("Support start (UTC)", { exact: true })
        .fill(start.toISOString());
      await page
        .getByLabel("Support end (UTC)", { exact: true })
        .fill(new Date(+start + 300000).toISOString());
      await page.getByLabel("Record these invented intervals once").check();
      await page
        .getByRole("button", { name: "Record and settle test effort" })
        .click();
      await expect(page.getByRole("status")).toContainText("State: completed");
      const effortHref = page.url();
      await page.goto(detail);
      await expect(
        page.getByText(
          "0 support test minutes held; 5 consumed; 15 released. Confirmed ceiling: 20. State: completed.",
          { exact: true },
        ),
      ).toBeVisible();
      await page.reload();
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM support_time_entries WHERE allocation_id=$1",
            [allocated.receipt.allocationId],
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
      expect(await support.revoke(admin, requestGrant.grantId)).toEqual({
        kind: "revoked",
      });
      expect((await page.goto(detail))!.status()).toBe(403);
      expect((await page.goto(effortHref))!.status()).toBe(200);
      await expect(
        page.getByText("PRIVATE CONNECTED REQUEST", { exact: false }),
      ).toHaveCount(0);
      const newGrant = await support.grant(admin, {
        requestId,
        staffId,
        role: "operator",
        idempotencyKey: randomUUID(),
        startsAt,
        expiresAt: expiry,
      });
      if (!("grantId" in newGrant))
        throw Error("Missing renewed request permission");
      expect(await support.time!.revoke(admin, timeGrant.grantId)).toEqual({
        kind: "revoked",
      });
      await page.goto(
        `/operator/support/${requestId}?grant=${newGrant.grantId}`,
      );
      await expect(
        page.getByText("No separately authorized test effort shown", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", {
          name: /Open separately authorized test effort receipt/,
        }),
      ).toHaveCount(0);
      expect((await page.goto(effortHref))!.status()).toBe(403);
    } finally {
      await pool.query("DELETE FROM principals WHERE id=ANY($1::uuid[])", [
        [member.learner.id, staffId, foreignId, adminId],
      ]);
    }
  });
}
