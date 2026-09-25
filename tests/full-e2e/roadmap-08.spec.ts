import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

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
