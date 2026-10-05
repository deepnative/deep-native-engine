import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { reviewerWorklistCursor } from "../../src/reviewer-worklist-cursor.ts";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, type ObjectStorage } from "../../src/evidence.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { deterministicRegistry } from "../../src/adapters.ts";
import { localAiHoldInspectionStore } from "../../src/local-ai-hold-inspection.ts";
const pool = testPool(),
  db = store(pool),
  auth = authorizationStore(pool);
const bytes = new Map<string, Buffer>();
const objects: ObjectStorage = {
  put: async (key, value) => {
    bytes.set(key, value);
  },
  get: async (key) => {
    const value = bytes.get(key);
    if (!value) throw Error("Invented bytes absent");
    return value;
  },
  remove: async (key) => {
    bytes.delete(key);
  },
};
const registry = deterministicRegistry({}, "test");
const local = localAiConsentStore(pool, objects, {
  mode: "test",
  adapter: () => ({
    ...registry.adapter("ai", "test"),
    execute: async () => {
      throw Error("Invented ambiguous outcome");
    },
  }),
});
const evidence = evidenceStore(pool, objects, "invented-hold-test-secret");
const inspection = localAiHoldInspectionStore(pool, {
  mode: "test",
  enabled: true,
  secret: Buffer.alloc(32, 7),
});
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  await pool.query(
    "INSERT INTO local_ai_control(singleton,paused) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET paused=false",
  );
  bytes.clear();
});
afterAll(() => pool.end());
async function fixture(
  background: "explorer" | "professional" | "technical" = "explorer",
  run = true,
) {
  const ownerToken = randomBytes(32).toString("hex"),
    adminToken = randomBytes(32).toString("hex"),
    operatorToken = randomBytes(32).toString("hex");
  await db.create(ownerToken, { background, goal: "everyday" });
  const owner = await db.session(ownerToken);
  if (owner.kind !== "active") throw Error("Invented owner absent");
  const starts = new Date(Date.now() - 60000),
    expires = new Date(Date.now() + 3600000);
  const adminId = await auth.provisionStaff(
      adminToken,
      "platform_admin",
      expires,
    ),
    operatorId = await auth.provisionStaff(operatorToken, "operator", expires);
  const upload = await evidence.upload(ownerToken, {
    name: "PRIVATE-NAME-MUST-NOT-LEAVE",
    mediaType: "text/plain",
    data: Buffer.from("PRIVATE-SOURCE-MUST-NOT-LEAVE"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (upload.kind !== "created") throw Error("Invented upload absent");
  await evidence.transitionQuarantine(upload.id, "clean");
  const permission = await local.grant(ownerToken, upload.id);
  if (permission.kind !== "granted") throw Error("Invented permission absent");
  const unitId = await syntheticLedger(pool).grant(
    owner.learner.id,
    "study_requests",
    1,
    randomUUID(),
    { startsAt: starts.toISOString(), expiresAt: expires.toISOString() },
  );
  const queued = await local.enqueueMetered(
    ownerToken,
    permission.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Invented request absent");
  if (run) {
    await local.run(ownerToken, queued.jobId);
    expect(
      (
        await pool.query("SELECT status FROM adapter_jobs WHERE id=$1", [
          queued.jobId,
        ])
      ).rows[0].status,
    ).toBe("needs_reconciliation");
  }
  return {
    ownerToken,
    ownerId: owner.learner.id,
    adminToken,
    adminId,
    operatorToken,
    operatorId,
    jobId: queued.jobId,
    evidenceId: upload.id,
    receiptId: permission.receiptId,
    unitId,
    starts,
    expires,
  };
}
async function accounting(jobId: string) {
  const job = (
    await pool.query(
      "SELECT to_jsonb(j) AS value FROM adapter_jobs j WHERE id=$1",
      [jobId],
    )
  ).rows;
  const balance = (
    await pool.query(
      "SELECT to_jsonb(g) AS value FROM synthetic_entitlement_grants g ORDER BY id",
    )
  ).rows;
  const reservations = (
    await pool.query(
      "SELECT to_jsonb(r) AS value FROM synthetic_entitlement_reservations r ORDER BY id",
    )
  ).rows;
  const events = (
    await pool.query(
      "SELECT to_jsonb(e) AS value FROM synthetic_entitlement_events e ORDER BY id",
    )
  ).rows;
  return { job, balance, reservations, events };
}
it.each(["explorer", "professional", "technical"] as const)(
  "requires an exact assignment and leaves %s hold accounting unchanged",
  async (background) => {
    const f = await fixture(background),
      before = await accounting(f.jobId);
    expect((await inspection.list(f.operatorToken)).kind).toBe("denied");
    expect(
      (
        await inspection.grant(
          f.adminToken,
          f.jobId,
          f.operatorId,
          f.starts,
          f.expires,
          randomUUID(),
        )
      ).kind,
    ).toBe("applied");
    const listed = await inspection.list(f.operatorToken);
    expect(listed.kind).toBe("ready");
    if (listed.kind !== "ready") throw Error("Expected assigned worklist");
    expect(listed.items.map((x) => x.jobId)).toEqual([f.jobId]);
    const detail = await inspection.detail(f.operatorToken, f.jobId);
    expect(detail.kind).toBe("ready");
    const encoded = JSON.stringify({ listed, detail });
    for (const privateValue of [
      f.ownerId,
      f.evidenceId,
      f.receiptId,
      f.unitId,
      f.adminId,
      f.operatorId,
      f.ownerToken,
      "PRIVATE-NAME-MUST-NOT-LEAVE",
      "PRIVATE-SOURCE-MUST-NOT-LEAVE",
    ])
      expect(encoded).not.toContain(privateValue);
    expect(await accounting(f.jobId)).toEqual(before);
    for (const actor of [
      f.ownerToken,
      f.adminToken,
      randomBytes(32).toString("hex"),
    ]) {
      expect((await inspection.list(actor)).kind).toBe("denied");
      expect((await inspection.detail(actor, f.jobId)).kind).toBe("denied");
    }
  },
);
it("replays the original grant, conflicts on changed instruction and revokes once", async () => {
  const f = await fixture(),
    key = randomUUID();
  const grant = await inspection.grant(
    f.adminToken,
    f.jobId,
    f.operatorId,
    f.starts,
    f.expires,
    key,
  );
  expect(grant.kind).toBe("applied");
  if (!("grantId" in grant)) throw Error("Expected exact grant");
  expect(
    await inspection.grant(
      f.adminToken,
      f.jobId,
      f.operatorId,
      f.starts,
      f.expires,
      key,
    ),
  ).toEqual({ kind: "replayed", grantId: grant.grantId });
  expect(
    (
      await inspection.grant(
        f.adminToken,
        f.jobId,
        f.operatorId,
        f.starts,
        new Date(+f.expires - 1000),
        key,
      )
    ).kind,
  ).toBe("conflict");
  expect((await inspection.revoke(f.operatorToken, grant.grantId)).kind).toBe(
    "denied",
  );
  expect((await inspection.revoke(f.adminToken, grant.grantId)).kind).toBe(
    "applied",
  );
  expect((await inspection.revoke(f.adminToken, grant.grantId)).kind).toBe(
    "replayed",
  );
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "denied",
  );
  expect(
    (
      await pool.query(
        "SELECT action,count(*)::int AS count FROM local_ai_hold_inspection_events GROUP BY action ORDER BY action",
      )
    ).rows,
  ).toEqual([
    { action: "grant-created", count: 1 },
    { action: "grant-revoked", count: 1 },
  ]);
});
it("retains only assigned content-free hold visibility after source withdrawal, then erases it with the member", async () => {
  const f = await fixture();
  await inspection.grant(
    f.adminToken,
    f.jobId,
    f.operatorId,
    f.starts,
    f.expires,
    randomUUID(),
  );
  await local.withdraw(f.ownerToken, f.receiptId);
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "ready",
  );
  await evidence.remove(f.ownerToken, f.evidenceId);
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "ready",
  );
  expect(
    (
      await pool.query(
        "SELECT local_ai_receipt_id FROM adapter_jobs WHERE id=$1",
        [f.jobId],
      )
    ).rows[0].local_ai_receipt_id,
  ).toBeNull();
  await db.remove(f.ownerId);
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "denied",
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM local_ai_hold_inspection_grants WHERE job_id=$1",
        [f.jobId],
      )
    ).rows[0].count,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM local_ai_hold_inspection_events WHERE job_id=$1",
        [f.jobId],
      )
    ).rows[0].count,
  ).toBe(0);
});

it("displays an expired running claim without rewriting it or its held unit", async () => {
  const f = await fixture("professional", false);
  await pool.query(
    "UPDATE adapter_jobs SET status='running',attempt_count=1,attempt_token=$2,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [f.jobId, randomUUID()],
  );
  await inspection.grant(
    f.adminToken,
    f.jobId,
    f.operatorId,
    f.starts,
    f.expires,
    randomUUID(),
  );
  const before = await accounting(f.jobId),
    list = await inspection.list(f.operatorToken);
  expect(list.kind).toBe("ready");
  if (list.kind !== "ready") throw Error("Expected expired-claim inspection");
  expect(list.items).toHaveLength(1);
  expect(list.items[0]?.state).toBe("expired-claim");
  expect(list.items[0]?.status).toBe("running");
  expect(await accounting(f.jobId)).toEqual(before);
});
it("current operator role, principal and exact grant are required on every fresh read", async () => {
  const f = await fixture();
  const grant = await inspection.grant(
    f.adminToken,
    f.jobId,
    f.operatorId,
    f.starts,
    f.expires,
    randomUUID(),
  );
  if (!("grantId" in grant)) throw Error("Expected grant");
  await pool.query(
    "UPDATE staff_profiles SET role='coach' WHERE principal_id=$1",
    [f.operatorId],
  );
  expect((await inspection.list(f.operatorToken)).kind).toBe("denied");
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "denied",
  );
  await pool.query(
    "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1",
    [f.operatorId],
  );
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "ready",
  );
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [f.operatorId],
  );
  expect((await inspection.list(f.operatorToken)).kind).toBe("denied");
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "denied",
  );
});
it("cannot grant private job metadata through a member, an operator or a self-assignment", async () => {
  const f = await fixture(),
    before = await accounting(f.jobId);
  for (const actor of [f.ownerToken, f.operatorToken])
    expect(
      (
        await inspection.grant(
          actor,
          f.jobId,
          f.operatorId,
          f.starts,
          f.expires,
          randomUUID(),
        )
      ).kind,
    ).toBe("denied");
  expect(
    (
      await inspection.grant(
        f.adminToken,
        f.jobId,
        f.adminId,
        f.starts,
        f.expires,
        randomUUID(),
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await inspection.grant(
        f.adminToken,
        randomUUID(),
        f.operatorId,
        f.starts,
        f.expires,
        randomUUID(),
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM local_ai_hold_inspection_grants",
      )
    ).rows[0].count,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM local_ai_hold_inspection_events",
      )
    ).rows[0].count,
  ).toBe(0);
  expect(await accounting(f.jobId)).toEqual(before);
});

it("pauses new grants and inspection while retaining exact administrator revocation", async () => {
  const f = await fixture();
  const grant = await inspection.grant(
    f.adminToken,
    f.jobId,
    f.operatorId,
    f.starts,
    f.expires,
    randomUUID(),
  );
  if (!("grantId" in grant)) throw Error("Expected grant");
  const paused = localAiHoldInspectionStore(pool, {
    mode: "test",
    enabled: false,
  });
  const before = await accounting(f.jobId);
  expect(await paused.list(f.operatorToken)).toEqual({ kind: "unavailable" });
  expect(
    await paused.grant(
      f.adminToken,
      f.jobId,
      f.operatorId,
      f.starts,
      f.expires,
      randomUUID(),
    ),
  ).toEqual({ kind: "unavailable" });
  expect((await paused.revoke(f.adminToken, grant.grantId)).kind).toBe(
    "applied",
  );
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "denied",
  );
  expect(await accounting(f.jobId)).toEqual(before);
});
it("reruns migration without assigning legacy jobs and preserves immutable grant history", async () => {
  const f = await fixture();
  await migrate(pool);
  expect((await inspection.list(f.operatorToken)).kind).toBe("denied");
  const grant = await inspection.grant(
    f.adminToken,
    f.jobId,
    f.operatorId,
    f.starts,
    f.expires,
    randomUUID(),
  );
  if (!("grantId" in grant)) throw Error("Expected grant");
  await expect(
    pool.query(
      "UPDATE local_ai_hold_inspection_grants SET purpose='other-purpose' WHERE id=$1",
      [grant.grantId],
    ),
  ).rejects.toThrow();
  await expect(
    pool.query("DELETE FROM local_ai_hold_inspection_grants WHERE id=$1", [
      grant.grantId,
    ]),
  ).rejects.toThrow();
  await expect(
    pool.query(
      "DELETE FROM local_ai_hold_inspection_events WHERE grant_id=$1",
      [grant.grantId],
    ),
  ).rejects.toThrow();
  await migrate(pool);
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "ready",
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM local_ai_hold_inspection_events WHERE grant_id=$1",
        [grant.grantId],
      )
    ).rows[0].count,
  ).toBe(1);
});
it.each(["commit", "handback"] as const)(
  "withholds metadata when current operator authority expires at %s",
  async (boundary) => {
    const f = await fixture();
    await inspection.grant(
      f.adminToken,
      f.jobId,
      f.operatorId,
      f.starts,
      f.expires,
      randomUUID(),
    );
    const before = await accounting(f.jobId);
    const client = await pool.connect();
    let committed = false,
      released = false;
    const controlled = localAiHoldInspectionStore(
      {
        connect: async () => ({
          async query(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              committed = true;
              if (boundary === "commit")
                await pool.query("SELECT pg_sleep(0.6)");
            }
            return result;
          },
          release(error?: Error) {
            if (boundary === "handback" && committed) {
              const end = performance.now() + 600;
              while (performance.now() < end) {
                /* synchronous native handback */
              }
            }
            released = true;
            client.release(error);
          },
        }),
      } as unknown as Pool,
      { mode: "test", enabled: true, secret: Buffer.alloc(32, 7) },
    );
    try {
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",
        [f.operatorId],
      );
      expect(await controlled.detail(f.operatorToken, f.jobId)).toEqual({
        kind: "denied",
      });
      expect(committed).toBe(true);
      expect(released).toBe(true);
      expect(await accounting(f.jobId)).toEqual(before);
    } finally {
      if (!released) client.release(true);
    }
  },
);

function rendezvous() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("denies a discovered job when exact grant revocation wins before reader locks", async () => {
  const f = await fixture();
  const grant = await inspection.grant(
    f.adminToken,
    f.jobId,
    f.operatorId,
    f.starts,
    f.expires,
    randomUUID(),
  );
  if (!("grantId" in grant)) throw Error("Expected grant");
  const reached = rendezvous(),
    resume = rendezvous();
  const client = await pool.connect();
  let intercepted = false,
    released = false;
  const controlled = localAiHoldInspectionStore(
    {
      connect: async () => ({
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (!intercepted && sql.includes("WITH instant AS MATERIALIZED")) {
            intercepted = true;
            reached.resolve();
            await resume.promise;
          }
          return result;
        },
        release(error?: Error) {
          released = true;
          client.release(error);
        },
      }),
    } as unknown as Pool,
    { mode: "test", enabled: true },
  );
  const before = await accounting(f.jobId);
  const pending = controlled.detail(f.operatorToken, f.jobId);
  try {
    await reached.promise;
    expect((await inspection.revoke(f.adminToken, grant.grantId)).kind).toBe(
      "applied",
    );
    resume.resolve();
    expect(await pending).toEqual({ kind: "denied" });
    expect(await accounting(f.jobId)).toEqual(before);
  } finally {
    resume.resolve();
    await pending;
    if (!released) client.release(true);
  }
});
it("serializes exact grant revocation behind a reader that already holds its authority fences", async () => {
  const f = await fixture();
  const grant = await inspection.grant(
    f.adminToken,
    f.jobId,
    f.operatorId,
    f.starts,
    f.expires,
    randomUUID(),
  );
  if (!("grantId" in grant)) throw Error("Expected grant");
  const reached = rendezvous(),
    resume = rendezvous();
  const reader = await pool.connect(),
    revoker = await pool.connect();
  const pid = (await revoker.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid;
  let intercepted = false,
    readerReleased = false,
    revokerReleased = false;
  const controlled = localAiHoldInspectionStore(
    {
      connect: async () => ({
        async query(sql: string, values?: unknown[]) {
          const result = await reader.query(sql, values);
          if (
            !intercepted &&
            sql.includes(
              "SELECT id FROM local_ai_hold_inspection_grants WHERE id=ANY",
            )
          ) {
            intercepted = true;
            reached.resolve();
            await resume.promise;
          }
          return result;
        },
        release(error?: Error) {
          readerReleased = true;
          reader.release(error);
        },
      }),
    } as unknown as Pool,
    { mode: "test", enabled: true },
  );
  const competing = localAiHoldInspectionStore(
    {
      connect: async () => ({
        query: (sql: string, values?: unknown[]) => revoker.query(sql, values),
        release(error?: Error) {
          revokerReleased = true;
          revoker.release(error);
        },
      }),
    } as unknown as Pool,
    { mode: "test", enabled: true },
  );
  const before = await accounting(f.jobId);
  const reading = controlled.detail(f.operatorToken, f.jobId);
  let revoking: ReturnType<typeof inspection.revoke> | undefined;
  try {
    await reached.promise;
    revoking = competing.revoke(f.adminToken, grant.grantId);
    let observed = false;
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      const blocked = await pool.query(
        "SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",
        [pid],
      );
      if (blocked.rows[0].blocked) {
        observed = true;
        break;
      }
      await new Promise<void>((done) => setImmediate(done));
    }
    expect(observed).toBe(true);
    resume.resolve();
    expect((await reading).kind).toBe("ready");
    expect((await revoking).kind).toBe("applied");
    expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
      "denied",
    );
    expect(await accounting(f.jobId)).toEqual(before);
  } finally {
    resume.resolve();
    await reading;
    if (revoking) await revoking;
    if (!readerReleased) reader.release(true);
    if (!revokerReleased) revoker.release(true);
  }
});

it("bounds navigation to twenty exact assignments and rechecks actor, purpose and revocation on continuation", async () => {
  const first = await fixture();
  const assigned: { jobId: string; grantId: string; adminToken: string }[] = [];
  for (let i = 0; i < 21; i++) {
    const f = i === 0 ? first : await fixture();
    const grant = await inspection.grant(
      f.adminToken,
      f.jobId,
      first.operatorId,
      f.starts,
      first.expires,
      randomUUID(),
    );
    if (!("grantId" in grant)) throw Error("Expected grant");
    assigned.push({
      jobId: f.jobId,
      grantId: grant.grantId,
      adminToken: f.adminToken,
    });
  }
  const unrelated = await fixture();
  const page = await inspection.list(first.operatorToken);
  expect(page.kind).toBe("ready");
  if (page.kind !== "ready" || !page.next) throw Error("Expected continuation");
  expect(page.items).toHaveLength(20);
  expect(page.items.some((x) => x.jobId === unrelated.jobId)).toBe(false);
  expect(await inspection.list(unrelated.operatorToken, page.next)).toEqual({
    kind: "invalid",
  });
  const reviewerCursor = reviewerWorklistCursor(Buffer.alloc(32, 7)).encode(
    first.operatorToken,
    "active",
    {
      id: first.jobId,
      at: first.starts.toISOString().replace(/(\.\d{3})Z$/, "$1000Z"),
    },
  );
  expect(await inspection.list(first.operatorToken, reviewerCursor)).toEqual({
    kind: "invalid",
  });
  const last = await inspection.list(first.operatorToken, page.next);
  expect(last.kind).toBe("ready");
  if (last.kind !== "ready") throw Error("Expected last page");
  expect(last.items).toHaveLength(1);
  expect(last.next).toBeNull();
  expect(new Set([...page.items, ...last.items].map((x) => x.jobId))).toEqual(
    new Set(assigned.map((x) => x.jobId)),
  );
  const target = assigned.find((x) => x.jobId === last.items[0]?.jobId)!;
  expect(
    (await inspection.revoke(target.adminToken, target.grantId)).kind,
  ).toBe("applied");
  expect(await inspection.list(first.operatorToken, page.next)).toEqual({
    kind: "denied",
  });
});

it.each(["commit", "handback"] as const)(
  "withholds metadata when exact inspection grant expires at %s",
  async (boundary) => {
    const f = await fixture();
    await inspection.grant(
      f.adminToken,
      f.jobId,
      f.operatorId,
      f.starts,
      new Date(Date.now() + 400),
      randomUUID(),
    );
    const before = await accounting(f.jobId);
    const client = await pool.connect();
    let committed = false,
      released = false;
    const controlled = localAiHoldInspectionStore(
      {
        connect: async () => ({
          async query(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              committed = true;
              if (boundary === "commit")
                await pool.query("SELECT pg_sleep(0.6)");
            }
            return result;
          },
          release(error?: Error) {
            if (boundary === "handback" && committed) {
              const end = performance.now() + 600;
              while (performance.now() < end) {
                /* synchronous native handback */
              }
            }
            released = true;
            client.release(error);
          },
        }),
      } as unknown as Pool,
      { mode: "test", enabled: true, secret: Buffer.alloc(32, 7) },
    );
    try {
      expect(await controlled.detail(f.operatorToken, f.jobId)).toEqual({
        kind: "denied",
      });
      expect(committed).toBe(true);
      expect(released).toBe(true);
      expect(await accounting(f.jobId)).toEqual(before);
    } finally {
      if (!released) client.release(true);
    }
  },
);

it("full owner erasure denies stale inspection while retaining another member's exact hold", async () => {
  const first = await fixture(),
    second = await fixture("technical");
  for (const f of [first, second])
    expect(
      (
        await inspection.grant(
          f.adminToken,
          f.jobId,
          f.operatorId,
          f.starts,
          f.expires,
          randomUUID(),
        )
      ).kind,
    ).toBe("applied");
  const otherBefore = await pool.query(
    "SELECT to_jsonb(j) AS value FROM adapter_jobs j WHERE id=$1",
    [second.jobId],
  );
  await db.remove(first.ownerId);
  expect(await inspection.detail(first.operatorToken, first.jobId)).toEqual({
    kind: "denied",
  });
  expect(
    (await inspection.detail(second.operatorToken, second.jobId)).kind,
  ).toBe("ready");
  expect(
    (
      await pool.query(
        "SELECT to_jsonb(j) AS value FROM adapter_jobs j WHERE id=$1",
        [second.jobId],
      )
    ).rows,
  ).toEqual(otherBefore.rows);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM local_ai_hold_inspection_events WHERE member_id=$1",
        [second.ownerId],
      )
    ).rows[0].count,
  ).toBe(1);
});
it("bounded lock failure withholds metadata and discards all reader authority locks", async () => {
  const f = await fixture();
  await inspection.grant(
    f.adminToken,
    f.jobId,
    f.operatorId,
    f.starts,
    f.expires,
    randomUUID(),
  );
  const blocker = await pool.connect(),
    reader = await pool.connect();
  const pid = (await reader.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid;
  let released = false;
  const controlled = localAiHoldInspectionStore(
    {
      connect: async () => ({
        query: (sql: string, values?: unknown[]) => reader.query(sql, values),
        release(error?: Error) {
          released = true;
          reader.release(error);
        },
      }),
    } as unknown as Pool,
    { mode: "test", enabled: true },
  );
  const before = await accounting(f.jobId);
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM adapter_jobs WHERE id=$1 FOR UPDATE", [
      f.jobId,
    ]);
    const start = performance.now();
    expect(await controlled.detail(f.operatorToken, f.jobId)).toEqual({
      kind: "unavailable",
    });
    expect(performance.now() - start).toBeLessThan(10000);
    expect(released).toBe(true);
    await blocker.query("ROLLBACK");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM pg_locks WHERE pid=$1",
          [pid],
        )
      ).rows[0].count,
    ).toBe(0);
    expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
      "ready",
    );
    expect(await accounting(f.jobId)).toEqual(before);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    if (!released) reader.release(true);
  }
}, 15000);
