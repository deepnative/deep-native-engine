import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { syntheticLedger } from "../../src/ledger.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { memberTestUnitsStore } from "../../src/member-test-units.ts";
import { migrate, store } from "../../src/store.ts";
import { studyAllowanceStore } from "../../src/study-allowances.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool),
  enabled = studyAllowanceStore(pool, { mode: "test", enabled: true }),
  paused = studyAllowanceStore(pool, { mode: "test", enabled: false }),
  ledger = syntheticLedger(pool);
const V1 = "study-allowance-test-v1";

async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  return { token, id: session.learner.id };
}
async function ready<T>(result: Promise<{ kind: string; value?: T }>) {
  const settled = await result;
  expect(settled.kind).toBe("ready");
  return settled.value as T;
}
async function instruction(token: string) {
  const view = await ready(enabled.member(token));
  return {
    policyVersion: view.policy!.version,
    periodStart: view.period.start.toISOString(),
  };
}
const grants = async (id: string) =>
  (
    await pool.query<{
      id: string;
      quantity: number;
      available: number;
      expires_at: Date;
    }>(
      "SELECT id,quantity,available,expires_at FROM synthetic_entitlement_grants WHERE member_id=$1 ORDER BY starts_at",
      [id],
    )
  ).rows;
const monthStart = (offset: number) => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
  );
};
// A genuine last-month claim, created through the same guard a real one meets.
async function lastMonthClaim(id: string, key: string) {
  const start = monthStart(-1),
    end = monthStart(0);
  const grant = await ledger.grant(
    id,
    "study_requests",
    5,
    `study-allowance:${id}:${start.toISOString().slice(0, 7)}`,
    { startsAt: start.toISOString(), expiresAt: end.toISOString() },
  );
  const workspace = (
    await pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE owner_principal_id=$1",
      [id],
    )
  ).rows[0]!.id;
  await pool.query(
    `INSERT INTO study_allowance_claims(id,member_id,workspace_id,policy_version,category,period_start,period_end,quantity,grant_id,operation_key)
     VALUES($1,$2,$3,$4,'study_requests',$5,$6,5,$7,$8)`,
    [randomUUID(), id, workspace, V1, start, end, grant, key],
  );
  return start.toISOString();
}
// A later policy version is the only table row this suite may add; the
// immutable guard is suspended solely to remove it between tests.
async function removeLaterPolicies() {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE study_allowance_policies DISABLE TRIGGER study_allowance_policy_guard",
    );
    await client.query(
      "DELETE FROM study_allowance_policies WHERE version<>$1",
      [V1],
    );
    await client.query(
      "ALTER TABLE study_allowance_policies ENABLE TRIGGER study_allowance_policy_guard",
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}
const addPolicy = (version: string, limit: number) =>
  pool.query(
    `INSERT INTO study_allowance_policies(version,category,period_limit,period,eligibility,grant_source,spend_state,effective_from)
     VALUES($1,'study_requests',$2,'utc_calendar_month','current_member_explicit_claim','test_configuration','test',clock_timestamp())`,
    [version, limit],
  );

beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
});
afterEach(removeLaterPolicies);
afterAll(async () => pool.end());

it("ALLOW-01 shows the versioned policy, and neither reading nor a profile change adds units", async () => {
  const owner = await member();
  const view = await ready(enabled.member(owner.token));
  expect(view.policy).toEqual({
    version: V1,
    category: "study_requests",
    periodLimit: 5,
    period: "utc_calendar_month",
    eligibility: "current_member_explicit_claim",
    grantSource: "test_configuration",
    rateEstimateVersion: null,
    spendState: "test",
  });
  expect(view.claim).toBeNull();
  const changed = await pool.query(
    "UPDATE learners SET background='technical' WHERE id=$1",
    [owner.id],
  );
  expect(changed.rowCount).toBe(1);
  await ready(enabled.member(owner.token));
  expect(await grants(owner.id)).toEqual([]);
});

it("ALLOW-02 a deliberate claim grants exactly the limit until the month ends, on the member's balance", async () => {
  const owner = await member();
  const checked = await instruction(owner.token);
  const claim = await ready(enabled.claim(owner.token, randomUUID(), checked));
  expect(claim).toMatchObject({
    policyVersion: V1,
    quantity: 5,
    available: 5,
    reserved: 0,
    consumed: 0,
  });
  const [grant] = await grants(owner.id);
  expect(grant!.quantity).toBe(5);
  expect(grant!.expires_at).toEqual(claim.periodEnd);
  expect(claim.periodEnd.getUTCDate()).toBe(1);
  const balance = await memberTestUnitsStore(pool).snapshot(owner.token);
  if (balance.kind !== "ready") throw Error("Expected a balance");
  expect(
    balance.value.categories.find((row) => row.category === "study_requests"),
  ).toMatchObject({ granted: 5, usable: 5 });
  const reservation = await ledger.reserve(
    owner.id,
    grant!.id,
    1,
    `allow-02-${randomUUID()}`,
  );
  await ledger.consume(owner.id, reservation, `allow-02-${randomUUID()}`);
  const after = await ready(enabled.member(owner.token));
  expect(after.claim).toMatchObject({ available: 4, consumed: 1 });
});

it("ALLOW-03 replay, another key and concurrent claims create one grant", async () => {
  const owner = await member();
  const checked = await instruction(owner.token);
  const key = randomUUID();
  const first = await ready(enabled.claim(owner.token, key, checked));
  expect((await ready(enabled.claim(owner.token, key, checked))).id).toBe(
    first.id,
  );
  expect(
    (await ready(enabled.claim(owner.token, randomUUID(), checked))).id,
  ).toBe(first.id);
  expect(await grants(owner.id)).toHaveLength(1);

  const racing = await member();
  const raced = await instruction(racing.token);
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      ready(enabled.claim(racing.token, randomUUID(), raced)),
    ),
  );
  expect(new Set(results.map((claim) => claim.id)).size).toBe(1);
  const racedGrants = await grants(racing.id);
  expect(racedGrants).toHaveLength(1);
  expect(racedGrants[0]!.quantity).toBe(5);
});

it("ALLOW-03 a key reused for a changed instruction conflicts, and two members' keys don't collide", async () => {
  const owner = await member();
  const checked = await instruction(owner.token);
  const key = randomUUID();
  await ready(enabled.claim(owner.token, key, checked));
  expect(
    (
      await enabled.claim(owner.token, key, {
        ...checked,
        policyVersion: "study-allowance-test-v2",
      })
    ).kind,
  ).toBe("conflict");
  const other = await member();
  const own = await ready(
    enabled.claim(other.token, key, await instruction(other.token)),
  );
  expect(own.quantity).toBe(5);
  expect(await grants(other.id)).toHaveLength(1);
});

it("ALLOW-04 a new month gives a new grant with no carry-over, and the old claim's key still replays", async () => {
  const owner = await member();
  const key = randomUUID();
  const previous = await lastMonthClaim(owner.id, key);
  const before = await ready(enabled.member(owner.token));
  expect(before.claim).toBeNull();
  const checked = await instruction(owner.token);
  const next = await ready(enabled.claim(owner.token, randomUUID(), checked));
  expect(next.available).toBe(5);
  expect(next.periodStart.toISOString()).toBe(monthStart(0).toISOString());
  expect(await grants(owner.id)).toHaveLength(2);
  const balance = await memberTestUnitsStore(pool).snapshot(owner.token);
  if (balance.kind !== "ready") throw Error("Expected a balance");
  expect(
    balance.value.categories.find((row) => row.category === "study_requests")!
      .usable,
  ).toBe(5);
  const replay = await ready(
    enabled.claim(owner.token, key, {
      policyVersion: V1,
      periodStart: previous,
    }),
  );
  expect(replay.periodStart.toISOString()).toBe(previous);
  expect(await grants(owner.id)).toHaveLength(2);
});

it("ALLOW-04 a form opened last month is refused", async () => {
  const owner = await member();
  const checked = await instruction(owner.token);
  expect(
    (
      await enabled.claim(owner.token, randomUUID(), {
        ...checked,
        periodStart: "2020-01-01T00:00:00.000Z",
      })
    ).kind,
  ).toBe("conflict");
  expect(await grants(owner.id)).toEqual([]);
});

it("ALLOW-05 a newer version doesn't top up a claimed month, refuses the stale form and applies next", async () => {
  const claimed = await member(),
    fresh = await member();
  const checked = await instruction(claimed.token);
  const first = await ready(
    enabled.claim(claimed.token, randomUUID(), checked),
  );
  await addPolicy("study-allowance-test-v2", 7);
  const same = await ready(enabled.claim(claimed.token, randomUUID(), checked));
  expect(same.id).toBe(first.id);
  expect(same.quantity).toBe(5);
  expect(await grants(claimed.id)).toHaveLength(1);

  expect((await enabled.claim(fresh.token, randomUUID(), checked)).kind).toBe(
    "conflict",
  );
  expect(await grants(fresh.id)).toEqual([]);
  const current = await instruction(fresh.token);
  expect(current.policyVersion).toBe("study-allowance-test-v2");
  const newer = await ready(enabled.claim(fresh.token, randomUUID(), current));
  expect(newer).toMatchObject({
    policyVersion: "study-allowance-test-v2",
    quantity: 7,
  });
});

it("ALLOW-05 policies and claims can't be rewritten, and a claim must match its grant", async () => {
  await expect(
    pool.query(
      "UPDATE study_allowance_policies SET period_limit=100 WHERE version=$1",
      [V1],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("DELETE FROM study_allowance_policies WHERE version=$1", [V1]),
  ).rejects.toThrow("immutable");
  const owner = await member();
  const claim = await ready(
    enabled.claim(owner.token, randomUUID(), await instruction(owner.token)),
  );
  await expect(
    pool.query("UPDATE study_allowance_claims SET quantity=100 WHERE id=$1", [
      claim.id,
    ]),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("DELETE FROM study_allowance_claims WHERE id=$1", [claim.id]),
  ).rejects.toThrow("retained");
  const other = await member();
  const grant = await ledger.grant(
    other.id,
    "study_requests",
    5,
    `allow-05-${randomUUID()}`,
    {
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  );
  const workspace = (
    await pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE owner_principal_id=$1",
      [other.id],
    )
  ).rows[0]!.id;
  await expect(
    pool.query(
      `INSERT INTO study_allowance_claims(id,member_id,workspace_id,policy_version,category,period_start,period_end,quantity,grant_id,operation_key)
       VALUES($1,$2,$3,$4,'study_requests',date_trunc('month',clock_timestamp()),date_trunc('month',clock_timestamp())+interval '1 month',5,$5,$6)`,
      [randomUUID(), other.id, workspace, V1, grant, randomUUID()],
    ),
  ).rejects.toThrow("Exact study allowance grant required");
});

it("ALLOW-06 staff and strangers are denied, pausing blocks claims, and retained claims stay readable", async () => {
  const owner = await member();
  const checked = await instruction(owner.token);
  expect((await paused.claim(owner.token, randomUUID(), checked)).kind).toBe(
    "denied",
  );
  expect(await grants(owner.id)).toEqual([]);
  await ready(enabled.claim(owner.token, randomUUID(), checked));
  const view = await ready(paused.member(owner.token));
  expect(view.claim?.quantity).toBe(5);
  expect(view.creationEnabled).toBe(false);

  const staff = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    staff,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  expect((await enabled.member(staff)).kind).toBe("denied");
  expect((await enabled.claim(staff, randomUUID(), checked)).kind).toBe(
    "denied",
  );
  const stranger = randomBytes(32).toString("hex");
  expect((await enabled.member(stranger)).kind).toBe("denied");
  const other = await member();
  expect((await ready(enabled.member(other.token))).claim).toBeNull();
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [owner.id],
  );
  expect((await enabled.member(owner.token)).kind).toBe("denied");
});

it("ALLOW-07 the export lists own claims without keys, and erasure leaves only the policy", async () => {
  const owner = await member(),
    other = await member();
  const key = randomUUID();
  const claim = await ready(
    enabled.claim(owner.token, key, await instruction(owner.token)),
  );
  await ready(
    enabled.claim(other.token, randomUUID(), await instruction(other.token)),
  );
  const exported = await memberExportStore(pool).exportOwned(owner.token);
  if (exported.kind !== "ready") throw Error("Expected an owned export");
  const records = exported.payload.records.studyAllowanceClaims!;
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    claimId: claim.id,
    policyVersion: V1,
    category: "study_requests",
    quantity: 5,
  });
  expect(JSON.stringify(records)).not.toContain(key);
  expect(records[0]).not.toHaveProperty("workspaceId");

  await pool.query("DELETE FROM principals WHERE id=$1", [owner.id]);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM study_allowance_claims WHERE member_id=$1",
        [owner.id],
      )
    ).rows,
  ).toEqual([]);
  expect(await grants(owner.id)).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM study_allowance_policies WHERE version=$1",
        [V1],
      )
    ).rows,
  ).toHaveLength(1);
});
