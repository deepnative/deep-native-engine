import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import {
  manualObservationStore,
  type ManualObservationInput,
} from "../../src/manual-observations.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const observations = manualObservationStore(pool);
const token = () => randomBytes(32).toString("hex");
const expires = () => new Date(Date.now() + 86_400_000);

async function member(background: "technical" | "professional" | "explorer") {
  const value = token();
  await db.create(value, {
    background,
    goal: background === "explorer" ? "everyday" : "work",
  });
  const session = await db.session(value);
  expect(session.kind).toBe("active");
  return {
    token: value,
    id: session.kind === "active" ? session.learner.id : "",
  };
}

beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(async () => pool.end());

it("records the same synthetic-only, unverified state for all learning backgrounds without granting access", async () => {
  const admin = token();
  const actorId = await authorizationStore(pool).provisionStaff(
    admin,
    "platform_admin",
    expires(),
  );
  const people = await Promise.all([
    member("technical"),
    member("professional"),
    member("explorer"),
  ]);
  for (const [index, person] of people.entries()) {
    const input: ManualObservationInput = {
      memberId: person.id,
      idempotencyKey: randomUUID(),
      evidenceReference: `SYN-INVENTED-${index}`,
      amountCents: 1000 + index,
    };
    const first = await observations.record(admin, input);
    expect(first).toMatchObject({
      kind: "created",
      observation: {
        ...input,
        actorId,
        status: "unverified_manual",
      },
    });
    expect(await observations.record(admin, input)).toEqual({
      kind: "replayed",
      observation: first.kind === "created" ? first.observation : undefined,
    });
    expect(
      await observations.record(admin, { ...input, amountCents: 5000 }),
    ).toEqual({ kind: "conflict" });
    expect(await observations.list(person.token)).toBeNull();
  }
  const rows = await observations.list(admin);
  expect(rows).toHaveLength(3);
  expect(rows?.every((row) => row.status === "unverified_manual")).toBe(true);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM synthetic_entitlement_grants WHERE member_id=ANY($1::uuid[])",
        [people.map((person) => person.id)],
      )
    ).rowCount,
  ).toBe(0);
});

it("handles concurrent replay and denies missing, revoked, expired and other-role actors", async () => {
  const admin = token();
  const reviewer = token();
  const auth = authorizationStore(pool);
  const adminId = await auth.provisionStaff(admin, "platform_admin", expires());
  await auth.provisionStaff(reviewer, "reviewer", expires());
  const person = await member("explorer");
  const input: ManualObservationInput = {
    memberId: person.id,
    idempotencyKey: randomUUID(),
    evidenceReference: "SYN-CONCURRENT-01",
    amountCents: 2500,
  };
  expect(await observations.list(reviewer)).toBeNull();
  expect(await observations.list("anonymous")).toBeNull();
  for (const denied of [reviewer, person.token, "anonymous"]) {
    expect(await observations.record(denied, input)).toEqual({
      kind: "denied",
    });
  }
  expect(
    await observations.record(admin, { ...input, memberId: randomUUID() }),
  ).toEqual({ kind: "member_missing" });
  expect(
    await observations.record(admin, { ...input, amountCents: 0 }),
  ).toEqual({ kind: "invalid" });
  const concurrent = await Promise.all([
    observations.record(admin, input),
    observations.record(admin, input),
  ]);
  expect(concurrent.map((result) => result.kind).sort()).toEqual([
    "created",
    "replayed",
  ]);
  expect(await observations.list(admin)).toHaveLength(1);
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [adminId],
  );
  expect(await observations.list(admin)).toBeNull();
  expect(
    await observations.record(admin, {
      ...input,
      idempotencyKey: randomUUID(),
    }),
  ).toEqual({ kind: "denied" });
  await pool.query(
    "UPDATE principals SET revoked_at=NULL,expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1",
    [adminId],
  );
  expect(await observations.list(admin)).toBeNull();
  expect(
    await observations.record(admin, {
      ...input,
      idempotencyKey: randomUUID(),
    }),
  ).toEqual({ kind: "denied" });
});

it("keeps the history immutable while retaining an actor ID and cascades on local member deletion", async () => {
  const admin = token();
  const adminId = await authorizationStore(pool).provisionStaff(
    admin,
    "platform_admin",
    expires(),
  );
  const person = await member("professional");
  const input: ManualObservationInput = {
    memberId: person.id,
    idempotencyKey: randomUUID(),
    evidenceReference: "SYN-DELETE-01",
    amountCents: 4200,
  };
  const result = await observations.record(admin, input);
  expect(result.kind).toBe("created");
  const id = result.kind === "created" ? result.observation.id : "";
  await expect(
    pool.query(
      "UPDATE synthetic_manual_observations SET amount_cents=1 WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("DELETE FROM synthetic_manual_observations WHERE id=$1", [id]),
  ).rejects.toThrow("immutable");
  await pool.query("DELETE FROM principals WHERE id=$1", [adminId]);
  expect(
    (
      await pool.query(
        "SELECT actor_id FROM synthetic_manual_observations WHERE id=$1",
        [id],
      )
    ).rows[0]?.actor_id,
  ).toBe(adminId);
  await pool.query("DELETE FROM learners WHERE id=$1", [person.id]);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM synthetic_manual_observations WHERE id=$1",
        [id],
      )
    ).rowCount,
  ).toBe(0);
});
