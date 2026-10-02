import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { store } from "../../src/store.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  ledger = syntheticLedger(pool);
const origin = "http://127.0.0.1:4317";
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
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
for (const [index, [background, goal]] of audiences.entries()) {
  test(`[L${116 + index}] ${background} reads and downloads separate own test units after holds and expiry`, async ({
    page,
  }) => {
    const token = randomBytes(32).toString("hex");
    await members.create(token, { background, goal });
    const member = await members.session(token);
    if (member.kind !== "active") throw Error("Member fixture unavailable");
    const id = member.learner.id;
    try {
      await session(page, token);
      await page.goto("/availability");
      await page
        .getByRole("link", { name: "View your local test units" })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Your local test units",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole("status")).toContainText(
        "No local test grants",
      );
      const grant = await ledger.grant(id, "coach_minutes", 60, randomUUID(), {
        startsAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2100-01-01T00:00:00.000Z",
      });
      await ledger.grant(id, "study_requests", 3, randomUUID(), {
        startsAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2100-01-01T00:00:00.000Z",
      });
      const row = page.locator('[data-test-unit-category="coach_minutes"]');
      const value = (key: string) => row.locator(`[data-field="${key}"]`);
      await page.reload();
      await expect(value("usable")).toHaveText("60");
      await expect(
        page.locator(
          '[data-test-unit-category="study_requests"] [data-field="usable"]',
        ),
      ).toHaveText("3");
      const key = randomUUID();
      const held = await ledger.reserve(id, grant, 20, key);
      expect(await ledger.reserve(id, grant, 20, key)).toBe(held);
      await page.reload();
      await expect(value("usable")).toHaveText("40");
      await expect(value("held")).toHaveText("20");
      await ledger.release(id, held, randomUUID());
      await page.reload();
      await expect(value("usable")).toHaveText("60");
      const pending = await ledger.reserve(id, grant, 10, randomUUID());
      await pool.query(
        "UPDATE synthetic_entitlement_grants SET expires_at='2021-01-01' WHERE id=$1",
        [grant],
      );
      await page.reload();
      await expect(value("usable")).toHaveText("0");
      await expect(value("held")).toHaveText("10");
      await expect(value("awaitingExpiry")).toHaveText("50");
      await ledger.release(id, pending, randomUUID());
      await ledger.expire(id, grant, randomUUID());
      await page.reload();
      await expect(value("expired")).toHaveText("60");
      const downloadEvent = page.waitForEvent("download");
      await page
        .getByRole("link", { name: "Download a current summary (JSON)" })
        .click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toBe("local-test-units.json");
      const stream = await download.createReadStream();
      if (!stream) throw Error("Download stream unavailable");
      let text = "";
      for await (const chunk of stream) text += chunk.toString();
      const report = JSON.parse(text);
      expect(report.scope).toBe("synthetic-local-preview");
      expect(report.categories).toHaveLength(5);
      expect(report.categories[0]).toMatchObject({
        usable: 0,
        held: 0,
        expired: 60,
      });
      expect(text).not.toContain(id);
      expect(text).not.toContain(grant);
      await expect(page.locator("body")).not.toContainText(id);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath("test-unit-summary.png"),
        fullPage: true,
      });
    } finally {
      await members.remove(id);
    }
  });
}
test("[L119] test-unit reader denies staff, revoked sessions and target scope without fabricating balances", async ({
  page,
}) => {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const member = await members.session(token);
  if (member.kind !== "active") throw Error("Member fixture unavailable");
  const staffToken = randomBytes(32).toString("hex");
  const staffId = await authorizationStore(pool).provisionStaff(
    staffToken,
    "operator",
    new Date(Date.now() + 3600000),
  );
  try {
    await ledger.grant(member.learner.id, "coach_minutes", 99, randomUUID(), {
      startsAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2100-01-01T00:00:00.000Z",
    });
    await session(page, token);
    const scoped = await page.goto("/member/test-units?memberId=another-owner");
    expect(scoped!.status()).toBe(400);
    await expect(page.locator("body")).not.toContainText("another-owner");
    await session(page, staffToken);
    expect((await page.goto("/member/test-units"))!.status()).toBe(403);
    await expect(page.locator("[data-test-unit-category]")).toHaveCount(0);
    await session(page, token);
    await pool.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [member.learner.id],
    );
    expect((await page.goto("/member/test-units"))!.status()).toBe(403);
    await expect(page.locator("[data-test-unit-category]")).toHaveCount(0);
    const response = await page.request.get("/member/test-units/download");
    expect(response.status()).toBe(403);
    expect(response.headers()["content-disposition"]).toBeUndefined();
    expect(response.headers()["cache-control"]).toContain("no-store");
  } finally {
    await members.remove(member.learner.id);
    await pool.query("DELETE FROM principals WHERE id=$1", [staffId]);
  }
});
