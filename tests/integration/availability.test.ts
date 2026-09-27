import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { migrate } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { availabilityStore } from "../../src/availability.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const slots = availabilityStore(pool);
const future = () => new Date(Date.now() + 3 * 86_400_000);

beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => pool.end());

async function staff(role: "coach" | "operator" | "platform_admin") {
  const token = randomBytes(32).toString("hex");
  const id = await authorizationStore(pool).provisionStaff(
    token,
    role,
    new Date(Date.now() + 10 * 86_400_000),
  );
  return { token, id };
}

it("only exposes explicit future slots backed by current verified primary and backup coverage", async () => {
  const operator = await staff("operator");
  const admin = await staff("platform_admin");
  const coach = await staff("coach");
  const backup = await staff("coach");
  const coverageId = randomUUID();
  const backupId = randomUUID();
  const start = future();
  const end = new Date(start.getTime() + 60 * 60_000);
  await pool.query(
    `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,
      starts_at,ends_at,loaded_cost_cents,capacity_minutes,backup_staff_id,
      qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
     VALUES ($1,$2,'coach','education','coaching',$3,$4,12000,120,$5,
       'synthetic qualification','synthetic agreement','synthetic conflict review',$6,CURRENT_TIMESTAMP),
       ($7,$5,'coach','education','coaching',$3,$4,12000,120,$2,
       'synthetic qualification','synthetic agreement','synthetic conflict review',$6,CURRENT_TIMESTAMP)`,
    [
      coverageId,
      coach.id,
      new Date(Date.now() - 3600_000),
      new Date(end.getTime() + 3 * 3600_000),
      backup.id,
      admin.id,
      backupId,
    ],
  );
  const slotId = await slots.create(operator.token, coverageId, start, end);
  expect(slotId).toBeTruthy();
  expect(await slots.list()).toMatchObject([
    { id: slotId, domain: "education", serviceType: "coaching" },
  ]);
  const next = new Date(end.getTime());
  const overlapping = new Date(end.getTime() + 30 * 60_000);
  const contenders = await Promise.all([
    slots.create(
      operator.token,
      coverageId,
      next,
      new Date(next.getTime() + 3600_000),
    ),
    slots.create(
      operator.token,
      coverageId,
      overlapping,
      new Date(overlapping.getTime() + 3600_000),
    ),
  ]);
  expect(contenders.filter(Boolean)).toHaveLength(1);
  const secondId = contenders.find(Boolean)!;
  expect(await slots.list()).toHaveLength(2);
  await pool.query(
    "UPDATE expert_registry SET capacity_minutes=60 WHERE id=$1",
    [backupId],
  );
  expect(await slots.list()).toEqual([]);
  await pool.query(
    "UPDATE expert_registry SET capacity_minutes=120 WHERE id=$1",
    [backupId],
  );
  const thirdStart = new Date(end.getTime() + 2 * 3600_000);
  const thirdEnd = new Date(thirdStart.getTime() + 3600_000);
  expect(
    await slots.create(operator.token, coverageId, thirdStart, thirdEnd),
  ).toBeNull();
  expect(await slots.retire(coach.token, secondId)).toBe(false);
  expect(await slots.retire(operator.token, secondId)).toBe(true);
  expect(await slots.retire(operator.token, secondId)).toBe(false);
  expect(
    (
      await pool.query(
        "SELECT version,retired_at FROM expert_availability_slots WHERE id=$1",
        [secondId],
      )
    ).rows[0],
  ).toMatchObject({ version: 2, retired_at: expect.any(Date) });
  const thirdId = await slots.create(
    operator.token,
    coverageId,
    thirdStart,
    thirdEnd,
  );
  expect(thirdId).toBeTruthy();
  expect(await slots.retire(operator.token, thirdId!)).toBe(true);
  await pool.query(
    "UPDATE expert_registry SET committed_minutes=70 WHERE id=$1",
    [coverageId],
  );
  expect(await slots.list()).toEqual([]);
  await pool.query(
    "UPDATE expert_registry SET committed_minutes=0 WHERE id=$1",
    [coverageId],
  );
  await pool.query("UPDATE expert_registry SET ends_at=$1 WHERE id=$2", [
    new Date(start.getTime() - 60_000),
    coverageId,
  ]);
  expect(await slots.list()).toEqual([]);
  await pool.query("UPDATE expert_registry SET ends_at=$1 WHERE id=$2", [
    new Date(end.getTime() + 3 * 3600_000),
    coverageId,
  ]);
  await pool.query(
    "UPDATE expert_registry SET retired_at=CURRENT_TIMESTAMP WHERE id=$1",
    [backupId],
  );
  expect(await slots.list()).toEqual([]);
  await pool.query("UPDATE expert_registry SET retired_at=NULL WHERE id=$1", [
    backupId,
  ]);
  expect(await slots.list()).toHaveLength(1);
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [backup.id],
  );
  expect(await slots.list()).toEqual([]);
  await pool.query("UPDATE principals SET revoked_at=NULL WHERE id=$1", [
    backup.id,
  ]);
  expect(await slots.list()).toHaveLength(1);
  await pool.query(
    "UPDATE expert_registry SET retired_at=CURRENT_TIMESTAMP WHERE id=$1",
    [coverageId],
  );
  expect(await slots.list()).toEqual([]);
});

it("denies staff-like claims and concurrent overlap while preserving read-only history", async () => {
  const operator = await staff("operator");
  const coach = await staff("coach");
  const start = future();
  const end = new Date(start.getTime() + 60 * 60_000);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,
      starts_at,ends_at,loaded_cost_cents,capacity_minutes)
     VALUES($1,$2,'coach','education','coaching',$3,$4,12000,120)`,
    [
      id,
      coach.id,
      new Date(Date.now() - 3600_000),
      new Date(end.getTime() + 3600_000),
    ],
  );
  expect(await slots.create(coach.token, id, start, end)).toBeNull();
  expect(await slots.create(operator.token, id, start, end)).toBeNull();
  expect(await slots.list()).toEqual([]);
});
