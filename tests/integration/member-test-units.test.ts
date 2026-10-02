import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { syntheticLedger, type LedgerCategory } from "../../src/ledger.ts";
import { memberSlotHolds } from "../../src/slot-holds.ts";
import { availabilityStore } from "../../src/availability.ts";
import {
  memberTestUnitsStore,
  type MemberTestUnitSnapshot,
} from "../../src/member-test-units.ts";
import { app } from "../../src/app.ts";
import { COOKIE } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  db = store(pool),
  ledger = syntheticLedger(pool),
  reader = memberTestUnitsStore(pool);
const categories: LedgerCategory[] = [
  "coach_minutes",
  "review_minutes",
  "support_minutes",
  "mock_sessions",
  "study_requests",
];
const current = {
  startsAt: "2020-01-01T00:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
};
const past = {
  startsAt: "2000-01-01T00:00:00.000Z",
  expiresAt: "2001-01-01T00:00:00.000Z",
};
const future = {
  startsAt: "2100-01-01T00:00:00.000Z",
  expiresAt: "2110-01-01T00:00:00.000Z",
};
beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs,principals,cohorts CASCADE"),
);
afterAll(async () => pool.end());
async function member(
  background: "explorer" | "professional" | "technical" = "explorer",
) {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background, goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw Error("Expected member");
  return { token, id: session.learner.id };
}
async function staff(
  role: "operator" | "platform_admin" | "coach" = "operator",
) {
  const token = randomBytes(32).toString("hex"),
    id = await authorizationStore(pool).provisionStaff(
      token,
      role,
      new Date(Date.now() + 3600000),
    );
  return { token, id };
}
async function grant(
  owner: string,
  category: LedgerCategory = "coach_minutes",
  quantity = 60,
  window = current,
) {
  return ledger.grant(owner, category, quantity, randomUUID(), window);
}
async function read(token: string): Promise<MemberTestUnitSnapshot> {
  const result = await reader.snapshot(token);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected ready snapshot");
  return result.value;
}
function category(
  value: MemberTestUnitSnapshot,
  name: LedgerCategory = "coach_minutes",
) {
  const found = value.categories.find((x) => x.category === name);
  if (!found) throw Error("Expected category");
  return found;
}
async function retained(owner: string) {
  return (
    await pool.query(
      `SELECT
    (SELECT jsonb_agg(g ORDER BY g.id) FROM synthetic_entitlement_grants g WHERE member_id=$1) grants,
    (SELECT jsonb_agg(e ORDER BY e.id) FROM synthetic_entitlement_events e WHERE member_id=$1) events,
    (SELECT jsonb_agg(r ORDER BY r.id) FROM synthetic_entitlement_reservations r JOIN synthetic_entitlement_grants g ON g.id=r.grant_id WHERE g.member_id=$1) reservations`,
      [owner],
    )
  ).rows[0];
}
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function controlled(
  after: (
    sql: string,
    client: PoolClient,
    result: QueryResult,
  ) => Promise<void>,
) {
  const connected = latch(),
    state = { pid: 0 };
  const use = memberTestUnitsStore({
    connect: async () => {
      const client = await pool.connect();
      state.pid = (
        await client.query("SELECT pg_backend_pid() pid")
      ).rows[0].pid;
      connected.release();
      return {
        query: async (sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params);
          await after(sql, client, result);
          return result;
        },
        on: client.on.bind(client),
        removeListener: client.removeListener.bind(client),
        release: (error?: Error) => client.release(error),
      };
    },
  } as unknown as Pool);
  return { use, connected, state };
}
it.each(["explorer", "professional", "technical"] as const)(
  "reads an empty own test grant state for %s without minting or changing data",
  async (background) => {
    const owner = await member(background),
      before = await retained(owner.id),
      value = await read(owner.token);
    expect(
      value.categories.map((row) => [row.category, row.granted, row.usable]),
    ).toEqual(categories.map((c) => [c, 0, 0]));
    expect(value.scope).toBe("synthetic-local-preview");
    expect(await retained(owner.id)).toEqual(before);
  },
);
it("reports all five categories with distinct current/future/held/expired accounting and no other owner's grant", async () => {
  const owner = await member(),
    other = await member();
  for (const name of categories) {
    const live = await grant(owner.id, name, 100);
    await ledger.reserve(owner.id, live, 20, randomUUID());
    const used = await ledger.reserve(owner.id, live, 10, randomUUID());
    await ledger.consume(owner.id, used, randomUUID());
    await ledger.adjust(owner.id, live, 5, randomUUID());
    await grant(owner.id, name, 30, future);
    await grant(owner.id, name, 40, past);
    const expired = await grant(owner.id, name, 50, past);
    await ledger.expire(owner.id, expired, randomUUID());
    await grant(other.id, name, 999);
  }
  const before = await retained(owner.id),
    value = await read(owner.token);
  for (const name of categories) {
    expect(category(value, name)).toMatchObject({
      grants: 4,
      granted: 220,
      usable: 65,
      future: 30,
      awaitingExpiry: 40,
      held: 20,
      consumed: 10,
      expired: 50,
      adjusted: 5,
      nextExpiry: new Date(current.expiresAt),
      nextStart: new Date(future.startsAt),
    });
  }
  expect(category(value, "mock_sessions").unit).toBe("sessions");
  expect(category(value, "study_requests").unit).toBe("requests");
  expect(JSON.stringify(value)).not.toMatch(
    new RegExp(`${owner.id}|${other.id}|999`),
  );
  expect(await retained(owner.id)).toEqual(before);
});
it("keeps held units after expiry and reflects an explicit release and sweep on a later read", async () => {
  const owner = await member(),
    id = await grant(owner.id),
    reservation = await ledger.reserve(owner.id, id, 20, randomUUID());
  await pool.query(
    "UPDATE synthetic_entitlement_grants SET expires_at='2021-01-01' WHERE id=$1",
    [id],
  );
  const before = await retained(owner.id);
  expect(category(await read(owner.token))).toMatchObject({
    usable: 0,
    awaitingExpiry: 40,
    held: 20,
    expired: 0,
    nextExpiry: null,
  });
  expect(await retained(owner.id)).toEqual(before);
  await ledger.release(owner.id, reservation, randomUUID());
  expect(category(await read(owner.token))).toMatchObject({
    usable: 0,
    awaitingExpiry: 40,
    held: 0,
    expired: 20,
  });
  expect(await ledger.sweepExpired(10)).toEqual({
    processed: 1,
    skipped: 0,
    moreDue: false,
  });
  expect(category(await read(owner.token))).toMatchObject({
    usable: 0,
    awaitingExpiry: 0,
    held: 0,
    expired: 60,
  });
});
it("retains legitimate migrated zero-length expired windows without making them usable or rewriting history", async () => {
  const owner = await member(),
    id = await grant(owner.id);
  await pool.query(
    "UPDATE synthetic_entitlement_grants SET starts_at=created_at,expires_at=created_at,expired_at=created_at,available=0,expired=quantity WHERE id=$1",
    [id],
  );
  const before = await retained(owner.id);
  expect(category(await read(owner.token))).toMatchObject({
    granted: 60,
    usable: 0,
    expired: 60,
    nextExpiry: null,
    nextStart: null,
  });
  expect(await retained(owner.id)).toEqual(before);
});
it.each(["expiry", "revocation", "deletion", "workspace"])(
  "denies %s without an empty private balance",
  async (kind) => {
    const owner = await member();
    await grant(owner.id);
    if (kind === "expiry")
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [owner.id],
      );
    if (kind === "revocation")
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [owner.id],
      );
    if (kind === "deletion") await db.remove(owner.id);
    if (kind === "workspace")
      await pool.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [owner.id],
      );
    expect(await reader.snapshot(owner.token)).toEqual({ kind: "denied" });
  },
);
it("denies a staff or unknown session while a different member sees only their own zero grants", async () => {
  const owner = await member(),
    other = await member(),
    operator = await staff();
  await grant(owner.id, "study_requests", 73);
  expect(await reader.snapshot(operator.token)).toEqual({ kind: "denied" });
  expect(await reader.snapshot(randomBytes(32).toString("hex"))).toEqual({
    kind: "denied",
  });
  expect(category(await read(other.token), "study_requests").granted).toBe(0);
});
it("uses the real owner boundary for the page and JSON download, rejecting target scope and staff", async () => {
  const owner = await member(),
    operator = await staff();
  await grant(owner.id);
  const application = app(db, {
    origin: "http://127.0.0.1:3000",
    secret: "synthetic-summary-test",
    mode: "test",
    memberTestUnits: reader,
  });
  const get = (path: string, token = owner.token) =>
    withLoopback(application, (server) =>
      request(server)
        .get(path)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${token}`),
    );
  const before = await retained(owner.id),
    html = await get("/member/test-units"),
    json = await get("/member/test-units/download");
  expect(html.status).toBe(200);
  expect(html.text).toContain('<span data-field="usable">60</span> minutes');
  expect(json.status).toBe(200);
  expect(json.body.categories[0].usable).toBe(60);
  expect(json.headers["cache-control"]).toBe("no-store");
  expect(json.text).not.toContain(owner.id);
  expect((await get(`/member/test-units?memberId=${owner.id}`)).status).toBe(
    400,
  );
  expect(
    (await get("/member/test-units/download", operator.token)).status,
  ).toBe(403);
  expect(await retained(owner.id)).toEqual(before);
});
it("returns the coherent earlier snapshot while a real reservation commits and shows the new balance on reload", async () => {
  const owner = await member(),
    id = await grant(owner.id),
    captured = latch(),
    resume = latch();
  const controlledReader = controlled(async (sql) => {
    if (sql.startsWith("WITH observed")) {
      captured.release();
      await resume.wait;
    }
  });
  const pending = controlledReader.use.snapshot(owner.token);
  try {
    await Promise.race([
      captured.wait,
      pending.then(() => {
        throw Error("Reader finished before capture");
      }),
    ]);
    await ledger.reserve(owner.id, id, 10, randomUUID());
    resume.release();
    const old = await pending;
    expect(old.kind).toBe("ready");
    if (old.kind !== "ready") throw Error("Expected snapshot");
    expect(category(old.value)).toMatchObject({ usable: 60, held: 0 });
    expect(category(await read(owner.token))).toMatchObject({
      usable: 50,
      held: 10,
    });
  } finally {
    resume.release();
    await pending;
  }
});
it.each(["deletion", "revocation", "workspace"])(
  "holds the actual owner locks through commit against concurrent %s",
  async (kind) => {
    const owner = await member();
    await grant(owner.id);
    const captured = latch(),
      resume = latch(),
      waiting = controlled(async (sql) => {
        if (sql.startsWith("WITH observed")) {
          captured.release();
          await resume.wait;
        }
      });
    const pending = waiting.use.snapshot(owner.token),
      writer = await pool.connect();
    let mutation: Promise<QueryResult> | undefined;
    try {
      await Promise.race([
        captured.wait,
        pending.then(() => {
          throw Error("Reader finished before capture");
        }),
      ]);
      await writer.query("BEGIN");
      const writerPid = (await writer.query("SELECT pg_backend_pid() pid"))
        .rows[0].pid;
      mutation =
        kind === "deletion"
          ? writer.query("DELETE FROM principals WHERE id=$1", [owner.id])
          : kind === "revocation"
            ? writer.query(
                "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
                [owner.id],
              )
            : writer.query(
                "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
                [owner.id],
              );
      await expect
        .poll(
          async () =>
            (await pool.query("SELECT pg_blocking_pids($1) pids", [writerPid]))
              .rows[0].pids,
          { timeout: 2000, interval: 10 },
        )
        .toContain(waiting.state.pid);
      resume.release();
      expect((await pending).kind).toBe("ready");
      await mutation;
      await writer.query("COMMIT");
      expect(await reader.snapshot(owner.token)).toEqual({ kind: "denied" });
    } finally {
      resume.release();
      await pending;
      await mutation;
      await writer.query("ROLLBACK");
      writer.release();
    }
  },
);
it.each(["session", "grant"])(
  "rejects a %s deadline crossed during actual PostgreSQL snapshot assembly",
  async (kind) => {
    const owner = await member(),
      id = await grant(owner.id),
      deadline = new Date(Date.now() + 2000);
    if (kind === "session")
      await pool.query("UPDATE principals SET expires_at=$2 WHERE id=$1", [
        owner.id,
        deadline,
      ]);
    else
      await pool.query(
        "UPDATE synthetic_entitlement_grants SET expires_at=$2 WHERE id=$1",
        [id, deadline],
      );
    let observed = false;
    const waiting = controlled(async (sql, client, result) => {
      if (sql.startsWith("WITH observed")) {
        expect(result.rows[0].usable).toBe("60");
        observed = true;
        await client.query(
          "SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))+0.02))",
          [deadline],
        );
      }
    });
    const before = await retained(owner.id),
      result = await waiting.use.snapshot(owner.token);
    expect(observed).toBe(true);
    expect(result).toEqual({
      kind: kind === "session" ? "denied" : "unavailable",
    });
    expect(await retained(owner.id)).toEqual(before);
  },
);
it.each(["infinite-end", "infinite-start", "expiry-marker", "zero-unexpired"])(
  "fails safely on actual malformed grant state %s without partial quantities",
  async (kind) => {
    const owner = await member(),
      id = await grant(owner.id);
    if (kind === "infinite-end")
      await pool.query(
        "UPDATE synthetic_entitlement_grants SET expires_at='infinity' WHERE id=$1",
        [id],
      );
    if (kind === "infinite-start")
      await pool.query(
        "UPDATE synthetic_entitlement_grants SET starts_at='-infinity' WHERE id=$1",
        [id],
      );
    if (kind === "expiry-marker")
      await pool.query(
        "UPDATE synthetic_entitlement_grants SET expired_at=clock_timestamp() WHERE id=$1",
        [id],
      );
    if (kind === "zero-unexpired")
      await pool.query(
        "UPDATE synthetic_entitlement_grants SET starts_at=expires_at WHERE id=$1",
        [id],
      );
    const before = await retained(owner.id);
    expect(await reader.snapshot(owner.token)).toEqual({ kind: "unavailable" });
    expect(await retained(owner.id)).toEqual(before);
  },
);
it("returns unavailable after an actual SQL fault and leaves retained records unchanged", async () => {
  const owner = await member();
  await grant(owner.id);
  const before = await retained(owner.id);
  const broken = controlled(async (sql, client) => {
    if (sql.startsWith("WITH observed")) await client.query("SELECT 1/0");
  });
  expect(await broken.use.snapshot(owner.token)).toEqual({
    kind: "unavailable",
  });
  expect(await retained(owner.id)).toEqual(before);
  expect(category(await read(owner.token)).usable).toBe(60);
});
it("withholds a private result after a committed read whose acknowledgement is lost, with no automatic replay", async () => {
  const owner = await member();
  await grant(owner.id);
  let commits = 0;
  const uncertain = controlled(async (sql) => {
    if (sql === "COMMIT") {
      commits++;
      throw Error("synthetic lost acknowledgement");
    }
  });
  const before = await retained(owner.id);
  expect(await uncertain.use.snapshot(owner.token)).toEqual({
    kind: "unavailable",
  });
  expect(commits).toBe(1);
  expect(await retained(owner.id)).toEqual(before);
});

async function sampleSlot() {
  const admin = await staff("platform_admin"),
    operator = await staff(),
    coach = await staff("coach"),
    backup = await staff("coach"),
    registry = randomUUID(),
    other = randomUUID();
  const start = new Date(Date.now() + 3 * 86400000),
    end = new Date(start.getTime() + 3600000);
  await pool.query(
    `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,loaded_cost_cents,capacity_minutes,backup_staff_id,qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
    VALUES($1,$2,'coach','education','coaching',$3,$4,12000,60,$5,'synthetic qualification','synthetic agreement','synthetic conflict',$6,clock_timestamp()),
    ($7,$5,'coach','education','coaching',$3,$4,12000,60,$2,'synthetic qualification','synthetic agreement','synthetic conflict',$6,clock_timestamp())`,
    [
      registry,
      coach.id,
      new Date(Date.now() - 3600000),
      new Date(end.getTime() + 3600000),
      backup.id,
      admin.id,
      other,
    ],
  );
  const slot = await availabilityStore(pool).create(
    operator.token,
    registry,
    start,
    end,
  );
  if (!slot) throw Error("Expected synthetic slot");
  return slot;
}

it("contains a real connection termination between snapshot and final authorization", async () => {
  const owner = await member();
  await grant(owner.id);
  const before = await retained(owner.id);
  const terminated = controlled(async (sql, client) => {
    if (sql.startsWith("WITH observed")) {
      const pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      expect(
        (await pool.query("SELECT pg_terminate_backend($1) stopped", [pid]))
          .rows[0].stopped,
      ).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
  expect(await terminated.use.snapshot(owner.token)).toEqual({
    kind: "unavailable",
  });
  expect(await retained(owner.id)).toEqual(before);
  expect(category(await read(owner.token)).usable).toBe(60);
});

it("honors the real five-second statement timeout without returning partial balances", async () => {
  const owner = await member();
  await grant(owner.id);
  const before = await retained(owner.id);
  const delayed = controlled(async (sql, client) => {
    if (sql.startsWith("WITH observed"))
      await client.query("SELECT pg_sleep(6)");
  });
  expect(await delayed.use.snapshot(owner.token)).toEqual({
    kind: "unavailable",
  });
  expect(await retained(owner.id)).toEqual(before);
}, 10000);

it("honors the real ownership lock timeout rather than reading around an exclusive lock", async () => {
  const owner = await member();
  await grant(owner.id);
  const blocker = await pool.connect(),
    waiting = controlled(async () => {});
  let pending: ReturnType<typeof reader.snapshot> | undefined;
  try {
    await blocker.query("BEGIN");
    const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0]
      .pid;
    await blocker.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
      owner.id,
    ]);
    pending = waiting.use.snapshot(owner.token);
    await waiting.connected.wait;
    await expect
      .poll(
        async () =>
          (
            await pool.query("SELECT pg_blocking_pids($1) pids", [
              waiting.state.pid,
            ])
          ).rows[0].pids,
        { timeout: 2000, interval: 10 },
      )
      .toContain(pid);
    expect(await pending).toEqual({ kind: "unavailable" });
    await blocker.query("ROLLBACK");
    expect(category(await read(owner.token)).usable).toBe(60);
  } finally {
    await blocker.query("ROLLBACK");
    await pending;
    blocker.release();
  }
}, 10000);

it("withholds private data after a real rollback whose acknowledgement is lost", async () => {
  const owner = await member();
  await grant(owner.id);
  let rollbacks = 0;
  const broken = controlled(async (sql, client) => {
    if (sql.startsWith("WITH observed")) await client.query("SELECT 1/0");
    if (sql === "ROLLBACK") {
      rollbacks++;
      throw Error("synthetic rollback acknowledgement lost");
    }
  });
  const before = await retained(owner.id);
  expect(await broken.use.snapshot(owner.token)).toEqual({
    kind: "unavailable",
  });
  expect(rollbacks).toBe(1);
  expect(await retained(owner.id)).toEqual(before);
});
it.each([false, true])(
  "reflects real sample hold replay and withdrawal with expired=%s without settling during a balance read",
  async (expired) => {
    const owner = await member(),
      id = await grant(owner.id),
      slot = await sampleSlot(),
      holds = memberSlotHolds(pool),
      key = randomUUID();
    await holds.request(owner.token, slot, id, key);
    await holds.request(owner.token, slot, id, key);
    expect(category(await read(owner.token))).toMatchObject({
      usable: 0,
      held: 60,
    });
    if (expired)
      await pool.query(
        "UPDATE synthetic_entitlement_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id],
      );
    const before = await retained(owner.id);
    expect(category(await read(owner.token))).toMatchObject({
      usable: 0,
      held: 60,
    });
    expect(await retained(owner.id)).toEqual(before);
    await holds.withdraw(owner.token, key);
    expect(category(await read(owner.token))).toMatchObject({
      usable: expired ? 0 : 60,
      held: 0,
      expired: expired ? 60 : 0,
    });
  },
);
