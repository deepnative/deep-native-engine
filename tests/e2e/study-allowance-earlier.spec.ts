import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { test, expect, devices, type BrowserContext } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { dropAttendanceBrowserDatabase } from "../support/attendance-browser-database.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { start } from "../../src/runtime.ts";
import { migrate } from "../../src/store.ts";

const monthStart = (offset: number) => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
  );
};
// Last month's genuine claim, with one unit held before the month ended and
// that request finishing afterwards.
async function lastMonthClaim(pool: Pool, memberId: string) {
  const from = monthStart(-1),
    to = monthStart(0),
    ledger = syntheticLedger(pool);
  const grant = await ledger.grant(
    memberId,
    "study_requests",
    5,
    `study-allowance:${memberId}:${from.toISOString().slice(0, 7)}`,
    { startsAt: from.toISOString(), expiresAt: to.toISOString() },
  );
  const workspace = (
    await pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE owner_principal_id=$1",
      [memberId],
    )
  ).rows[0]!.id;
  await pool.query(
    `INSERT INTO study_allowance_claims(id,member_id,workspace_id,policy_version,category,period_start,period_end,quantity,grant_id,operation_key)
     VALUES($1,$2,$3,'study-allowance-test-v1','study_requests',$4,$5,5,$6,$7)`,
    [randomUUID(), memberId, workspace, from, to, grant, randomUUID()],
  );
  const reservation = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE synthetic_entitlement_grants SET available=available-1,reserved=reserved+1 WHERE id=$1",
      [grant],
    );
    await client.query(
      "INSERT INTO synthetic_entitlement_reservations(id,grant_id,quantity,state) VALUES($1,$2,1,'reserved')",
      [reservation, grant],
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  await ledger.consume(memberId, reservation, `l319-${randomUUID()}`);
  return from;
}

test("[L319] RENEW-01/02/05 a member reads last month's allowance and claims this month", async ({
  browser,
}, info) => {
  test.setTimeout(90000);
  const original = process.env.DNE_TEST_DATABASE_URL;
  if (
    !original ||
    !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(original).pathname)
  )
    throw Error("Missing generated browser database");
  const adminUrl = new URL(original),
    ownUrl = new URL(original),
    name = `dne_test_${randomBytes(16).toString("hex")}`;
  adminUrl.pathname = "/postgres";
  ownUrl.pathname = `/${name}`;
  const control = new Pool({ connectionString: adminUrl.href }),
    pool = new Pool({ connectionString: ownUrl.href });
  const storage = await mkdtemp(join(tmpdir(), "dne199-earlier-")),
    contexts: BrowserContext[] = [];
  let running: Awaited<ReturnType<typeof start>> | undefined,
    created = false;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(pool);
    running = await start({
      DNE_DATABASE_URL: ownUrl.href,
      DNE_APP_MODE: "test",
      DNE_PORT: "0",
      DNE_PRIVATE_STORAGE_ROOT: storage,
      DNE_LOCAL_TEST_UNIT_ISSUANCE: "enabled",
    });
    const origin = running.origin;
    const context = await browser.newContext(
      info.project.name === "mobile-chromium"
        ? devices["Pixel 7"]
        : devices["Desktop Chrome"],
    );
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByLabel("Display name").fill("Sample learner");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(page, "everyday");
    await page
      .getByRole("button", { name: "Start my learning path", exact: true })
      .click();
    await expect
      .poll(async () => (await pool.query("SELECT 1 FROM learners")).rowCount)
      .toBe(1);
    const memberId = (
      await pool.query<{ id: string }>("SELECT id FROM learners")
    ).rows[0]!.id;
    const from = await lastMonthClaim(pool, memberId);
    const label = from.toLocaleString("en-GB", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

    await page.goto(origin + "/member/study-allowance");
    const earlier = page.locator(
      `[data-earlier-month="${from.toISOString().slice(0, 7)}"]`,
    );
    await expect(
      earlier.getByRole("heading", { name: `${label} · Study requests` }),
    ).toBeVisible();
    await expect(earlier.locator('[data-field="earlier-used"]')).toHaveText(
      "1",
    );
    await expect(earlier.locator('[data-field="earlier-ended"]')).toHaveText(
      "4",
    );
    await expect(
      page.getByText("Nothing renews automatically.", { exact: false }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.goto(origin + "/member/test-units");
    await expect(
      page
        .locator('[data-test-unit-category="study_requests"]')
        .locator('[data-field="usable"]'),
    ).toHaveText("0");

    await page.goto(origin + "/member/study-allowance");
    await page
      .getByRole("checkbox", {
        name: "I want this month's 5 study requests.",
        exact: true,
      })
      .check();
    await page
      .getByRole("button", {
        name: "Claim this month's allowance",
        exact: true,
      })
      .click();
    await expect(page.locator('[data-field="available"]')).toHaveText("5");
    await expect(page.getByText("The next month opens")).toBeVisible();
    await expect(earlier.locator('[data-field="earlier-ended"]')).toHaveText(
      "4",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    for (const context of contexts) await context.close();
    await running?.close();
    await pool.end();
    try {
      if (created) await dropAttendanceBrowserDatabase(control, name);
    } finally {
      await control.end();
      await rm(storage, { recursive: true, force: true });
    }
  }
});
