import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { studyUnitFixtureStore } from "../../src/study-unit-fixtures.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool),
  native = syntheticLedger(pool);
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterEach(() => vi.useRealTimers());
afterAll(() => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const result = await members.session(token);
  if (result.kind !== "active") throw Error("Invented member unavailable");
  return { token, id: result.learner.id };
}
async function instant() {
  return (await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now"))
    .rows[0]!.now;
}
function hostTime(value: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(value);
}
async function grant(owner: string, starts: Date, expires: Date) {
  return native.grant(owner, "study_requests", 3, randomUUID(), {
    startsAt: starts.toISOString(),
    expiresAt: expires.toISOString(),
  });
}
async function balance(id: string) {
  return (
    await pool.query(
      "SELECT available,reserved,consumed,expired,adjusted FROM synthetic_entitlement_grants WHERE id=$1",
      [id],
    )
  ).rows[0];
}
it("LEDGER-CLOCK-01 immediately reserves an issued SQL-valid fixture with a lagging native app clock, and replays once", async () => {
  const owner = await member(),
    staffToken = randomBytes(32).toString("hex");
  const admin = await authorizationStore(pool).provisionStaff(
    staffToken,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const fixtures = studyUnitFixtureStore(pool, { mode: "test", enabled: true });
  const ready = <T>(r: { kind: string; value?: T }): T => {
    if (r.kind !== "ready") throw Error("Fixed study fixture unavailable");
    return r.value!;
  };
  const request = ready(
    await fixtures.request(
      owner.token,
      randomUUID(),
      ready(await fixtures.checkRequest(owner.token, admin)),
    ),
  );
  const issued = ready(
    await fixtures.issue(
      staffToken,
      randomUUID(),
      ready(await fixtures.checkIssue(staffToken, request.id)),
    ),
  );
  const validity = (
    await pool.query(
      "SELECT starts_at<=clock_timestamp() AND expires_at>clock_timestamp() AS valid FROM synthetic_entitlement_grants WHERE id=$1",
      [issued.grantId],
    )
  ).rows[0];
  expect(validity.valid).toBe(true);
  hostTime(new Date(+(await instant()) - 60000));
  const key = randomUUID(),
    id = await native.reserve(owner.id, issued.grantId!, 1, key);
  expect(await native.reserve(owner.id, issued.grantId!, 1, key)).toBe(id);
  expect(await balance(issued.grantId!)).toMatchObject({
    available: 2,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM synthetic_entitlement_events WHERE idempotency_key=$1",
        [key],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("LEDGER-CLOCK-01 native reservation stays usable when the host clock incorrectly appears past expiry", async () => {
  const owner = await member(),
    now = await instant();
  const id = await grant(
    owner.id,
    new Date(+now - 60000),
    new Date(+now + 60000),
  );
  hostTime(new Date(+now + 120000));
  await native.reserve(owner.id, id, 1, randomUUID());
  expect(await balance(id)).toMatchObject({ available: 2, reserved: 1 });
});
it("LEDGER-CLOCK-02 a host clock inside an already DB-expired window cannot authorize reservation", async () => {
  const owner = await member(),
    now = await instant();
  const id = await grant(
    owner.id,
    new Date(+now - 120000),
    new Date(+now - 60000),
  );
  hostTime(new Date(+now - 90000));
  await expect(
    native.reserve(owner.id, id, 1, randomUUID()),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(await balance(id)).toMatchObject({ available: 3, reserved: 0 });
});
it("LEDGER-CLOCK-02 a host clock inside a future window cannot authorize premature reservation", async () => {
  const owner = await member(),
    now = await instant();
  const id = await grant(
    owner.id,
    new Date(+now + 60000),
    new Date(+now + 120000),
  );
  hostTime(new Date(+now + 90000));
  await expect(
    native.reserve(owner.id, id, 1, randomUUID()),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(await balance(id)).toMatchObject({ available: 3, reserved: 0 });
});
it("LEDGER-CLOCK-02 an adjustment cannot consume an expired grant just because the host clock is behind", async () => {
  const owner = await member(),
    now = await instant();
  const id = await grant(
    owner.id,
    new Date(+now - 120000),
    new Date(+now - 60000),
  );
  hostTime(new Date(+now - 90000));
  await expect(
    native.adjust(owner.id, id, 1, randomUUID()),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(await balance(id)).toMatchObject({ available: 3, adjusted: 0 });
});
it("LEDGER-CLOCK-02 native expiry uses current database time even when the host has not reached expiry", async () => {
  const owner = await member(),
    now = await instant();
  const id = await grant(
    owner.id,
    new Date(+now - 120000),
    new Date(+now - 60000),
  );
  hostTime(new Date(+now - 90000));
  await native.expire(owner.id, id, randomUUID());
  expect(await balance(id)).toMatchObject({ available: 0, expired: 3 });
});
it("LEDGER-CLOCK-03 a lagging host never releases an expired hold back into usable balance", async () => {
  const owner = await member(),
    now = await instant();
  const id = await grant(
    owner.id,
    new Date(+now - 120000),
    new Date(+now - 60000),
  );
  const testTime = new Date(+now - 90000);
  const held = await syntheticLedger(pool, () => testTime).reserve(
    owner.id,
    id,
    1,
    randomUUID(),
  );
  hostTime(testTime);
  await native.release(owner.id, held, randomUUID());
  expect(await balance(id)).toMatchObject({
    available: 2,
    reserved: 0,
    expired: 1,
  });
});
it("LEDGER-CLOCK-02/03 native expiry selection ignores an ahead host and expiry of an expired grant ignores a behind host", async () => {
  const owner = await member(),
    now = await instant();
  const active = await grant(
    owner.id,
    new Date(+now - 120000),
    new Date(+now + 60000),
  );
  const expired = await grant(
    owner.id,
    new Date(+now - 120000),
    new Date(+now - 60000),
  );
  hostTime(new Date(+now + 120000));
  const result = await native.sweepExpired(10);
  expect(result).toMatchObject({ processed: 1 });
  expect(await balance(active)).toMatchObject({ available: 3, expired: 0 });
  expect(await balance(expired)).toMatchObject({ available: 0, expired: 3 });
});
it("LEDGER-CLOCK-04 native reservation observes clock after a real lock wait crossing expiry", async () => {
  const owner = await member(),
    now = await instant();
  const id = await grant(
    owner.id,
    new Date(+now - 60000),
    new Date(+now + 2000),
  );
  const lock = await pool.connect();
  await lock.query("BEGIN");
  await lock.query(
    "SELECT id FROM synthetic_entitlement_grants WHERE id=$1 FOR UPDATE",
    [id],
  );
  const blocker = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid;
  hostTime(now);
  const pending = native.reserve(owner.id, id, 1, randomUUID()).then(
    () => "reserved",
    () => "denied",
  );
  try {
    let waiting = false;
    for (let observation = 0; observation < 50; observation++) {
      const state = (
        await pool.query(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
           WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting,
           clock_timestamp() < expires_at AS valid
           FROM synthetic_entitlement_grants WHERE id=$2`,
          [blocker, id],
        )
      ).rows[0];
      if (state.waiting) {
        expect(state.valid).toBe(true);
        waiting = true;
        break;
      }
      await pool.query("SELECT pg_sleep(0.02)");
    }
    expect(waiting).toBe(true);
    // PostgreSQL owns this real wait and its clock; Date-only faking does not
    // fake timers or skip a validity boundary.
    await lock.query(
      `SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM
       (expires_at-clock_timestamp()))) + 0.05)
       FROM synthetic_entitlement_grants WHERE id=$1`,
      [id],
    );
    await lock.query("COMMIT");
    expect(await pending).toBe("denied");
    expect(await balance(id)).toMatchObject({ available: 3, reserved: 0 });
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
});
