import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { authorizationStore } from "../../src/authorization.ts";
import {
  supportLedgerOnConnection,
  syntheticLedger,
  syntheticLedgerOnConnection,
} from "../../src/ledger.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  support = supportRequestStore(pool),
  ledger = syntheticLedger(pool),
  auth = authorizationStore(pool);
beforeAll(async () => {
  await migrate(pool);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
});
afterAll(async () => pool.end());
async function fixture(ceiling: number) {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "professional", goal: "work" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  const memberId = session.learner.id;
  const intake = await support.create(token, {
    idempotencyKey: randomUUID(),
    subject: "Invented effort",
    body: "Private invented support sample",
  });
  if (!("receipt" in intake))
    throw Error("Invented support request unavailable");
  const requestId = intake.receipt.requestId;
  const grantId = await ledger.grant(
    memberId,
    "support_minutes",
    ceiling,
    randomUUID(),
    {
      startsAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  );
  const actorId = await auth.provisionStaff(
    randomBytes(32).toString("hex"),
    "operator",
    new Date(Date.now() + 3600000),
  );
  const adminId = await auth.provisionStaff(
    randomBytes(32).toString("hex"),
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const timeGrantId = randomUUID();
  const allocationId = randomUUID(),
    key = randomUUID(),
    client = await pool.connect();
  const reservations: string[] = [];
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO support_time_allocations(id,request_id,member_id,grant_id,ceiling,idempotency_key) VALUES($1,$2,$3,$4,$5,$6)",
      [allocationId, requestId, memberId, grantId, ceiling, key],
    );
    const boundary = supportLedgerOnConnection(client, allocationId);
    for (let ordinal = 1; ordinal <= ceiling; ordinal++) {
      const reservation = await boundary.reserve(
        memberId,
        grantId,
        1,
        `support-time:${allocationId}:unit:${ordinal}:reserve`,
      );
      await client.query(
        "INSERT INTO support_time_units(allocation_id,ordinal,reservation_id) VALUES($1,$2,$3)",
        [allocationId, ordinal, reservation],
      );
      reservations.push(reservation);
    }
    await client.query(
      "INSERT INTO support_time_grants(id,allocation_id,request_id,staff_id,staff_role,starts_at,expires_at,granted_by,idempotency_key) VALUES($1,$2,$3,$4,'operator',$5,$6,$7,$8)",
      [
        timeGrantId,
        allocationId,
        requestId,
        actorId,
        new Date(Date.now() - 60000),
        new Date(Date.now() + 3600000),
        adminId,
        randomUUID(),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return {
    token,
    memberId,
    requestId,
    grantId,
    allocationId,
    actorId,
    timeGrantId,
    reservations,
  };
}
async function begin(f: Awaited<ReturnType<typeof fixture>>) {
  await pool.query(
    "UPDATE support_time_allocations SET state='begun',begun_by=$2,begin_key=$3,begun_grant_id=$4,begun_at=clock_timestamp() WHERE id=$1",
    [f.allocationId, f.actorId, randomUUID(), f.timeGrantId],
  );
}
it.each([
  [20, 10, 5],
  [120, 110, 5],
  [1, 1, 0],
])(
  "atomically settles %i held units against actual support/preparation intervals (%i/%i), preserving unused units",
  async (ceiling, delivered, preparation) => {
    const started = performance.now(),
      f = await fixture(ceiling),
      client = await pool.connect();
    expect(
      (
        await pool.query(
          "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
          [f.grantId],
        )
      ).rows,
    ).toEqual([{ available: 0, reserved: ceiling, consumed: 0 }]);
    await begin(f);
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(44154,hashtext($1))", [
        f.actorId,
      ]);
      const clock = (
        await client.query<{ at: Date }>("SELECT clock_timestamp() at")
      ).rows[0]!.at;
      const start = new Date(clock.getTime() - 240 * 60000),
        end = new Date(start.getTime() + delivered * 60000),
        prepEnd = preparation
          ? new Date(end.getTime() + preparation * 60000)
          : null;
      await client.query(
        "INSERT INTO support_time_entries(allocation_id,id,actor_id,idempotency_key,support_start,support_end,preparation_start,preparation_end,support_minutes,preparation_minutes,grant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          f.allocationId,
          randomUUID(),
          f.actorId,
          randomUUID(),
          start,
          end,
          preparation ? end : null,
          prepEnd,
          delivered,
          preparation,
          f.timeGrantId,
        ],
      );
      const boundary = supportLedgerOnConnection(client, f.allocationId);
      for (let i = 0; i < ceiling; i++) {
        const operation = i < delivered + preparation ? "consume" : "release";
        await boundary[operation](
          f.memberId,
          f.reservations[i]!,
          `support-time:${f.allocationId}:unit:${i + 1}:${operation}`,
        );
      }
      await client.query(
        "UPDATE support_time_allocations SET state='completed',settled_at=clock_timestamp() WHERE id=$1",
        [f.allocationId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    expect(
      (
        await pool.query(
          "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
          [f.grantId],
        )
      ).rows,
    ).toEqual([
      {
        available: ceiling - delivered - preparation,
        reserved: 0,
        consumed: delivered + preparation,
      },
    ]);
    expect(
      (
        await pool.query(
          "SELECT operation,count(*)::integer n FROM synthetic_entitlement_events WHERE grant_id=$1 GROUP BY operation",
          [f.grantId],
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        { operation: "reserve", n: ceiling },
        { operation: "consume", n: delivered + preparation },
      ]),
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM support_time_entries WHERE allocation_id=$1",
          [f.allocationId],
        )
      ).rows[0].n,
    ).toBe(1);
    await expect(
      ledger.consume(
        f.memberId,
        f.reservations[0]!,
        `support-time:${f.allocationId}:unit:1:consume`,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    await migrate(pool);
    expect(
      (
        await pool.query(
          "SELECT state FROM support_time_allocations WHERE id=$1",
          [f.allocationId],
        )
      ).rows[0].state,
    ).toBe("completed");
    expect(performance.now() - started).toBeLessThan(10000);
  },
);
it("rejects generic, formal and AI-domain settlement, and an incomplete transaction cannot orphan a support hold", async () => {
  const f = await fixture(20),
    r = f.reservations[0]!;
  await expect(
    ledger.consume(f.memberId, r, randomUUID()),
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(
    ledger.release(f.memberId, r, randomUUID()),
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(
    ledger.settleCompletion(f.memberId, r, randomUUID(), {
      reference: "synthetic:wrong-domain",
      category: "support_minutes",
      deliveredMinutes: 1,
      preparationMinutes: 0,
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await expect(
      syntheticLedgerOnConnection(client, f.allocationId).consume(
        f.memberId,
        r,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query(
      "SELECT release_synthetic_reservation_balance($1,$2,clock_timestamp(),NULL,$3)",
      [r, f.memberId, f.allocationId],
    );
    await expect(client.query("COMMIT")).rejects.toThrow(
      "Support time allocation and unit outcomes must agree",
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [f.grantId],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 20, consumed: 0 }]);
  expect(
    (
      await pool.query(
        "SELECT state FROM synthetic_entitlement_reservations WHERE id=$1",
        [r],
      )
    ).rows[0].state,
  ).toBe("reserved");
});

it("withdraws unstarted support, releases every minute once, and redacts text", async () => {
  const f = await fixture(20);
  expect(await support.withdraw(f.token, f.requestId)).toEqual({
    kind: "withdrawn",
  });
  expect(await support.withdraw(f.token, f.requestId)).toEqual({
    kind: "already-withdrawn",
  });
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [f.grantId],
      )
    ).rows,
  ).toEqual([{ available: 20, reserved: 0, consumed: 0 }]);
  expect(
    (
      await pool.query(
        "SELECT state FROM support_time_allocations WHERE id=$1",
        [f.allocationId],
      )
    ).rows,
  ).toEqual([{ state: "cancelled" }]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM synthetic_entitlement_events WHERE grant_id=$1 AND operation='release'",
        [f.grantId],
      )
    ).rows,
  ).toEqual([{ n: 20 }]);
  expect(
    (
      await pool.query(
        "SELECT subject,body FROM support_requests WHERE id=$1",
        [f.requestId],
      )
    ).rows,
  ).toEqual([{ subject: null, body: null }]);
});
it.each(["withdrawal", "grant revocation"])(
  "keeps begun support held after %s without fabricating effort",
  async (reason) => {
    const f = await fixture(20);
    await begin(f);
    if (reason === "withdrawal") {
      expect(await support.withdraw(f.token, f.requestId)).toEqual({
        kind: "withdrawn",
      });
    } else {
      await pool.query(
        "UPDATE support_time_grants SET revoked_at=clock_timestamp() WHERE id=$1",
        [f.timeGrantId],
      );
    }
    expect(
      (
        await pool.query(
          "SELECT state FROM support_time_allocations WHERE id=$1",
          [f.allocationId],
        )
      ).rows,
    ).toEqual([{ state: "needs_reconciliation" }]);
    expect(
      (
        await pool.query(
          "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
          [f.grantId],
        )
      ).rows,
    ).toEqual([{ available: 0, reserved: 20, consumed: 0 }]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM support_time_entries WHERE allocation_id=$1",
          [f.allocationId],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    await expect(
      pool.query(
        "SELECT release_synthetic_reservation_balance($1,$2,clock_timestamp(),NULL,$3)",
        [f.reservations[0], f.memberId, f.allocationId],
      ),
    ).rejects.toThrow("remains held");
  },
);
it("rejects begin using a nonexistent or revoked purpose grant, preserving the hold", async () => {
  const f = await fixture(1);
  await expect(
    pool.query(
      "UPDATE support_time_allocations SET state='begun',begun_by=$2,begin_key=$3,begun_grant_id=$4,begun_at=clock_timestamp() WHERE id=$1",
      [f.allocationId, f.actorId, randomUUID(), randomUUID()],
    ),
  ).rejects.toThrow("authority unavailable");
  await pool.query(
    "UPDATE support_time_grants SET revoked_at=clock_timestamp() WHERE id=$1",
    [f.timeGrantId],
  );
  await expect(begin(f)).rejects.toThrow("authority unavailable");
  expect(
    (
      await pool.query(
        "SELECT state FROM support_time_allocations WHERE id=$1",
        [f.allocationId],
      )
    ).rows,
  ).toEqual([{ state: "allocated" }]);
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [f.grantId],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 1, consumed: 0 }]);
});

it("erases owned held support history without refunding or damaging another member", async () => {
  const erased = await fixture(20),
    retained = await fixture(1);
  await begin(erased);
  await members.remove(erased.memberId);
  for (const table of [
    "support_time_allocations",
    "support_time_units",
    "support_time_grants",
    "support_time_entries",
    "support_time_events",
  ]) {
    const column =
      table === "support_time_allocations" ? "id" : "allocation_id";
    expect(
      (
        await pool.query(
          `SELECT count(*)::integer n FROM ${table} WHERE ${column}=$1`,
          [erased.allocationId],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  }
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM synthetic_entitlement_reservations WHERE id=ANY($1::uuid[])",
        [erased.reservations],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [retained.grantId],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 1, consumed: 0 }]);
  await begin(retained);
  expect(
    (
      await pool.query(
        "SELECT state FROM support_time_allocations WHERE id=$1",
        [retained.allocationId],
      )
    ).rows,
  ).toEqual([{ state: "begun" }]);
});
