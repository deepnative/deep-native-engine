import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { availabilityStore } from "../../src/availability.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { hash } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

async function start(page: Page, context: BrowserContext) {
  await page.goto("/");
  await page.getByLabel("Display name").fill("Sample learner");
  await page.getByLabel("Your starting point").selectOption("professional");
  await chooseLearningGoal(page, "everyday");
  // Sample windows are listed only with a saved time zone.
  await page
    .getByText("Personalize your path (optional)", { exact: true })
    .click();
  await page.getByLabel("Time zone (optional)").fill("America/Toronto");
  await page.getByRole("button", { name: "Start my learning path" }).click();
  const token = (await context.cookies()).find(
    (cookie) => cookie.name === "dne_preview",
  )!.value;
  return (
    await pool.query<{ id: string }>(
      "SELECT id FROM learners WHERE token_hash=$1",
      [hash(token)],
    )
  ).rows[0]!.id;
}
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("[L324] COACHMOCK-06 a member sees the coach-minute gate, reserves a sample coaching hold and finds it in practice history", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const auth = authorizationStore(pool);
  const expires = new Date(Date.now() + 10 * 86_400_000);
  const staff = (role: "coach" | "operator" | "platform_admin") =>
    auth.provisionStaff(randomBytes(32).toString("hex"), role, expires);
  const operatorToken = randomBytes(32).toString("hex");
  const admin = await staff("platform_admin");
  const operator = await auth.provisionStaff(
    operatorToken,
    "operator",
    expires,
  );
  const coach = await staff("coach");
  const backup = await staff("coach");
  const registry = randomUUID(),
    backupRegistry = randomUUID();
  const startsAt = new Date(Date.now() + 3 * 86_400_000),
    endsAt = new Date(startsAt.getTime() + 3600_000);
  let memberId: string | undefined;
  try {
    await pool.query(
      `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,loaded_cost_cents,capacity_minutes,backup_staff_id,qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
      VALUES($1,$2,'coach','education','coaching',$3,$4,12000,60,$5,'synthetic qualification','synthetic agreement','synthetic conflict',$6,CURRENT_TIMESTAMP),
      ($7,$5,'coach','education','coaching',$3,$4,12000,60,$2,'synthetic qualification','synthetic agreement','synthetic conflict',$6,CURRENT_TIMESTAMP)`,
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
    const slotId = await availabilityStore(pool).create(
      operatorToken,
      registry,
      startsAt,
      endsAt,
    );
    expect(slotId).toBeTruthy();
    memberId = await start(page, context);

    await page.goto("/practice-sessions");
    const section = page.getByRole("region", {
      name: "Practice interview with a coach",
    });
    await expect(section).toContainText(
      "A practice interview with a person needs coach minutes.",
    );
    await expect(section).toContainText("No coach is booked for you.");
    await expect(section).toContainText(
      "No coaches are available to book yet, so a practice interview with a person can't be arranged.",
    );
    await expect(
      section.getByRole("link", { name: "sample coaching window" }),
    ).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(true);

    await syntheticLedger(pool).grant(
      memberId,
      "coach_minutes",
      60,
      `L324-${randomUUID()}`,
      {
        startsAt: new Date(Date.now() - 3600_000).toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    );
    await page.reload();
    await expect(section).toContainText("A sample hold isn't a booking");
    await section.getByRole("link", { name: "sample coaching window" }).click();
    await expect(page).toHaveURL(/\/availability$/);
    // Other journeys may share this database, so reserve the window this
    // journey created rather than the first one listed.
    const form = page.locator("form", {
      has: page.locator(`input[name="slotId"][value="${slotId}"]`),
    });
    await form.getByRole("button", { name: "Reserve sample hold" }).click();
    await expect(
      page.getByText("SAMPLE HOLD — NOT A BOOKING", { exact: true }),
    ).toBeVisible();

    await page.goto("/practice-sessions");
    await expect(section).toContainText("Your sample coaching holds");
    const held = section.getByRole("link", {
      name: "Sample hold with a coach · not a booking",
    });
    await expect(held).toHaveCount(1);
    await expect(section).toContainText("Held until");
    await expect(section).toContainText(
      "The sessions listed here are simulated practice. No person reads them",
    );
    expect(await noSidewaysScroll(page)).toBe(true);
    await held.click();
    await expect(
      page.getByText("SAMPLE HOLD — NOT A BOOKING", { exact: true }),
    ).toBeVisible();
  } finally {
    if (memberId)
      await pool.query("DELETE FROM principals WHERE id=$1", [memberId]);
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
  }
});
