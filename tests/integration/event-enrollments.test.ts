import { memberExportStore } from "../../src/member-export.ts";
import type { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { eventEnrollmentStore } from "../../src/event-enrollments.ts";
import type { EventPreview } from "../../src/events.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool);
const fixture = (): EventPreview => ({
  id: "invented-enrollment",
  version: 1,
  status: "current",
  title: "Invented rehearsal",
  description: "Invented data only",
  agenda: ["Compare an invented example"],
  goals: ["everyday"],
  domainTags: [],
  itRoles: [],
  startsAt: new Date(Date.now() + 86400000).toISOString(),
  endsAt: new Date(Date.now() + 90000000).toISOString(),
  fixtureCapacity: 1,
  localRegistration: true,
});
beforeAll(() => migrate(pool));
beforeEach(() =>
  pool.query("TRUNCATE principals,private_event_inventory CASCADE"),
);
afterAll(() => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  return { token, id: session.learner.id };
}
it("has one final-seat winner, stable own receipts, and no foreign receipt access", async () => {
  const event = fixture(),
    events = eventEnrollmentStore(pool, {
      mode: "test",
      enabled: true,
      catalog: [event],
    });
  const a = await member(),
    b = await member(),
    ids = [randomUUID(), randomUUID()];
  const results = await Promise.all(
    [a, b].map((owner, i) => events.enroll(owner.token, event.id, 1, ids[i]!)),
  );
  expect(results.map((result) => result.kind).sort()).toEqual([
    "enrolled",
    "full",
  ]);
  const winner = results.findIndex((result) => result.kind === "enrolled"),
    owners = [a, b],
    owner = owners[winner]!,
    other = owners[1 - winner]!;
  expect(await events.receipt(other.token, ids[winner]!)).toBeNull();
  expect(await events.enroll(owner.token, event.id, 1, ids[winner]!)).toEqual({
    kind: "replayed",
    receiptId: ids[winner],
  });
  expect(await events.enroll(owner.token, event.id, 1, randomUUID())).toEqual({
    kind: "already-enrolled",
    receiptId: ids[winner],
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int count FROM private_event_enrollments WHERE withdrawn_at IS NULL",
      )
    ).rows[0].count,
  ).toBe(1);
});
it("withdraws once, preserves later enrollment against stale replay and frees capacity after erasure", async () => {
  const event = fixture(),
    events = eventEnrollmentStore(pool, {
      mode: "test",
      enabled: true,
      catalog: [event],
    });
  const a = await member(),
    b = await member(),
    old = randomUUID(),
    current = randomUUID();
  expect((await events.enroll(a.token, event.id, 1, old)).kind).toBe(
    "enrolled",
  );
  expect(await events.withdraw(b.token, old)).toBe("unavailable");
  expect(await events.withdraw(a.token, old)).toBe("withdrawn");
  expect((await events.enroll(a.token, event.id, 1, current)).kind).toBe(
    "enrolled",
  );
  expect(await events.withdraw(a.token, old)).toBe("already-withdrawn");
  expect((await events.receipt(a.token, current))?.withdrawnAt).toBeNull();
  expect((await events.enroll(b.token, event.id, 1, randomUUID())).kind).toBe(
    "full",
  );
  await members.remove(a.id);
  expect((await events.enroll(b.token, event.id, 1, randomUUID())).kind).toBe(
    "enrolled",
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::int count FROM private_event_enrollments WHERE member_id=$1",
        [a.id],
      )
    ).rows[0].count,
  ).toBe(0);
});
it("keeps receipts and withdrawal when paused but refuses new, live and non-opted-in registration", async () => {
  const event = fixture(),
    events = eventEnrollmentStore(pool, {
      mode: "test",
      enabled: true,
      catalog: [event],
    }),
    owner = await member(),
    other = await member(),
    id = randomUUID();
  expect((await events.enroll(owner.token, event.id, 1, id)).kind).toBe(
    "enrolled",
  );
  const paused = eventEnrollmentStore(pool, {
    mode: "test",
    enabled: false,
    catalog: [event],
  });
  expect((await paused.receipt(owner.token, id))?.id).toBe(id);
  expect((await paused.enroll(owner.token, event.id, 1, id)).kind).toBe(
    "replayed",
  );
  expect(
    (await paused.enroll(other.token, event.id, 1, randomUUID())).kind,
  ).toBe("unavailable");
  expect(await paused.withdraw(owner.token, id)).toBe("withdrawn");
  for (const mode of ["demo", "test", "live"] as const) {
    const off = eventEnrollmentStore(pool, {
      mode,
      enabled: true,
      catalog: [{ ...event, localRegistration: false }],
    });
    expect(
      (await off.enroll(other.token, event.id, 1, randomUUID())).kind,
    ).toBe("unavailable");
  }
  const live = eventEnrollmentStore(pool, {
    mode: "live",
    enabled: true,
    catalog: [event],
  });
  expect(await live.history(owner.token)).toBeNull();
  expect(await live.receipt(owner.token, id)).toBeNull();
});
it("pins inventory, separates replacement versions and preserves withdrawn old-version history", async () => {
  const event = fixture(),
    catalog = [event],
    events = eventEnrollmentStore(pool, {
      mode: "test",
      enabled: true,
      catalog,
    }),
    owner = await member(),
    other = await member(),
    id = randomUUID();
  expect((await events.enroll(owner.token, event.id, 1, id)).kind).toBe(
    "enrolled",
  );
  expect(await events.withdraw(owner.token, id)).toBe("withdrawn");
  const changed = eventEnrollmentStore(pool, {
    mode: "test",
    enabled: true,
    catalog: [{ ...event, fixtureCapacity: 2 }],
  });
  expect(
    (await changed.enroll(other.token, event.id, 1, randomUUID())).kind,
  ).toBe("unavailable");
  catalog[0] = { ...event, status: "replaced" };
  catalog.push({ ...event, version: 2 });
  expect(
    (await events.enroll(other.token, event.id, 1, randomUUID())).kind,
  ).toBe("unavailable");
  expect(
    (await events.enroll(owner.token, event.id, 2, randomUUID())).kind,
  ).toBe("enrolled");
  expect((await events.receipt(owner.token, id))?.eventVersion).toBe(1);
  expect((await events.enroll(owner.token, event.id, 2, id)).kind).toBe(
    "conflict",
  );
});
it("does not release durable seats merely because the owner session expires", async () => {
  const event = fixture(),
    events = eventEnrollmentStore(pool, {
      mode: "test",
      enabled: true,
      catalog: [event],
    }),
    owner = await member(),
    other = await member(),
    id = randomUUID();
  expect((await events.enroll(owner.token, event.id, 1, id)).kind).toBe(
    "enrolled",
  );
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [owner.id],
  );
  expect(await events.receipt(owner.token, id)).toBeNull();
  expect(
    (await events.enroll(other.token, event.id, 1, randomUUID())).kind,
  ).toBe("full");
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
    [owner.id],
  );
  expect((await events.receipt(owner.token, id))?.id).toBe(id);
});
it("paginates only owned receipts and leaves another owner history untouched by deletion", async () => {
  const event = { ...fixture(), fixtureCapacity: 2 },
    events = eventEnrollmentStore(pool, {
      mode: "test",
      enabled: true,
      catalog: [event],
    }),
    owner = await member(),
    other = await member();
  for (let i = 0; i < 23; i++) {
    const id = randomUUID();
    expect((await events.enroll(owner.token, event.id, 1, id)).kind).toBe(
      "enrolled",
    );
    expect(await events.withdraw(owner.token, id)).toBe("withdrawn");
  }
  const otherId = randomUUID();
  expect((await events.enroll(other.token, event.id, 1, otherId)).kind).toBe(
    "enrolled",
  );
  const first = await events.history(owner.token);
  expect(first?.items).toHaveLength(20);
  expect(first?.nextCursor).not.toBeNull();
  const second = await events.history(owner.token, first!.nextCursor!);
  expect(second?.items).toHaveLength(3);
  expect(second?.nextCursor).toBeNull();
  expect(
    new Set([...first!.items, ...second!.items].map((item) => item.id)).size,
  ).toBe(23);
  expect(first!.items.some((item) => item.id === otherId)).toBe(false);
  await members.remove(owner.id);
  expect(await events.history(owner.token, first!.nextCursor!)).toBeNull();
  expect((await events.receipt(other.token, otherId))?.id).toBe(otherId);
});

it("reconciles simultaneous same-owner submissions without allocating a second seat", async () => {
  const event = { ...fixture(), fixtureCapacity: 2 };
  const events = eventEnrollmentStore(pool, {
    mode: "test",
    enabled: true,
    catalog: [event],
  });
  const owner = await member(),
    other = await member(),
    id = randomUUID();
  const duplicate = await Promise.all([
    events.enroll(owner.token, event.id, 1, id),
    events.enroll(owner.token, event.id, 1, id),
  ]);
  expect(duplicate.map((result) => result.kind).sort()).toEqual([
    "enrolled",
    "replayed",
  ]);
  expect(
    duplicate.every(
      (result) => "receiptId" in result && result.receiptId === id,
    ),
  ).toBe(true);
  const otherId = randomUUID();
  expect(await events.enroll(other.token, event.id, 1, otherId)).toEqual({
    kind: "enrolled",
    receiptId: otherId,
  });
  expect((await events.preview(owner.token, event.id, 1))?.remaining).toBe(0);
  expect(
    (await events.history(owner.token))?.items.map((item) => item.id),
  ).toEqual([id]);
});

it("keeps an old receipt withdrawable after its catalog version is retired and replaced", async () => {
  const event = fixture(),
    catalog = [event];
  const events = eventEnrollmentStore(pool, {
    mode: "test",
    enabled: true,
    catalog,
  });
  const owner = await member(),
    oldId = randomUUID(),
    newId = randomUUID();
  expect((await events.enroll(owner.token, event.id, 1, oldId)).kind).toBe(
    "enrolled",
  );
  catalog.splice(0, 1, {
    ...event,
    version: 2,
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    endsAt: new Date(Date.now() + 176400000).toISOString(),
  });
  expect(await events.preview(owner.token, event.id, 1)).toBeNull();
  expect(
    (await events.enroll(owner.token, event.id, 1, randomUUID())).kind,
  ).toBe("already-enrolled");
  expect((await events.enroll(owner.token, event.id, 2, newId)).kind).toBe(
    "enrolled",
  );
  expect(await events.withdraw(owner.token, oldId)).toBe("withdrawn");
  const old = await events.receipt(owner.token, oldId),
    current = await events.receipt(owner.token, newId);
  expect(old?.startsAt.toISOString()).toBe(event.startsAt);
  expect(old?.withdrawnAt).toBeInstanceOf(Date);
  expect(current?.eventVersion).toBe(2);
  expect(current?.withdrawnAt).toBeNull();
});

it("enforces maximum inventory capacity and reuses only an explicitly withdrawn seat", async () => {
  const event = { ...fixture(), fixtureCapacity: 100 };
  const events = eventEnrollmentStore(pool, {
    mode: "test",
    enabled: true,
    catalog: [event],
  });
  const owners = [];
  for (let index = 0; index < 101; index++) owners.push(await member());
  const ids = owners.map(() => randomUUID());
  for (let index = 0; index < 100; index++) {
    expect(
      (await events.enroll(owners[index]!.token, event.id, 1, ids[index]!))
        .kind,
    ).toBe("enrolled");
  }
  expect(
    (await events.enroll(owners[100]!.token, event.id, 1, ids[100]!)).kind,
  ).toBe("full");
  expect(
    (await events.preview(owners[100]!.token, event.id, 1))?.remaining,
  ).toBe(0);
  expect(await events.withdraw(owners[49]!.token, ids[49]!)).toBe("withdrawn");
  expect(
    (await events.enroll(owners[100]!.token, event.id, 1, ids[100]!)).kind,
  ).toBe("enrolled");
  const seats = await pool.query(
    "SELECT seat_number FROM private_event_enrollments WHERE withdrawn_at IS NULL ORDER BY seat_number",
  );
  expect(seats.rows.map((row) => row.seat_number)).toEqual(
    Array.from({ length: 100 }, (_, index) => index + 1),
  );
  expect(await events.withdraw(owners[49]!.token, ids[49]!)).toBe(
    "already-withdrawn",
  );
  expect(
    (await events.preview(owners[100]!.token, event.id, 1))?.remaining,
  ).toBe(0);
});

it.each(["enroll", "withdraw"] as const)(
  "reconciles an uncertain committed %s without replaying the mutation",
  async (operation) => {
    const event = fixture(),
      owner = await member(),
      id = randomUUID();
    const options = { mode: "test" as const, enabled: true, catalog: [event] };
    const events = eventEnrollmentStore(pool, options);
    if (operation === "withdraw")
      await events.enroll(owner.token, event.id, 1, id);
    const statements: string[] = [];
    let discarded = false;
    const uncertain = eventEnrollmentStore(
      {
        async connect() {
          const client = await pool.connect();
          return {
            async query(sql: string, values?: unknown[]) {
              statements.push(sql);
              const result = await client.query(sql, values);
              if (sql === "COMMIT")
                throw Error("Invented lost commit acknowledgment");
              return result;
            },
            release(error?: Error) {
              discarded = error instanceof Error;
              client.release(error);
            },
          };
        },
      } as unknown as Pool,
      options,
    );
    await expect(
      operation === "enroll"
        ? uncertain.enroll(owner.token, event.id, 1, id)
        : uncertain.withdraw(owner.token, id),
    ).rejects.toThrow(/^Private event registration unavailable$/);
    expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(statements).not.toContain("ROLLBACK");
    expect(discarded).toBe(true);
    const actual = await events.receipt(owner.token, id);
    expect(actual?.id).toBe(id);
    if (operation === "withdraw") {
      expect(actual?.withdrawnAt).toBeInstanceOf(Date);
      expect(await events.withdraw(owner.token, id)).toBe("already-withdrawn");
    } else {
      expect(actual?.withdrawnAt).toBeNull();
      expect(await events.enroll(owner.token, event.id, 1, id)).toEqual({
        kind: "replayed",
        receiptId: id,
      });
    }
    expect((await events.history(owner.token))?.items).toHaveLength(1);
  },
);

it.each(
  (["preview", "enroll", "receipt", "history", "withdraw"] as const).flatMap(
    (operation) =>
      (["commit-reply", "native-handback"] as const).map((delay) => ({
        operation,
        delay,
      })),
  ),
)(
  "withholds $operation when successful $delay crosses the database-derived session deadline",
  async ({ operation, delay }) => {
    const event = fixture(),
      owner = await member(),
      id = randomUUID();
    const options = { mode: "test" as const, enabled: true, catalog: [event] };
    const events = eventEnrollmentStore(pool, options);
    if (operation !== "enroll")
      await events.enroll(owner.token, event.id, 1, id);
    const expires = (
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1 RETURNING expires_at",
        [owner.id],
      )
    ).rows[0].expires_at;
    const statements: string[] = [];
    let delivered: Promise<unknown> = Promise.resolve(),
      discarded = false;
    const delayed = eventEnrollmentStore(
      {
        async connect() {
          const client = await pool.connect();
          return {
            async query(sql: string, values?: unknown[]) {
              statements.push(sql);
              const result = await client.query(sql, values);
              if (sql === "COMMIT" && delay === "commit-reply") {
                delivered = pool.query(
                  "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.02)",
                  [expires],
                );
                await delivered;
              }
              return result;
            },
            release(error?: Error) {
              discarded = error instanceof Error;
              client.release(error);
              if (delay === "native-handback")
                Atomics.wait(
                  new Int32Array(new SharedArrayBuffer(4)),
                  0,
                  0,
                  1100,
                );
            },
          };
        },
      } as unknown as Pool,
      options,
    );
    const outcome =
      operation === "preview"
        ? await delayed.preview(owner.token, event.id, 1)
        : operation === "enroll"
          ? await delayed.enroll(owner.token, event.id, 1, id)
          : operation === "receipt"
            ? await delayed.receipt(owner.token, id)
            : operation === "history"
              ? await delayed.history(owner.token)
              : await delayed.withdraw(owner.token, id);
    await delivered;
    expect(outcome).toEqual(
      operation === "enroll"
        ? { kind: "unavailable" }
        : operation === "withdraw"
          ? "unavailable"
          : null,
    );
    expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(statements).not.toContain("ROLLBACK");
    expect(discarded).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT expires_at<=clock_timestamp() expired FROM principals WHERE id=$1",
          [owner.id],
        )
      ).rows[0].expired,
    ).toBe(true);
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
      [owner.id],
    );
    const durable = await events.receipt(owner.token, id);
    expect(durable?.id).toBe(id);
    if (operation === "withdraw")
      expect(durable?.withdrawnAt).toBeInstanceOf(Date);
    else expect(durable?.withdrawnAt).toBeNull();
  },
);

function eventLatch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function waitForEventBlock(waiter: number, blocker: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await pool.query(
      "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) blocked",
      [blocker, waiter],
    );
    if (result.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected event transaction lock wait was not observed");
}
it.each(
  (["delete", "revoke"] as const).flatMap((change) =>
    (["enroll", "receipt", "withdraw"] as const).flatMap((operation) =>
      (["authority-first", "operation-first"] as const).map((order) => ({
        change,
        operation,
        order,
      })),
    ),
  ),
)(
  "$change against $operation respects $order with actual PostgreSQL locks",
  async ({ change, operation, order }) => {
    const event = { ...fixture(), fixtureCapacity: 2 },
      owner = await member(),
      other = await member(),
      id = randomUUID();
    const options = { mode: "test" as const, enabled: true, catalog: [event] };
    const events = eventEnrollmentStore(pool, options);
    if (operation !== "enroll")
      expect((await events.enroll(owner.token, event.id, 1, id)).kind).toBe(
        "enrolled",
      );
    const otherId = randomUUID();
    expect((await events.enroll(other.token, event.id, 1, otherId)).kind).toBe(
      "enrolled",
    );
    const connected = eventLatch(),
      reached = eventLatch(),
      resume = eventLatch();
    let operationPid = 0,
      paused = false;
    const controlled = eventEnrollmentStore(
      {
        async connect() {
          const client = await pool.connect();
          operationPid = (await client.query("SELECT pg_backend_pid() pid"))
            .rows[0].pid;
          connected.release();
          return {
            async query(sql: string, values?: unknown[]) {
              const result = await client.query(sql, values);
              if (
                order === "operation-first" &&
                !paused &&
                sql.includes("SELECT id FROM workspaces")
              ) {
                paused = true;
                reached.release();
                await resume.wait;
              }
              return result;
            },
            release: client.release.bind(client),
          };
        },
      } as unknown as Pool,
      options,
    );
    const authority = await pool.connect();
    let pending: Promise<unknown> | undefined,
      changing: Promise<unknown> | undefined;
    const changeSql =
      change === "delete"
        ? "DELETE FROM principals WHERE id=$1"
        : "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1";
    try {
      await authority.query("BEGIN");
      const authorityPid = (
        await authority.query("SELECT pg_backend_pid() pid")
      ).rows[0].pid;
      if (order === "authority-first")
        await authority.query(changeSql, [owner.id]);
      pending =
        operation === "enroll"
          ? controlled.enroll(owner.token, event.id, 1, id)
          : operation === "receipt"
            ? controlled.receipt(owner.token, id)
            : controlled.withdraw(owner.token, id);
      await connected.wait;
      if (order === "authority-first") {
        await waitForEventBlock(operationPid, authorityPid);
        await authority.query("COMMIT");
        expect(await pending).toEqual(
          operation === "enroll"
            ? { kind: "unavailable" }
            : operation === "withdraw"
              ? "unavailable"
              : null,
        );
      } else {
        await reached.wait;
        changing = authority.query(changeSql, [owner.id]);
        await waitForEventBlock(authorityPid, operationPid);
        resume.release();
        const result = await pending;
        if (operation === "enroll")
          expect(result).toEqual({ kind: "enrolled", receiptId: id });
        else if (operation === "withdraw") expect(result).toBe("withdrawn");
        else expect(result).toMatchObject({ id, withdrawnAt: null });
        await changing;
        await authority.query("COMMIT");
      }
      expect(await events.receipt(owner.token, id)).toBeNull();
      expect(await events.history(owner.token)).toBeNull();
      expect(
        (await events.receipt(other.token, otherId))?.withdrawnAt,
      ).toBeNull();
      if (change === "delete")
        expect(
          (
            await pool.query(
              "SELECT count(*)::int count FROM private_event_enrollments WHERE member_id=$1",
              [owner.id],
            )
          ).rows[0].count,
        ).toBe(0);
    } finally {
      resume.release();
      await pending;
      await changing;
      await authority.query("ROLLBACK");
      authority.release();
    }
  },
);

it("rechecks event start after an actual inventory lock wait and creates no late registration", async () => {
  const event = {
    ...fixture(),
    startsAt: new Date(Date.now() + 1200).toISOString(),
  };
  const options = { mode: "test" as const, enabled: true, catalog: [event] };
  const events = eventEnrollmentStore(pool, options),
    owner = await member(),
    other = await member(),
    id = randomUUID();
  expect((await events.enroll(owner.token, event.id, 1, id)).kind).toBe(
    "enrolled",
  );
  expect(await events.withdraw(owner.token, id)).toBe("withdrawn");
  const lock = await pool.connect(),
    connected = eventLatch();
  let pid = 0,
    pending: Promise<unknown> | undefined;
  const waiting = eventEnrollmentStore(
    {
      async connect() {
        const client = await pool.connect();
        pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
        connected.release();
        return {
          query: client.query.bind(client),
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool,
    options,
  );
  try {
    await lock.query("BEGIN");
    const blocker = (await lock.query("SELECT pg_backend_pid() pid")).rows[0]
      .pid;
    await lock.query(
      "SELECT event_id FROM private_event_inventory WHERE event_id=$1 FOR UPDATE",
      [event.id],
    );
    pending = waiting.enroll(other.token, event.id, 1, randomUUID());
    await connected.wait;
    await waitForEventBlock(pid, blocker);
    await pool.query(
      "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.02)",
      [event.startsAt],
    );
    await lock.query("COMMIT");
    expect(await pending).toEqual({ kind: "unavailable" });
    expect((await events.preview(other.token, event.id, 1))?.canEnroll).toBe(
      false,
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM private_event_enrollments WHERE member_id=$1",
          [other.id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect((await events.receipt(owner.token, id))?.withdrawnAt).toBeInstanceOf(
      Date,
    );
  } finally {
    await lock.query("ROLLBACK");
    await pending;
    lock.release();
  }
});

it("exports bounded owned registration pages and invalidates continuation after erasure", async () => {
  const event = { ...fixture(), fixtureCapacity: 2 },
    owner = await member(),
    other = await member();
  const events = eventEnrollmentStore(pool, {
    mode: "test",
    enabled: true,
    catalog: [event],
  });
  const id = randomUUID(),
    foreignId = randomUUID();
  await events.enroll(owner.token, event.id, 1, id);
  await events.withdraw(owner.token, id);
  await events.enroll(other.token, event.id, 1, foreignId);
  // A large retained history, without requiring101 UI interactions to prepare pagination.
  const ids = Array.from({ length: 101 }, () => randomUUID());
  await pool.query(
    `INSERT INTO private_event_enrollments(id,member_id,workspace_id,event_id,event_version,capacity,seat_number,created_at,withdrawn_at)
    SELECT id,$2,$2,$3,1,2,1,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day' FROM unnest($1::uuid[]) id`,
    [ids, owner.id, event.id],
  );
  const exports = memberExportStore(pool),
    collected: Record<string, unknown>[] = [];
  let cursor: string | undefined,
    savedCursor: string | undefined,
    pages = 0;
  do {
    const result = await exports.exportOwned(owner.token, cursor);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw Error("Expected owned event export");
    expect(result.payload.version).toBe("local-member-records-v22");
    expect(result.payload.page.recordCount).toBeLessThanOrEqual(100);
    const rows = result.payload.records.eventEnrollments;
    expect(rows).toBeDefined();
    if (!rows) throw Error("Missing registration export section");
    collected.push(...rows);
    cursor = result.payload.page.nextCursor ?? undefined;
    savedCursor ??= cursor;
    expect(++pages).toBeLessThan(5);
  } while (cursor);
  expect(pages).toBe(2);
  expect(new Set(collected.map((row) => row.id))).toEqual(
    new Set([id, ...ids]),
  );
  expect(JSON.stringify(collected)).not.toContain(foreignId);
  expect(Object.keys(collected[0]!).sort()).toEqual(
    [
      "id",
      "eventId",
      "eventVersion",
      "title",
      "startsAt",
      "endsAt",
      "createdAt",
      "withdrawnAt",
    ].sort(),
  );
  await members.remove(owner.id);
  expect(await exports.exportOwned(owner.token, savedCursor)).toEqual({
    kind: "denied",
  });
  expect((await events.receipt(other.token, foreignId))?.id).toBe(foreignId);
});

it("reapplies the additive migration without inferring legacy registrations or mutating retained receipts", async () => {
  const owner = await member(),
    event = fixture(),
    id = randomUUID();
  await migrate(pool);
  await migrate(pool);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int count FROM private_event_enrollments",
      )
    ).rows[0].count,
  ).toBe(0);
  const events = eventEnrollmentStore(pool, {
    mode: "test",
    enabled: true,
    catalog: [event],
  });
  await events.enroll(owner.token, event.id, 1, id);
  const before = await events.receipt(owner.token, id);
  await migrate(pool);
  await migrate(pool);
  expect(await events.receipt(owner.token, id)).toEqual(before);
  await expect(
    pool.query(
      "UPDATE private_event_inventory SET capacity=2 WHERE event_id=$1",
      [event.id],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query(
      "UPDATE private_event_enrollments SET seat_number=2 WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow("immutable");
  await events.withdraw(owner.token, id);
  await expect(
    pool.query(
      "UPDATE private_event_enrollments SET withdrawn_at=NULL WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow("immutable");
});
