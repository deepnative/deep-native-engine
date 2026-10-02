import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { hash } from "../../src/store.ts";
import {
  disabledSupportRequestStore,
  supportRequestStore,
  supportTextValid,
  type SupportRequestStore,
} from "../../src/support-requests.ts";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = id(1),
  operator = id(2),
  admin = id(3),
  requestId = id(4),
  grantId = id(5),
  key = id(6);
const token = "a".repeat(64),
  secret = Buffer.alloc(32, 42),
  date = new Date("2026-01-01"),
  future = new Date("2100-01-01");
const scope = { requestId, grantId };
const input = {
  idempotencyKey: key,
  subject: " Invented subject ",
  body: " Invented body\n🧪 ",
};
const grantInput = {
  idempotencyKey: key,
  requestId,
  staffId: operator,
  role: "operator" as const,
  startsAt: date,
  expiresAt: future,
};
const row = {
  requestId,
  receivedAt: date,
  acknowledgedAt: null,
  resolvedAt: null,
  withdrawnAt: null,
  coverageState: "unverified",
  memberId: owner,
  workspaceId: owner,
};
const detail = { ...row, subject: input.subject, body: input.body };
const mutation = {
  requestId,
  eventId: id(8),
  occurredAt: date,
  messageId: id(9),
};
const grant = {
  id: grantId,
  requestId,
  staffId: operator,
  role: "operator",
  purpose: "support-request-local-v1",
  startsAt: date,
  expiresAt: future,
  revokedAt: null,
  active: true,
  grantedBy: admin,
  idempotencyKey: key,
};
const candidate = {
  requestId,
  grantId,
  memberId: owner,
  workspaceId: owner,
  cursorAt: "2026-01-01T00:00:00.000001Z",
};
type Override = (sql: string, values: unknown[]) => unknown[] | undefined;
function fixture(
  options: {
    actor?: "member" | "operator" | "admin";
    override?: Override;
    fail?: string;
    rollbackFails?: boolean;
    connectFails?: boolean;
    defaultSecret?: boolean;
  } = {},
) {
  const actor =
    options.actor === "admin"
      ? admin
      : options.actor === "operator"
        ? operator
        : owner;
  const people = [owner, operator, admin].map((value) => ({
    id: value,
    kind: value === owner ? "member" : "staff",
    tokenHash: hash(token),
    expiresAt: future,
    active: true,
  }));
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (
      (options.fail && sql.includes(options.fail)) ||
      (options.rollbackFails && sql === "ROLLBACK")
    )
      throw Error("Private DB diagnostic");
    const replaced = options.override?.(sql, values);
    if (replaced !== undefined) return { rows: replaced };
    if (sql === "SELECT id,kind FROM principals WHERE token_hash=$1")
      return {
        rows: [{ id: actor, kind: actor === owner ? "member" : "staff" }],
      };
    if (sql.includes("FROM principals WHERE id=ANY"))
      return {
        rows: people.filter((r) => (values[0] as string[]).includes(r.id)),
      };
    if (sql.includes("FROM staff_profiles"))
      return {
        rows: [
          { id: operator, role: "operator" },
          { id: admin, role: "platform_admin" },
        ],
      };
    if (sql.includes("FROM workspaces\n"))
      return { rows: [{ id: owner, memberId: owner, deletingAt: null }] };
    if (sql.includes("JOIN LATERAL")) return { rows: [candidate] };
    if (sql.startsWith("SELECT g.request_id"))
      return { rows: [{ ...candidate, staffId: operator }] };
    if (sql.startsWith("SELECT member_id"))
      return { rows: [{ memberId: owner, workspaceId: owner }] };
    if (sql.includes("JOIN support_request_grants g ON"))
      return { rows: [candidate] };
    if (sql.includes("FROM support_request_grants WHERE granted_by"))
      return { rows: [] };
    if (sql.includes("FROM support_request_grants WHERE id=ANY"))
      return { rows: [grant] };
    if (sql.includes("FROM support_request_mutations WHERE"))
      return { rows: [] };
    if (sql.startsWith("SELECT body FROM"))
      return { rows: [{ body: input.body }] };
    if (sql.includes("FROM (SELECT id,body"))
      return {
        rows: [
          {
            id: id(9),
            body: input.body,
            createdAt: date,
            kind: "reply",
            attribution: "Synthetic operator",
            cursorAt: candidate.cursorAt,
          },
        ],
      };
    if (sql.includes("FROM support_requests r WHERE r.id=ANY"))
      return { rows: [row] };
    if (sql.includes("r.intake_key=$2")) return { rows: [] };
    if (sql.includes("r.subject,") && sql.includes('AS "cursorAt"'))
      return { rows: [{ ...detail, cursorAt: candidate.cursorAt }] };
    if (sql.includes("r.subject,r.body FROM support_requests"))
      return { rows: [detail] };
    if (sql.startsWith("INSERT INTO support_requests(")) return { rows: [row] };
    if (sql.startsWith("INSERT INTO support_request_events"))
      return { rows: [{ ...mutation, messageId: values[5] }] };
    if (sql.includes("bool_and(deadline")) return { rows: [{ valid: true }] };
    return { rows: [] };
  });
  const release = vi.fn(),
    connect = options.connectFails
      ? vi.fn().mockRejectedValue(Error("Private connection failure"))
      : vi.fn().mockResolvedValue({ query, release });
  const pool = { connect } as unknown as Pool;
  return {
    use: options.defaultSecret
      ? supportRequestStore(pool)
      : supportRequestStore(pool, secret),
    query,
    connect,
    release,
    people,
  };
}
const calls = {
  create: (s: SupportRequestStore, t = token) => s.create(t, input),
  receipt: (s: SupportRequestStore, t = token) => s.receipt(t, key),
  ownerHistory: (s: SupportRequestStore, t = token) => s.ownerHistory(t),
  memberDetail: (s: SupportRequestStore, t = token) =>
    s.memberDetail(t, requestId),
  operatorWorklist: (s: SupportRequestStore, t = token) =>
    s.operatorWorklist(t),
  operatorDetail: (s: SupportRequestStore, t = token) =>
    s.operatorDetail(t, scope),
  acknowledge: (s: SupportRequestStore, t = token) =>
    s.acknowledge(t, scope, key),
  reply: (s: SupportRequestStore, t = token) =>
    s.reply(t, scope, key, input.body),
  note: (s: SupportRequestStore, t = token) =>
    s.note(t, scope, key, input.body),
  resolve: (s: SupportRequestStore, t = token) => s.resolve(t, scope, key),
  withdraw: (s: SupportRequestStore, t = token) => s.withdraw(t, requestId),
  grant: (s: SupportRequestStore, t = token) => s.grant(t, grantInput),
  revoke: (s: SupportRequestStore, t = token) => s.revoke(t, grantId),
};
const actorFor = (name: keyof typeof calls) =>
  ["grant", "revoke"].includes(name)
    ? ("admin" as const)
    : [
          "operatorWorklist",
          "operatorDetail",
          "acknowledge",
          "reply",
          "note",
          "resolve",
        ].includes(name)
      ? ("operator" as const)
      : ("member" as const);
afterEach(() => vi.restoreAllMocks());
it("keeps disabled and malformed identities denied without database access", async () => {
  const f = fixture();
  for (const call of Object.values(calls)) {
    expect(await call(disabledSupportRequestStore())).toEqual({
      kind: "denied",
    });
    expect(await call(f.use, "")).toEqual({ kind: "denied" });
  }
  expect(f.connect).not.toHaveBeenCalled();
  const nonstring = fixture();
  expect(await nonstring.use.ownerHistory(null as unknown as string)).toEqual({
    kind: "denied",
  });
  expect(nonstring.connect).not.toHaveBeenCalled();
});
it.each(Object.keys(calls) as (keyof typeof calls)[])(
  "authorizes %s and rejects absent identities, expiry, storage failure without a private diagnostic",
  async (name) => {
    const good = fixture({ actor: actorFor(name), defaultSecret: true });
    expect((await calls[name](good.use)).kind).not.toBe("denied");
    expect(good.query.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
    for (const options of [
      {
        override: (sql: string) =>
          sql.startsWith("SELECT id,kind FROM") ? [] : undefined,
      },
      {
        override: (sql: string) =>
          sql.includes("bool_and(deadline") ? [] : undefined,
      },
      {
        override: (sql: string) =>
          sql.includes("bool_and(deadline") ? [{ valid: false }] : undefined,
      },
    ]) {
      const f = fixture({ actor: actorFor(name), ...options });
      expect(await calls[name](f.use)).toEqual({ kind: "denied" });
      expect(f.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    }
    for (const options of [
      { connectFails: true },
      { fail: "SET LOCAL" },
      { fail: "COMMIT" },
      { fail: "COMMIT", rollbackFails: true },
    ]) {
      const f = fixture({ actor: actorFor(name), ...options });
      expect(await calls[name](f.use)).toEqual({ kind: "unavailable" });
      if (options.rollbackFails)
        expect(f.release).toHaveBeenCalledWith(expect.any(Error));
      expect(f.connect).toHaveBeenCalledTimes(1);
    }
  },
);
it("validates exact UTF-16 boundaries and preserves whitespace and supplementary characters", async () => {
  for (const value of [
    null,
    undefined,
    4,
    "",
    " \t\n\u00a0",
    "x\0",
    "\ud800",
    "\udfff",
    "😀".repeat(61),
    "a".repeat(121),
  ])
    expect(supportTextValid(value, 120)).toBe(false);
  for (const value of [
    "x",
    " x ",
    "😀".repeat(60),
    "\uffff",
    "\u{10000}",
    "\u{10ffff}",
  ])
    expect(supportTextValid(value, 120)).toBe(true);
  const f = fixture();
  for (const [field, value] of [
    ["idempotencyKey", "bad"],
    ["subject", " "],
    ["body", "x".repeat(2001)],
  ] as const)
    expect(await f.use.create(token, { ...input, [field]: value })).toEqual({
      kind: "invalid",
      field,
    });
  expect(await f.use.reply(token, scope, key, "\0")).toEqual({
    kind: "invalid",
    field: "body",
  });
  expect(await f.use.note(token, scope, key, "\ud800")).toEqual({
    kind: "invalid",
    field: "body",
  });
  expect(f.connect).not.toHaveBeenCalled();
});
it("rejects malformed object identifiers before opening transactions", async () => {
  const f = fixture();
  for (const task of [
    f.use.receipt(token, "bad"),
    f.use.memberDetail(token, "bad"),
    f.use.operatorDetail(token, { ...scope, requestId: "bad" }),
    f.use.operatorDetail(token, { ...scope, grantId: "bad" }),
    f.use.acknowledge(token, scope, "bad"),
    f.use.resolve(token, { ...scope, grantId: "bad" }, key),
    f.use.withdraw(token, "bad"),
    f.use.revoke(token, "bad"),
  ])
    expect(await task).toEqual({ kind: "denied" });
  for (const change of [
    { requestId: "bad" },
    { role: "reviewer" },
    { startsAt: "date" },
    { expiresAt: "date" },
    { startsAt: new Date(NaN) },
    { expiresAt: new Date(NaN) },
    { expiresAt: date },
  ])
    expect(
      await f.use.grant(token, {
        ...grantInput,
        ...change,
      } as typeof grantInput),
    ).toEqual({ kind: "denied" });
  expect(f.connect).not.toHaveBeenCalled();
});
it("requires stable principal, workspace and ownership records", async () => {
  const changes = [
    [],
    [{ id: owner, kind: "member", active: false }],
    [{ id: owner, kind: "member", active: true, tokenHash: "wrong" }],
    [{ id: owner, kind: "staff", active: true, tokenHash: hash(token) }],
  ];
  for (const people of changes)
    expect(
      await fixture({
        override: (sql) =>
          sql.includes("FROM principals WHERE id=ANY") ? people : undefined,
      }).use.ownerHistory(token),
    ).toEqual({ kind: "denied" });
  for (const workspace of [
    [],
    [{ id: id(99), memberId: owner }],
    [{ id: owner, memberId: id(99) }],
    [{ id: owner, memberId: owner, deletingAt: date }],
  ])
    expect(
      await fixture({
        override: (sql) =>
          sql.includes("FROM workspaces\n") ? workspace : undefined,
      }).use.ownerHistory(token),
    ).toEqual({ kind: "denied" });
  for (const record of [
    [],
    [{ ...row, memberId: operator }],
    [{ ...row, workspaceId: operator }],
  ])
    expect(
      await fixture({
        override: (sql) =>
          sql.includes("WHERE r.id=ANY") ? record : undefined,
      }).use.memberDetail(token, requestId),
    ).toEqual({ kind: "denied" });
  expect(await fixture({ actor: "operator" }).use.ownerHistory(token)).toEqual({
    kind: "denied",
  });
});
it("replays intake only for exact bytes, retains withdrawn receipt without recovering text", async () => {
  for (const [existing, expected] of [
    [detail, "replayed"],
    [{ ...detail, subject: "Changed" }, "conflict"],
    [{ ...detail, body: "Changed" }, "conflict"],
    [{ ...detail, withdrawnAt: date }, "withdrawn"],
  ] as const)
    expect(
      (
        await fixture({
          override: (sql) =>
            sql.includes("r.intake_key=$2") ? [existing] : undefined,
        }).use.create(token, input)
      ).kind,
    ).toBe(expected);
  const f = fixture({
    override: (sql) => (sql.includes("r.intake_key=$2") ? [detail] : undefined),
  });
  const result = await f.use.receipt(token, key);
  expect(result).toMatchObject({ kind: "found", receipt: { requestId } });
  expect(JSON.stringify(result)).not.toContain(input.subject);
});
it("denies resolved intake replay while retaining owner receipt recovery", async () => {
  const f = fixture({
    override: (sql) =>
      sql.includes("r.intake_key=$2")
        ? [{ ...detail, resolvedAt: date }]
        : undefined,
  });
  for (const attempted of [
    input,
    { ...input, subject: "Changed subject" },
    { ...input, body: "Changed body" },
  ])
    expect(await f.use.create(token, attempted)).toEqual({ kind: "conflict" });
  expect(await f.use.receipt(token, key)).toMatchObject({
    kind: "found",
    receipt: { requestId, resolvedAt: date },
  });
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});
it("requires current staff kind, profile, precise grant and unchanged request scope", async () => {
  for (const method of [
    "operatorWorklist",
    "operatorDetail",
    "acknowledge",
    "grant",
    "revoke",
  ] as const)
    expect(await calls[method](fixture().use)).toEqual({ kind: "denied" });
  const cases: Override[] = [
    (sql) =>
      sql.includes("JOIN support_request_grants g ON") ? [] : undefined,
    (sql) =>
      sql.includes("FROM principals WHERE id=ANY")
        ? [
            {
              id: operator,
              kind: "staff",
              tokenHash: hash(token),
              expiresAt: future,
              active: true,
            },
            { id: owner, kind: "staff" },
          ]
        : undefined,
    (sql) => (sql.includes("FROM staff_profiles") ? [] : undefined),
    (sql) =>
      sql.includes("FROM staff_profiles")
        ? [{ id: operator, role: "content_editor" }]
        : undefined,
  ];
  for (const override of cases)
    expect(
      await fixture({ actor: "operator", override }).use.operatorDetail(
        token,
        scope,
      ),
    ).toEqual({ kind: "denied" });
  for (const change of [
    { id: id(88) },
    { requestId: id(88) },
    { staffId: admin },
    { role: "platform_admin" },
    { purpose: "other" },
    { active: false },
  ]) {
    const override: Override = (sql) =>
      sql.includes("FROM support_request_grants WHERE id=ANY")
        ? [{ ...grant, ...change }]
        : undefined;
    expect(
      await fixture({ actor: "operator", override }).use.operatorDetail(
        token,
        scope,
      ),
    ).toEqual({ kind: "denied" });
    expect(
      await fixture({ actor: "operator", override }).use.operatorWorklist(
        token,
      ),
    ).toEqual({ kind: "unavailable" });
  }
  for (const change of [
    null,
    { requestId: id(88) },
    { memberId: operator },
    { workspaceId: operator },
  ]) {
    const override: Override = (sql) =>
      sql.includes("WHERE r.id=ANY")
        ? change === null
          ? []
          : [{ ...row, ...change }]
        : undefined;
    expect(
      await fixture({ actor: "operator", override }).use.operatorDetail(
        token,
        scope,
      ),
    ).toEqual({ kind: "denied" });
  }
  const withdrawn: Override = (sql) =>
    sql.includes("WHERE r.id=ANY")
      ? [{ ...row, withdrawnAt: date }]
      : undefined;
  expect(
    await fixture({
      actor: "operator",
      override: withdrawn,
    }).use.operatorDetail(token, scope),
  ).toEqual({ kind: "withdrawn" });
  expect(
    await fixture({
      actor: "operator",
      override: withdrawn,
    }).use.operatorWorklist(token),
  ).toEqual({ kind: "unavailable" });
});
it("honors terminal precedence and exact per-action replay", async () => {
  for (const action of ["acknowledge", "resolve", "reply", "note"] as const) {
    const replay = fixture({
      actor: "operator",
      override: (sql) =>
        sql.includes("FROM support_request_mutations WHERE")
          ? [mutation]
          : undefined,
    });
    expect(await calls[action](replay.use)).toEqual({
      kind: "replayed",
      receipt: mutation,
    });
    for (const state of ["resolvedAt", "withdrawnAt"] as const) {
      const f = fixture({
        actor: "operator",
        override: (sql) =>
          sql.includes("WHERE r.id=ANY")
            ? [{ ...row, [state]: date }]
            : sql.includes("FROM support_request_mutations WHERE")
              ? [mutation]
              : undefined,
      });
      expect((await calls[action](f.use)).kind).toBe(
        state === "withdrawnAt"
          ? "withdrawn"
          : action === "resolve"
            ? "replayed"
            : "conflict",
      );
    }
  }
  expect(
    await fixture({
      actor: "operator",
      override: (sql) =>
        sql.includes("WHERE r.id=ANY")
          ? [{ ...row, resolvedAt: date }]
          : undefined,
    }).use.resolve(token, scope, key),
  ).toEqual({ kind: "conflict" });
  expect(
    await fixture({
      actor: "operator",
      override: (sql) =>
        sql.includes("WHERE r.id=ANY")
          ? [{ ...row, acknowledgedAt: date }]
          : undefined,
    }).use.acknowledge(token, scope, key),
  ).toEqual({ kind: "conflict" });
  for (const original of [[], [{ body: "changed" }]])
    expect(
      await fixture({
        actor: "operator",
        override: (sql) =>
          sql.includes("FROM support_request_mutations WHERE")
            ? [mutation]
            : sql.startsWith("SELECT body FROM")
              ? original
              : undefined,
      }).use.reply(token, scope, key, input.body),
    ).toEqual({ kind: "conflict" });
});
it("returns empty withdrawn member detail and keeps repeated withdrawal stable", async () => {
  const f = fixture({
    override: (sql) =>
      sql.includes("WHERE r.id=ANY")
        ? [{ ...row, withdrawnAt: date }]
        : sql.includes("r.subject,r.body FROM")
          ? [{ ...detail, subject: null, body: null, withdrawnAt: date }]
          : undefined,
  });
  expect(await f.use.memberDetail(token, requestId)).toMatchObject({
    kind: "ready",
    value: { body: null, replies: { items: [], nextCursor: null } },
  });
  expect(await f.use.withdraw(token, requestId)).toEqual({
    kind: "already-withdrawn",
  });
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(
    false,
  );
});
function signed(
  data: unknown,
  scopeName = "owner-history",
  tokenValue = token,
) {
  const body = Buffer.from(
    typeof data === "string" ? data : JSON.stringify(data),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(hash(tokenValue)).update("\0").update(scopeName).update("\0").update(body).digest("base64url")}`;
}
const validCursor = () => [
  candidate.cursorAt,
  requestId,
  "",
  Date.now() + 60000,
];
it("denies tampered, cross-actor, cross-projection, expired and noncanonical continuation cursors", async () => {
  const values: unknown[] = [
    "not json",
    {},
    [],
    [3, requestId, "", future.valueOf()],
    ["bad", requestId, "", future.valueOf()],
    ["2026-99-01T00:00:00.000001Z", requestId, "", future.valueOf()],
    ["2026-02-30T00:00:00.000001Z", requestId, "", future.valueOf()],
    [candidate.cursorAt, 3, "", future.valueOf()],
    [candidate.cursorAt, "bad", "", future.valueOf()],
    [candidate.cursorAt, requestId, "note", future.valueOf()],
    [candidate.cursorAt, requestId, "", 3.5],
    [candidate.cursorAt, requestId, "", 1],
  ];
  for (const after of [
    "x".repeat(1025),
    "bad",
    signed(validCursor(), "wrong"),
    signed(validCursor(), "owner-history", "b".repeat(64)),
    ...values.map((value) => signed(value)),
  ])
    expect(await fixture().use.ownerHistory(token, after)).toEqual({
      kind: "denied",
    });
});
it("paginates every projection at twenty without exposing internal-note metadata to members", async () => {
  const messages = Array.from({ length: 21 }, (_, i) => ({
    id: id(i + 100),
    body: `Invented ${i}`,
    createdAt: date,
    kind: "reply",
    attribution: "Synthetic operator",
    cursorAt: candidate.cursorAt,
  }));
  const histories = messages.map((message) => ({
    ...detail,
    requestId: message.id,
    cursorAt: candidate.cursorAt,
  }));
  const candidates = messages.map((message) => ({
    ...candidate,
    requestId: message.id,
  }));
  const override: Override = (sql) =>
    sql.includes("FROM (SELECT id,body")
      ? messages
      : sql.includes("JOIN LATERAL")
        ? candidates
        : sql.includes("FROM support_request_grants WHERE id=ANY")
          ? candidates.map((c) => ({ ...grant, requestId: c.requestId }))
          : sql.includes("WHERE r.id=ANY")
            ? candidates.map((c) => ({ ...row, requestId: c.requestId }))
            : sql.includes("r.subject,") && sql.includes('AS "cursorAt"')
              ? histories
              : undefined;
  // Direct detail uses its own request while worklist has twenty-one candidates.
  const detailOverride: Override = (sql, values) =>
    sql.includes("WHERE r.id=ANY")
      ? [row]
      : sql.includes("FROM support_request_grants WHERE id=ANY")
        ? [grant]
        : override(sql, values);
  const ownerStore = fixture({ override: detailOverride }).use;
  const staffStore = fixture({
    actor: "operator",
    override: detailOverride,
  }).use;
  for (const [read, scopeName] of [
    [
      (after?: string) => ownerStore.ownerHistory(token, after),
      "owner-history",
    ],
    [
      (after?: string) => ownerStore.memberDetail(token, requestId, after),
      `member:${requestId}`,
    ],
    [
      (after?: string) => staffStore.operatorDetail(token, scope, after),
      `operator:${requestId}:${grantId}`,
    ],
    [
      (after?: string) =>
        fixture({ actor: "operator", override }).use.operatorWorklist(
          token,
          after,
        ),
      "operator-worklist",
    ],
  ] as const) {
    const first = await read();
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") throw Error("Expected authorized page");
    const page =
      "replies" in first.value
        ? first.value.replies
        : "messages" in first.value
          ? first.value.messages
          : first.value;
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBeTruthy();
    expect((await read(page.nextCursor!)).kind).toBe("ready");
    expect(
      (
        await read(
          signed(
            [candidate.cursorAt, requestId, "reply", Date.now() + 10000],
            scopeName,
          ),
        )
      ).kind,
    ).toBe("ready");
  }
  const member = await ownerStore.memberDetail(token, requestId);
  expect(JSON.stringify(member)).not.toContain('"kind":"reply"');
  const empty = fixture({
    actor: "operator",
    override: (sql) => (sql.includes("JOIN LATERAL") ? [] : undefined),
  });
  expect(await empty.use.operatorWorklist(token)).toEqual({
    kind: "ready",
    value: { items: [], nextCursor: null },
  });
});
it("rechecks cursor expiry after slow protected reads and audit writes", async () => {
  for (const name of [
    "ownerHistory",
    "memberDetail",
    "operatorWorklist",
    "operatorDetail",
  ] as const) {
    const scopeName =
      name === "ownerHistory"
        ? "owner-history"
        : name === "memberDetail"
          ? `member:${requestId}`
          : name === "operatorWorklist"
            ? "operator-worklist"
            : `operator:${requestId}:${grantId}`;
    const expiry = Date.now() + 1000,
      after = signed([candidate.cursorAt, requestId, "", expiry]);
    const valid =
      scopeName === "owner-history"
        ? after
        : signed([candidate.cursorAt, requestId, "", expiry], scopeName);
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(expiry - 1)
      .mockReturnValue(expiry + 1);
    const f = fixture({ actor: actorFor(name) });
    const result =
      name === "ownerHistory"
        ? await f.use.ownerHistory(token, valid)
        : name === "memberDetail"
          ? await f.use.memberDetail(token, requestId, valid)
          : name === "operatorWorklist"
            ? await f.use.operatorWorklist(token, valid)
            : await f.use.operatorDetail(token, scope, valid);
    expect(result).toEqual({ kind: "denied" });
    expect(f.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    vi.restoreAllMocks();
  }
});
it("authorizes grant administration from current real staff roles and refuses scope drift", async () => {
  for (const override of [
    ((sql) =>
      sql.startsWith("SELECT member_id") ? [] : undefined) as Override,
    ((sql) =>
      sql.includes("FROM staff_profiles")
        ? [
            { id: admin, role: "operator" },
            { id: operator, role: "operator" },
          ]
        : undefined) as Override,
    ((sql) =>
      sql.includes("FROM staff_profiles")
        ? [
            { id: admin, role: "platform_admin" },
            { id: operator, role: "platform_admin" },
          ]
        : undefined) as Override,
    ((sql) =>
      sql.includes("FROM principals WHERE id=ANY")
        ? [
            { id: owner, kind: "member" },
            { id: operator, kind: "staff", active: false },
            {
              id: admin,
              kind: "staff",
              tokenHash: hash(token),
              active: true,
              expiresAt: future,
            },
          ]
        : undefined) as Override,
  ])
    expect(
      await fixture({ actor: "admin", override }).use.grant(token, grantInput),
    ).toEqual({ kind: "denied" });
  for (const record of [
    [],
    [{ ...row, memberId: operator }],
    [{ ...row, workspaceId: operator }],
  ]) {
    const f = fixture({
      actor: "admin",
      override: (sql) => (sql.includes("WHERE r.id=ANY") ? record : undefined),
    });
    expect(await f.use.grant(token, grantInput)).toEqual({ kind: "denied" });
    expect(await f.use.revoke(token, grantId)).toEqual({ kind: "denied" });
  }
  expect(
    await fixture({
      actor: "admin",
      override: (sql) =>
        sql.includes("WHERE r.id=ANY")
          ? [{ ...row, withdrawnAt: date }]
          : undefined,
    }).use.grant(token, grantInput),
  ).toEqual({ kind: "withdrawn" });
  for (const change of [
    {},
    { requestId: id(55) },
    { staffId: admin },
    { role: "platform_admin" },
    { startsAt: new Date("2025-01-01") },
    { expiresAt: new Date("2099-01-01") },
    { revokedAt: date },
  ]) {
    const result = await fixture({
      actor: "admin",
      override: (sql) =>
        sql.includes("WHERE granted_by")
          ? [{ ...grant, ...change }]
          : undefined,
    }).use.grant(token, grantInput);
    expect(result.kind).toBe(
      Object.keys(change).length === 0 ? "replayed" : "conflict",
    );
  }
  for (const override of [
    ((sql) =>
      sql.startsWith("SELECT g.request_id") ? [] : undefined) as Override,
    ((sql) =>
      sql.includes("FROM staff_profiles")
        ? [{ id: admin, role: "operator" }]
        : undefined) as Override,
    ...[null, { requestId: id(55) }, { staffId: admin }].map(
      (change) => (sql: string) =>
        sql.includes("FROM support_request_grants WHERE id=ANY")
          ? change === null
            ? []
            : [{ ...grant, ...change }]
          : undefined,
    ),
  ])
    expect(
      await fixture({ actor: "admin", override }).use.revoke(token, grantId),
    ).toEqual({ kind: "denied" });
  expect(
    await fixture({
      actor: "admin",
      override: (sql) =>
        sql.includes("FROM support_request_grants WHERE id=ANY")
          ? [{ ...grant, revokedAt: date }]
          : undefined,
    }).use.revoke(token, grantId),
  ).toEqual({ kind: "already-revoked" });
});
