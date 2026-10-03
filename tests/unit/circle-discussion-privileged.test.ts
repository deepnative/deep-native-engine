import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { expect, it, vi } from "vitest";
import {
  circleDiscussionStore,
  CIRCLE_DISCUSSION_POLICY,
} from "../../src/circle-discussion.ts";

const admin = "00000000-0000-4000-8000-000000000005";
const staff = "00000000-0000-4000-8000-000000000006";
const grant = "00000000-0000-4000-8000-000000000007";
const key = "00000000-0000-4000-8000-000000000009";
const token = "a".repeat(64);
const circle = "everyday-ai";
const expires = new Date(Date.now() + 600000);
interface GrantFixture {
  identity: boolean;
  adminExists: boolean;
  adminActive: boolean;
  staffExists: boolean;
  staffActive: boolean;
  adminRole: string | null;
  staffRole: string | null;
  fitsLifetime: boolean;
  observed: boolean;
  locked: boolean;
  revoked: boolean;
  finalActive: boolean;
  prior: {
    id: string;
    staff_id: string;
    circle_id: string;
    granted_by: string;
    expires_at: Date;
  } | null;
}
// These observations model authorization changes between identity discovery,
// locked current-role checks and transaction handback. SQL constraints and real
// concurrent lock behavior are exercised separately against PostgreSQL.
function fixture(overrides: Partial<GrantFixture> = {}, writes = true) {
  const state: GrantFixture = {
    identity: true,
    adminExists: true,
    adminActive: true,
    staffExists: true,
    staffActive: true,
    adminRole: "platform_admin",
    staffRole: "moderator",
    fitsLifetime: true,
    observed: true,
    locked: true,
    revoked: false,
    finalActive: true,
    prior: null,
    ...overrides,
  };
  const effects: { sql: string; values: unknown[] }[] = [];
  const commands: string[] = [];
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
      return {
        rows: [
          {
            n: (values[0] as string[]).length,
            grant_active: state.finalActive,
            remaining_ms: "60000",
          },
        ],
      };
    if (sql.startsWith("SELECT id FROM principals WHERE token_hash="))
      return { rows: state.identity ? [{ id: admin }] : [] };
    if (sql.includes("FROM principals WHERE id=ANY"))
      return {
        rows: [
          ...(state.adminExists
            ? [{ id: admin, active: state.adminActive }]
            : []),
          ...(state.staffExists
            ? [{ id: staff, active: state.staffActive }]
            : []),
        ],
      };
    if (sql.startsWith("SELECT principal_id,role FROM staff_profiles"))
      return {
        rows: [
          ...(state.adminRole
            ? [{ principal_id: admin, role: state.adminRole }]
            : []),
          ...(state.staffRole
            ? [{ principal_id: staff, role: state.staffRole }]
            : []),
        ],
      };
    if (sql.startsWith("SELECT s.role FROM staff_profiles"))
      return { rows: state.fitsLifetime ? [{ role: state.staffRole }] : [] };
    if (sql.includes("WHERE idempotency_key=$1"))
      return { rows: state.prior ? [state.prior] : [] };
    if (sql.startsWith("SELECT staff_id FROM preview_circle_moderator_grants"))
      return { rows: state.observed ? [{ staff_id: staff }] : [] };
    if (
      sql.startsWith("SELECT revoked_at FROM preview_circle_moderator_grants")
    )
      return {
        rows: state.locked
          ? [{ revoked_at: state.revoked ? new Date() : null }]
          : [],
      };
    if (sql.startsWith("INSERT INTO") || sql.startsWith("UPDATE ")) {
      effects.push({ sql, values });
      return { rows: [] };
    }
    throw Error("Unexpected grant boundary observation");
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return {
    state,
    effects,
    commands,
    release,
    db: circleDiscussionStore(pool, "invented-grant-secret", writes),
  };
}

it("creates an exact-circle grant and content-free audit under current administrator authority", async () => {
  const f = fixture();
  const result = await f.db.grantModerator(token, staff, circle, key, expires);
  expect(result).toEqual({ kind: "ready", value: { id: expect.any(String) } });
  expect(f.effects).toHaveLength(2);
  expect(f.effects[0]?.values.slice(1)).toEqual([
    staff,
    "moderator",
    circle,
    CIRCLE_DISCUSSION_POLICY,
    admin,
    key,
    expires,
  ]);
  expect(f.effects[1]?.values).toEqual([
    admin,
    staff,
    f.effects[0]?.values[0],
    circle,
  ]);
  expect(f.commands.at(-1)).toBe("COMMIT");
  expect(f.release).toHaveBeenCalledOnce();
});

it.each([
  { identity: false },
  { adminExists: false },
  { adminActive: false },
  { staffExists: false },
  { staffActive: false },
  { adminRole: null },
  { adminRole: "moderator" },
  { staffRole: null },
  { staffRole: "coach" },
])(
  "denies grant creation when current identity or role is unavailable: %j",
  async (change) => {
    const f = fixture(change);
    expect(
      await f.db.grantModerator(token, staff, circle, key, expires),
    ).toEqual({ kind: "denied" });
    expect(f.effects).toEqual([]);
    expect(f.commands.at(-1)).toBe("ROLLBACK");
  },
);

it("rejects a grant extending beyond its target principal lifetime", async () => {
  const f = fixture({ fitsLifetime: false });
  expect(await f.db.grantModerator(token, staff, circle, key, expires)).toEqual(
    { kind: "invalid" },
  );
  expect(f.effects).toEqual([]);
});

it("replays an identical grant without a second grant or audit", async () => {
  const f = fixture({
    prior: {
      id: grant,
      staff_id: staff,
      circle_id: circle,
      granted_by: admin,
      expires_at: expires,
    },
  });
  expect(await f.db.grantModerator(token, staff, circle, key, expires)).toEqual(
    { kind: "ready", value: { id: grant } },
  );
  expect(f.effects).toEqual([]);
});
it.each([
  { staff_id: admin },
  { circle_id: "technical-ai" },
  { granted_by: staff },
  { expires_at: new Date(expires.getTime() + 1) },
])("rejects reuse of a grant key for changed scope: %j", async (change) => {
  const f = fixture({
    prior: {
      id: grant,
      staff_id: staff,
      circle_id: circle,
      granted_by: admin,
      expires_at: expires,
      ...change,
    },
  });
  expect(await f.db.grantModerator(token, staff, circle, key, expires)).toEqual(
    { kind: "conflict" },
  );
  expect(f.effects).toEqual([]);
});

it("permits a current administrator to revoke an expired target's grant while sharing is paused", async () => {
  const f = fixture({ staffActive: false, staffRole: null }, false);
  expect(await f.db.revokeModerator(token, circle, grant)).toEqual({
    kind: "ready",
    value: { id: grant },
  });
  expect(f.effects).toHaveLength(2);
  expect(f.effects[0]?.values).toEqual([grant]);
  expect(f.effects[1]?.values).toEqual([admin, staff, grant, circle]);
  expect(f.commands.at(-1)).toBe("COMMIT");
});
it("replaying revocation does not invent another audit action", async () => {
  const f = fixture({ revoked: true });
  expect(await f.db.revokeModerator(token, circle, grant)).toEqual({
    kind: "ready",
    value: { id: grant },
  });
  expect(f.effects).toEqual([]);
});
it.each([
  { observed: false },
  { locked: false },
  { identity: false },
  { adminActive: false },
  { staffExists: false },
  { adminRole: "moderator" },
])(
  "denies revocation without its current administrator or retained scope: %j",
  async (change) => {
    const f = fixture(change);
    expect(await f.db.revokeModerator(token, circle, grant)).toEqual({
      kind: "denied",
    });
    expect(f.effects).toEqual([]);
    expect(f.commands.at(-1)).toBe("ROLLBACK");
  },
);
it("does not acknowledge a newly created grant after final authorization expires", async () => {
  const f = fixture({ finalActive: false });
  expect(await f.db.grantModerator(token, staff, circle, key, expires)).toEqual(
    { kind: "denied" },
  );
  expect(f.commands).not.toContain("COMMIT");
  expect(f.commands.at(-1)).toBe("ROLLBACK");
});

const member = "00000000-0000-4000-8000-000000000001";
const choice = "00000000-0000-4000-8000-000000000002";
const post = "00000000-0000-4000-8000-000000000003";
const reply = "00000000-0000-4000-8000-000000000004";
interface SourcePost {
  id: string;
  member_id: string;
  choice_id: string;
  root_id: string | null;
  body: string | null;
  state: "visible" | "hidden" | "withdrawn";
  revision: number;
  createdAt: string;
}
const question: SourcePost = {
  id: post,
  member_id: member,
  choice_id: choice,
  root_id: null,
  body: "Invented question",
  state: "visible",
  revision: 1,
  createdAt: "2026-10-03T00:00:00Z",
};
interface ModeratorFixture {
  observed: boolean;
  principal: boolean;
  profile: boolean;
  currentGrant: boolean;
  finalGrant: boolean;
  receipt: { id: null; status: string; revision: number } | null;
  sourceActive: boolean;
  workspace: boolean;
  sharing: boolean;
  posts: SourcePost[];
  missingBody: boolean;
  priorAction: {
    post_id: string;
    fingerprint: string;
    new_revision: number;
  } | null;
  reports: {
    id: string;
    member_id: string;
    target_id: string;
    category: string;
  }[];
}
function moderatorFixture(
  overrides: Partial<ModeratorFixture> = {},
  writes = true,
) {
  const state: ModeratorFixture = {
    observed: true,
    principal: true,
    profile: true,
    currentGrant: true,
    finalGrant: true,
    receipt: null,
    sourceActive: true,
    workspace: true,
    sharing: true,
    posts: [],
    missingBody: false,
    priorAction: null,
    reports: [],
    ...overrides,
  };
  const commands: string[] = [];
  const effects: { sql: string; values: unknown[] }[] = [];
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
      return {
        rows: [
          {
            n: (values[0] as string[]).length,
            grant_active: state.finalGrant,
            remaining_ms: "60000",
          },
        ],
      };
    if (sql.startsWith("SELECT p.id,g.id grant_id"))
      return {
        rows: state.observed
          ? [{ id: staff, grant_id: grant, role: "moderator" }]
          : [],
      };
    if (sql.startsWith("SELECT id,kind FROM principals"))
      return {
        rows: [
          ...(state.principal ? [{ id: staff, kind: "staff" }] : []),
          ...(state.sourceActive && (values[0] as string[]).includes(member)
            ? [{ id: member, kind: "member" }]
            : []),
        ],
      };
    if (sql.startsWith("SELECT role FROM staff_profiles"))
      return { rows: state.profile ? [{ role: "moderator" }] : [] };
    if (sql.startsWith("SELECT id FROM preview_circle_moderator_grants"))
      return { rows: state.currentGrant ? [{ id: grant }] : [] };
    if (sql.startsWith("SELECT NULL::uuid id,action AS status"))
      return { rows: state.receipt ? [state.receipt] : [] };
    if (sql.startsWith("SELECT post_id,fingerprint,new_revision"))
      return { rows: state.priorAction ? [state.priorAction] : [] };
    if (
      sql.startsWith("UPDATE preview_circle_posts") ||
      sql.startsWith("INSERT INTO preview_circle_moderation_audit")
    ) {
      effects.push({ sql, values });
      return { rows: [] };
    }
    if (sql.includes("FROM workspaces"))
      return {
        rows:
          state.workspace && (values[0] as string[]).includes(member)
            ? [{ owner_principal_id: member }]
            : [],
      };
    if (sql.includes("FROM preview_circle_choices c"))
      return {
        rows:
          state.sharing && (values[0] as string[]).includes(member)
            ? [{ id: choice, member_id: member, pseudonym: "Peer invented" }]
            : [],
      };
    if (sql.startsWith("SELECT id,member_id,target_id,category"))
      return {
        rows: state.reports
          .filter((r) => values[1] === null || r.id > String(values[1]))
          .slice(0, 21),
      };
    if (sql.startsWith("SELECT id,member_id,choice_id,root_id,state,revision"))
      return {
        rows: sql.includes("WHERE id=$1")
          ? state.posts.filter(
              (p) =>
                p.id === values[0] &&
                (!sql.includes("AND root_id IS NULL") || p.root_id === null),
            )
          : state.posts,
      };
    if (sql.startsWith("SELECT id,body,state,revision"))
      return {
        rows: state.missingBody
          ? []
          : state.posts
              .filter((p) => (values[1] as string[]).includes(p.id))
              .map(({ id, body, state, revision, createdAt }) => ({
                id,
                body,
                state,
                revision,
                createdAt,
              })),
      };
    if (
      sql.includes("FROM preview_circle_memberships") ||
      sql.includes("FROM preview_circle_choices c") ||
      sql.includes("FROM preview_circle_reports") ||
      sql.includes("FROM preview_circle_posts")
    )
      return { rows: [] };
    throw Error("Unexpected moderator authorization observation");
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return {
    commands,
    effects,
    db: circleDiscussionStore(pool, "invented-moderator-secret", writes),
  };
}
it("returns an empty queue only under a current exact-purpose moderator grant", async () => {
  const f = moderatorFixture();
  expect(await f.db.moderationQueue(token, circle)).toEqual({
    kind: "ready",
    value: { items: [], nextCursor: null },
  });
  expect(f.commands.at(-1)).toBe("COMMIT");
});
it.each([
  { observed: false },
  { principal: false },
  { profile: false },
  { currentGrant: false },
  { finalGrant: false },
])(
  "denies queue and action reconciliation after moderator authorization changes: %j",
  async (change) => {
    const f = moderatorFixture(change);
    expect(await f.db.moderationQueue(token, circle)).toEqual({
      kind: "denied",
    });
    expect(await f.db.reconcile(token, circle, "moderation", key)).toEqual({
      kind: "denied",
    });
    expect(f.commands).not.toContain("COMMIT");
  },
);
it("rejects a forged queue continuation before exposing any report", async () => {
  const f = moderatorFixture();
  expect(await f.db.moderationQueue(token, circle, "forged")).toEqual({
    kind: "invalid",
  });
  expect(
    f.commands.some((sql) => sql.includes("FROM preview_circle_reports")),
  ).toBe(false);
});
it("allows content-free action recovery during sharing pause under a current grant", async () => {
  const f = moderatorFixture(
    { receipt: { id: null, status: "hidden", revision: 2 } },
    false,
  );
  expect(await f.db.reconcile(token, circle, "moderation", key)).toEqual({
    kind: "ready",
    value: { found: true, id: null, status: "hidden", revision: 2 },
  });
  expect(
    f.commands.some((sql) => sql.includes("FROM preview_circle_posts")),
  ).toBe(false);
});
it("does not disclose whether an unknown action key belongs to another moderator", async () => {
  const f = moderatorFixture();
  expect(await f.db.reconcile(token, circle, "moderation", key)).toEqual({
    kind: "ready",
    value: { found: false, id: null, status: null, revision: null },
  });
});
it("does not authorize an action against a missing source merely because a grant exists", async () => {
  const f = moderatorFixture();
  expect(
    await f.db.moderate(token, circle, grant, key, "hide", 1, "privacy"),
  ).toEqual({ kind: "denied" });
  expect(f.commands.at(-1)).toBe("ROLLBACK");
});

it.each([
  {
    action: "hide" as const,
    before: "visible" as const,
    after: "hidden",
    audit: "hidden",
  },
  {
    action: "restore" as const,
    before: "hidden" as const,
    after: "visible",
    audit: "restored",
  },
])(
  "$action advances the current source revision and records only a content-free action",
  async ({ action, before, after, audit }) => {
    const f = moderatorFixture({ posts: [{ ...question, state: before }] });
    expect(
      await f.db.moderate(token, circle, post, key, action, 1, "privacy"),
    ).toEqual({ kind: "ready", value: { id: post, revision: 2 } });
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.values).toEqual([post, after]);
    expect(f.effects[1]?.values.slice(0, 10)).toEqual([
      staff,
      "moderator",
      member,
      circle,
      post,
      audit,
      "privacy",
      1,
      2,
      key,
    ]);
    expect(JSON.stringify(f.effects)).not.toContain(question.body);
    expect(f.commands.at(-1)).toBe("COMMIT");
  },
);
it.each([
  { sourceActive: false },
  { workspace: false },
  { sharing: false },
  { missingBody: true },
  { posts: [{ ...question, state: "withdrawn" as const, body: null }] },
  { posts: [{ ...question, choice_id: key }] },
])(
  "cannot restore a withdrawn, departed or no-longer-shared source: %j",
  async (change) => {
    const f = moderatorFixture({
      posts: [{ ...question, state: "hidden" }],
      ...change,
    });
    expect(
      await f.db.moderate(token, circle, post, key, "restore", 1, "privacy"),
    ).toEqual({ kind: "denied" });
    expect(f.effects).toEqual([]);
  },
);
it.each([
  { action: "hide" as const, state: "hidden" as const, revision: 1 },
  { action: "restore" as const, state: "visible" as const, revision: 1 },
  { action: "hide" as const, state: "visible" as const, revision: 2 },
])(
  "conflicts on stale revision or incompatible current state: %j",
  async ({ action, state, revision }) => {
    const f = moderatorFixture({ posts: [{ ...question, state, revision }] });
    expect(
      await f.db.moderate(token, circle, post, key, action, 1, "privacy"),
    ).toEqual({ kind: "conflict" });
    expect(f.effects).toEqual([]);
  },
);
it("replays an identical action without changing state or adding audit", async () => {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        circle,
        id: post,
        action: "hide",
        revision: 1,
        reason: "privacy",
      }),
    )
    .digest("hex");
  const f = moderatorFixture({
    posts: [{ ...question, state: "hidden", revision: 2 }],
    priorAction: { post_id: post, fingerprint: digest, new_revision: 2 },
  });
  expect(
    await f.db.moderate(token, circle, post, key, "hide", 1, "privacy"),
  ).toEqual({ kind: "ready", value: { id: post, revision: 2 } });
  expect(f.effects).toEqual([]);
});
it.each([
  { post_id: reply, fingerprint: "different", new_revision: 2 },
  { post_id: post, fingerprint: "different", new_revision: 2 },
])(
  "rejects a reused action key for a different target or payload: %j",
  async (priorAction) => {
    const f = moderatorFixture({ posts: [question], priorAction });
    expect(
      await f.db.moderate(token, circle, post, key, "hide", 1, "privacy"),
    ).toEqual({ kind: "conflict" });
    expect(f.effects).toEqual([]);
  },
);
it("hides an independently owned reply only while its root is currently visible", async () => {
  const f = moderatorFixture({
    posts: [
      question,
      { ...question, id: reply, root_id: post, body: "Invented reply" },
    ],
  });
  expect(
    await f.db.moderate(token, circle, reply, key, "hide", 1, "conduct"),
  ).toEqual({ kind: "ready", value: { id: reply, revision: 2 } });
  expect(f.effects[0]?.values).toEqual([reply, "hidden"]);
});
it.each(["hidden", "withdrawn"] as const)(
  "cannot act on a reply when its root is %s",
  async (state) => {
    const f = moderatorFixture({
      posts: [
        { ...question, state },
        { ...question, id: reply, root_id: post },
      ],
    });
    expect(
      await f.db.moderate(token, circle, reply, key, "hide", 1, "conduct"),
    ).toEqual({ kind: "denied" });
    expect(f.effects).toEqual([]);
  },
);
it("cannot act on a reply whose root was erased", async () => {
  const f = moderatorFixture({
    posts: [{ ...question, id: reply, root_id: post }],
  });
  expect(
    await f.db.moderate(token, circle, reply, key, "hide", 1, "conduct"),
  ).toEqual({ kind: "denied" });
});
it("bounds report pages without exposing reporter identity and signs a usable continuation", async () => {
  const reports = Array.from({ length: 21 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`,
    member_id: member,
    target_id: post,
    category: "privacy",
  }));
  const f = moderatorFixture({ posts: [question], reports });
  const first = await f.db.moderationQueue(token, circle);
  expect(first.kind).toBe("ready");
  if (first.kind !== "ready") throw Error("Expected first page");
  expect(first.value.items).toHaveLength(20);
  expect(first.value.nextCursor).toEqual(expect.any(String));
  expect(first.value.items[0]).toEqual({
    id: reports[0]?.id,
    category: "privacy",
    target: {
      id: post,
      body: question.body,
      state: "visible",
      revision: 1,
      createdAt: question.createdAt,
      pseudonym: "Peer invented",
    },
  });
  expect(JSON.stringify(first.value.items)).not.toContain(member);
  const second = await f.db.moderationQueue(
    token,
    circle,
    first.value.nextCursor!,
  );
  expect(second.kind).toBe("ready");
  if (second.kind !== "ready") throw Error("Expected second page");
  expect(second.value.items).toHaveLength(1);
  expect(second.value.nextCursor).toBeNull();
});
it("retains a safe unavailable-target marker without disclosing withdrawn text", async () => {
  const f = moderatorFixture({
    posts: [{ ...question, state: "withdrawn", body: null }],
    reports: [
      { id: key, member_id: member, target_id: post, category: "privacy" },
    ],
  });
  expect(await f.db.moderationQueue(token, circle)).toEqual({
    kind: "ready",
    value: {
      items: [{ id: key, category: "privacy", target: null }],
      nextCursor: null,
    },
  });
});
it("does not refill a bounded queue after a reporter's workspace becomes unavailable", async () => {
  const f = moderatorFixture({
    workspace: false,
    posts: [question],
    reports: [
      { id: key, member_id: member, target_id: post, category: "privacy" },
    ],
  });
  expect(await f.db.moderationQueue(token, circle)).toEqual({
    kind: "ready",
    value: { items: [], nextCursor: null },
  });
});

it("cannot restore a reply whose root has an obsolete source choice", async () => {
  const f = moderatorFixture({
    posts: [
      { ...question, choice_id: key },
      { ...question, id: reply, root_id: post, state: "hidden" },
    ],
  });
  expect(
    await f.db.moderate(token, circle, reply, key, "restore", 1, "privacy"),
  ).toEqual({ kind: "denied" });
  expect(f.effects).toEqual([]);
});
