import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

test("[F-ROADMAP-08-A] three IT specialties enter common foundation without specialist or paid admission", async ({
  page,
  context,
}) => {
  const specialties = [
    { label: "Cybersecurity", role: "security", goal: "build" },
    {
      label: "Product ownership and management",
      role: "product",
      goal: "work",
    },
    {
      label: "Project, program and delivery management",
      role: "delivery",
      goal: "work",
    },
  ] as const;
  const learnerIds: string[] = [];
  for (const [index, specialty] of specialties.entries()) {
    await requiredCheck(index + 1, async () => {
      await context.clearCookies();
      await page.goto("/");
      await page.getByLabel("Your starting point").selectOption("technical");
      await page
        .getByLabel("What would you like to do?")
        .selectOption(specialty.goal);
      await page
        .getByRole("group", { name: "IT specialties (optional)" })
        .getByLabel(specialty.label)
        .check();
      await expect(page.getByLabel(/contract|client|employer/i)).toHaveCount(0);
      await page.getByLabel("I'll use invented or sample information").check();
      await page
        .getByRole("button", { name: "Start my learning path" })
        .click();
      await expect(page).toHaveURL(/\/learn$/);
      await expect(
        page.getByRole("region", { name: "Your starter plan" }),
      ).toBeVisible();

      const cookie = (await context.cookies()).find(
        (item) => item.name === "dne_preview",
      );
      expect(cookie).toBeDefined();
      const tokenHash = createHash("sha256")
        .update(cookie!.value)
        .digest("hex");
      const learner = await pool.query<{
        id: string;
        background: string;
        goal: string;
        it_roles: string[];
        kind: string;
      }>(
        `SELECT l.id,l.background,l.goal,l.it_roles,p.kind
         FROM learners l JOIN principals p ON p.id=l.id
         WHERE l.token_hash=$1`,
        [tokenHash],
      );
      expect(learner.rowCount).toBe(1);
      const row = learner.rows[0]!;
      expect(learnerIds).not.toContain(row.id);
      learnerIds.push(row.id);
      expect(row).toMatchObject({
        background: "technical",
        goal: specialty.goal,
        it_roles: [specialty.role],
        kind: "member",
      });
      const paid = await pool.query(
        "SELECT id FROM synthetic_entitlement_grants WHERE member_id=$1",
        [row.id],
      );
      expect(paid.rowCount).toBe(0);
      await expect(
        page.getByRole("button", { name: /buy|purchase|accept offer/i }),
      ).toHaveCount(0);

      await page.getByRole("link", { name: "Open lesson" }).click();
      await expect(
        page.getByRole("heading", { name: "Give AI a clear starting point" }),
      ).toBeVisible();
      await page
        .getByLabel("Your instruction to AI")
        .fill(
          `Using invented ${specialty.role} details, draft a short practical plan.`,
        );
      await page
        .getByLabel("How will you check the result?")
        .fill(
          "Compare the result with the invented brief and verify each step.",
        );
      await page.getByLabel("I checked the context").check();
      await page.getByRole("button", { name: "Complete exercise" }).click();
      await expect(
        page.getByText("Exercise completed", { exact: true }),
      ).toBeVisible();
      const exercise = await pool.query<{
        lesson_id: string;
        lesson_version: number;
        completed_at: Date | null;
      }>(
        "SELECT lesson_id,lesson_version,completed_at FROM exercises WHERE learner_id=$1",
        [row.id],
      );
      expect(exercise.rows).toMatchObject([
        { lesson_id: "clear-instructions", lesson_version: 1 },
      ]);
      expect(exercise.rows[0]!.completed_at).not.toBeNull();
      await page.goto("/readiness/tracks");
      const readiness = page
        .getByRole("listitem")
        .filter({ hasText: specialty.label });
      await expect(readiness).toContainText("in preparation");
      await expect(
        page.getByRole("button", { name: /book|buy|purchase/i }),
      ).toHaveCount(0);
    });
  }
  expect(learnerIds).toHaveLength(3);
});

test("[F-ROADMAP-08-B] uncovered reviewer and exhausted service capacity are disclosed", async ({
  page,
}) => {
  const auth = authorizationStore(pool);
  const expiry = new Date(Date.now() + 86_400_000);
  const admin = await auth.provisionStaff(
    randomBytes(32).toString("hex"),
    "platform_admin",
    expiry,
  );
  const ids: string[] = [];
  async function pair(
    role: "reviewer" | "coach",
    service: "formal-review" | "coaching",
  ) {
    const firstStaff = await auth.provisionStaff(
      randomBytes(32).toString("hex"),
      role,
      expiry,
    );
    const backupStaff = await auth.provisionStaff(
      randomBytes(32).toString("hex"),
      role,
      expiry,
    );
    const first = randomUUID();
    const backup = randomUUID();
    ids.push(first, backup);
    for (const [id, staffId, backupId] of [
      [first, firstStaff, backupStaff],
      [backup, backupStaff, firstStaff],
    ]) {
      await pool.query(
        `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,
          starts_at,ends_at,loaded_cost_cents,capacity_minutes,committed_minutes,
          backup_staff_id,qualification_ref,agreement_ref,conflict_review_ref,
          verified_by,verified_at)
         VALUES($1,$2,$3,'education',$4,CURRENT_TIMESTAMP-INTERVAL '1 day',
          CURRENT_TIMESTAMP+INTERVAL '1 day',10000,90,0,$5,
          'invented qualification','invented agreement','invented conflict check',
          $6,CURRENT_TIMESTAMP)`,
        [id, staffId, role, service, backupId, admin],
      );
    }
    return { first, backup };
  }
  try {
    await requiredCheck(1, async () => {
      const reviewer = await pair("reviewer", "formal-review");
      await page.goto("/readiness/tracks");
      const row = page.getByRole("listitem").filter({
        hasText: "Education · formal-review",
      });
      await expect(row).toContainText("in preparation");
      await expect(row).not.toContainText(
        "Qualified reviewer coverage not verified",
      );
      await pool.query(
        "UPDATE expert_registry SET verified_by=NULL,verified_at=NULL WHERE id=ANY($1::uuid[])",
        [[reviewer.first, reviewer.backup]],
      );
      const current = await pool.query<{ verified_at: Date | null }>(
        "SELECT verified_at FROM expert_registry WHERE id=ANY($1::uuid[])",
        [[reviewer.first, reviewer.backup]],
      );
      expect(current.rows).toEqual([
        { verified_at: null },
        { verified_at: null },
      ]);
      await page.reload();
      await expect(row).toContainText(
        "Qualified reviewer coverage not verified",
      );
      await expect(row).toContainText(
        "Deliverable service capacity not verified",
      );
      await expect(page.getByText("invented qualification")).toHaveCount(0);
      await expect(page.getByText("invented agreement")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /book|buy|purchase/i }),
      ).toHaveCount(0);
    });
    await requiredCheck(2, async () => {
      const coach = await pair("coach", "coaching");
      await page.goto("/readiness/tracks");
      const row = page.getByRole("listitem").filter({
        hasText: "Education · coaching",
      });
      await expect(row).toContainText("in preparation");
      await expect(row).not.toContainText(
        "Deliverable service capacity not verified",
      );
      await pool.query(
        "UPDATE expert_registry SET committed_minutes=capacity_minutes WHERE id=$1",
        [coach.first],
      );
      const current = await pool.query<{
        capacity_minutes: number;
        committed_minutes: number;
      }>(
        "SELECT capacity_minutes,committed_minutes FROM expert_registry WHERE id=$1",
        [coach.first],
      );
      expect(current.rows).toEqual([
        { capacity_minutes: 90, committed_minutes: 90 },
      ]);
      await page.reload();
      await expect(row).toContainText(
        "Deliverable service capacity not verified",
      );
      await expect(page.getByText("invented conflict check")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /book|buy|purchase/i }),
      ).toHaveCount(0);
    });
  } finally {
    if (ids.length) {
      await pool.query("DELETE FROM expert_registry WHERE id=ANY($1::uuid[])", [
        ids,
      ]);
    }
  }
});
