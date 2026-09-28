import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { authorizationStore } from "../../src/authorization.ts";
import { availabilityStore } from "../../src/availability.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const slots = availabilityStore(pool);

function sunday(year: number, month: number, ordinal: number) {
  const first = new Date(Date.UTC(year, month, 1));
  return 1 + ((7 - first.getUTCDay()) % 7) + 7 * (ordinal - 1);
}

test.afterAll(async () => pool.end());

test("[L64] private sample availability respects verified coverage, time zone and withdrawal without booking", async ({
  browser,
  page,
}, testInfo) => {
  const origin = "http://127.0.0.1:4317";
  const outsider = await browser.newContext({ baseURL: origin });
  const technical = await browser.newContext({ baseURL: origin });
  const otherLearner = await browser.newContext({ baseURL: origin });
  const noZone = await browser.newContext({ baseURL: origin });
  const adminToken = randomBytes(32).toString("hex");
  const operatorToken = randomBytes(32).toString("hex");
  const coachToken = randomBytes(32).toString("hex");
  const backupToken = randomBytes(32).toString("hex");
  const auth = authorizationStore(pool);
  const expires = new Date(Date.now() + 10 * 86_400_000);
  const adminId = await auth.provisionStaff(
    adminToken,
    "platform_admin",
    expires,
  );
  const operatorId = await auth.provisionStaff(
    operatorToken,
    "operator",
    expires,
  );
  const coachId = await auth.provisionStaff(coachToken, "coach", expires);
  const backupId = await auth.provisionStaff(backupToken, "coach", expires);
  const primaryRecordId = randomUUID();
  const backupRecordId = randomUUID();
  const year = new Date().getUTCFullYear() + 1;
  const start = new Date(Date.UTC(year, 2, sunday(year, 2, 2), 6, 30));
  const end = new Date(start.getTime() + 60 * 60_000);
  const fallStart = new Date(Date.UTC(year, 10, sunday(year, 10, 1), 5, 30));
  const fallEnd = new Date(fallStart.getTime() + 60 * 60_000);
  const coverageStart = new Date(Date.now() - 3600_000);
  const coverageEnd = new Date(Date.UTC(year + 1, 0, 1));
  try {
    await pool.query(
      `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,
        starts_at,ends_at,loaded_cost_cents,capacity_minutes,backup_staff_id,
        qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
       VALUES ($1,$2,'coach','education','coaching',$3,$4,12000,120,$5,
         'synthetic qualification','synthetic agreement','synthetic conflict review',$6,CURRENT_TIMESTAMP),
         ($7,$5,'coach','education','coaching',$3,$4,12000,120,$2,
         'synthetic qualification','synthetic agreement','synthetic conflict review',$6,CURRENT_TIMESTAMP)`,
      [
        primaryRecordId,
        coachId,
        coverageStart,
        coverageEnd,
        backupId,
        adminId,
        backupRecordId,
      ],
    );
    const slotId = await slots.create(
      operatorToken,
      primaryRecordId,
      start,
      end,
    );
    expect(slotId).toBeTruthy();
    const fallSlotId = await slots.create(
      operatorToken,
      primaryRecordId,
      fallStart,
      fallEnd,
    );
    expect(fallSlotId).toBeTruthy();
    const outsiderPage = await outsider.newPage();
    await outsiderPage.goto("/availability");
    await expect(outsiderPage).toHaveURL(origin + "/");

    await page.goto("/");
    await page
      .getByLabel("Your starting point")
      .selectOption(
        testInfo.project.name === "mobile-chromium"
          ? "professional"
          : "explorer",
      );
    await page
      .getByLabel("What would you like to do?")
      .selectOption("everyday");
    await page.getByLabel("Time zone (optional)").fill("America/Toronto");
    await page.getByLabel("I'll use invented or sample information").check();
    await page.getByRole("button", { name: "Start my learning path" }).click();
    await page
      .getByRole("link", { name: "View sample appointment windows" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Optional service availability" }),
    ).toBeVisible();
    await expect(
      page.getByText("Education · coaching", { exact: false }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(start.toISOString(), { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("GMT-05:00", { exact: false }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("GMT-04:00", { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByText("sample window, not bookable")).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: /book|buy|reserve/i }),
    ).toHaveCount(0);
    expect(
      (
        await page.request.post(`/availability/${slotId}`, {
          headers: { origin },
        })
      ).status(),
    ).toBe(403);
    const dashboard = await page.request.get("/learn");
    const csrf = (await dashboard.text()).match(
      /name="csrf" value="([a-f0-9]+)"/,
    )![1]!;
    expect(
      (
        await page.request.post(`/availability/${slotId}`, {
          headers: { origin, "x-csrf-token": csrf },
        })
      ).status(),
    ).toBe(404);

    const technicalPage = await technical.newPage();
    await technicalPage.goto("/");
    await technicalPage
      .getByLabel("Your starting point")
      .selectOption("technical");
    await technicalPage
      .getByLabel("What would you like to do?")
      .selectOption("build");
    await technicalPage
      .getByLabel("Time zone (optional)")
      .fill("Europe/Berlin");
    await technicalPage
      .getByLabel("I'll use invented or sample information")
      .check();
    await technicalPage
      .getByRole("button", { name: "Start my learning path" })
      .click();
    await technicalPage.goto("/availability");
    await expect(
      technicalPage.getByText("Times shown for Europe/Berlin"),
    ).toBeVisible();
    await expect(
      technicalPage.getByText(start.toISOString(), { exact: false }),
    ).toBeVisible();
    await expect(
      technicalPage.getByRole("button", { name: /book|buy|reserve/i }),
    ).toHaveCount(0);

    const otherLearnerPage = await otherLearner.newPage();
    await otherLearnerPage.goto("/");
    await otherLearnerPage
      .getByLabel("Your starting point")
      .selectOption(
        testInfo.project.name === "mobile-chromium"
          ? "explorer"
          : "professional",
      );
    await otherLearnerPage
      .getByLabel("What would you like to do?")
      .selectOption("everyday");
    await otherLearnerPage
      .getByLabel("Time zone (optional)")
      .fill("America/Vancouver");
    await otherLearnerPage
      .getByLabel("I'll use invented or sample information")
      .check();
    await otherLearnerPage
      .getByRole("button", { name: "Start my learning path" })
      .click();
    await otherLearnerPage.goto("/availability");
    await expect(
      otherLearnerPage.getByText("Times shown for America/Vancouver"),
    ).toBeVisible();
    await expect(
      otherLearnerPage.getByText(start.toISOString(), { exact: false }),
    ).toBeVisible();
    await expect(
      otherLearnerPage.getByRole("button", { name: /book|buy|reserve/i }),
    ).toHaveCount(0);

    const noZonePage = await noZone.newPage();
    await noZonePage.goto("/");
    await noZonePage.getByLabel("Your starting point").selectOption("explorer");
    await noZonePage
      .getByLabel("What would you like to do?")
      .selectOption("everyday");
    await noZonePage
      .getByLabel("I'll use invented or sample information")
      .check();
    await noZonePage
      .getByRole("button", { name: "Start my learning path" })
      .click();
    await noZonePage.goto("/availability");
    await expect(
      noZonePage.getByText("Choose a valid time zone"),
    ).toBeVisible();
    await expect(
      noZonePage.getByText("No sample windows can be shown right now"),
    ).toBeVisible();
    await noZonePage.getByRole("link", { name: "profile form" }).click();
    await expect(noZonePage.getByLabel("Time zone (optional)")).toBeVisible();

    // Retained reciprocal rows can predate the cross-role integrity check.
    // Leave enough minutes so the browser proves overlap exclusion itself.
    await pool.query(
      "UPDATE expert_registry SET capacity_minutes=240 WHERE id IN ($1,$2)",
      [primaryRecordId, backupRecordId],
    );
    const conflictingSlotId = randomUUID();
    await pool.query(
      `INSERT INTO expert_availability_slots
       (id,expert_registry_id,starts_at,ends_at,created_by)
       VALUES($1,$2,$3,$4,$5)`,
      [conflictingSlotId, backupRecordId, start, end, operatorId],
    );
    await page.reload();
    await expect(
      page.getByText(start.toISOString(), { exact: false }),
    ).toHaveCount(0);
    await expect(
      page.getByText(fallStart.toISOString(), { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("sample window, not bookable")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: /book|buy|reserve/i }),
    ).toHaveCount(0);
    expect(await slots.retire(operatorToken, conflictingSlotId)).toBe(true);
    await page.reload();
    await expect(
      page.getByText(start.toISOString(), { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("sample window, not bookable")).toHaveCount(2);

    expect(await slots.retire(coachToken, slotId!)).toBe(false);
    expect(await slots.retire(operatorToken, slotId!)).toBe(true);
    expect(await slots.retire(operatorToken, fallSlotId!)).toBe(true);
    await page.reload();
    await expect(
      page.getByText("No sample windows can be shown right now"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Continue shared learning" }),
    ).toBeVisible();
    await technicalPage.reload();
    await expect(
      technicalPage.getByText("No sample windows can be shown right now"),
    ).toBeVisible();
    await otherLearnerPage.reload();
    await expect(
      otherLearnerPage.getByText("No sample windows can be shown right now"),
    ).toBeVisible();
  } finally {
    await pool.query("DELETE FROM expert_registry WHERE id IN ($1,$2)", [
      primaryRecordId,
      backupRecordId,
    ]);
    await pool.query("DELETE FROM principals WHERE id IN ($1,$2,$3,$4)", [
      adminId,
      operatorId,
      coachId,
      backupId,
    ]);
    await outsider.close();
    await technical.close();
    await otherLearner.close();
    await noZone.close();
  }
});
