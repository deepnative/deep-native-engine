import { randomUUID } from "node:crypto";
import { afterAll, afterEach, expect, it } from "vitest";
import { PROGRAM_DIGEST } from "../../src/program-values.ts";
import { exactMetrics } from "../../src/metrics.ts";
import {
  dropDeferredProgramFixtures,
  programEnrollmentFixture,
} from "../support/program-enrollment-recovery-server.ts";

// #121 PROGWD-01..04: a dated withdrawal from the program term, distinct from
// account deletion, against real PostgreSQL. Each test owns its database.
afterEach(() => dropDeferredProgramFixtures());
afterAll(() => dropDeferredProgramFixtures());

const intent = {
  programVersion: 1,
  termVersion: 1,
  revision: 2,
  digest: PROGRAM_DIGEST,
};
async function open() {
  const f = await programEnrollmentFixture(undefined, { deferDrop: true });
  await f.publish();
  const admin = await f.staff("platform_admin");
  expect(
    (await f.programs.change(admin.token, "open", 1, PROGRAM_DIGEST)).kind,
  ).toBe("ready");
  return { ...f, admin };
}
async function enrolled(f: Awaited<ReturnType<typeof open>>) {
  const member = await f.member();
  const receipt = await f.programs.enroll(member.token, randomUUID(), intent);
  if (receipt.kind !== "ready") throw Error("Missing invented enrollment");
  return { ...member, enrollmentId: receipt.value.id };
}

it("PROGWD-01 withdraws once with a retained date and keeps the receipt, without reopening the seat", async () => {
  const f = await open();
  try {
    const m = await enrolled(f);
    const before = await f.programs.overview();
    const first = await f.programs.withdraw(m.token, m.enrollmentId);
    expect(first).toMatchObject({
      kind: "ready",
      value: { id: m.enrollmentId, withdrawnAt: expect.any(String) },
    });
    const again = await f.programs.withdraw(m.token, m.enrollmentId);
    expect(again).toEqual(first);
    expect(await f.programs.mine(m.token)).toEqual(first);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM local_program_withdrawals WHERE enrollment_id=$1",
          [m.enrollmentId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(await f.programs.overview()).toMatchObject({
      kind: "ready",
      value: {
        remaining: before.kind === "ready" ? before.value.remaining : -1,
      },
    });
    // It can't enroll again in this term.
    expect(
      await f.programs.enroll(m.token, randomUUID(), intent),
    ).toMatchObject({
      kind: "ready",
      value: { withdrawnAt: expect.any(String) },
    });
  } finally {
    await f.close();
  }
});

it("PROGWD-02 denies another member's enrollment and keeps database guards", async () => {
  const f = await open();
  try {
    const m = await enrolled(f);
    const other = await enrolled(f);
    expect(await f.programs.withdraw(other.token, m.enrollmentId)).toEqual({
      kind: "denied",
    });
    expect(await f.programs.withdraw(f.admin.token, m.enrollmentId)).toEqual({
      kind: "denied",
    });
    await expect(
      f.pool.query(
        "INSERT INTO local_program_withdrawals(enrollment_id,workspace_id) VALUES($1,$2)",
        [m.enrollmentId, other.id],
      ),
    ).rejects.toThrow("requires its own enrollment");
    await f.programs.withdraw(m.token, m.enrollmentId);
    await expect(
      f.pool.query(
        "UPDATE local_program_withdrawals SET withdrawn_at=clock_timestamp() WHERE enrollment_id=$1",
        [m.enrollmentId],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      f.pool.query(
        "DELETE FROM local_program_withdrawals WHERE enrollment_id=$1",
        [m.enrollmentId],
      ),
    ).rejects.toThrow("retained until account erasure");
  } finally {
    await f.close();
  }
});

it("PROGWD-03 account deletion is separate: it removes the withdrawal and the enrollment", async () => {
  const f = await open();
  try {
    const m = await enrolled(f);
    await f.programs.withdraw(m.token, m.enrollmentId);
    await f.members.remove(m.id);
    for (const table of [
      "local_program_withdrawals",
      "local_program_enrollments",
    ])
      expect(
        (
          await f.pool.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1`, [
            m.id,
          ])
        ).rowCount,
      ).toBe(0);
  } finally {
    await f.close();
  }
});

it("PROGWD-04 the metrics count enrolled and withdrawn members and never deleted ones", async () => {
  const f = await open();
  try {
    const operator = await f.staff("operator");
    const people = [];
    for (let i = 0; i < 6; i++) people.push(await enrolled(f));
    for (const m of people.slice(0, 2))
      await f.programs.withdraw(m.token, m.enrollmentId);
    await f.members.remove(people[0]!.id);
    const row = await exactMetrics(f.pool, operator.token);
    expect(row).toMatchObject({
      members: 5,
      enrolledInProgram: 5,
      withdrewFromProgram: 1,
    });
  } finally {
    await f.close();
  }
});
