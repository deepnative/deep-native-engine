import { createHash, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { testPool } from "../support/database.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

async function onboard(page: Page) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

async function memberId(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (item) => item.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const tokenHash = createHash("sha256").update(cookie!.value).digest("hex");
  const row = await pool.query<{ id: string }>(
    "SELECT id FROM learners WHERE token_hash=$1",
    [tokenHash],
  );
  expect(row.rowCount).toBe(1);
  return row.rows[0]!.id;
}

test("[L61] current owner downloads private structured records while another member and expired session cannot", async ({
  page,
  context,
  browser,
}) => {
  const otherContext = await browser.newContext({
    baseURL: "http://127.0.0.1:4317",
  });
  try {
    const otherPage = await otherContext.newPage();
    await onboard(page);
    await onboard(otherPage);
    const ownerId = await memberId(context);
    await pool.query(
      `INSERT INTO learning_milestones(id,member_id,goal_title,milestone_title,next_action)
       VALUES($1,$2,'Invented goal','Owner-only milestone','Review next step')`,
      [randomUUID(), ownerId],
    );
    await expect(
      page.getByRole("link", {
        name: "Download my structured preview records",
      }),
    ).toBeVisible();
    const own = await page.request.get("/api/member/export");
    expect(own.status()).toBe(200);
    expect(own.headers()["content-disposition"]).toContain(
      "deep-native-member-records.json",
    );
    expect(own.headers()["cache-control"]).toBe("no-store");
    expect(await own.json()).toMatchObject({
      version: "local-member-records-v1",
      profile: { id: ownerId },
      records: { milestones: [{ milestoneTitle: "Owner-only milestone" }] },
    });
    const other = await otherPage.request.get("/api/member/export");
    expect(other.status()).toBe(200);
    expect((await other.json()).records.milestones).toEqual([]);
    await pool.query(
      "UPDATE principals SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1",
      [ownerId],
    );
    const expired = await page.request.get("/api/member/export");
    expect(expired.status()).toBe(403);
    expect(await expired.json()).toEqual({ error: "forbidden" });
  } finally {
    await otherContext.close();
  }
});
