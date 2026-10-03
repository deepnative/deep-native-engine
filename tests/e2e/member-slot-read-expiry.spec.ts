import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { authorizationStore } from "../../src/authorization.ts";
import { availabilityStore } from "../../src/availability.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { hash } from "../../src/store.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
test.afterAll(async () => pool.end());
for (const [index, background] of [
  "explorer",
  "professional",
  "technical",
].entries()) {
  test(`[L${136 + index}] ${background} withdraws a sample hold and recovers without private receipt data after session expiry during a lock wait`, async ({
    page,
    context,
  }) => {
    const staffIds: string[] = [];
    const registry = randomUUID(),
      backupRegistry = randomUUID();
    let memberId: string | undefined;
    const holder = await pool.connect();
    try {
      await page.goto("/");
      await page.getByLabel("Your starting point").selectOption(background);
      await page
        .getByLabel("What would you like to do?")
        .selectOption("everyday");
      await page.getByLabel("Time zone (optional)").fill("America/Toronto");
      await page.getByLabel("I'll use invented or sample information").check();
      await page
        .getByRole("button", { name: "Start my learning path" })
        .click();
      const token = (await context.cookies()).find(
        (cookie) => cookie.name === COOKIE,
      )!.value;
      memberId = (
        await pool.query("SELECT id FROM learners WHERE token_hash=$1", [
          hash(token),
        ])
      ).rows[0].id;
      expect(
        (
          await pool.query("SELECT kind FROM principals WHERE id=$1", [
            memberId,
          ])
        ).rows,
      ).toEqual([{ kind: "member" }]);
      await page.goto("/availability");
      await expect(
        page.getByRole("button", { name: "Reserve sample hold" }),
      ).toHaveCount(0);
      expect(
        (
          await pool.query(
            "SELECT id FROM synthetic_entitlement_grants WHERE member_id=$1",
            [memberId],
          )
        ).rows,
      ).toEqual([]);

      const auth = authorizationStore(pool),
        end = new Date(Date.now() + 10 * 86400000);
      const admin = await auth.provisionStaff(
        randomBytes(32).toString("hex"),
        "platform_admin",
        end,
      );
      staffIds.push(admin);
      const operatorToken = randomBytes(32).toString("hex");
      const operator = await auth.provisionStaff(
        operatorToken,
        "operator",
        end,
      );
      staffIds.push(operator);
      const coach = await auth.provisionStaff(
        randomBytes(32).toString("hex"),
        "coach",
        end,
      );
      staffIds.push(coach);
      const backup = await auth.provisionStaff(
        randomBytes(32).toString("hex"),
        "coach",
        end,
      );
      staffIds.push(backup);
      const startsAt = new Date(Date.now() + 3 * 86400000),
        endsAt = new Date(+startsAt + 3600000);
      await pool.query(
        `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,loaded_cost_cents,capacity_minutes,backup_staff_id,qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
        VALUES ($1,$2,'coach','education','coaching',$3,$4,12000,60,$5,'invented qualification','invented agreement','invented conflict',$6,clock_timestamp()-interval '1 minute'),
        ($7,$5,'coach','education','coaching',$3,$4,12000,60,$2,'invented qualification','invented agreement','invented conflict',$6,clock_timestamp()-interval '1 minute')`,
        [
          registry,
          coach,
          new Date(Date.now() - 3600000),
          new Date(+endsAt + 3600000),
          backup,
          admin,
          backupRegistry,
        ],
      );
      const slot = await availabilityStore(pool).create(
        operatorToken,
        registry,
        startsAt,
        endsAt,
      );
      expect(slot).toBeTruthy();
      const grant = await syntheticLedger(pool).grant(
        memberId!,
        "coach_minutes",
        60,
        randomUUID(),
        {
          startsAt: new Date(Date.now() - 3600000).toISOString(),
          expiresAt: end.toISOString(),
        },
      );
      await page.reload();
      const reserve = page.getByRole("button", { name: "Reserve sample hold" });
      await reserve.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByText("held", { exact: true })).toBeVisible();
      await expect(
        page.getByText("SAMPLE HOLD — NOT A BOOKING", { exact: true }),
      ).toBeVisible();
      const receiptPath = new URL(page.url()).pathname;
      const requestId = receiptPath.split("/").at(-1)!;
      const withdraw = page.getByRole("button", {
        name: "Withdraw sample hold",
      });
      await withdraw.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByText("released", { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByText("released", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Withdraw sample hold" }),
      ).toHaveCount(0);
      expect(
        (
          await pool.query(
            "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
            [grant],
          )
        ).rows,
      ).toEqual([{ available: 60, reserved: 0 }]);
      expect(
        (
          await pool.query(
            "SELECT id FROM synthetic_entitlement_events WHERE member_id=$1 AND operation='release'",
            [memberId],
          )
        ).rowCount,
      ).toBe(1);

      // Real lock wait after middleware has recognized the active member. The
      // read's DB-derived lifetime expires without a receipt/grant projection.
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
        [memberId],
      );
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      await holder.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
        memberId,
      ]);
      const loading = page.goto(receiptPath);
      await expect
        .poll(
          async () =>
            Number(
              (
                await pool.query(
                  `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
        AND $1::integer=ANY(pg_blocking_pids(pid)) AND position('FOR SHARE OF p' in query)>0`,
                  [pid],
                )
              ).rows[0].count,
            ),
          { timeout: 1500 },
        )
        .toBe(1);
      expect((await loading)!.status()).toBe(404);
      await expect(
        page.getByRole("heading", { name: "Inspect your sample hold" }),
      ).toBeVisible();
      for (const marker of [
        requestId,
        grant,
        slot!,
        startsAt.toISOString(),
        "Reserved test quantity",
        "Your sample hold receipt",
      ])
        await expect(page.locator("body")).not.toContainText(marker);
      await holder.query("ROLLBACK");
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
                [memberId],
              )
            ).rows[0].expired,
        )
        .toBe(true);
      expect(
        (
          await pool.query(
            "SELECT id FROM synthetic_entitlement_events WHERE member_id=$1 AND operation='release'",
            [memberId],
          )
        ).rowCount,
      ).toBe(1);
      const recover = page.getByRole("link", {
        name: "Inspect your current sample receipts",
      });
      await recover.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL("http://127.0.0.1:4317/");
      await expect(
        page.getByRole("button", { name: "Start my learning path" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      if (memberId)
        await pool.query("DELETE FROM principals WHERE id=$1", [memberId]);
      await pool.query("DELETE FROM expert_registry WHERE id IN ($1,$2)", [
        registry,
        backupRegistry,
      ]);
      await pool.query("DELETE FROM principals WHERE id=ANY($1::uuid[])", [
        staffIds,
      ]);
    }
  });
}
