import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { migrate, store } from "../../src/store.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const end = new Date("2026-02-01T00:00:00.000Z");
let current = end;
const ledger = syntheticLedger(pool, () => current);
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  current = end;
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => pool.end());
async function member(
  background: "explorer" | "professional" | "technical" = "explorer",
) {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background, goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw new Error("Synthetic fixture failed.");
  return session.learner.id;
}
async function grant(
  owner: string,
  key: string,
  expiresAt = end.toISOString(),
) {
  return ledger.grant(owner, "review_minutes", 10, key, {
    startsAt: "2026-01-01T00:00:00.000Z",
    expiresAt,
  });
}
it("sweeps a bounded expiry/ID-ordered batch at the exact boundary and reports remaining work", async () => {
  const owner = await member();
  const first = await grant(owner, "first", "2026-01-31T00:00:00.000Z");
  const tied = [await grant(owner, "a"), await grant(owner, "b")].sort();
  const future = await grant(owner, "future", "2026-02-01T00:00:00.001Z");
  const laterMember = await member();
  const otherCategory = await ledger.grant(
    laterMember,
    "study_requests",
    1,
    "other",
    {
      startsAt: end.toISOString(),
      expiresAt: "2100-01-01T00:00:00.000Z",
    },
  );
  expect(await ledger.sweepExpired(2)).toEqual({
    processed: 2,
    skipped: 0,
    moreDue: true,
  });
  expect(
    (
      await pool.query(
        "SELECT id FROM synthetic_entitlement_grants WHERE expired_at IS NOT NULL ORDER BY expires_at,id",
      )
    ).rows.map((row) => row.id),
  ).toEqual([first, tied[0]]);
  expect(await ledger.sweepExpired(500)).toEqual({
    processed: 1,
    skipped: 0,
    moreDue: false,
  });
  expect(await ledger.sweepExpired(1)).toEqual({
    processed: 0,
    skipped: 0,
    moreDue: false,
  });
  expect(
    (
      await pool.query(
        "SELECT id,available FROM synthetic_entitlement_grants WHERE expired_at IS NULL ORDER BY available",
      )
    ).rows,
  ).toEqual([
    { id: otherCategory, available: 1 },
    { id: future, available: 10 },
  ]);
});

function pausedSweep() {
  let selected!: () => void;
  let proceed!: () => void;
  const ready = new Promise<void>((resolve) => {
    selected = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const wrapped = {
    query: async (sql: string, values?: unknown[]) => {
      const result = await pool.query(sql, values);
      if (sql.includes("SELECT id,member_id")) {
        selected();
        await gate;
      }
      return result;
    },
    connect: pool.connect.bind(pool),
  } as unknown as Pool;
  return { ledger: syntheticLedger(wrapped, () => current), ready, proceed };
}
async function balance(id: string) {
  return (
    await pool.query(
      "SELECT available,reserved,consumed,expired,adjusted FROM synthetic_entitlement_grants WHERE id=$1",
      [id],
    )
  ).rows[0];
}
it("limits a full batch to 500 even when more grants are due", async () => {
  const owner = await member();
  await pool.query(
    `INSERT INTO synthetic_entitlement_grants(id,member_id,category,quantity,available,starts_at,expires_at)
    SELECT gen_random_uuid(),$1,'study_requests',1,1,'2026-01-01',$2 FROM generate_series(1,501)`,
    [owner, end],
  );
  expect(await ledger.sweepExpired(500)).toEqual({
    processed: 500,
    skipped: 0,
    moreDue: true,
  });
  expect(await ledger.sweepExpired(500)).toEqual({
    processed: 1,
    skipped: 0,
    moreDue: false,
  });
  expect(
    (
      await pool.query(
        "SELECT 1 FROM synthetic_entitlement_events WHERE operation='expire'",
      )
    ).rowCount,
  ).toBe(501);
});
it("concurrent sweeps replay one stable per-grant event without double expiry", async () => {
  const owner = await member();
  const id = await grant(owner, "concurrent");
  const a = pausedSweep();
  const b = pausedSweep();
  const attempts = [a.ledger.sweepExpired(1), b.ledger.sweepExpired(1)];
  await Promise.all([a.ready, b.ready]);
  a.proceed();
  b.proceed();
  expect(await Promise.all(attempts)).toEqual([
    { processed: 1, skipped: 0, moreDue: false },
    { processed: 1, skipped: 0, moreDue: false },
  ]);
  expect(await balance(id)).toEqual({
    available: 0,
    reserved: 0,
    consumed: 0,
    expired: 10,
    adjusted: 0,
  });
  expect(
    (
      await pool.query(
        "SELECT quantity FROM synthetic_entitlement_events WHERE operation='expire'",
      )
    ).rows,
  ).toEqual([{ quantity: 10 }]);
});
it.each(["manual", "delete", "clock", "extend"] as const)(
  "safely skips a candidate invalidated by %s after selection",
  async (action) => {
    const owner = await member();
    const id = await grant(owner, "invalidated");
    const paused = pausedSweep();
    const result = paused.ledger.sweepExpired(1);
    try {
      await paused.ready;
      if (action === "manual") await ledger.expire(owner, id, "manual-expiry");
      if (action === "delete") await db.remove(owner);
      if (action === "clock") current = new Date(end.getTime() - 1);
      if (action === "extend")
        await pool.query(
          "UPDATE synthetic_entitlement_grants SET expires_at=$2 WHERE id=$1",
          [id, new Date(end.getTime() + 1)],
        );
    } finally {
      paused.proceed();
    }
    expect(await result).toEqual({ processed: 0, skipped: 1, moreDue: false });
    const events = (
      await pool.query(
        "SELECT quantity FROM synthetic_entitlement_events WHERE operation='expire'",
      )
    ).rows;
    expect(events).toEqual(action === "manual" ? [{ quantity: 10 }] : []);
    if (action === "clock" || action === "extend")
      expect((await balance(id)).available).toBe(10);
  },
);
it.each(["release", "consume", "reserve"] as const)(
  "serializes expiry with %s and preserves held-unit conservation",
  async (operation) => {
    const owner = await member();
    const id = await grant(owner, "settlement");
    current = new Date(end.getTime() - 1);
    const held = await ledger.reserve(owner, id, 4, "held");
    current = end;
    const blocker = await pool.connect();
    let attempts: Promise<unknown>[] = [];
    let results: PromiseSettledResult<unknown>[];
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM synthetic_entitlement_grants WHERE id=$1 FOR UPDATE",
        [id],
      );
      attempts = [
        ledger.sweepExpired(1),
        operation === "reserve"
          ? ledger.reserve(owner, id, 1, "competing")
          : ledger[operation](owner, held, "competing"),
      ];
      // Attach rejection handlers immediately; either lock winner is valid.
      const pending = Promise.allSettled(attempts);
      let waiting = false;
      for (let check = 0; check < 100; check++) {
        const count = (
          await pool.query(`SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`)
        ).rows[0].count;
        if (count >= 2) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("COMMIT");
      results = await pending;
    } finally {
      await blocker.query("ROLLBACK");
      await Promise.allSettled(attempts);
      blocker.release();
    }
    expect(results[0]).toMatchObject({
      status: "fulfilled",
      value: { processed: 1, skipped: 0, moreDue: false },
    });
    expect(results[1]).toMatchObject(
      operation === "reserve"
        ? { status: "rejected", reason: { code: "unavailable" } }
        : { status: "fulfilled" },
    );
    expect(await balance(id)).toEqual({
      available: 0,
      reserved: operation === "reserve" ? 4 : 0,
      consumed: operation === "consume" ? 4 : 0,
      expired: operation === "release" ? 10 : 6,
      adjusted: 0,
    });
    if (operation === "reserve") {
      await ledger.release(owner, held, "late-release");
      expect(await balance(id)).toEqual({
        available: 0,
        reserved: 0,
        consumed: 0,
        expired: 10,
        adjusted: 0,
      });
    }
    expect(
      (
        await pool.query(
          "SELECT 1 FROM synthetic_entitlement_events WHERE operation='expire'",
        )
      ).rowCount,
    ).toBe(1);
  },
);
function command(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        ["src/expiry-sweep-main.ts", ...args],
        {
          env: {
            ...process.env,
            DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
            DNE_APP_MODE: "test",
            ...overrides,
          },
        },
        (error, stdout, stderr) =>
          resolve({ code: error ? 1 : 0, stdout, stderr }),
      );
    },
  );
}
async function rejectSecondExpiry() {
  await pool.query(`CREATE FUNCTION reject_sweep_expiry() RETURNS trigger AS $$
    BEGIN IF NEW.operation='expire' AND EXISTS(SELECT 1 FROM synthetic_entitlement_events WHERE operation='expire')
      THEN RAISE EXCEPTION 'private-marker-do-not-print'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await pool.query(
    "CREATE TRIGGER reject_sweep_expiry BEFORE INSERT ON synthetic_entitlement_events FOR EACH ROW EXECUTE FUNCTION reject_sweep_expiry()",
  );
}
async function allowExpiry() {
  await pool.query(
    "DROP TRIGGER reject_sweep_expiry ON synthetic_entitlement_events",
  );
  await pool.query("DROP FUNCTION reject_sweep_expiry()");
}
it("reports partial CLI failure privately, rolls back the failed event, and safely completes a retry", async () => {
  const owner = await member();
  const first = await grant(owner, "first", "2026-01-30T00:00:00.000Z");
  const second = await grant(owner, "second");
  await rejectSecondExpiry();
  try {
    const result = await command(["--limit", "2"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      status: "failed",
      processed: 1,
      skipped: 0,
      moreDue: null,
    });
    expect(await balance(first)).toMatchObject({ available: 0, expired: 10 });
    expect(await balance(second)).toMatchObject({ available: 10, expired: 0 });
  } finally {
    await allowExpiry();
  }
  const retry = await command(["--limit", "2"]);
  expect(retry.code).toBe(0);
  expect(retry.stderr).toBe("");
  expect(JSON.parse(retry.stdout)).toEqual({
    status: "complete",
    processed: 1,
    skipped: 0,
    moreDue: false,
  });
  const repeat = await command(["--limit", "2"]);
  expect(repeat.code).toBe(0);
  expect(JSON.parse(repeat.stdout)).toEqual({
    status: "complete",
    processed: 0,
    skipped: 0,
    moreDue: false,
  });
  expect(
    (
      await pool.query(
        "SELECT 1 FROM synthetic_entitlement_events WHERE operation='expire'",
      )
    ).rowCount,
  ).toBe(2);
});

it.each([
  { DNE_APP_MODE: "live" },
  {
    DNE_DATABASE_URL:
      "postgres://synthetic-private-marker@example.invalid/database",
  },
  { DNE_APP_MODE: "demo" },
])(
  "refuses command configurations outside local database isolation",
  async (override) => {
    const owner = await member();
    await grant(owner, "untouched");
    const result = await command(["--limit", "1"], override);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      status: "failed",
      processed: 0,
      skipped: 0,
      moreDue: null,
    });
    expect(
      (
        await pool.query(
          "SELECT 1 FROM synthetic_entitlement_events WHERE operation='expire'",
        )
      ).rowCount,
    ).toBe(0);
  },
);
it("preserves distinct members and categories while expiring their own available balances", async () => {
  const fixtures = [];
  for (const [background, category, quantity] of [
    ["explorer", "study_requests", 1],
    ["professional", "review_minutes", 3],
    ["technical", "support_minutes", 5],
  ] as const) {
    const owner = await member(background);
    const id = await ledger.grant(
      owner,
      category,
      quantity,
      `distinct-${background}`,
      { startsAt: "2026-01-01T00:00:00.000Z", expiresAt: end.toISOString() },
    );
    fixtures.push({ id, member_id: owner, category, quantity });
  }
  expect(await ledger.sweepExpired(3)).toEqual({
    processed: 3,
    skipped: 0,
    moreDue: false,
  });
  const rows = (
    await pool.query(`SELECT g.id,g.member_id,g.category,g.quantity,g.available,g.expired,e.quantity AS event_quantity,e.member_id AS event_member
    FROM synthetic_entitlement_grants g JOIN synthetic_entitlement_events e ON e.grant_id=g.id AND e.operation='expire'`)
  ).rows;
  for (const fixture of fixtures)
    expect(rows).toContainEqual({
      ...fixture,
      available: 0,
      expired: fixture.quantity,
      event_quantity: fixture.quantity,
      event_member: fixture.member_id,
    });
});

it.each(["consume", "release"] as const)(
  "expires a fully held grant once and permits late %s without restoring availability",
  async (operation) => {
    const owner = await member();
    const id = await grant(owner, "fully-held");
    current = new Date(end.getTime() - 1);
    const held = await ledger.reserve(owner, id, 10, "all-held");
    current = end;
    expect(await ledger.sweepExpired(1)).toEqual({
      processed: 1,
      skipped: 0,
      moreDue: false,
    });
    expect(await balance(id)).toEqual({
      available: 0,
      reserved: 10,
      consumed: 0,
      expired: 0,
      adjusted: 0,
    });
    expect(
      (
        await pool.query(
          "SELECT quantity FROM synthetic_entitlement_events WHERE operation='expire'",
        )
      ).rows,
    ).toEqual([{ quantity: 0 }]);
    await ledger[operation](owner, held, "late-settlement");
    expect(await ledger.sweepExpired(1)).toEqual({
      processed: 0,
      skipped: 0,
      moreDue: false,
    });
    expect(await balance(id)).toEqual({
      available: 0,
      reserved: 0,
      consumed: operation === "consume" ? 10 : 0,
      expired: operation === "release" ? 10 : 0,
      adjusted: 0,
    });
  },
);
