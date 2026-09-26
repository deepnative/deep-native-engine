import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

async function onboard(page: Page, specialty: "security" | "analysis") {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("technical");
  await page
    .getByLabel("What would you like to do?")
    .selectOption(specialty === "security" ? "build" : "work");
  await page
    .getByRole("group", { name: "IT specialties (optional)" })
    .getByLabel(
      specialty === "security" ? "Cybersecurity" : "Business analysis",
    )
    .check();
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
  await expect(
    page.getByRole("region", { name: "Your starter plan" }),
  ).toBeVisible();
}

async function member(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (item) => item.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const tokenHash = createHash("sha256").update(cookie!.value).digest("hex");
  const result = await pool.query<{
    id: string;
    background: string;
    goal: string;
    it_roles: string[];
  }>("SELECT id,background,goal,it_roles FROM learners WHERE token_hash=$1", [
    tokenHash,
  ]);
  expect(result.rowCount).toBe(1);
  return result.rows[0]!;
}

async function complete(page: Page, instruction: string) {
  await page.getByLabel("Your instruction to AI").fill(instruction);
  await page
    .getByLabel("How will you check the result?")
    .fill(
      "Compare each suggestion with the invented brief and mark unsupported details.",
    );
  await page.getByLabel("I checked the context").check();
  await page.getByRole("button", { name: "Complete exercise" }).click();
  await expect(
    page.getByText("Exercise completed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No AI or qualified reviewer has assessed it."),
  ).toBeVisible();
}

test("[F-BUILD-01-A] cybersecurity learner uses common local foundation without specialist purchase", async ({
  page,
  context,
}) => {
  await requiredCheck(1, async () => {
    await onboard(page, "security");
    const owner = await member(context);
    expect(owner).toMatchObject({
      background: "technical",
      goal: "build",
      it_roles: ["security"],
    });
    await page.getByRole("link", { name: "Open lesson" }).click();
    await expect(
      page.getByRole("heading", { name: "Review a sign-up flow" }),
    ).toBeVisible();
    await complete(
      page,
      "Using the invented sign-up flow, suggest invalid-input and privacy checks without using real accounts.",
    );
    const saved = await pool.query<{
      lesson_id: string;
      lesson_version: number;
      completed_at: Date | null;
    }>(
      "SELECT lesson_id,lesson_version,completed_at FROM exercises WHERE learner_id=$1",
      [owner.id],
    );
    expect(saved.rows).toMatchObject([
      { lesson_id: "clear-instructions", lesson_version: 1 },
    ]);
    expect(saved.rows[0]!.completed_at).not.toBeNull();
    const paid = await pool.query(
      "SELECT id FROM synthetic_entitlement_grants WHERE member_id=$1",
      [owner.id],
    );
    expect(paid.rowCount).toBe(0);
    await page.goto("/readiness/tracks");
    await expect(
      page.getByRole("listitem").filter({ hasText: "Cybersecurity" }),
    ).toContainText("in preparation");
    await expect(
      page.getByRole("button", { name: /book|buy|purchase/i }),
    ).toHaveCount(0);
  });
});

test("[F-BUILD-01-B] business-analysis learner completes a noncoding local exercise", async ({
  page,
  context,
}) => {
  await requiredCheck(1, async () => {
    await onboard(page, "analysis");
    const owner = await member(context);
    expect(owner).toMatchObject({
      background: "technical",
      goal: "work",
      it_roles: ["analysis"],
    });
    await page.getByRole("link", { name: "Open lesson" }).click();
    await expect(
      page.getByRole("heading", { name: "Turn meeting notes into next steps" }),
    ).toBeVisible();
    await expect(page.getByText("Sam will write the checklist")).toBeVisible();
    await complete(
      page,
      "Turn the invented meeting notes into a plain-language action list with owners, dates, and missing details.",
    );
    await page.reload();
    await expect(
      page.getByText("Exercise completed", { exact: true }),
    ).toBeVisible();
    const saved = await pool.query<{
      goal_at_start: string;
      lesson_id: string;
      lesson_version: number;
      completed_at: Date | null;
    }>(
      "SELECT goal_at_start,lesson_id,lesson_version,completed_at FROM exercises WHERE learner_id=$1",
      [owner.id],
    );
    expect(saved.rows).toMatchObject([
      {
        goal_at_start: "work",
        lesson_id: "clear-instructions",
        lesson_version: 1,
      },
    ]);
    expect(saved.rows[0]!.completed_at).not.toBeNull();
    const paid = await pool.query(
      "SELECT id FROM synthetic_entitlement_grants WHERE member_id=$1",
      [owner.id],
    );
    expect(paid.rowCount).toBe(0);
    await page.goto("/readiness/tracks");
    await expect(
      page.getByRole("listitem").filter({ hasText: "Business analysis" }),
    ).toContainText("in preparation");
    await expect(
      page.getByRole("button", { name: /book|buy|purchase/i }),
    ).toHaveCount(0);
  });
});

test("[F-BUILD-01-C] uncovered tailored-review request is refused without paid access", async ({
  page,
  context,
}) => {
  await requiredCheck(1, async () => {
    await onboard(page, "analysis");
    const owner = await member(context);
    await page
      .getByRole("link", { name: "Check tailored-review availability" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Check tailored-review availability" }),
    ).toBeVisible();
    await page.getByLabel("Review domain").selectOption("education");
    const [response] = await Promise.all([
      page.waitForResponse(
        (reply) =>
          reply.url().endsWith("/tailored-review") &&
          reply.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Check tailored review" }).click(),
    ]);
    expect(response.status()).toBe(409);
    await expect(
      page.getByRole("heading", { name: "Tailored review is unavailable" }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toContainText(
      "No request was accepted or saved",
    );
    await expect(page.getByRole("status")).toContainText(
      "Qualified reviewer coverage not verified",
    );
    await expect(page.getByRole("status")).toContainText(
      "Deliverable service capacity not verified",
    );
    await expect(
      page.getByRole("button", { name: /book|buy|purchase|pay/i }),
    ).toHaveCount(0);
    const paid = await pool.query(
      "SELECT id FROM synthetic_entitlement_grants WHERE member_id=$1",
      [owner.id],
    );
    const events = await pool.query(
      "SELECT id FROM synthetic_entitlement_events WHERE member_id=$1",
      [owner.id],
    );
    expect(paid.rowCount).toBe(0);
    expect(events.rowCount).toBe(0);
    await page
      .getByRole("link", { name: "Return to your learning path" })
      .click();
    await expect(page).toHaveURL(/\/learn$/);
  });
});

test("[F-BUILD-01-D] demo reviewer roster entry does not change live service readiness", async ({
  page,
  context,
}) => {
  const recordId = randomUUID();
  try {
    await requiredCheck(1, async () => {
      const staffId = await authorizationStore(pool).provisionStaff(
        randomBytes(32).toString("hex"),
        "reviewer",
        new Date(Date.now() + 86_400_000),
      );
      await pool.query(
        `INSERT INTO expert_registry(
           id,staff_id,staff_role,domain,service_type,starts_at,ends_at,
           loaded_cost_cents,capacity_minutes,committed_minutes,
           qualification_ref,agreement_ref,conflict_review_ref
         ) VALUES($1,$2,'reviewer','education','formal-review',
           CURRENT_TIMESTAMP-INTERVAL '1 day',CURRENT_TIMESTAMP+INTERVAL '1 day',
           10000,90,0,'invented demo qualification','','')`,
        [recordId, staffId],
      );
      const record = await pool.query<{
        verified_by: string | null;
        verified_at: Date | null;
        backup_staff_id: string | null;
        capacity_minutes: number;
      }>(
        `SELECT verified_by,verified_at,backup_staff_id,capacity_minutes
         FROM expert_registry WHERE id=$1`,
        [recordId],
      );
      expect(record.rows).toEqual([
        {
          verified_by: null,
          verified_at: null,
          backup_staff_id: null,
          capacity_minutes: 90,
        },
      ]);

      await onboard(page, "analysis");
      const owner = await member(context);
      await page.goto("/readiness/tracks");
      const service = page
        .getByRole("listitem")
        .filter({ hasText: "Education · formal-review" });
      await expect(service).toContainText("in preparation");
      await expect(service).toContainText(
        "Qualified reviewer coverage not verified",
      );
      await expect(service).toContainText(
        "Deliverable service capacity not verified",
      );
      await expect(page.getByText("invented demo qualification")).toHaveCount(
        0,
      );
      await expect(
        page.getByRole("button", { name: /book|buy|purchase/i }),
      ).toHaveCount(0);
      const paid = await pool.query(
        "SELECT id FROM synthetic_entitlement_grants WHERE member_id=$1",
        [owner.id],
      );
      expect(paid.rowCount).toBe(0);
    });
  } finally {
    await pool.query("DELETE FROM expert_registry WHERE id=$1", [recordId]);
  }
});
