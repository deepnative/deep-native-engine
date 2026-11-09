import {
  devices,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
  type TestInfo,
} from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { availabilityStore } from "../../src/availability.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { COOKIE } from "../../src/session.ts";
import { hash } from "../../src/store.ts";
import { authorizationStore } from "./administrator-fixture.ts";
import { browserOrigin } from "./browser-origin.ts";
import { chooseLearningGoal } from "./choose-learning-goal.ts";

// The focused-run override (#176) must reach the journey helpers too.
export const slotOrigin = browserOrigin;

export type SlotMember = {
  id: string;
  token: string;
  context: BrowserContext;
  page: Page;
};

function device(info: TestInfo) {
  return info.project.name === "mobile-chromium"
    ? devices["Pixel 7"]!
    : devices["Desktop Chrome"]!;
}

// Each journey owns its coach, slots and members, and finds its own slots by ID:
// the availability page lists every slot in the shared disposable database.
export async function slotWorld(pool: Pool, browser: Browser, info: TestInfo) {
  const auth = authorizationStore(pool);
  const expires = new Date(Date.now() + 10 * 86_400_000);
  const operatorToken = randomBytes(32).toString("hex");
  const admin = await auth.provisionStaff(
    randomBytes(32).toString("hex"),
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
  const registry = randomUUID();
  const backupRegistry = randomUUID();
  const firstStart = Date.now() + 3 * 86_400_000;
  await pool.query(
    `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,loaded_cost_cents,capacity_minutes,backup_staff_id,qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
     VALUES($1,$2,'coach','education','coaching',$3,$4,12000,480,$5,'synthetic qualification','synthetic agreement','synthetic conflict',$6,CURRENT_TIMESTAMP),
     ($7,$5,'coach','education','coaching',$3,$4,12000,480,$2,'synthetic qualification','synthetic agreement','synthetic conflict',$6,CURRENT_TIMESTAMP)`,
    [
      registry,
      coach,
      new Date(Date.now() - 3_600_000),
      new Date(firstStart + 86_400_000),
      backup,
      admin,
      backupRegistry,
    ],
  );
  const contexts: BrowserContext[] = [];
  const memberIds: string[] = [];
  let slots = 0;
  return {
    async slot() {
      // Two hours apart, so one coach can hold both without a conflict.
      const startsAt = new Date(firstStart + slots++ * 7_200_000);
      const id = await availabilityStore(pool).create(
        operatorToken,
        registry,
        startsAt,
        new Date(startsAt.getTime() + 3_600_000),
      );
      expect(id).toBeTruthy();
      return id!;
    },
    async member(): Promise<SlotMember> {
      const context = await browser.newContext({
        ...device(info),
        baseURL: slotOrigin,
      });
      contexts.push(context);
      const page = await context.newPage();
      await page.goto("/");
      await page.getByLabel("Display name").fill("Sample learner");
      await page.getByLabel("Your starting point").selectOption("explorer");
      await chooseLearningGoal(page, "everyday");
      await page
        .getByText("Personalize your path (optional)", { exact: true })
        .click();
      await page.getByLabel("Time zone (optional)").fill("America/Toronto");
      await page
        .getByRole("button", { name: "Start my learning path" })
        .click();
      await expect(page).toHaveURL(/\/learn$/);
      const token = (await context.cookies()).find(
        (cookie) => cookie.name === COOKIE,
      )!.value;
      const id = (
        await pool.query<{ id: string }>(
          "SELECT id FROM learners WHERE token_hash=$1",
          [hash(token)],
        )
      ).rows[0]!.id;
      memberIds.push(id);
      return { id, token, context, page };
    },
    // A second browser signed in as the same member, as on a second device.
    async secondDevice(member: SlotMember) {
      const context = await browser.newContext({
        ...device(info),
        baseURL: slotOrigin,
      });
      contexts.push(context);
      await context.addCookies([
        {
          name: COOKIE,
          value: member.token,
          url: slotOrigin,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      return context.newPage();
    },
    async cleanup() {
      await Promise.all(contexts.map((context) => context.close()));
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
    },
  };
}

export function grantCoachMinutes(pool: Pool, memberId: string) {
  return syntheticLedger(pool).grant(
    memberId,
    "coach_minutes",
    60,
    randomUUID(),
    {
      startsAt: new Date(Date.now() - 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  );
}

export function slotForm(page: Page, slotId: string) {
  return page.locator('form[action="/availability/holds"]').filter({
    has: page.locator(`input[name="slotId"][value="${slotId}"]`),
  });
}

export async function grantBalance(pool: Pool, grantId: string) {
  return (
    await pool.query<{ available: number; reserved: number }>(
      "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
      [grantId],
    )
  ).rows[0]!;
}

export async function heldSlots(pool: Pool, memberId: string) {
  return (
    await pool.query<{ slot_id: string }>(
      "SELECT slot_id FROM synthetic_slot_holds WHERE member_id=$1 AND state='held' ORDER BY slot_id",
      [memberId],
    )
  ).rows.map((row) => row.slot_id);
}

// Forces real overlap instead of hoping two clicks land together: this
// connection holds the contended row while both browsers submit, and lets go
// only once PostgreSQL shows two other sessions waiting. The product's own
// locks then decide the winner.
export async function submitTogether(
  pool: Pool,
  contended: { sql: string; id: string },
  attempts: readonly { page: Page; slotId: string }[],
): Promise<Response[]> {
  const holder = await pool.connect();
  let open = false;
  try {
    await holder.query("BEGIN");
    open = true;
    await holder.query(contended.sql, [contended.id]);
    const responses = attempts.map(({ page }) =>
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/availability/holds") &&
          response.request().method() === "POST",
      ),
    );
    const clicks = Promise.all(
      attempts.map(({ page, slotId }) =>
        slotForm(page, slotId)
          .getByRole("button", { name: "Reserve sample hold" })
          .click(),
      ),
    );
    await expect
      .poll(
        async () =>
          (
            await pool.query<{ waiting: number }>(
              `SELECT count(*)::int AS waiting FROM pg_stat_activity
               WHERE datname=current_database() AND wait_event_type='Lock'`,
            )
          ).rows[0]!.waiting,
        { timeout: 4000, intervals: [50] },
      )
      .toBe(attempts.length);
    await holder.query("COMMIT");
    open = false;
    const [settled] = await Promise.all([Promise.all(responses), clicks]);
    return settled;
  } finally {
    if (open) await holder.query("ROLLBACK");
    holder.release();
  }
}
