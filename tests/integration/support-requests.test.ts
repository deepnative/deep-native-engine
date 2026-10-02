import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import {
  supportRequestStore,
  supportTextValid,
} from "../../src/support-requests.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  db = store(pool),
  auth = authorizationStore(pool);
const secret = Buffer.alloc(32, 42),
  support = supportRequestStore(pool, secret);
const token = () => randomBytes(32).toString("hex");
beforeAll(async () => {
  await migrate(pool);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs,principals,cohorts CASCADE");
});
afterAll(async () => {
  await pool.end();
});
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function controlled(match?: string, failure?: "before" | "after") {
  const connected = latch(),
    reached = latch(),
    resume = latch(),
    state = { pid: 0, calls: [] as string[], discarded: false };
  const use = supportRequestStore(
    {
      async connect() {
        const client = await pool.connect();
        state.pid = (
          await client.query("SELECT pg_backend_pid() pid")
        ).rows[0].pid;
        connected.release();
        let intercepted = false;
        return {
          async query(sql: string, values?: unknown[]) {
            state.calls.push(sql);
            const selected = match && !intercepted && sql.startsWith(match);
            if (selected) intercepted = true;
            if (selected && failure === "before")
              throw Error("Synthetic database failure");
            const result = await client.query(sql, values);
            if (selected && failure === "after")
              throw Error("Synthetic lost receipt");
            if (selected) {
              reached.release();
              await resume.wait;
            }
            return result;
          },
          release(error?: Error) {
            state.discarded = Boolean(error);
            client.release(error);
          },
        };
      },
    } as unknown as Pool,
    secret,
  );
  return { use, connected, reached, resume, state };
}
async function blocked(pid: number, by: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (
      (
        await pool.query(
          "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) blocked",
          [by, pid],
        )
      ).rows[0].blocked
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected PostgreSQL lock wait was not observed");
}
async function member(
  background: "explorer" | "professional" | "technical" = "explorer",
) {
  const value = token();
  await db.create(value, { background, goal: "everyday" });
  const session = await db.session(value);
  if (session.kind !== "active") throw Error("Synthetic member missing");
  return { token: value, id: session.learner.id };
}
async function fixture() {
  const owner = await member(),
    other = await member(),
    admin = token(),
    operator = token();
  const expiresAt = new Date(Date.now() + 3600000),
    startsAt = new Date(Date.now() - 1000);
  const adminId = await auth.provisionStaff(admin, "platform_admin", expiresAt),
    operatorId = await auth.provisionStaff(operator, "operator", expiresAt);
  const input = {
    idempotencyKey: randomUUID(),
    subject: "Invented request",
    body: "  Invented body\n🧪 ",
  };
  const created = await support.create(owner.token, input);
  expect(created.kind).toBe("created");
  if (!("receipt" in created)) throw Error("Synthetic request missing");
  const requestId = created.receipt.requestId;
  const grantInput = {
    idempotencyKey: randomUUID(),
    requestId,
    staffId: operatorId,
    role: "operator" as const,
    startsAt,
    expiresAt,
  };
  const grant = await support.grant(admin, grantInput);
  expect(grant.kind).toBe("created");
  if (!("grantId" in grant)) throw Error("Synthetic grant missing");
  return {
    owner,
    other,
    admin,
    adminId,
    operator,
    operatorId,
    input,
    requestId,
    grantInput,
    scope: { requestId, grantId: grant.grantId },
  };
}
it("receives exact invented text across all backgrounds with stable owner-only receipts", async () => {
  for (const background of ["explorer", "professional", "technical"] as const) {
    const owner = await member(background),
      input = {
        idempotencyKey: randomUUID(),
        subject: "  Invented subject ",
        body: "Invented body\n🧪 ",
      };
    const first = await support.create(owner.token, input);
    expect(first.kind).toBe("created");
    if (!("receipt" in first)) throw Error("Missing receipt");
    expect(await support.create(owner.token, input)).toEqual({
      kind: "replayed",
      receipt: first.receipt,
    });
    expect(await support.receipt(owner.token, input.idempotencyKey)).toEqual({
      kind: "found",
      receipt: first.receipt,
    });
    expect(
      await support.create(owner.token, { ...input, body: input.body.trim() }),
    ).toEqual({ kind: "conflict" });
    expect(
      await support.memberDetail(owner.token, first.receipt.requestId),
    ).toMatchObject({
      kind: "ready",
      value: {
        subject: input.subject,
        body: input.body,
        acknowledgedAt: null,
        resolvedAt: null,
        coverageState: "unverified",
        replies: { items: [], nextCursor: null },
      },
    });
    expect(
      await support.receipt((await member()).token, input.idempotencyKey),
    ).toEqual({ kind: "missing" });
  }
});
it("requires exact grants and keeps internal notes separate from explicit member replies", async () => {
  const f = await fixture();
  expect(await support.operatorWorklist(f.admin)).toEqual({
    kind: "ready",
    value: { items: [], nextCursor: null },
  });
  expect(await support.operatorDetail(f.admin, f.scope)).toEqual({
    kind: "denied",
  });
  const note = await support.note(
    f.operator,
    f.scope,
    randomUUID(),
    "INTERNAL-ONLY synthetic marker",
  );
  expect(note.kind).toBe("applied");
  expect(await support.memberDetail(f.owner.token, f.requestId)).toMatchObject({
    kind: "ready",
    value: { acknowledgedAt: null, replies: { items: [] } },
  });
  expect(
    (
      await support.reply(
        f.operator,
        f.scope,
        randomUUID(),
        "Visible invented reply",
      )
    ).kind,
  ).toBe("applied");
  const own = await support.memberDetail(f.owner.token, f.requestId);
  expect(own).toMatchObject({
    kind: "ready",
    value: {
      acknowledgedAt: null,
      replies: {
        items: [
          { body: "Visible invented reply", attribution: "Synthetic operator" },
        ],
      },
    },
  });
  expect(JSON.stringify(own)).not.toContain("INTERNAL-ONLY");
  expect(JSON.stringify(own)).not.toContain(f.operatorId);
  const staff = await support.operatorDetail(f.operator, f.scope);
  expect(staff).toMatchObject({
    kind: "ready",
    value: {
      messages: {
        items: [
          expect.objectContaining({ kind: "reply" }),
          expect.objectContaining({ kind: "internal-note" }),
        ],
      },
    },
  });
  expect(await support.operatorWorklist(f.operator)).toMatchObject({
    kind: "ready",
    value: { items: [{ requestId: f.requestId, grantId: f.scope.grantId }] },
  });
  expect(await support.memberDetail(f.other.token, f.requestId)).toEqual({
    kind: "denied",
  });
  expect(await support.operatorDetail(f.owner.token, f.scope)).toEqual({
    kind: "denied",
  });
});
it("acknowledges independently, resolves without implied satisfaction and enforces terminal replay precedence", async () => {
  const f = await fixture(),
    ackKey = randomUUID(),
    noteKey = randomUUID(),
    replyKey = randomUUID(),
    resolveKey = randomUUID();
  const acknowledged = await support.acknowledge(f.operator, f.scope, ackKey);
  expect(acknowledged.kind).toBe("applied");
  expect(await support.acknowledge(f.operator, f.scope, ackKey)).toMatchObject({
    ...acknowledged,
    kind: "replayed",
  });
  expect(await support.acknowledge(f.operator, f.scope, randomUUID())).toEqual({
    kind: "conflict",
  });
  const note = await support.note(
    f.operator,
    f.scope,
    noteKey,
    "Internal sample",
  );
  expect(
    await support.note(f.operator, f.scope, noteKey, "Internal sample"),
  ).toMatchObject({ ...note, kind: "replayed" });
  expect(
    await support.note(f.operator, f.scope, noteKey, "Changed sample"),
  ).toEqual({ kind: "conflict" });
  await support.reply(f.operator, f.scope, replyKey, "Reply sample");
  const resolved = await support.resolve(f.operator, f.scope, resolveKey);
  expect(resolved.kind).toBe("applied");
  expect(await support.resolve(f.operator, f.scope, resolveKey)).toMatchObject({
    ...resolved,
    kind: "replayed",
  });
  for (const result of [
    await support.acknowledge(f.operator, f.scope, ackKey),
    await support.note(f.operator, f.scope, noteKey, "Internal sample"),
    await support.reply(f.operator, f.scope, replyKey, "Reply sample"),
    await support.resolve(f.operator, f.scope, randomUUID()),
  ])
    expect(result).toEqual({ kind: "conflict" });
  expect(await support.withdraw(f.owner.token, f.requestId)).toEqual({
    kind: "withdrawn",
  });
  expect(await support.resolve(f.operator, f.scope, resolveKey)).toEqual({
    kind: "withdrawn",
  });
  expect(await support.create(f.owner.token, f.input)).toEqual({
    kind: "withdrawn",
  });
  expect(await support.withdraw(f.owner.token, f.requestId)).toEqual({
    kind: "already-withdrawn",
  });
  expect(await support.operatorDetail(f.operator, f.scope)).toEqual({
    kind: "withdrawn",
  });
  expect(await support.memberDetail(f.owner.token, f.requestId)).toMatchObject({
    kind: "ready",
    value: {
      subject: null,
      body: null,
      withdrawnAt: expect.any(Date),
      replies: { items: [] },
    },
  });
  for (const table of [
    "support_request_notes",
    "support_request_replies",
    "support_request_mutations",
  ])
    expect(
      (
        await pool.query(`SELECT * FROM ${table} WHERE request_id=$1`, [
          f.requestId,
        ])
      ).rows,
    ).toEqual([]);
});
it("denies resolved intake retries but retains the owner-only receipt for uncertain outcomes", async () => {
  const f = await fixture();
  expect((await support.resolve(f.operator, f.scope, randomUUID())).kind).toBe(
    "applied",
  );
  const before = (
    await pool.query(
      "SELECT * FROM support_request_events WHERE request_id=$1 ORDER BY occurred_at,id",
      [f.requestId],
    )
  ).rows;
  for (const attempted of [
    f.input,
    { ...f.input, subject: "Changed invented subject" },
    { ...f.input, body: "Changed invented body" },
  ])
    expect(await support.create(f.owner.token, attempted)).toEqual({
      kind: "conflict",
    });
  expect(
    await support.receipt(f.owner.token, f.input.idempotencyKey),
  ).toMatchObject({
    kind: "found",
    receipt: { requestId: f.requestId, resolvedAt: expect.any(Date) },
  });
  expect(await support.receipt(f.other.token, f.input.idempotencyKey)).toEqual({
    kind: "missing",
  });
  expect(
    (
      await pool.query(
        "SELECT * FROM support_request_events WHERE request_id=$1 ORDER BY occurred_at,id",
        [f.requestId],
      )
    ).rows,
  ).toEqual(before);
  expect(await support.memberDetail(f.owner.token, f.requestId)).toMatchObject({
    kind: "ready",
    value: { subject: f.input.subject, body: f.input.body },
  });
});
it("serializes duplicate intake and exact action retries without duplicate receipts or messages", async () => {
  const f = await fixture(),
    next = { ...f.input, idempotencyKey: randomUUID() };
  const intake = await Promise.all(
    Array.from({ length: 5 }, () => support.create(f.owner.token, next)),
  );
  expect(intake.map((r) => r.kind).sort()).toEqual([
    "created",
    "replayed",
    "replayed",
    "replayed",
    "replayed",
  ]);
  const intakeIds = intake.map((r) =>
    "receipt" in r ? r.receipt.requestId : "missing",
  );
  expect(new Set(intakeIds).size).toBe(1);
  const key = randomUUID(),
    actions = await Promise.all(
      Array.from({ length: 5 }, () =>
        support.reply(
          f.operator,
          f.scope,
          key,
          "Exact concurrent invented reply",
        ),
      ),
    );
  expect(actions.map((r) => r.kind).sort()).toEqual([
    "applied",
    "replayed",
    "replayed",
    "replayed",
    "replayed",
  ]);
  expect(
    (
      await pool.query(
        "SELECT * FROM support_request_replies WHERE request_id=$1",
        [f.requestId],
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await pool.query(
        "SELECT * FROM support_request_events WHERE request_id=$1 AND action='replied'",
        [f.requestId],
      )
    ).rows,
  ).toHaveLength(1);
  const resolve = await support.resolve(f.operator, f.scope, randomUUID());
  expect(resolve.kind).toBe("applied");
  expect(await support.memberDetail(f.owner.token, f.requestId)).toMatchObject({
    kind: "ready",
    value: { acknowledgedAt: null, resolvedAt: expect.any(Date) },
  });
});
it("administrates grants with real admin tokens and serializes absent idempotency slots", async () => {
  const f = await fixture(),
    input = { ...f.grantInput, idempotencyKey: randomUUID() };
  expect(await support.grant(f.operator, input)).toEqual({ kind: "denied" });
  expect(await support.grant(f.adminId, input)).toEqual({ kind: "denied" });
  const results = await Promise.all(
    Array.from({ length: 4 }, () => support.grant(f.admin, input)),
  );
  expect(results.map((r) => r.kind).sort()).toEqual([
    "created",
    "replayed",
    "replayed",
    "replayed",
  ]);
  expect(
    await support.grant(f.admin, {
      ...input,
      startsAt: new Date(input.startsAt.valueOf() - 1),
    }),
  ).toEqual({ kind: "conflict" });
  expect(await support.revoke(f.operator, f.scope.grantId)).toEqual({
    kind: "denied",
  });
  expect(await support.revoke(f.admin, f.scope.grantId)).toEqual({
    kind: "revoked",
  });
  expect(await support.revoke(f.admin, f.scope.grantId)).toEqual({
    kind: "already-revoked",
  });
  expect(await support.grant(f.admin, f.grantInput)).toEqual({
    kind: "conflict",
  });
  expect(await support.operatorDetail(f.operator, f.scope)).toEqual({
    kind: "denied",
  });
  // A second current grant remains independently usable and selected once.
  const list = await support.operatorWorklist(f.operator);
  expect(list).toMatchObject({
    kind: "ready",
    value: { items: [{ requestId: f.requestId }], nextCursor: null },
  });
  if (list.kind !== "ready") throw Error("Missing current grant");
  expect(list.value.items[0]!.grantId).not.toBe(f.scope.grantId);
});
it("requires precise role and active time windows without reusing legacy workspace grants", async () => {
  const f = await fixture();
  await support.revoke(f.admin, f.scope.grantId);
  await auth.grantSupport(
    f.adminId,
    f.operatorId,
    f.owner.id,
    "operator",
    "invented old support purpose",
    new Date(Date.now() + 3600000),
  );
  expect(await support.operatorWorklist(f.operator)).toEqual({
    kind: "ready",
    value: { items: [], nextCursor: null },
  });
  const futureGrant = await support.grant(f.admin, {
    ...f.grantInput,
    idempotencyKey: randomUUID(),
    startsAt: new Date(Date.now() + 60000),
  });
  if (!("grantId" in futureGrant)) throw Error("Expected future grant");
  expect(
    await support.operatorDetail(f.operator, {
      requestId: f.requestId,
      grantId: futureGrant.grantId,
    }),
  ).toEqual({ kind: "denied" });
  const expired = randomUUID();
  await pool.query(
    "INSERT INTO support_request_grants(id,request_id,staff_id,staff_role,starts_at,expires_at,granted_by,idempotency_key) VALUES($1,$2,$3,'operator',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',$4,$5)",
    [expired, f.requestId, f.operatorId, f.adminId, randomUUID()],
  );
  expect(
    await support.operatorDetail(f.operator, {
      requestId: f.requestId,
      grantId: expired,
    }),
  ).toEqual({ kind: "denied" });
  const current = await support.grant(f.admin, {
    ...f.grantInput,
    idempotencyKey: randomUUID(),
  });
  if (!("grantId" in current)) throw Error("Expected current grant");
  // Legacy grants bind the old staff role by foreign key; remove that unrelated
  // fixture before exercising this store's current-role revalidation.
  await pool.query("DELETE FROM support_access_grants WHERE staff_id=$1", [
    f.operatorId,
  ]);
  await pool.query(
    "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
    [f.operatorId],
  );
  expect(
    await support.operatorDetail(f.operator, {
      requestId: f.requestId,
      grantId: current.grantId,
    }),
  ).toEqual({ kind: "denied" });
  expect(
    await support.grant(f.admin, {
      ...f.grantInput,
      idempotencyKey: randomUUID(),
    }),
  ).toEqual({ kind: "denied" });
  // Administration can revoke despite a recipient role change.
  expect(await support.revoke(f.admin, current.grantId)).toEqual({
    kind: "revoked",
  });
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [f.adminId],
  );
  expect(await support.revoke(f.admin, futureGrant.grantId)).toEqual({
    kind: "denied",
  });
});
it("keeps 120/2000 UTF-16 unit bounds consistent with PostgreSQL declarative checks", async () => {
  const f = await fixture();
  const cases = [
    "x",
    "中".repeat(120),
    "中".repeat(121),
    "😀".repeat(60),
    "😀".repeat(61),
    "😀".repeat(1000),
    "😀".repeat(1001),
    "中".repeat(2000),
    "中".repeat(2001),
    "\uffff",
    "\u{10000}",
    "\u{10ffff}",
    "中".repeat(118) + "😀",
    "中".repeat(119) + "😀",
  ];
  for (const value of cases) {
    for (const cap of [120, 2000]) {
      const request = randomUUID(),
        subject = cap === 120 ? value : "Invented subject",
        body = cap === 2000 ? value : "Invented body";
      const operation = pool.query(
        "INSERT INTO support_requests(id,member_id,workspace_id,intake_key,subject,body) VALUES($1,$2,$2,$3,$4,$5)",
        [request, f.owner.id, randomUUID(), subject, body],
      );
      if (supportTextValid(value, cap))
        await expect(operation).resolves.toMatchObject({ rowCount: 1 });
      else await expect(operation).rejects.toMatchObject({ code: "23514" });
    }
  }
  for (const table of ["support_request_notes", "support_request_replies"]) {
    for (const value of ["😀".repeat(1000), "😀".repeat(1001), "", " "]) {
      const operation = pool.query(
        `INSERT INTO ${table}(id,request_id,actor_id,body) VALUES($1,$2,$3,$4)`,
        [randomUUID(), f.requestId, f.operatorId, value],
      );
      if (supportTextValid(value, 2000))
        await expect(operation).resolves.toMatchObject({ rowCount: 1 });
      else await expect(operation).rejects.toMatchObject({ code: "23514" });
    }
  }
  for (const body of [
    "\ud800",
    "\udfff",
    "\0",
    " \t\n\u00a0",
    "中".repeat(2001),
  ])
    expect(
      await support.reply(f.operator, f.scope, randomUUID(), body),
    ).toEqual({ kind: "invalid", field: "body" });
});
it("guards immutable request/grant/message/audit history while permitting privacy cascades", async () => {
  const f = await fixture();
  await support.acknowledge(f.operator, f.scope, randomUUID());
  await support.reply(f.operator, f.scope, randomUUID(), "Invented reply");
  await support.note(f.operator, f.scope, randomUUID(), "Invented note");
  for (const assignment of [
    "subject='Changed'",
    "body='Changed'",
    "received_at=clock_timestamp()",
    "intake_key=gen_random_uuid()",
    "acknowledged_at=NULL,acknowledged_by=NULL",
    "coverage_state='verified'",
  ])
    await expect(
      pool.query(`UPDATE support_requests SET ${assignment} WHERE id=$1`, [
        f.requestId,
      ]),
    ).rejects.toThrow("immutable");
  for (const assignment of [
    "purpose='other'",
    "starts_at=clock_timestamp()",
    "staff_role='platform_admin'",
    "idempotency_key=gen_random_uuid()",
  ])
    await expect(
      pool.query(
        `UPDATE support_request_grants SET ${assignment} WHERE id=$1`,
        [f.scope.grantId],
      ),
    ).rejects.toThrow("immutable");
  for (const table of ["support_request_replies", "support_request_notes"])
    await expect(
      pool.query(`UPDATE ${table} SET body='Changed' WHERE request_id=$1`, [
        f.requestId,
      ]),
    ).rejects.toThrow("immutable");
  await expect(
    pool.query(
      "UPDATE support_request_mutations SET occurred_at=clock_timestamp() WHERE request_id=$1",
      [f.requestId],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query(
      "UPDATE support_request_events SET action='resolved' WHERE request_id=$1",
      [f.requestId],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("DELETE FROM support_request_events WHERE request_id=$1", [
      f.requestId,
    ]),
  ).rejects.toThrow("immutable");
  await support.resolve(f.operator, f.scope, randomUUID());
  await expect(
    pool.query(
      "UPDATE support_requests SET resolved_at=NULL,resolved_by=NULL WHERE id=$1",
      [f.requestId],
    ),
  ).rejects.toThrow("immutable");
  await support.revoke(f.admin, f.scope.grantId);
  await expect(
    pool.query(
      "UPDATE support_request_grants SET revoked_at=NULL WHERE id=$1",
      [f.scope.grantId],
    ),
  ).rejects.toThrow("immutable");
  const auditCount = (
    await pool.query(
      "SELECT count(*)::int count FROM support_request_events WHERE request_id=$1",
      [f.requestId],
    )
  ).rows[0].count;
  await pool.query("DELETE FROM principals WHERE id=$1", [f.operatorId]);
  expect(
    (
      await pool.query(
        "SELECT * FROM support_request_grants WHERE request_id=$1",
        [f.requestId],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT * FROM support_request_events WHERE request_id=$1",
        [f.requestId],
      )
    ).rows,
  ).toHaveLength(auditCount);
  expect(await support.memberDetail(f.owner.token, f.requestId)).toMatchObject({
    kind: "ready",
    value: {
      replies: {
        items: [{ body: "Invented reply", attribution: "Synthetic operator" }],
      },
    },
  });
  await support.withdraw(f.owner.token, f.requestId);
  await expect(
    pool.query(
      "UPDATE support_requests SET withdrawn_at=NULL,subject='Restore',body='Restore' WHERE id=$1",
      [f.requestId],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query(
      "UPDATE support_requests SET withdrawn_at=clock_timestamp() WHERE id=$1",
      [f.requestId],
    ),
  ).rejects.toThrow("immutable");
  await pool.query("DELETE FROM support_requests WHERE id=$1", [f.requestId]);
  expect(
    (
      await pool.query(
        "SELECT * FROM support_request_events WHERE request_id=$1",
        [f.requestId],
      )
    ).rows,
  ).toEqual([]);
  const second = await support.create(f.owner.token, {
    ...f.input,
    idempotencyKey: randomUUID(),
  });
  expect(second.kind).toBe("created");
  await pool.query("DELETE FROM principals WHERE id=$1", [f.owner.id]);
  expect(
    (await pool.query("SELECT * FROM support_request_events")).rows,
  ).toEqual([]);
});
it("pages owner and multi-owner staff histories with precise keysets and audits only emitted rows", async () => {
  const f = await fixture();
  for (let i = 0; i < 43; i++) {
    const owner = i % 2 ? f.owner : f.other,
      id = randomUUID();
    await pool.query(
      "INSERT INTO support_requests(id,member_id,workspace_id,intake_key,subject,body,received_at) VALUES($1,$2,$2,$3,$4,'Invented bounded body',$5::timestamptz+($6::int*interval '1 microsecond'))",
      [
        id,
        owner.id,
        randomUUID(),
        `Invented request ${i}`,
        "2026-01-01T00:00:00.000000Z",
        Math.floor(i / 2),
      ],
    );
    for (let duplicate = 0; duplicate < 2; duplicate++)
      await pool.query(
        "INSERT INTO support_request_grants(id,request_id,staff_id,staff_role,starts_at,expires_at,granted_by,idempotency_key) VALUES($1,$2,$3,'operator',$4,$5,$6,$7)",
        [
          randomUUID(),
          id,
          f.operatorId,
          f.grantInput.startsAt,
          f.grantInput.expiresAt,
          f.adminId,
          randomUUID(),
        ],
      );
  }
  const first = await support.operatorWorklist(f.operator);
  if (first.kind !== "ready") throw Error("Expected worklist");
  expect(first.value.items).toHaveLength(20);
  expect(
    (
      await pool.query(
        "SELECT * FROM support_request_events WHERE action='worklist-read'",
      )
    ).rows,
  ).toHaveLength(20);
  const staffIds = first.value.items.map((r) => r.requestId);
  let after = first.value.nextCursor;
  while (after) {
    const next = await support.operatorWorklist(f.operator, after);
    if (next.kind !== "ready") throw Error("Expected staff continuation");
    staffIds.push(...next.value.items.map((r) => r.requestId));
    after = next.value.nextCursor;
  }
  expect(staffIds).toEqual(
    (
      await pool.query(
        "SELECT id FROM support_requests ORDER BY received_at DESC,id DESC",
      )
    ).rows.map((r) => r.id),
  );
  expect(new Set(staffIds).size).toBe(44);
  const ownerFirst = await support.ownerHistory(f.owner.token);
  if (ownerFirst.kind !== "ready") throw Error("Expected owner history");
  expect(ownerFirst.value.items).toHaveLength(20);
  const ownerNext = await support.ownerHistory(
    f.owner.token,
    ownerFirst.value.nextCursor!,
  );
  if (ownerNext.kind !== "ready") throw Error("Expected owner continuation");
  expect(
    [...ownerFirst.value.items, ...ownerNext.value.items].map(
      (r) => r.requestId,
    ),
  ).toEqual(
    (
      await pool.query(
        "SELECT id FROM support_requests WHERE member_id=$1 ORDER BY received_at DESC,id DESC",
        [f.owner.id],
      )
    ).rows.map((r) => r.id),
  );
  expect(
    await support.ownerHistory(f.other.token, ownerFirst.value.nextCursor!),
  ).toEqual({ kind: "denied" });
  expect(
    await support.operatorWorklist(f.operator, ownerFirst.value.nextCursor!),
  ).toEqual({ kind: "denied" });
  expect(
    await support.operatorWorklist(
      f.operator,
      first.value.nextCursor!.slice(0, -1) + "!",
    ),
  ).toEqual({ kind: "denied" });
});
it("paginates replies independently from notes without note ordinals or cursor leakage", async () => {
  const f = await fixture();
  for (let i = 0; i < 25; i++)
    for (const table of ["support_request_replies", "support_request_notes"])
      await pool.query(
        `INSERT INTO ${table}(id,request_id,actor_id,body,created_at) VALUES($1,$2,$3,$4,$5::timestamptz+($6::int*interval '1 microsecond'))`,
        [
          randomUUID(),
          f.requestId,
          f.operatorId,
          `${table.endsWith("notes") ? "INTERNAL" : "VISIBLE"} invented ${i}`,
          "2026-01-01T00:00:00.000000Z",
          Math.floor(i / 2),
        ],
      );
  const first = await support.memberDetail(f.owner.token, f.requestId),
    staff = await support.operatorDetail(f.operator, f.scope);
  if (first.kind !== "ready" || staff.kind !== "ready")
    throw Error("Expected authorized messages");
  expect(first.value.replies.items).toHaveLength(20);
  expect(staff.value.messages.items).toHaveLength(20);
  const next = await support.memberDetail(
    f.owner.token,
    f.requestId,
    first.value.replies.nextCursor!,
  );
  if (next.kind !== "ready") throw Error("Expected reply continuation");
  expect(next.value.replies.items).toHaveLength(5);
  const replies = [...first.value.replies.items, ...next.value.replies.items];
  expect(replies.map((r) => r.id)).toEqual(
    (
      await pool.query(
        "SELECT id FROM support_request_replies WHERE request_id=$1 ORDER BY created_at DESC,id DESC",
        [f.requestId],
      )
    ).rows.map((r) => r.id),
  );
  expect(JSON.stringify([first, next])).not.toMatch(
    /INTERNAL|internal-note|actor_id|grantId|eventId/,
  );
  expect(
    await support.memberDetail(
      f.owner.token,
      f.requestId,
      staff.value.messages.nextCursor!,
    ),
  ).toEqual({ kind: "denied" });
  expect(
    await support.operatorDetail(
      f.operator,
      f.scope,
      first.value.replies.nextCursor!,
    ),
  ).toEqual({ kind: "denied" });
  const all = [...staff.value.messages.items];
  let after = staff.value.messages.nextCursor;
  while (after) {
    const page = await support.operatorDetail(f.operator, f.scope, after);
    if (page.kind !== "ready") throw Error("Expected staff continuation");
    all.push(...page.value.messages.items);
    after = page.value.messages.nextCursor;
  }
  expect(all).toHaveLength(50);
  expect(new Set(all.map((m) => m.id)).size).toBe(50);
});
it.each(["create", "reply", "withdraw"] as const)(
  "recovers %s after a lost COMMIT receipt without automatic retry",
  async (action) => {
    const f = await fixture(),
      uncertain = controlled("COMMIT", "after"),
      key = randomUUID();
    const result =
      action === "create"
        ? await uncertain.use.create(f.owner.token, {
            ...f.input,
            idempotencyKey: key,
          })
        : action === "reply"
          ? await uncertain.use.reply(
              f.operator,
              f.scope,
              key,
              "Lost receipt invented reply",
            )
          : await uncertain.use.withdraw(f.owner.token, f.requestId);
    expect(result).toEqual({ kind: "unavailable" });
    expect(
      uncertain.state.calls.filter((sql) => sql === "COMMIT"),
    ).toHaveLength(1);
    if (action === "create")
      expect(await support.receipt(f.owner.token, key)).toMatchObject({
        kind: "found",
        receipt: { requestId: expect.any(String) },
      });
    if (action === "reply") {
      expect(
        await support.reply(
          f.operator,
          f.scope,
          key,
          "Lost receipt invented reply",
        ),
      ).toMatchObject({ kind: "replayed" });
      expect(
        (
          await pool.query(
            "SELECT * FROM support_request_replies WHERE request_id=$1",
            [f.requestId],
          )
        ).rows,
      ).toHaveLength(1);
    }
    if (action === "withdraw")
      expect(
        await support.memberDetail(f.owner.token, f.requestId),
      ).toMatchObject({
        kind: "ready",
        value: {
          withdrawnAt: expect.any(Date),
          body: null,
          replies: { items: [] },
        },
      });
  },
);
it.each([
  "INSERT INTO support_request_events",
  "INSERT INTO support_request_mutations",
  "COMMIT",
])(
  "rolls back message and audit atomically after failure at %s",
  async (failure) => {
    const f = await fixture(),
      failed = controlled(failure, "before");
    expect(
      await failed.use.reply(
        f.operator,
        f.scope,
        randomUUID(),
        "Must rollback invented reply",
      ),
    ).toEqual({ kind: "unavailable" });
    expect(
      (
        await pool.query(
          "SELECT * FROM support_request_replies WHERE request_id=$1",
          [f.requestId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT * FROM support_request_events WHERE request_id=$1 AND action='replied'",
          [f.requestId],
        )
      ).rows,
    ).toEqual([]);
  },
);
it.each(["member", "grant"] as const)(
  "rolls back writes and audits when %s expires after protected writes",
  async (expires) => {
    const f = await fixture(),
      deadline = new Date(Date.now() + 500);
    let scope = f.scope;
    if (expires === "member")
      await pool.query("UPDATE principals SET expires_at=$2 WHERE id=$1", [
        f.operatorId,
        deadline,
      ]);
    else {
      const created = await support.grant(f.admin, {
        ...f.grantInput,
        idempotencyKey: randomUUID(),
        expiresAt: deadline,
      });
      if (!("grantId" in created)) throw Error("Expected short grant");
      scope = { requestId: f.requestId, grantId: created.grantId };
    }
    const paused = controlled("INSERT INTO support_request_mutations"),
      pending = paused.use.reply(
        f.operator,
        scope,
        randomUUID(),
        "Expired invented reply",
      );
    try {
      await paused.reached.wait;
      await pool.query(
        "SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)",
        [deadline],
      );
    } finally {
      paused.resume.release();
    }
    expect(await pending).toEqual({ kind: "denied" });
    expect(
      (
        await pool.query(
          "SELECT * FROM support_request_replies WHERE request_id=$1",
          [f.requestId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT * FROM support_request_events WHERE request_id=$1 AND action='replied'",
          [f.requestId],
        )
      ).rows,
    ).toEqual([]);
  },
);
it.each(["withdraw-first", "read-first"] as const)(
  "linearizes staff reads and withdrawal in %s order",
  async (order) => {
    const f = await fixture();
    await support.reply(
      f.operator,
      f.scope,
      randomUUID(),
      "Readable before withdrawal",
    );
    const first = controlled(
        order === "withdraw-first"
          ? "DELETE FROM support_request_replies"
          : "INSERT INTO support_request_events",
      ),
      second = controlled();
    const pendingFirst =
      order === "withdraw-first"
        ? first.use.withdraw(f.owner.token, f.requestId)
        : first.use.operatorDetail(f.operator, f.scope);
    let pendingSecond:
      | ReturnType<typeof support.operatorDetail>
      | ReturnType<typeof support.withdraw>
      | undefined;
    try {
      await first.reached.wait;
      pendingSecond =
        order === "withdraw-first"
          ? second.use.operatorDetail(f.operator, f.scope)
          : second.use.withdraw(f.owner.token, f.requestId);
      await second.connected.wait;
      await blocked(second.state.pid, first.state.pid);
    } finally {
      first.resume.release();
    }
    const before = await pendingFirst,
      after = await pendingSecond;
    if (order === "withdraw-first") {
      expect(before).toEqual({ kind: "withdrawn" });
      expect(after).toEqual({ kind: "withdrawn" });
    } else {
      expect(before).toMatchObject({
        kind: "ready",
        value: { body: f.input.body },
      });
      expect(after).toEqual({ kind: "withdrawn" });
    }
    expect(await support.operatorDetail(f.operator, f.scope)).toEqual({
      kind: "withdrawn",
    });
  },
);
it.each(["revoke-first", "reply-first"] as const)(
  "linearizes grant revocation and replies in %s order",
  async (order) => {
    const f = await fixture(),
      first = controlled(
        order === "revoke-first"
          ? "UPDATE support_request_grants SET"
          : "INSERT INTO support_request_mutations",
      ),
      second = controlled();
    const one =
      order === "revoke-first"
        ? first.use.revoke(f.admin, f.scope.grantId)
        : first.use.reply(
            f.operator,
            f.scope,
            randomUUID(),
            "Permitted before revocation",
          );
    let two: Promise<unknown> | undefined;
    try {
      await first.reached.wait;
      two =
        order === "revoke-first"
          ? second.use.reply(
              f.operator,
              f.scope,
              randomUUID(),
              "Denied after revocation",
            )
          : second.use.revoke(f.admin, f.scope.grantId);
      await second.connected.wait;
      await blocked(second.state.pid, first.state.pid);
    } finally {
      first.resume.release();
    }
    expect((await one).kind).toBe(
      order === "revoke-first" ? "revoked" : "applied",
    );
    expect(await two).toMatchObject({
      kind: order === "revoke-first" ? "denied" : "revoked",
    });
    expect(
      await support.reply(
        f.operator,
        f.scope,
        randomUUID(),
        "Denied current request",
      ),
    ).toEqual({ kind: "denied" });
    expect(
      (
        await pool.query(
          "SELECT * FROM support_request_replies WHERE request_id=$1",
          [f.requestId],
        )
      ).rows,
    ).toHaveLength(order === "reply-first" ? 1 : 0);
  },
);
it("fails the whole metadata-discovered worklist when a selected grant changes before locking", async () => {
  const f = await fixture(),
    paused = controlled(
      'SELECT r.id AS "requestId",r.member_id AS "memberId",r.workspace_id AS "workspaceId",selected.id',
    ),
    pending = paused.use.operatorWorklist(f.operator);
  try {
    await paused.reached.wait;
    expect(await support.revoke(f.admin, f.scope.grantId)).toEqual({
      kind: "revoked",
    });
  } finally {
    paused.resume.release();
  }
  expect(await pending).toEqual({ kind: "unavailable" });
  expect(
    paused.state.calls.some((sql) => sql.includes("r.subject,r.body")),
  ).toBe(false);
  expect(
    (
      await pool.query(
        "SELECT * FROM support_request_events WHERE action='worklist-read'",
      )
    ).rows,
  ).toEqual([]);
});
it("revalidates current staff role after an actual profile-row wait", async () => {
  const f = await fixture(),
    blocker = await pool.connect(),
    waiting = controlled();
  let pending: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0]
      .pid;
    await blocker.query(
      "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
      [f.operatorId],
    );
    pending = waiting.use.operatorDetail(f.operator, f.scope);
    await waiting.connected.wait;
    await blocked(waiting.state.pid, pid);
    await blocker.query("COMMIT");
    expect(await pending).toEqual({ kind: "denied" });
    expect(
      (
        await pool.query(
          "SELECT * FROM support_request_events WHERE action='detail-read'",
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await pending;
  }
});
it.each(["principal", "workspace", "request"] as const)(
  "denies a read after a waited %s deletion/revocation boundary",
  async (boundary) => {
    const f = await fixture(),
      blocker = await pool.connect(),
      waiting = controlled();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      if (boundary === "principal")
        await blocker.query(
          "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [f.operatorId],
        );
      if (boundary === "workspace")
        await blocker.query(
          "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
          [f.owner.id],
        );
      if (boundary === "request")
        await blocker.query(
          "SELECT id FROM support_requests WHERE id=$1 FOR UPDATE",
          [f.requestId],
        );
      pending = waiting.use.operatorDetail(f.operator, f.scope);
      await waiting.connected.wait;
      await blocked(waiting.state.pid, pid);
      if (boundary === "request")
        await blocker.query(
          "UPDATE support_requests SET subject=NULL,body=NULL,withdrawn_at=clock_timestamp() WHERE id=$1",
          [f.requestId],
        );
      await blocker.query("COMMIT");
      expect(await pending).toEqual({
        kind: boundary === "request" ? "withdrawn" : "denied",
      });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pending;
    }
  },
);
