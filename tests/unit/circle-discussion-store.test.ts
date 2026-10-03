import { createHmac, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import {
  circleDiscussionStore,
  disabledCircleDiscussionStore,
  CIRCLE_DISCUSSION_POLICY,
  type CircleDiscussionStore,
} from "../../src/circle-discussion.ts";
const token = "a".repeat(64),
  actor = "00000000-0000-4000-8000-000000000001",
  choice = "00000000-0000-4000-8000-000000000002",
  id = "00000000-0000-4000-8000-000000000003",
  circle = "everyday-ai",
  secret = "invented-unit-secret";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function operations(db: CircleDiscussionStore, t = token, c = circle) {
  return {
    choice: () => db.choice(t, c),
    choose: () => db.choose(t, c, id, "1", CIRCLE_DISCUSSION_POLICY, true),
    list: () => db.list(t, c),
    thread: () => db.thread(t, c, id),
    post: () => db.post(t, c, id, "Invented question", true),
    report: () => db.report(t, c, id, id, "privacy"),
    withdraw: () => db.withdraw(t, c, id, true),
    withdrawChoice: () => db.withdrawChoice(t, c, true),
    owned: () => db.owned(t, c),
    reports: () => db.reports(t, c),
    reportReceipt: () => db.reportReceipt(t, c, id),
    reconcile: () => db.reconcile(t, c, "post", id),
    grantModerator: () =>
      db.grantModerator(t, id, c, id, new Date(Date.now() + 60000)),
    revokeModerator: () => db.revokeModerator(t, c, id),
    moderationQueue: () => db.moderationQueue(t, c),
    moderate: () => db.moderate(t, c, id, id, "hide", 1, "privacy"),
  };
}
interface InventedPost {
  id: string;
  member_id: string;
  choice_id: string;
  root_id: string | null;
  body: string | null;
  state: "visible" | "hidden" | "withdrawn";
  revision: number;
  createdAt: string;
}
interface PriorPost {
  id: string;
  fingerprint: string | null;
  state: string;
  circle_id: string;
  root_id: string | null;
}
interface PriorChoice {
  id: string;
  circle_id: string;
  generation: string;
  policy_version: string;
  revoked_at: Date | null;
}
interface MemberFixture {
  priorReport: {
    id: string;
    circle_id: string;
    target_id: string;
    category: string;
  } | null;
  duplicateReport: { id: string; category: string } | null;
  bodyRows: boolean;
  priorPost: PriorPost | null;
  priorChoice: PriorChoice | null;
  postCount: number;
  replyCount: number;
  withdrawal: { id: string; state: string } | null;
  reports: {
    id: string;
    target_id: string;
    category: "privacy";
    createdAt: string;
  }[];
  posts: InventedPost[];
  identity: boolean;
  principal: boolean;
  workspace: boolean;
  joined: boolean;
  chosen: boolean;
  receipt: {
    id: string | null;
    status: string;
    revision: number | null;
  } | null;
  current: { n: number; grant_active: boolean; remaining_ms: string } | null;
}
function fixture(overrides: Partial<MemberFixture> = {}) {
  const state: MemberFixture = {
    priorReport: null,
    duplicateReport: null,
    bodyRows: true,
    priorPost: null,
    priorChoice: null,
    postCount: 0,
    replyCount: 0,
    withdrawal: null,
    reports: [],
    posts: [],
    identity: true,
    principal: true,
    workspace: true,
    joined: true,
    chosen: true,
    receipt: null,
    current: { n: 1, grant_active: true, remaining_ms: "60000" },
    ...overrides,
  };
  const commands: string[] = [],
    insertions: unknown[][] = [],
    postInsertions: unknown[][] = [],
    reportInsertions: unknown[][] = [],
    changes: string[] = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    commands.push(sql);
    if (
      ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) ||
      sql.startsWith("SET LOCAL") ||
      sql.includes("set_config(") ||
      sql.includes("pg_advisory_xact_lock(")
    )
      return { rows: [] };
    if (sql.startsWith("WITH instant"))
      return { rows: state.current ? [state.current] : [] };
    if (sql.startsWith("SELECT id FROM principals WHERE token_hash="))
      return { rows: state.identity ? [{ id: actor }] : [] };
    if (sql.includes("FROM principals WHERE id=ANY"))
      return { rows: state.principal ? [{ id: actor }] : [] };
    if (sql.includes("FROM workspaces WHERE owner_principal_id=ANY"))
      return { rows: state.workspace ? [{ owner_principal_id: actor }] : [] };
    if (sql.includes("FROM preview_circle_memberships"))
      return {
        rows: state.joined ? [{ member_id: actor, generation: "1" }] : [],
      };
    if (sql.includes("FROM preview_circle_choices c"))
      return {
        rows: state.chosen
          ? [
              {
                id: choice,
                member_id: actor,
                pseudonym: "Peer aaaaaaaaaaaaaaaa",
              },
            ]
          : [],
      };
    if (
      sql.startsWith(
        "SELECT id,circle_id,generation::text,policy_version,revoked_at",
      )
    )
      return { rows: state.priorChoice ? [state.priorChoice] : [] };
    if (sql.startsWith("SELECT id,fingerprint,state,circle_id,root_id"))
      return { rows: state.priorPost ? [state.priorPost] : [] };
    if (sql.startsWith("SELECT count(*)::integer n FROM preview_circle_posts"))
      return {
        rows: [
          {
            n: sql.includes("WHERE root_id=")
              ? state.replyCount
              : state.postCount,
          },
        ],
      };
    if (sql.startsWith("INSERT INTO preview_circle_posts")) {
      postInsertions.push(values);
      return { rows: [] };
    }
    if (sql.startsWith("SELECT id,state FROM preview_circle_posts"))
      return { rows: state.withdrawal ? [state.withdrawal] : [] };
    if (sql.startsWith("UPDATE preview_circle_posts")) {
      changes.push(sql);
      return { rows: [] };
    }
    if (
      sql.includes("FROM preview_circle_choices WHERE member_id=") &&
      sql.includes("idempotency_key")
    )
      return {
        rows:
          sql.includes(" AS ") || sql.includes("CASE WHEN")
            ? state.receipt
              ? [state.receipt]
              : []
            : [],
      };
    if (
      sql.includes("FROM preview_circle_posts WHERE member_id=") &&
      sql.includes("idempotency_key")
    )
      return { rows: state.receipt ? [state.receipt] : [] };
    if (
      sql.startsWith(
        "SELECT id,circle_id,target_id,category FROM preview_circle_reports",
      )
    )
      return { rows: state.priorReport ? [state.priorReport] : [] };
    if (sql.startsWith("SELECT id,category FROM preview_circle_reports"))
      return { rows: state.duplicateReport ? [state.duplicateReport] : [] };
    if (sql.startsWith("INSERT INTO preview_circle_reports")) {
      reportInsertions.push(values);
      return { rows: [] };
    }
    if (
      sql.includes("FROM preview_circle_reports WHERE member_id=") &&
      sql.includes("idempotency_key")
    )
      return { rows: state.receipt ? [state.receipt] : [] };
    if (sql.startsWith("INSERT INTO preview_circle_choices")) {
      insertions.push(values);
      return { rows: [] };
    }
    if (sql.startsWith("SELECT id,target_id,category,created_at")) {
      const receiptId = values[2],
        after = values[3];
      return {
        rows: state.reports
          .filter(
            (r) =>
              (receiptId === null || r.id === receiptId) &&
              (after === null || r.id > String(after)),
          )
          .slice(0, 21),
      };
    }
    if (
      sql.startsWith(
        "SELECT id,member_id,choice_id,root_id,state,revision FROM preview_circle_posts",
      )
    ) {
      const rows = sql.includes("WHERE id=$1")
        ? state.posts.filter((p) => p.id === values[0])
        : sql.includes("root_id=$2")
          ? state.posts.filter((p) => p.root_id === values[1])
          : state.posts;
      return { rows };
    }
    if (sql.startsWith("SELECT id,body,state,revision")) {
      const ids = values[0] as string[];
      return {
        rows: (state.bodyRows ? state.posts : [])
          .filter((p) => ids.includes(p.id))
          .map((p) => ({ ...p, rootId: p.root_id })),
      };
    }
    // Absent target/receipt/staff observations are legitimate negative fixtures;
    // PostgreSQL integration tests separately prove the real query isolation.
    return { rows: [] };
  });
  const release = vi.fn(),
    connect = vi.fn(async () => ({ query, release }) as unknown as PoolClient),
    pool = { connect } as unknown as Pool;
  return {
    state,
    query,
    release,
    connect,
    pool,
    commands,
    insertions,
    postInsertions,
    reportInsertions,
    changes,
    db: circleDiscussionStore(pool, secret),
  };
}
it("disables every operation unless the discussion store is explicitly supplied", async () => {
  const db = disabledCircleDiscussionStore();
  for (const call of Object.values(operations(db)))
    expect(await call()).toEqual({ kind: "denied" });
});
it.each(["bad-token", "unknown-circle"])(
  "denies all operations for %s before acquiring a connection",
  async (kind) => {
    const f = fixture();
    for (const call of Object.values(
      operations(
        f.db,
        kind === "bad-token" ? "bad" : token,
        kind === "unknown-circle" ? "unknown" : circle,
      ),
    ))
      expect(await call()).toEqual({ kind: "denied" });
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it("pauses group operations without treating pause as permission to access any retained data", async () => {
  const f = fixture({ identity: false }),
    db = circleDiscussionStore(f.pool, secret, false),
    calls = operations(db);
  for (const name of [
    "choice",
    "choose",
    "list",
    "thread",
    "post",
    "report",
    "grantModerator",
    "moderationQueue",
    "moderate",
  ] as const)
    expect(await calls[name]()).toEqual({ kind: "denied" });
  expect(f.connect).not.toHaveBeenCalled();
  for (const name of [
    "owned",
    "reports",
    "reportReceipt",
    "reconcile",
    "withdraw",
    "withdrawChoice",
    "revokeModerator",
  ] as const)
    expect(await calls[name]()).toEqual({ kind: "denied" });
  expect(f.commands.filter((sql) => sql === "COMMIT")).toHaveLength(0);
});
it("denies an unrecognized actor across all public store operations and releases each connection once", async () => {
  const f = fixture({ identity: false });
  for (const call of Object.values(operations(f.db)))
    expect(await call()).toEqual({ kind: "denied" });
  expect(f.release).toHaveBeenCalledTimes(Object.keys(operations(f.db)).length);
  expect(f.commands.filter((sql) => sql === "COMMIT")).toEqual([]);
});
it.each(["principal", "workspace", "joined"] as const)(
  "withholds choice state when the current %s observation is absent",
  async (gate) => {
    const f = fixture({ [gate]: false });
    expect(await f.db.choice(token, circle)).toEqual({ kind: "denied" });
    expect(f.commands).toContain("ROLLBACK");
    expect(f.commands).not.toContain("COMMIT");
  },
);
it.each([false, true])(
  "returns the real separate choice state when chosen=%s",
  async (chosen) => {
    const f = fixture({ chosen });
    expect(await f.db.choice(token, circle)).toEqual({
      kind: "ready",
      value: { generation: "1", active: chosen },
    });
    expect(f.commands.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(f.release).toHaveBeenCalledOnce();
  },
);
it("requires the current sharing choice for posting even when membership is present", async () => {
  const f = fixture({ chosen: false });
  expect(await f.db.post(token, circle, id, "Invented question", true)).toEqual(
    { kind: "denied" },
  );
  expect(f.insertions).toEqual([]);
});
it.each([
  ["key", "bad", "1", CIRCLE_DISCUSSION_POLICY, true],
  ["generation", id, "bad", CIRCLE_DISCUSSION_POLICY, true],
  ["policy", id, "1", "other-policy", true],
  ["confirmation", id, "1", CIRCLE_DISCUSSION_POLICY, false],
] as const)(
  "rejects invalid sharing %s without opening a transaction",
  async (_name, key, generation, policy, confirmed) => {
    const f = fixture();
    expect(
      await f.db.choose(token, circle, key, generation, policy, confirmed),
    ).toEqual({ kind: "invalid" });
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it("does not overwrite an existing choice and rejects a stale membership generation", async () => {
  const f = fixture();
  expect(
    await f.db.choose(token, circle, id, "2", CIRCLE_DISCUSSION_POLICY, true),
  ).toEqual({ kind: "conflict" });
  expect(
    await f.db.choose(token, circle, id, "1", CIRCLE_DISCUSSION_POLICY, true),
  ).toEqual({ kind: "conflict" });
  expect(f.insertions).toEqual([]);
});
it("creates a separately confirmed choice for the current generation and commits once", async () => {
  const f = fixture({ chosen: false });
  const response = await f.db.choose(
    token,
    circle,
    id,
    "1",
    CIRCLE_DISCUSSION_POLICY,
    true,
  );
  expect(response.kind).toBe("ready");
  if (response.kind !== "ready") throw Error("Invented choice unavailable");
  expect(response.value.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(f.insertions).toHaveLength(1);
  expect(f.insertions[0]!.slice(1, 7)).toEqual([
    actor,
    circle,
    "1",
    CIRCLE_DISCUSSION_POLICY,
    expect.stringMatching(/^Peer [a-f0-9]{16}$/),
    id,
  ]);
  expect(f.commands.filter((sql) => sql === "COMMIT")).toHaveLength(1);
});
it.each(["choice", "post", "report"])(
  "returns only content-free owned %s original-key receipt fields",
  async (kind) => {
    const receipt = {
        id,
        status: kind === "post" ? "withdrawn" : "retained",
        revision: kind === "post" ? 2 : null,
      },
      f = fixture({ receipt, joined: false, chosen: false });
    expect(await f.db.reconcile(token, circle, kind, id)).toEqual({
      kind: "ready",
      value: { found: true, ...receipt },
    });
    f.state.receipt = null;
    expect(await f.db.reconcile(token, circle, kind, id)).toEqual({
      kind: "ready",
      value: { found: false, id: null, status: null, revision: null },
    });
  },
);
it.each([
  null,
  { n: 0, grant_active: true, remaining_ms: "60000" },
  { n: 1, grant_active: false, remaining_ms: "60000" },
  { n: 1, grant_active: true, remaining_ms: "NaN" },
  { n: 1, grant_active: true, remaining_ms: "0" },
])(
  "withholds a ready receipt when final current authorization no longer proves validity: %j",
  async (current) => {
    const f = fixture({ current });
    expect(await f.db.reconcile(token, circle, "post", id)).toEqual({
      kind: "denied",
    });
    expect(f.commands).toContain("ROLLBACK");
    expect(f.commands).not.toContain("COMMIT");
  },
);
it("withholds a ready result after the whole operation deadline", async () => {
  const f = fixture();
  const now = vi.spyOn(performance, "now");
  let elapsed = 0;
  now.mockImplementation(() => elapsed);
  const original = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, values) => {
    const result = await original(sql, values);
    if (sql.startsWith("WITH instant")) elapsed = 10001;
    return result;
  });
  expect(await f.db.choice(token, circle)).toEqual({ kind: "denied" });
  expect(f.commands).not.toContain("COMMIT");
});
it.each(["BEGIN", "COMMIT", "ROLLBACK", "release"])(
  "suppresses sensitive %s failures without acknowledgement or automatic replay",
  async (stage) => {
    const f = fixture({ identity: stage !== "ROLLBACK" });
    if (stage === "release")
      f.release.mockImplementation(() => {
        throw Error("Invented private driver details");
      });
    else {
      const original = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (sql, values) => {
        if (sql === stage) {
          f.commands.push(sql);
          throw Error("Invented private driver details");
        }
        return original(sql, values);
      });
    }
    await expect(f.db.choice(token, circle)).rejects.toThrow(
      stage === "COMMIT" || stage === "release"
        ? "Circle outcome unconfirmed"
        : "Circle operation unavailable",
    );
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  },
);
it("rejects acquisition errors without leaking driver details", async () => {
  const f = fixture();
  f.connect.mockRejectedValue(Error("Invented connection failure"));
  await expect(f.db.owned(token, circle)).rejects.toThrow(
    "Circle operation unavailable",
  );
  expect(f.release).not.toHaveBeenCalled();
});
it("times out acquisition and discards a late connection without using it", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let resolve!: (client: PoolClient) => void;
  f.connect.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const assertion = expect(f.db.owned(token, circle)).rejects.toThrow(
    "Circle operation unavailable",
  );
  await vi.advanceTimersByTimeAsync(3000);
  await assertion;
  resolve({ query: f.query, release: f.release } as unknown as PoolClient);
  await Promise.resolve();
  await Promise.resolve();
  expect(f.release).toHaveBeenCalledWith(expect.any(Error));
  expect(f.query).not.toHaveBeenCalled();
});
function signed(value: unknown) {
  const encoded = Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
  ).toString("base64url");
  return (
    encoded + "." + createHmac("sha256", secret).update(encoded).digest("hex")
  );
}
it.each([
  "x".repeat(1025),
  "malformed",
  "a.bad",
  "a." + "0".repeat(64),
  signed("not-json"),
  signed(null),
  signed({
    actor,
    circle,
    kind: "wrong",
    last: id,
    policy: CIRCLE_DISCUSSION_POLICY,
    choice: null,
  }),
])(
  "rejects a malformed or misbound private cursor before returning rows",
  async (cursor) => {
    const f = fixture();
    expect(await f.db.owned(token, circle, cursor)).toEqual({
      kind: "invalid",
    });
    expect(f.commands).not.toContain("COMMIT");
  },
);
it("accepts only a current actor's exact private continuation without requiring group choice", async () => {
  const f = fixture({ joined: false, chosen: false });
  expect(
    await f.db.owned(
      token,
      circle,
      signed({
        actor,
        circle,
        kind: "owned",
        last: id,
        policy: CIRCLE_DISCUSSION_POLICY,
        choice: null,
      }),
    ),
  ).toEqual({ kind: "ready", value: { items: [], nextCursor: null } });
});
it("treats choice withdrawal as a private operation that remains available after leaving", async () => {
  const f = fixture({ joined: false, chosen: false });
  expect(
    await circleDiscussionStore(f.pool, secret, false).withdrawChoice(
      token,
      circle,
      true,
    ),
  ).toEqual({ kind: "ready", value: { id: actor } });
  expect(f.release).toHaveBeenCalledOnce();
});

const validationCases: [
  string,
  (db: CircleDiscussionStore) => Promise<unknown>,
][] = [
  ["thread UUID", (db) => db.thread(token, circle, "invalid")],
  [
    "post key",
    (db) => db.post(token, circle, "bad", "Invented question", true),
  ],
  ["empty post", (db) => db.post(token, circle, id, "  ", true)],
  ["overlong post", (db) => db.post(token, circle, id, "x".repeat(2001), true)],
  [
    "post confirmation",
    (db) => db.post(token, circle, id, "Invented question", false),
  ],
  [
    "reply UUID",
    (db) => db.post(token, circle, id, "Invented question", true, "bad"),
  ],
  ["report target", (db) => db.report(token, circle, "bad", id, "privacy")],
  ["report key", (db) => db.report(token, circle, id, "bad", "privacy")],
  [
    "report category",
    (db) => db.report(token, circle, id, id, "invented-private-free-text"),
  ],
  ["withdraw UUID", (db) => db.withdraw(token, circle, "bad", true)],
  ["withdraw confirmation", (db) => db.withdraw(token, circle, id, false)],
  [
    "choice withdrawal confirmation",
    (db) => db.withdrawChoice(token, circle, false),
  ],
  ["receipt UUID", (db) => db.reportReceipt(token, circle, "bad")],
  ["reconciliation key", (db) => db.reconcile(token, circle, "post", "bad")],
  ["reconciliation kind", (db) => db.reconcile(token, circle, "unknown", id)],
  [
    "staff UUID",
    (db) =>
      db.grantModerator(token, "bad", circle, id, new Date(Date.now() + 60000)),
  ],
  [
    "grant key",
    (db) =>
      db.grantModerator(token, id, circle, "bad", new Date(Date.now() + 60000)),
  ],
  [
    "grant invalid date",
    (db) => db.grantModerator(token, id, circle, id, new Date("bad")),
  ],
  [
    "grant past date",
    (db) => db.grantModerator(token, id, circle, id, new Date(Date.now() - 1)),
  ],
  ["revoke UUID", (db) => db.revokeModerator(token, circle, "bad")],
  [
    "moderation target",
    (db) => db.moderate(token, circle, "bad", id, "hide", 1, "privacy"),
  ],
  [
    "moderation key",
    (db) => db.moderate(token, circle, id, "bad", "hide", 1, "privacy"),
  ],
  [
    "moderation action",
    (db) => db.moderate(token, circle, id, id, "delete", 1, "privacy"),
  ],
  [
    "moderation fractional revision",
    (db) => db.moderate(token, circle, id, id, "hide", 1.1, "privacy"),
  ],
  [
    "moderation zero revision",
    (db) => db.moderate(token, circle, id, id, "hide", 0, "privacy"),
  ],
  [
    "moderation reason",
    (db) => db.moderate(token, circle, id, id, "hide", 1, "private-text"),
  ],
];
it.each(validationCases)(
  "rejects invalid %s before opening a connection",
  async (_name, call) => {
    const f = fixture();
    expect(await call(f.db)).toEqual({ kind: "invalid" });
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it.each([
  { actor: "another-actor" },
  { circle: "professional-work" },
  { policy: "old-policy" },
  { choice: id },
  { last: 1 },
  { last: "bad" },
])("rejects private continuation with mismatched %j", async (patch) => {
  const f = fixture();
  const cursor = signed({
    actor,
    circle,
    kind: "owned",
    last: id,
    policy: CIRCLE_DISCUSSION_POLICY,
    choice: null,
    ...patch,
  });
  expect(await f.db.owned(token, circle, cursor)).toEqual({ kind: "invalid" });
});
function inventedPost(patch: Partial<InventedPost> = {}): InventedPost {
  return {
    id,
    member_id: actor,
    choice_id: choice,
    root_id: null,
    body: "Invented retained text",
    state: "visible",
    revision: 1,
    createdAt: "2026-10-03T00:00:00Z",
    ...patch,
  };
}
it("keeps an independently owned reply private without exporting its foreign-root reference", async () => {
  const f = fixture({
    joined: false,
    chosen: false,
    posts: [inventedPost({ root_id: randomUUID(), state: "hidden" })],
  });
  expect(
    await circleDiscussionStore(f.pool, secret, false).owned(token, circle),
  ).toEqual({
    kind: "ready",
    value: {
      items: [
        {
          id,
          body: "Invented retained text",
          state: "hidden",
          revision: 1,
          createdAt: "2026-10-03T00:00:00Z",
          pseudonym: "Your invented contribution",
        },
      ],
      nextCursor: null,
    },
  });
});
it("filters old-choice, hidden and no-longer-authorized source metadata before exposing any group text", async () => {
  const f = fixture({
    posts: [
      inventedPost(),
      inventedPost({
        id: randomUUID(),
        choice_id: randomUUID(),
        body: "Invented old choice text",
      }),
      inventedPost({
        id: randomUUID(),
        state: "hidden",
        body: "Invented hidden source",
      }),
      inventedPost({
        id: randomUUID(),
        member_id: randomUUID(),
        body: "Invented unrecognized source",
      }),
    ],
  });
  const response = await f.db.list(token, circle);
  expect(response.kind).toBe("ready");
  if (response.kind !== "ready") throw Error("Invented list unavailable");
  expect(response.value.items).toEqual([
    {
      id,
      body: "Invented retained text",
      state: "visible",
      revision: 1,
      createdAt: "2026-10-03T00:00:00Z",
      rootId: null,
      pseudonym: "Peer aaaaaaaaaaaaaaaa",
    },
  ]);
});
it("continues a bounded owned page with a signed original actor key, and denies its reuse in group or report lists", async () => {
  const posts = Array.from({ length: 21 }, () =>
    inventedPost({ id: randomUUID() }),
  ).sort((a, b) => a.id.localeCompare(b.id));
  const f = fixture({ posts });
  const first = await f.db.owned(token, circle);
  if (first.kind !== "ready") throw Error("Invented owned page unavailable");
  expect(first.value.items).toHaveLength(20);
  expect(first.value.nextCursor).toBeTruthy();
  expect(await f.db.list(token, circle, first.value.nextCursor!)).toEqual({
    kind: "invalid",
  });
  expect(await f.db.reports(token, circle, first.value.nextCursor!)).toEqual({
    kind: "invalid",
  });
  f.state.posts = posts.slice(20);
  const next = await f.db.owned(token, circle, first.value.nextCursor!);
  if (next.kind !== "ready") throw Error("Invented continuation unavailable");
  expect(next.value.items.map((item) => item.id)).toEqual([posts[20]!.id]);
  expect(next.value.nextCursor).toBeNull();
});

const reportId = "00000000-0000-4000-8000-000000000004";
function inventedReport(target_id = id, report_id = reportId) {
  return {
    id: report_id,
    target_id,
    category: "privacy" as const,
    createdAt: "2026-10-03T00:00:00Z",
  };
}
it.each([
  ["visible", inventedPost(), "reported"],
  ["hidden", inventedPost({ state: "hidden" }), "hidden"],
  [
    "withdrawn",
    inventedPost({ state: "withdrawn", body: null }),
    "unavailable",
  ],
  ["old-choice", inventedPost({ choice_id: randomUUID() }), "unavailable"],
  ["foreign-source", inventedPost({ member_id: randomUUID() }), "unavailable"],
] as const)(
  "returns a content-free receipt for a %s source without copying its body or root identity",
  async (_state, post, status) => {
    const f = fixture({ posts: [post], reports: [inventedReport()] });
    expect(await f.db.reportReceipt(token, circle, reportId)).toEqual({
      kind: "ready",
      value: {
        id: reportId,
        category: "privacy",
        status,
        createdAt: "2026-10-03T00:00:00Z",
      },
    });
    expect(await f.db.reportReceipt(token, circle, randomUUID())).toEqual({
      kind: "denied",
    });
    expect(f.commands.some((sql) => sql.startsWith("SELECT id,body"))).toBe(
      false,
    );
  },
);
it("marks a reply report unavailable when its root is missing, hidden, or from an old choice", async () => {
  const root = randomUUID(),
    reply = inventedPost({ root_id: root }),
    f = fixture({ reports: [inventedReport()], posts: [reply] });
  for (const rootPost of [
    undefined,
    inventedPost({ id: root, state: "hidden" }),
    inventedPost({ id: root, choice_id: randomUUID() }),
  ]) {
    f.state.posts = rootPost ? [reply, rootPost] : [reply];
    const receipt = await f.db.reportReceipt(token, circle, reportId);
    expect(receipt).toEqual({
      kind: "ready",
      value: {
        id: reportId,
        category: "privacy",
        status: "unavailable",
        createdAt: "2026-10-03T00:00:00Z",
      },
    });
  }
  f.state.posts = [reply, inventedPost({ id: root })];
  const receipt = await f.db.reportReceipt(token, circle, reportId);
  if (receipt.kind !== "ready")
    throw Error("Invented reply receipt unavailable");
  expect(receipt.value.status).toBe("reported");
});
it.each([true, false])(
  "bounds content-free receipt pages during writes=%s without requiring active sharing",
  async (writes) => {
    const reports = Array.from({ length: 22 }, () =>
      inventedReport(id, randomUUID()),
    ).sort((a, b) => a.id.localeCompare(b.id));
    const f = fixture({ chosen: false, joined: false, reports, posts: [] }),
      db = circleDiscussionStore(f.pool, secret, writes);
    const first = await db.reports(token, circle);
    if (first.kind !== "ready") throw Error("Invented report page unavailable");
    expect(first.value.items).toHaveLength(20);
    expect(first.value.items.every((r) => r.status === "unavailable")).toBe(
      true,
    );
    expect(first.value.nextCursor).toBeTruthy();
    const next = await db.reports(token, circle, first.value.nextCursor!);
    if (next.kind !== "ready")
      throw Error("Invented report continuation unavailable");
    expect(next.value.items.map((r) => r.id)).toEqual(
      reports.slice(20).map((r) => r.id),
    );
    expect(next.value.nextCursor).toBeNull();
    expect(await db.owned(token, circle, first.value.nextCursor!)).toEqual({
      kind: "invalid",
    });
  },
);
it("denies private report reads when current owner workspace disappears after observation", async () => {
  const f = fixture({ workspace: false, reports: [inventedReport()] });
  expect(await f.db.reports(token, circle)).toEqual({ kind: "denied" });
});

it("stores only a deliberately confirmed trimmed question and returns a content-free ID", async () => {
  const f = fixture();
  const posted = await f.db.post(
    token,
    circle,
    id,
    "  Invented question  ",
    true,
  );
  if (posted.kind !== "ready")
    throw Error("Invented confirmed post unavailable");
  expect(Object.keys(posted.value)).toEqual(["id"]);
  expect(f.postInsertions).toHaveLength(1);
  expect(f.postInsertions[0]!.slice(1, 7)).toEqual([
    actor,
    circle,
    choice,
    null,
    "Invented question",
    id,
  ]);
  expect(f.commands.filter((sql) => sql === "COMMIT")).toHaveLength(1);
});
it.each([199, 200, 201])(
  "honors the retained-owner post bound at %s",
  async (postCount) => {
    const f = fixture({ postCount });
    const response = await f.db.post(
      token,
      circle,
      id,
      "Invented question",
      true,
    );
    expect(response.kind).toBe(postCount < 200 ? "ready" : "limit");
    expect(f.postInsertions).toHaveLength(postCount < 200 ? 1 : 0);
  },
);
it.each([99, 100, 101])(
  "honors the retained root-reply bound at %s",
  async (replyCount) => {
    const f = fixture({ replyCount, posts: [inventedPost()] });
    const response = await f.db.post(
      token,
      circle,
      randomUUID(),
      "Invented reply",
      true,
      id,
    );
    expect(response.kind).toBe(replyCount < 100 ? "ready" : "limit");
    expect(f.postInsertions).toHaveLength(replyCount < 100 ? 1 : 0);
  },
);
it.each([
  undefined,
  inventedPost({ state: "hidden" }),
  inventedPost({ state: "withdrawn", body: null }),
  inventedPost({ choice_id: randomUUID() }),
  inventedPost({ root_id: randomUUID() }),
])(
  "denies a reply when its root observation is unavailable or ineligible: %j",
  async (root) => {
    const f = fixture({ posts: root ? [root] : [] });
    expect(
      await f.db.post(token, circle, randomUUID(), "Invented reply", true, id),
    ).toEqual({ kind: "denied" });
    expect(f.postInsertions).toEqual([]);
  },
);
it("reconciles terminal withdrawn post keys without restoring text or creating a new post", async () => {
  const f = fixture({
    priorPost: {
      id,
      fingerprint: null,
      state: "withdrawn",
      circle_id: circle,
      root_id: null,
    },
  });
  expect(
    await f.db.post(
      token,
      circle,
      id,
      "Invented new text must not resurrect the old record",
      true,
    ),
  ).toEqual({ kind: "ready", value: { id } });
  expect(f.postInsertions).toEqual([]);
});
it.each([
  { circle_id: "professional-work", root_id: null },
  { circle_id: circle, root_id: randomUUID() },
  { circle_id: circle, root_id: null },
])(
  "conflicts on a changed destination, root, or payload under a retained original key: %j",
  async (patch) => {
    const f = fixture({
      priorPost: {
        id,
        fingerprint: "different-digest",
        state: "visible",
        ...patch,
      },
    });
    expect(
      await f.db.post(token, circle, id, "Different invented text", true),
    ).toEqual({ kind: "conflict" });
    expect(f.postInsertions).toEqual([]);
  },
);
it.each([
  {
    circle_id: circle,
    generation: "1",
    policy_version: CIRCLE_DISCUSSION_POLICY,
    revoked_at: null,
  },
  {
    circle_id: "professional-work",
    generation: "1",
    policy_version: CIRCLE_DISCUSSION_POLICY,
    revoked_at: null,
  },
  {
    circle_id: circle,
    generation: "2",
    policy_version: CIRCLE_DISCUSSION_POLICY,
    revoked_at: null,
  },
  {
    circle_id: circle,
    generation: "1",
    policy_version: "old-policy",
    revoked_at: null,
  },
  {
    circle_id: circle,
    generation: "1",
    policy_version: CIRCLE_DISCUSSION_POLICY,
    revoked_at: new Date(),
  },
])(
  "reuses a choice key only with its original current destination, generation and policy: %j",
  async (prior) => {
    const f = fixture({ priorChoice: { id, ...prior } });
    const response = await f.db.choose(
      token,
      circle,
      id,
      "1",
      CIRCLE_DISCUSSION_POLICY,
      true,
    );
    expect(response).toEqual(
      prior.circle_id === circle &&
        prior.generation === "1" &&
        prior.policy_version === CIRCLE_DISCUSSION_POLICY &&
        prior.revoked_at === null
        ? { kind: "ready", value: { id } }
        : { kind: "conflict" },
    );
    expect(f.insertions).toEqual([]);
  },
);
it.each([
  null,
  { id, state: "visible" },
  { id, state: "hidden" },
  { id, state: "withdrawn" },
])(
  "withdraws only a currently owned retained record and remains terminal on replay: %j",
  async (withdrawal) => {
    const f = fixture({ withdrawal, joined: false, chosen: false }),
      db = circleDiscussionStore(f.pool, secret, false);
    expect(await db.withdraw(token, circle, id, true)).toEqual(
      withdrawal ? { kind: "ready", value: { id } } : { kind: "denied" },
    );
    expect(f.changes).toHaveLength(
      withdrawal && withdrawal.state !== "withdrawn" ? 1 : 0,
    );
  },
);

it("replays the original confirmed post payload exactly once and rejects changed text under the same key", async () => {
  const f = fixture();
  const first = await f.db.post(
    token,
    circle,
    id,
    "Invented stable question",
    true,
  );
  if (first.kind !== "ready") throw Error("Invented post unavailable");
  const stored = f.postInsertions[0]!;
  f.state.priorPost = {
    id: first.value.id,
    circle_id: circle,
    root_id: null,
    state: "visible",
    fingerprint: stored[7] as string,
  };
  expect(
    await f.db.post(token, circle, id, "Invented stable question", true),
  ).toEqual(first);
  expect(
    await f.db.post(token, circle, id, "Changed invented question", true),
  ).toEqual({ kind: "conflict" });
  expect(f.postInsertions).toHaveLength(1);
});
it("returns one-level replies only while the root and original choices are eligible", async () => {
  const replyId = randomUUID(),
    root = inventedPost(),
    reply = inventedPost({
      id: replyId,
      root_id: id,
      body: "Invented independent reply",
    });
  const f = fixture({ posts: [root, reply] });
  const thread = await f.db.thread(token, circle, id);
  if (thread.kind !== "ready") throw Error("Invented thread unavailable");
  expect(thread.value.root.id).toBe(id);
  expect(thread.value.replies.items.map((r) => r.id)).toEqual([replyId]);
  expect(thread.value.replies.nextCursor).toBeNull();
  expect(await f.db.thread(token, circle, replyId)).toEqual({ kind: "denied" });
  for (const rootPatch of [
    { state: "hidden" as const },
    { choice_id: randomUUID() },
  ]) {
    f.state.posts = [{ ...root, ...rootPatch }, reply];
    expect(await f.db.thread(token, circle, id)).toEqual({ kind: "denied" });
  }
});
it("withholds a thread whose current root body is absent after target validation", async () => {
  const f = fixture({ posts: [inventedPost()], bodyRows: false });
  expect(await f.db.thread(token, circle, id)).toEqual({ kind: "denied" });
});
it("does not backfill an authorization-filtered group page from its lookahead item", async () => {
  const posts = Array.from({ length: 21 }, () =>
    inventedPost({ id: randomUUID(), choice_id: randomUUID() }),
  ).sort((a, b) => a.id.localeCompare(b.id));
  posts[20]!.choice_id = choice;
  const f = fixture({ posts });
  const listing = await f.db.list(token, circle);
  if (listing.kind !== "ready") throw Error("Invented group page unavailable");
  expect(listing.value.items).toEqual([]);
  expect(listing.value.nextCursor).toBeTruthy();
  const binding = JSON.parse(
    Buffer.from(listing.value.nextCursor!.split(".")[0]!, "base64url").toString(
      "utf8",
    ),
  );
  expect(binding).toMatchObject({
    actor,
    circle,
    kind: "roots",
    last: posts[19]!.id,
    choice,
  });
  f.state.posts = posts.slice(20);
  const next = await f.db.list(token, circle, listing.value.nextCursor!);
  if (next.kind !== "ready")
    throw Error("Invented next group page unavailable");
  expect(next.value.items.map((p) => p.id)).toEqual([posts[20]!.id]);
});
it("rejects a thread cursor with another root or stale circle choice", async () => {
  const f = fixture({ posts: [inventedPost()] });
  for (const binding of [
    { kind: "replies:" + randomUUID(), choice },
    { kind: "replies:" + id, choice: randomUUID() },
  ])
    expect(
      await f.db.thread(
        token,
        circle,
        id,
        signed({
          actor,
          circle,
          last: id,
          policy: CIRCLE_DISCUSSION_POLICY,
          ...binding,
        }),
      ),
    ).toEqual({ kind: "invalid" });
});

it("sanitizes synchronous acquisition failures as well as rejected promises", async () => {
  const f = fixture();
  f.connect.mockImplementation(() => {
    throw Error("Invented private synchronous driver failure");
  });
  await expect(f.db.owned(token, circle)).rejects.toThrow(
    "Circle operation unavailable",
  );
  expect(f.release).not.toHaveBeenCalled();
});

const reportTarget: InventedPost = {
  id,
  member_id: actor,
  choice_id: choice,
  root_id: null,
  body: "Invented reportable question",
  state: "visible",
  revision: 1,
  createdAt: "2026-10-03T00:00:00Z",
};
it("reports an exact visible item without copying text or an accusation", async () => {
  const f = fixture({ posts: [reportTarget] });
  const key = randomUUID();
  expect(await f.db.report(token, circle, id, key, "privacy")).toEqual({
    kind: "ready",
    value: { id: expect.any(String) },
  });
  expect(f.reportInsertions).toHaveLength(1);
  expect(f.reportInsertions[0]?.slice(1)).toEqual([
    actor,
    circle,
    id,
    "privacy",
    key,
  ]);
  expect(JSON.stringify(f.reportInsertions)).not.toContain(reportTarget.body);
});
it("returns the original content-free report receipt for the same key and payload", async () => {
  const receipt = randomUUID();
  const f = fixture({
    posts: [],
    priorReport: {
      id: receipt,
      circle_id: circle,
      target_id: id,
      category: "privacy",
    },
  });
  expect(await f.db.report(token, circle, id, randomUUID(), "privacy")).toEqual(
    { kind: "ready", value: { id: receipt } },
  );
  expect(f.reportInsertions).toEqual([]);
});
it.each([
  { circle_id: "technical-ai" },
  { target_id: choice },
  { category: "conduct" },
])("rejects a report key reused for a changed payload: %j", async (change) => {
  const f = fixture({
    posts: [reportTarget],
    priorReport: {
      id: randomUUID(),
      circle_id: circle,
      target_id: id,
      category: "privacy",
      ...change,
    },
  });
  expect(await f.db.report(token, circle, id, randomUUID(), "privacy")).toEqual(
    { kind: "conflict" },
  );
  expect(f.reportInsertions).toEqual([]);
});
it("deduplicates a second key reporting the same item with the same category", async () => {
  const receipt = randomUUID();
  const f = fixture({
    posts: [reportTarget],
    duplicateReport: { id: receipt, category: "privacy" },
  });
  expect(await f.db.report(token, circle, id, randomUUID(), "privacy")).toEqual(
    { kind: "ready", value: { id: receipt } },
  );
  expect(f.reportInsertions).toEqual([]);
});
it("does not reinterpret an existing report as a different accusation", async () => {
  const f = fixture({
    posts: [reportTarget],
    duplicateReport: { id: randomUUID(), category: "conduct" },
  });
  expect(await f.db.report(token, circle, id, randomUUID(), "privacy")).toEqual(
    { kind: "conflict" },
  );
  expect(f.reportInsertions).toEqual([]);
});
it.each([
  { state: "hidden" as const },
  { state: "withdrawn" as const },
  { choice_id: id },
  { member_id: id },
])(
  "cannot newly report an invisible or ineligible target: %j",
  async (change) => {
    const f = fixture({ posts: [{ ...reportTarget, ...change }] });
    expect(
      await f.db.report(token, circle, id, randomUUID(), "privacy"),
    ).toEqual({ kind: "denied" });
    expect(f.reportInsertions).toEqual([]);
  },
);
it("denies a report whose source does not exist", async () => {
  const f = fixture();
  expect(await f.db.report(token, circle, id, randomUUID(), "privacy")).toEqual(
    { kind: "denied" },
  );
  expect(f.reportInsertions).toEqual([]);
});
it("does not acknowledge a report after current authorization fails at handback", async () => {
  const f = fixture({
    posts: [reportTarget],
    current: { n: 0, grant_active: true, remaining_ms: "60000" },
  });
  expect(await f.db.report(token, circle, id, randomUUID(), "privacy")).toEqual(
    { kind: "denied" },
  );
  expect(f.commands).not.toContain("COMMIT");
  expect(f.commands.at(-1)).toBe("ROLLBACK");
});

it.each(["list", "thread"] as const)(
  "withholds %s when a principal becomes unavailable after initial observation",
  async (operation) => {
    const f = fixture({ posts: [inventedPost()] });
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, values = []) => {
      if (sql.includes("FROM principals WHERE id=ANY"))
        f.state.principal = false;
      return original(sql, values);
    });
    expect(
      await (operation === "list"
        ? f.db.list(token, circle)
        : f.db.thread(token, circle, id)),
    ).toEqual({ kind: "denied" });
    expect(f.commands).not.toContain("COMMIT");
  },
);
it("withholds a thread before reading replies when its actor cannot be observed", async () => {
  const f = fixture({ posts: [inventedPost()], identity: false });
  expect(await f.db.thread(token, circle, id)).toEqual({ kind: "denied" });
});
it("rejects a group continuation when sharing changes between observation and current authorization", async () => {
  const f = fixture({ posts: [inventedPost()] });
  const original = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, values = []) => {
    const result = await original(sql, values);
    if (sql.includes("FOR SHARE OF c"))
      return {
        rows: [
          { id: randomUUID(), member_id: actor, pseudonym: "Peer changed" },
        ],
      };
    return result;
  });
  expect(
    await f.db.list(
      token,
      circle,
      signed({
        actor,
        circle,
        last: id,
        kind: "roots",
        policy: CIRCLE_DISCUSSION_POLICY,
        choice,
      }),
    ),
  ).toEqual({ kind: "invalid" });
});
