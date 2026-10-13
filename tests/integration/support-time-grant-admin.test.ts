import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { memberExportStore } from "../../src/member-export.ts";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { supportTimeGrantAdminStore } from "../../src/support-time-grant-admin.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  support = supportRequestStore(pool),
  ledger = syntheticLedger(pool);
const admin = supportTimeGrantAdminStore(
  pool,
  { mode: "test", administration: "enabled", writes: true },
  Buffer.from("invented support cursor"),
);
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(() => pool.end());
const fresh = () => randomBytes(32).toString("hex");
async function fixture() {
  const owner = fresh(),
    administrator = fresh(),
    operator = fresh(),
    end = new Date(Date.now() + 3600000);
  await members.create(owner, { background: "professional", goal: "work" });
  const session = await members.session(owner);
  if (session.kind !== "active") throw Error("Invented member required");
  const administratorId = await auth.provisionStaff(
      administrator,
      "platform_admin",
      end,
    ),
    operatorId = await auth.provisionStaff(operator, "operator", end);
  await ledger.grant(session.learner.id, "support_minutes", 20, randomUUID(), {
    startsAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: end.toISOString(),
  });
  const request = await support.create(owner, {
    idempotencyKey: randomUUID(),
    subject: "PRIVATE-INVENTED-SUBJECT",
    body: "PRIVATE-INVENTED-SUPPORT-TEXT",
  });
  if (!("receipt" in request)) throw Error("Request required");
  const held = await support.time!.allocate(
    owner,
    request.receipt.requestId,
    randomUUID(),
    20,
  );
  if (!("receipt" in held)) throw Error("Held allocation required");
  const input = {
    requestId: request.receipt.requestId,
    allocationId: held.receipt.allocationId,
    operatorId,
    operationId: randomUUID(),
    startsAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(+end - 1000).toISOString(),
  };
  return {
    owner,
    administrator,
    administratorId,
    operator,
    operatorId,
    memberId: session.learner.id,
    end,
    input,
  };
}
const savedRow = (result: Awaited<ReturnType<typeof admin.grant>>) =>
  row(result);
function row(result: Awaited<ReturnType<typeof admin.grant>>) {
  expect(["applied", "replayed"]).toContain(result.kind);
  if (result.kind !== "applied" && result.kind !== "replayed")
    throw Error("Grant required");
  return result.row;
}
const counts = async () =>
  (
    await pool.query(
      "SELECT (SELECT count(*)::int FROM support_time_grants) grants,(SELECT count(*)::int FROM support_time_events WHERE action='grant-created') created,(SELECT count(*)::int FROM support_time_events WHERE action='grant-revoked') revoked,(SELECT count(*)::int FROM support_time_grant_revocations) operations",
    )
  ).rows[0];
it("SUPPORT-GRANT-01/02/03 exact content-free check and grant reuse native once-only settlement without request permission", async () => {
  const f = await fixture(),
    before = await counts();
  const checked = await admin.check(f.administrator, {
    requestId: f.input.requestId,
    allocationId: f.input.allocationId,
    operatorId: f.operatorId,
  });
  expect(checked).toMatchObject({
    kind: "ready",
    check: { ceiling: 20, allocationState: "allocated" },
  });
  expect(await counts()).toEqual(before);
  expect(JSON.stringify(checked)).not.toContain("PRIVATE-INVENTED");
  expect(JSON.stringify(checked)).not.toContain(f.owner);
  const saved = row(await admin.grant(f.administrator, f.input));
  expect(saved).toMatchObject({ state: "active", role: "operator" });
  expect(await support.operatorWorklist(f.operator)).toMatchObject({
    kind: "ready",
    value: { items: [] },
  });
  const scope = {
    requestId: f.input.requestId,
    allocationId: f.input.allocationId,
    grantId: saved.grantId,
  };
  expect(
    await support.time!.begin(f.operator, scope, randomUUID()),
  ).toMatchObject({ kind: "applied" });
  const start = new Date(Date.now() - 3600000),
    key = randomUUID(),
    intervals = {
      supportStart: start,
      supportEnd: new Date(+start + 600000),
      preparationStart: new Date(+start + 600000),
      preparationEnd: new Date(+start + 900000),
    };
  expect(
    await support.time!.record(f.operator, scope, key, intervals),
  ).toMatchObject({
    kind: "applied",
    receipt: {
      held: 0,
      consumed: 15,
      released: 5,
      supportMinutes: 10,
      preparationMinutes: 5,
    },
  });
  expect(
    await support.time!.record(f.operator, scope, key, intervals),
  ).toMatchObject({ kind: "replayed", receipt: { consumed: 15, released: 5 } });
  expect(await support.time!.receipt(f.owner, f.input.requestId)).toMatchObject(
    { kind: "ready", value: { consumed: 15, released: 5, state: "completed" } },
  );
  expect(await counts()).toMatchObject({ grants: 1, created: 1, revoked: 0 });
});
it("SUPPORT-GRANT-02/06 rejects an overlong window, self and wrong role without shortening or creating grants", async () => {
  const f = await fixture();
  expect(
    await admin.grant(f.administrator, {
      ...f.input,
      expiresAt: new Date(+f.end + 1000).toISOString(),
    }),
  ).toMatchObject({ kind: "invalid" });
  expect(
    await admin.grant(f.administrator, {
      ...f.input,
      operatorId: f.administratorId,
    }),
  ).toMatchObject({ kind: "denied" });
  const reviewer = fresh(),
    reviewerId = await auth.provisionStaff(reviewer, "reviewer", f.end);
  expect(
    await admin.grant(f.administrator, { ...f.input, operatorId: reviewerId }),
  ).toMatchObject({ kind: "denied" });
  for (const token of [f.owner, f.operator, reviewer, fresh(), "invalid"])
    expect(await admin.open(token)).toMatchObject({ kind: "denied" });
  expect(await counts()).toMatchObject({ grants: 0, created: 0 });
});
it("SUPPORT-GRANT-04 concurrent exact creation retains one operation; changed payload conflicts", async () => {
  const f = await fixture(),
    results = await Promise.all(
      Array.from({ length: 4 }, () => admin.grant(f.administrator, f.input)),
    );
  expect(results.filter((r) => r.kind === "applied")).toHaveLength(1);
  expect(new Set(results.map((r) => row(r).grantId)).size).toBe(1);
  expect(await counts()).toMatchObject({ grants: 1, created: 1 });
  expect(
    await admin.grant(f.administrator, {
      ...f.input,
      startsAt: new Date(Date.now() - 120000).toISOString(),
    }),
  ).toMatchObject({ kind: "conflict" });
  const recovered = await admin.recover(f.administrator, f.input.operationId);
  expect(recovered).toMatchObject({
    kind: "ready",
    row: { grantId: row(results[0]!).grantId },
  });
});
it("SUPPORT-GRANT-04/05 original exact revocation and independent overlapping permission remain distinct", async () => {
  const f = await fixture(),
    first = row(await admin.grant(f.administrator, f.input)),
    second = row(
      await admin.grant(f.administrator, {
        ...f.input,
        operationId: randomUUID(),
      }),
    );
  const note = await support.grant(f.administrator, {
    requestId: f.input.requestId,
    staffId: f.operatorId,
    role: "operator",
    idempotencyKey: randomUUID(),
    startsAt: new Date(f.input.startsAt),
    expiresAt: new Date(f.input.expiresAt),
  });
  if (!("grantId" in note)) throw Error("Request grant required");
  const operation = { grantId: first.grantId, operationId: randomUUID() };
  const result = await admin.revoke(f.administrator, operation);
  expect(result).toMatchObject({
    kind: "applied",
    row: { state: "revoked" },
    revocation: { outcome: "revoked" },
  });
  expect(await admin.revoke(f.administrator, operation)).toMatchObject({
    kind: "replayed",
    revocation: { outcome: "revoked" },
  });
  expect(
    await admin.revoke(f.administrator, {
      grantId: second.grantId,
      operationId: operation.operationId,
    }),
  ).toMatchObject({ kind: "conflict" });
  expect(
    await admin.recoverRevocation(f.administrator, operation.operationId),
  ).toMatchObject({ kind: "ready", revocation: { outcome: "revoked" } });
  expect(
    await admin.revoke(f.administrator, {
      grantId: first.grantId,
      operationId: randomUUID(),
    }),
  ).toMatchObject({ kind: "applied", revocation: { outcome: "unchanged" } });
  expect(await admin.exact(f.administrator, second.grantId)).toMatchObject({
    kind: "ready",
    row: { state: "active" },
  });
  expect(
    await support.operatorDetail(f.operator, {
      requestId: f.input.requestId,
      grantId: note.grantId,
    }),
  ).toMatchObject({ kind: "ready" });
  expect(await admin.grant(f.administrator, f.input)).toMatchObject({
    kind: "conflict",
  });
  expect(await counts()).toMatchObject({
    grants: 2,
    created: 2,
    revoked: 1,
    operations: 2,
  });
});
it("SUPPORT-GRANT-05 bound begun work stays unresolved and held when its time permission is revoked", async () => {
  const f = await fixture(),
    saved = row(await admin.grant(f.administrator, f.input));
  await support.time!.begin(
    f.operator,
    {
      requestId: f.input.requestId,
      allocationId: f.input.allocationId,
      grantId: saved.grantId,
    },
    randomUUID(),
  );
  expect(
    await admin.revoke(f.administrator, {
      grantId: saved.grantId,
      operationId: randomUUID(),
    }),
  ).toMatchObject({ kind: "applied" });
  expect(await support.time!.receipt(f.owner, f.input.requestId)).toMatchObject(
    {
      kind: "ready",
      value: {
        state: "needs_reconciliation",
        held: 20,
        consumed: 0,
        released: 0,
      },
    },
  );
});
it("SUPPORT-GRANT-07 bounded actor-owned pages reject forged/foreign cursors and exact original operations", async () => {
  const f = await fixture();
  for (let i = 0; i < 22; i++)
    row(
      await admin.grant(f.administrator, {
        ...f.input,
        operationId: randomUUID(),
      }),
    );
  const first = await admin.history(f.administrator);
  expect(first.kind).toBe("ready");
  if (first.kind !== "ready") throw Error("History required");
  expect(first.rows).toHaveLength(20);
  expect(first.next).toBeTypeOf("string");
  const second = await admin.history(f.administrator, first.next!);
  expect(second).toMatchObject({ kind: "ready", next: null });
  if (second.kind !== "ready") throw Error("Page required");
  expect(second.rows).toHaveLength(2);
  expect(
    new Set([...first.rows, ...second.rows].map((r) => r.grantId)).size,
  ).toBe(22);
  const other = fresh();
  await auth.provisionStaff(other, "platform_admin", f.end);
  expect(await admin.history(other, first.next!)).toMatchObject({
    kind: "invalid",
  });
  expect(
    await admin.history(f.administrator, first.next! + "forged"),
  ).toMatchObject({ kind: "invalid" });
  expect(await admin.exact(other, first.rows[0]!.grantId)).toMatchObject({
    kind: "absent",
  });
  expect(await admin.recover(other, f.input.operationId)).toMatchObject({
    kind: "absent",
  });
  expect(
    await admin.revoke(other, {
      grantId: first.rows[0]!.grantId,
      operationId: randomUUID(),
    }),
  ).toMatchObject({ kind: "denied" });
});
it("SUPPORT-GRANT-07/08 repeat migration preserves legacy CLI permission; recovery-only blocks creation while write pause blocks mutations", async () => {
  const f = await fixture();
  const legacy = await support.time!.grant(f.administrator, {
    requestId: f.input.requestId,
    allocationId: f.input.allocationId,
    staffId: f.operatorId,
    role: "operator",
    idempotencyKey: f.input.operationId,
    startsAt: new Date(f.input.startsAt),
    expiresAt: new Date(f.input.expiresAt),
  });
  expect(legacy.kind).toBe("created");
  if (!("grantId" in legacy)) throw Error("Legacy grant required");
  await migrate(pool);
  expect(await counts()).toMatchObject({
    grants: 1,
    created: 1,
    operations: 0,
  });
  const recovery = supportTimeGrantAdminStore(pool, {
    mode: "test",
    administration: "recovery-only",
    writes: true,
  });
  expect(await recovery.grant(f.administrator, f.input)).toMatchObject({
    kind: "replayed",
    row: { grantId: legacy.grantId },
  });
  expect(
    await recovery.grant(f.administrator, {
      ...f.input,
      operationId: randomUUID(),
    }),
  ).toMatchObject({ kind: "unavailable" });
  const paused = supportTimeGrantAdminStore(pool, {
    mode: "test",
    administration: "enabled",
    writes: false,
  });
  expect(await paused.exact(f.administrator, legacy.grantId)).toMatchObject({
    kind: "ready",
    writesEnabled: false,
  });
  expect(await paused.grant(f.administrator, f.input)).toMatchObject({
    kind: "unavailable",
  });
  expect(
    await paused.revoke(f.administrator, {
      grantId: legacy.grantId,
      operationId: randomUUID(),
    }),
  ).toMatchObject({ kind: "unavailable" });
  expect(
    await recovery.revoke(f.administrator, {
      grantId: legacy.grantId,
      operationId: randomUUID(),
    }),
  ).toMatchObject({ kind: "applied" });
});
it("SUPPORT-GRANT-06/07 withdrawn/erased sources retain or remove content-free originals without resurrection", async () => {
  const f = await fixture(),
    saved = row(await admin.grant(f.administrator, f.input));
  await support.withdraw(f.owner, f.input.requestId);
  expect(await admin.exact(f.administrator, saved.grantId)).toMatchObject({
    kind: "ready",
    row: { sourceAvailable: false },
  });
  expect(
    await admin.grant(f.administrator, {
      ...f.input,
      operationId: randomUUID(),
    }),
  ).toMatchObject({ kind: "denied" });
  await admin.revoke(f.administrator, {
    grantId: saved.grantId,
    operationId: randomUUID(),
  });
  await members.remove(f.memberId);
  expect(await counts()).toMatchObject({ grants: 0, operations: 0 });
  expect(
    await admin.recover(f.administrator, f.input.operationId),
  ).toMatchObject({ kind: "absent" });
});

it.each(["grant", "revoke"] as const)(
  "SUPPORT-GRANT-06 lost %s COMMIT acknowledgement retains exactly one recoverable original operation",
  async (action) => {
    const f = await fixture(),
      row =
        action === "revoke"
          ? savedRow(await admin.grant(f.administrator, f.input))
          : null,
      operationId = randomUUID();
    let commits = 0,
      rollbacks = 0;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            if (sql === "ROLLBACK") rollbacks++;
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              commits++;
              throw Error("Invented lost acknowledgement");
            }
            return result;
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    const s = supportTimeGrantAdminStore(scoped, {
      mode: "test",
      administration: "enabled",
      writes: true,
    });
    expect(
      (action === "grant"
        ? await s.grant(f.administrator, f.input)
        : await s.revoke(f.administrator, {
            grantId: row!.grantId,
            operationId,
          })
      ).kind,
    ).toBe("unavailable");
    expect(commits).toBe(1);
    expect(rollbacks).toBe(0);
    expect(
      (action === "grant"
        ? await admin.recover(f.administrator, f.input.operationId)
        : await admin.recoverRevocation(f.administrator, operationId)
      ).kind,
    ).toBe("ready");
    expect(
      (action === "grant"
        ? await admin.grant(f.administrator, f.input)
        : await admin.revoke(f.administrator, {
            grantId: row!.grantId,
            operationId,
          })
      ).kind,
    ).toBe("replayed");
    expect(await counts()).toMatchObject({
      created: 1,
      revoked: action === "revoke" ? 1 : 0,
      operations: action === "revoke" ? 1 : 0,
    });
  },
);

it.each([
  ["grant", "commit"],
  ["grant", "handback"],
  ["revoke", "commit"],
  ["revoke", "handback"],
] as const)(
  "SUPPORT-GRANT-05/06 %s expiry through %s withholds an original write acknowledgement",
  async (action, phase) => {
    const f = await fixture();
    const row =
      action === "revoke"
        ? savedRow(await admin.grant(f.administrator, f.input))
        : undefined;
    const operationId = randomUUID();
    const expires = (
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '800 milliseconds' WHERE id=$1 RETURNING expires_at",
        [f.administratorId],
      )
    ).rows[0].expires_at as Date;
    const input = {
      ...f.input,
      expiresAt: new Date(+expires - 10).toISOString(),
    };
    let commits = 0,
      deadline = 0;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              commits++;
              const remaining = Number(
                (
                  await pool.query(
                    "SELECT EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000 remaining",
                    [expires],
                  )
                ).rows[0].remaining,
              );
              if (phase === "commit")
                await pool.query(
                  "SELECT pg_sleep(GREATEST(0,$1::float8)/1000+0.04)",
                  [remaining],
                );
              else deadline = performance.now() + Math.max(0, remaining) + 40;
            }
            return result;
          },
          release: (error?: Error) => {
            while (performance.now() < deadline) {
              /* Deliberately delayed native handback. */
            }
            client.release(error);
          },
        };
      },
    } as unknown as Pool;
    const target = supportTimeGrantAdminStore(scoped, {
      mode: "test",
      administration: "enabled",
      writes: true,
    });
    expect(
      (action === "grant"
        ? await target.grant(f.administrator, input)
        : await target.revoke(f.administrator, {
            grantId: row!.grantId,
            operationId,
          })
      ).kind,
    ).toBe("unavailable");
    expect(commits).toBe(1);
    expect(await counts()).toMatchObject({
      grants: 1,
      created: 1,
      revoked: action === "revoke" ? 1 : 0,
      operations: action === "revoke" ? 1 : 0,
    });
    await pool.query("UPDATE principals SET expires_at=$2 WHERE id=$1", [
      f.administratorId,
      f.end,
    ]);
    expect(
      (action === "grant"
        ? await admin.recover(f.administrator, f.input.operationId)
        : await admin.recoverRevocation(f.administrator, operationId)
      ).kind,
    ).toBe("ready");
  },
);

it.each([
  [
    "administrator role",
    "UPDATE staff_profiles SET role='coach' WHERE principal_id=$1",
    "administratorId",
  ],
  [
    "administrator revocation",
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    "administratorId",
  ],
  [
    "operator role",
    "UPDATE staff_profiles SET role='coach' WHERE principal_id=$1",
    "operatorId",
  ],
  [
    "operator expiry",
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    "operatorId",
  ],
  [
    "request withdrawal",
    "UPDATE support_requests SET subject=NULL,body=NULL,withdrawn_at=clock_timestamp() WHERE id=$1",
    "requestId",
  ],
] as const)(
  "SUPPORT-GRANT-06 %s committed during an actual lock wait denies creation without grant or accounting change",
  async (_label, sql, key) => {
    const f = await fixture(),
      holder = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query(sql, [
        key === "requestId" ? f.input.requestId : f[key],
      ]);
      const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      pending = admin.grant(f.administrator, f.input);
      let blocked = false;
      for (let i = 0; i < 400; i++) {
        if (
          (
            await pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
              [pid],
            )
          ).rowCount
        ) {
          blocked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(blocked).toBe(true);
      await holder.query("COMMIT");
      expect(await pending).toMatchObject({ kind: "denied" });
      expect(await counts()).toMatchObject({
        grants: 0,
        created: 0,
        revoked: 0,
        operations: 0,
      });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending;
    }
  },
);
it("SUPPORT-GRANT-07 additive immutable revocation records retain member export boundaries and cascade on ordinary erasure", async () => {
  const f = await fixture(),
    saved = row(await admin.grant(f.administrator, f.input)),
    operationId = randomUUID();
  await admin.revoke(f.administrator, { grantId: saved.grantId, operationId });
  await expect(
    pool.query(
      "UPDATE support_time_grant_revocations SET outcome='unchanged' WHERE grant_id=$1",
      [saved.grantId],
    ),
  ).rejects.toThrow();
  await expect(
    pool.query("DELETE FROM support_time_grant_revocations WHERE grant_id=$1", [
      saved.grantId,
    ]),
  ).rejects.toThrow();
  const exported = await memberExportStore(pool).exportOwned(f.owner);
  expect(exported.kind).toBe("ready");
  for (const key of [
    f.input.operationId,
    operationId,
    f.administrator,
    f.operator,
  ])
    expect(JSON.stringify(exported)).not.toContain(key);
  await migrate(pool);
  expect(await counts()).toMatchObject({
    created: 1,
    revoked: 1,
    operations: 1,
  });
  await members.remove(f.memberId);
  expect(await counts()).toMatchObject({ grants: 0, operations: 0 });
});
it.each([
  "open",
  "check",
  "history",
  "exact",
  "recover",
  "recoverRevocation",
] as const)(
  "SUPPORT-GRANT-06 %s withholds private metadata after native handback crosses administrator expiry",
  async (action) => {
    const f = await fixture(),
      saved = row(await admin.grant(f.administrator, f.input)),
      operationId = randomUUID();
    await admin.revoke(f.administrator, {
      grantId: saved.grantId,
      operationId,
    });
    const expires = (
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '700 milliseconds' WHERE id=$1 RETURNING expires_at",
        [f.administratorId],
      )
    ).rows[0].expires_at as Date;
    let deadline = 0,
      commits = 0;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              commits++;
              const remaining = Number(
                (
                  await pool.query(
                    "SELECT EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000 remaining",
                    [expires],
                  )
                ).rows[0].remaining,
              );
              deadline = performance.now() + Math.max(0, remaining) + 30;
            }
            return result;
          },
          release: (error?: Error) => {
            while (performance.now() < deadline) {
              /* Deliberate bounded expiry during native handback. */
            }
            client.release(error);
          },
        };
      },
    } as unknown as Pool;
    const target = supportTimeGrantAdminStore(scoped, {
      mode: "test",
      administration: "enabled",
      writes: true,
    });
    const result =
      action === "open"
        ? await target.open(f.administrator)
        : action === "check"
          ? await target.check(f.administrator, {
              requestId: f.input.requestId,
              allocationId: f.input.allocationId,
              operatorId: f.operatorId,
            })
          : action === "history"
            ? await target.history(f.administrator)
            : action === "exact"
              ? await target.exact(f.administrator, saved.grantId)
              : action === "recover"
                ? await target.recover(f.administrator, f.input.operationId)
                : await target.recoverRevocation(f.administrator, operationId);
    expect(result).toMatchObject({ kind: "denied" });
    expect(commits).toBe(1);
    expect(await counts()).toMatchObject({
      grants: 1,
      created: 1,
      revoked: 1,
      operations: 1,
    });
  },
);
it("SUPPORT-GRANT-02 scheduled and expired finite permissions cannot begin effort and history changes no accounting", async () => {
  const f = await fixture(),
    future = {
      ...f.input,
      startsAt: new Date(Date.now() + 60000).toISOString(),
    },
    scheduled = row(await admin.grant(f.administrator, future));
  expect(scheduled.state).toBe("scheduled");
  expect(
    await support.time!.begin(
      f.operator,
      {
        requestId: future.requestId,
        allocationId: future.allocationId,
        grantId: scheduled.grantId,
      },
      randomUUID(),
    ),
  ).toMatchObject({ kind: "denied" });
  const expires = (
    await pool.query(
      "SELECT clock_timestamp()+interval '800 milliseconds' end_at",
    )
  ).rows[0].end_at as Date;
  const short = {
      ...f.input,
      operationId: randomUUID(),
      expiresAt: expires.toISOString(),
    },
    saved = row(await admin.grant(f.administrator, short));
  await pool.query(
    "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.03)",
    [expires],
  );
  expect(await admin.exact(f.administrator, saved.grantId)).toMatchObject({
    kind: "ready",
    row: { state: "expired" },
  });
  expect(
    await support.time!.begin(
      f.operator,
      {
        requestId: short.requestId,
        allocationId: short.allocationId,
        grantId: saved.grantId,
      },
      randomUUID(),
    ),
  ).toMatchObject({ kind: "denied" });
  expect(await support.time!.receipt(f.owner, f.input.requestId)).toMatchObject(
    {
      kind: "ready",
      value: { state: "allocated", held: 20, consumed: 0, released: 0 },
    },
  );
  expect(await counts()).toMatchObject({ created: 2, revoked: 0 });
});
