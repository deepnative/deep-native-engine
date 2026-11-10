import type { Pool, PoolClient } from "pg";
import { expect, it, vi } from "vitest";
import {
  circleDiscussionStore,
  disabledCircleDiscussionStore,
} from "../../src/circle-discussion.ts";

// #196 RPTD: store branches for report dispositions with a mocked driver.
const staff = "00000000-0000-4000-8000-000000000006";
const grant = "00000000-0000-4000-8000-000000000007";
const reporter = "00000000-0000-4000-8000-000000000003";
const owner = "00000000-0000-4000-8000-000000000002";
const post = "00000000-0000-4000-8000-000000000004";
const report = "00000000-0000-4000-8000-000000000010";
const key = "00000000-0000-4000-8000-000000000009";
const token = "a".repeat(64);
const circle = "everyday-ai";

interface State {
  staff: boolean;
  member: boolean;
  report: boolean;
  post: { state: string; revision: number } | null;
  sharing: boolean;
  prior: { report_id: string; fingerprint: string; revision: number } | null;
  current: { action: string; revision: number } | null;
  decision: number | null;
  ownReport: boolean;
  history: {
    action: string;
    reason: string;
    occurredAt: string;
    revision: number;
  }[];
  queueState:
    | { id: string; state: string; revision: number; decision: number | null }[]
    | null;
}
function fixture(overrides: Partial<State> = {}, writes = true) {
  const s: State = {
    staff: true,
    member: true,
    report: true,
    post: { state: "visible", revision: 1 },
    sharing: true,
    prior: null,
    current: null,
    decision: null,
    ownReport: true,
    history: [],
    queueState: null,
    ...overrides,
  };
  const inserts: unknown[][] = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
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
            grant_active: true,
            remaining_ms: "60000",
          },
        ],
      };
    // Staff observation and authority.
    if (sql.startsWith("SELECT p.id,g.id grant_id"))
      return {
        rows: s.staff
          ? [{ id: staff, grant_id: grant, role: "moderator" }]
          : [],
      };
    if (sql.startsWith("SELECT id,kind FROM principals"))
      return {
        rows: [
          { id: staff, kind: "staff" },
          { id: owner, kind: "member" },
          { id: reporter, kind: "member" },
        ].filter((p) => (values[0] as string[]).includes(p.id)),
      };
    if (sql.startsWith("SELECT role FROM authorized_staff_profiles"))
      return { rows: [{ role: "moderator" }] };
    if (sql.startsWith("SELECT id FROM preview_circle_moderator_grants"))
      return { rows: [{ id: grant }] };
    // Member observation.
    if (sql.startsWith("SELECT id FROM principals WHERE token_hash"))
      return { rows: s.member ? [{ id: reporter }] : [] };
    if (sql.startsWith("SELECT id FROM principals WHERE id=ANY"))
      return { rows: [{ id: reporter }] };
    if (sql.includes("FROM workspaces"))
      return {
        rows: (values[0] as string[]).map((id) => ({ owner_principal_id: id })),
      };
    if (sql.includes("FROM preview_circle_choices c"))
      return {
        rows: s.sharing
          ? [owner, reporter]
              .filter((id) => (values[0] as string[]).includes(id))
              .map((id) => ({ id: grant, member_id: id, pseudonym: "Peer" }))
          : [{ id: grant, member_id: owner, pseudonym: "Peer" }],
      };
    if (sql.includes("FROM preview_circle_memberships")) return { rows: [] };
    if (sql.startsWith("SELECT id FROM preview_circle_posts"))
      return { rows: [] };
    // Report and source.
    if (sql.startsWith("SELECT target_id,member_id,created_at"))
      return {
        rows: s.report
          ? [{ target_id: post, member_id: reporter, created_at: "2026-11-10" }]
          : [],
      };
    if (sql.startsWith("SELECT id,member_id,choice_id,root_id,state,revision"))
      return {
        rows: s.post
          ? [
              {
                id: post,
                member_id: owner,
                choice_id: grant,
                root_id: null,
                ...s.post,
              },
            ]
          : [],
      };
    if (sql.startsWith("SELECT id,body,state,revision"))
      return {
        rows: s.post
          ? [{ id: post, body: "Invented", createdAt: "2026-11-10", ...s.post }]
          : [],
      };
    if (sql.startsWith("SELECT report_id,fingerprint,revision"))
      return { rows: s.prior ? [s.prior] : [] };
    if (
      sql.startsWith(
        "SELECT id FROM preview_circle_reports WHERE id=$1 FOR UPDATE",
      )
    )
      return { rows: [{ id: report }] };
    if (
      sql.startsWith(
        "SELECT action,revision FROM preview_circle_report_dispositions",
      )
    )
      return { rows: s.current ? [s.current] : [] };
    if (sql.startsWith("SELECT new_revision AS revision"))
      return { rows: s.decision === null ? [] : [{ revision: s.decision }] };
    if (sql.startsWith("INSERT INTO preview_circle_report_dispositions")) {
      inserts.push(values);
      return { rows: [] };
    }
    if (sql.startsWith("SELECT category,created_at"))
      return {
        rows: s.ownReport
          ? [{ category: "privacy", reportedAt: "2026-11-10 00:00:00+00" }]
          : [],
      };
    if (sql.startsWith("SELECT action,reason,occurred_at"))
      return { rows: s.history };
    if (sql.startsWith("SELECT report_id AS id,action AS status"))
      return { rows: [{ id: report, status: "rejected", revision: 2 }] };
    if (sql.startsWith("SELECT id,member_id,target_id,category"))
      return {
        rows: [
          {
            id: report,
            member_id: reporter,
            target_id: post,
            category: "privacy",
          },
        ],
      };
    if (sql.startsWith("SELECT r.id,")) return { rows: s.queueState ?? [] };
    throw Error(`Unexpected SQL ${sql.slice(0, 60)}`);
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return {
    db: circleDiscussionStore(pool, "invented-secret", writes),
    inserts,
    query,
  };
}
const dispose = (
  db: ReturnType<typeof fixture>["db"],
  action = "reject",
  reason = "rule_not_breached",
  revisions: [number, number, number | null] = [1, 1, null],
) => db.disposeReport(token, circle, report, key, action, reason, ...revisions);

it("RPTD-01 records one rejection at the next revision with only structured fields", async () => {
  const f = fixture();
  expect(await dispose(f.db)).toEqual({
    kind: "ready",
    value: { id: report, revision: 2 },
  });
  expect(f.inserts).toHaveLength(1);
  expect(f.inserts[0]!.slice(0, 9)).toEqual([
    report,
    circle,
    2,
    "rejected",
    "rule_not_breached",
    staff,
    "moderator",
    1,
    null,
  ]);
});
it("RPTD-02 escalates from open and rejects from escalated, never after a terminal state", async () => {
  expect(
    await dispose(fixture().db, "escalate", "needs_another_look"),
  ).toMatchObject({ kind: "ready", value: { revision: 2 } });
  expect(
    await dispose(
      fixture({ current: { action: "escalated", revision: 2 } }).db,
      "reject",
      "insufficient_context",
      [2, 1, null],
    ),
  ).toMatchObject({ kind: "ready", value: { revision: 3 } });
  for (const current of [
    { action: "escalated", revision: 2 },
    { action: "rejected", revision: 2 },
    { action: "closed", revision: 2 },
  ])
    expect(
      await dispose(fixture({ current }).db, "escalate", "policy_unclear", [
        2,
        1,
        null,
      ]),
    ).toEqual({ kind: "conflict" });
  expect(
    await dispose(
      fixture({ current: { action: "rejected", revision: 2 } }).db,
      "reject",
      "rule_not_breached",
      [2, 1, null],
    ),
  ).toEqual({ kind: "conflict" });
});
it("RPTD-03 closes only against the latest recorded decision since the report", async () => {
  const args: [string, string, [number, number, number]] = [
    "close",
    "recorded_target_decision",
    [1, 2, 2],
  ];
  const hidden = { state: "hidden", revision: 2 };
  expect(
    await dispose(fixture({ post: hidden, decision: 2 }).db, ...args),
  ).toMatchObject({ kind: "ready", value: { revision: 2 } });
  for (const decision of [null, 3])
    expect(
      await dispose(fixture({ post: hidden, decision }).db, ...args),
    ).toEqual({ kind: "conflict" });
});
it("RPTD-06 replays the exact original key and conflicts on any changed intent or stale revision", async () => {
  const f = fixture();
  await dispose(f.db);
  const original = f.inserts[0]![10] as string;
  expect(
    await dispose(
      fixture({
        prior: { report_id: report, fingerprint: original, revision: 2 },
      }).db,
    ),
  ).toEqual({ kind: "ready", value: { id: report, revision: 2 } });
  for (const prior of [
    { report_id: report, fingerprint: "changed", revision: 2 },
    { report_id: post, fingerprint: original, revision: 2 },
  ])
    expect(await dispose(fixture({ prior }).db)).toEqual({ kind: "conflict" });
  for (const revisions of [
    [2, 1, null],
    [1, 2, null],
  ] as [number, number, null][])
    expect(
      await dispose(fixture().db, "reject", "rule_not_breached", revisions),
    ).toEqual({ kind: "conflict" });
});
it("RPTD-04/05 denies without writing when authority, the report, the source or the reporter is not current", async () => {
  for (const change of [
    { staff: false },
    { report: false },
    { post: null },
    { post: { state: "withdrawn", revision: 2 } },
    { sharing: false },
  ]) {
    const f = fixture(change);
    expect(await dispose(f.db)).toEqual({ kind: "denied" });
    expect(f.inserts).toEqual([]);
  }
  expect(await dispose(fixture({}, false).db)).toEqual({ kind: "denied" });
  expect(
    await disabledCircleDiscussionStore().disposeReport(
      token,
      circle,
      report,
      key,
      "reject",
      "rule_not_breached",
      1,
      1,
      null,
    ),
  ).toEqual({ kind: "denied" });
});
it("rejects malformed actions, reasons, identifiers and revisions before any query", async () => {
  const f = fixture();
  for (const args of [
    [report, key, "delete", "rule_not_breached", 1, 1, null],
    [report, key, "reject", "policy_unclear", 1, 1, null],
    [report, key, "escalate", "rule_not_breached", 1, 1, null],
    [report, key, "close", "recorded_target_decision", 1, 1, null],
    [report, key, "reject", "rule_not_breached", 1, 1, 2],
    [report, key, "close", "recorded_target_decision", 1, 1, 1],
    [report, key, "close", "recorded_target_decision", 1, 1, 2.5],
    [report, key, "reject", "rule_not_breached", 0, 1, null],
    [report, key, "reject", "rule_not_breached", 1, 1.5, null],
    ["bad", key, "reject", "rule_not_breached", 1, 1, null],
    [report, "bad", "reject", "rule_not_breached", 1, 1, null],
  ] as const)
    expect(
      await f.db.disposeReport(
        token,
        circle,
        ...(args as unknown as [
          string,
          string,
          string,
          string,
          number,
          number,
          number | null,
        ]),
      ),
    ).toEqual({ kind: "invalid" });
  expect(
    await f.db.disposeReport(
      "bad",
      circle,
      report,
      key,
      "reject",
      "rule_not_breached",
      1,
      1,
      null,
    ),
  ).toEqual({ kind: "denied" });
  expect(f.query).not.toHaveBeenCalled();
});
it("RPTD-05 gives the reporter a content-free record, including during a write pause", async () => {
  for (const writes of [true, false]) {
    const open = await fixture({}, writes).db.reportDisposition(
      token,
      circle,
      report,
    );
    expect(open).toEqual({
      kind: "ready",
      value: {
        reportDispositionVersion: 1,
        circleId: circle,
        reportId: report,
        category: "privacy",
        reportedAt: "2026-11-10 00:00:00+00",
        disposition: "open",
        revision: 1,
        history: [],
      },
    });
  }
  const history = [
    {
      action: "escalated",
      reason: "policy_unclear",
      occurredAt: "t1",
      revision: 2,
    },
    {
      action: "closed",
      reason: "recorded_target_decision",
      occurredAt: "t2",
      revision: 3,
    },
  ];
  expect(
    await fixture({ history }).db.reportDisposition(token, circle, report),
  ).toMatchObject({
    kind: "ready",
    value: {
      disposition: "closed",
      revision: 3,
      history: [
        { action: "escalated", reason: "policy_unclear", occurredAt: "t1" },
        {
          action: "closed",
          reason: "recorded_target_decision",
          occurredAt: "t2",
        },
      ],
    },
  });
  expect(
    await fixture({ ownReport: false }).db.reportDisposition(
      token,
      circle,
      report,
    ),
  ).toEqual({ kind: "denied" });
  expect(
    await fixture({ member: false }).db.reportDisposition(
      token,
      circle,
      report,
    ),
  ).toEqual({ kind: "denied" });
  expect(await fixture().db.reportDisposition(token, circle, "bad")).toEqual({
    kind: "invalid",
  });
  expect(await fixture().db.reportDisposition("bad", circle, report)).toEqual({
    kind: "denied",
  });
  expect(
    await disabledCircleDiscussionStore().reportDisposition(
      token,
      circle,
      report,
    ),
  ).toEqual({ kind: "denied" });
});
it("RPTD-07 inspects an original disposition key as staff", async () => {
  expect(
    await fixture().db.reconcile(token, circle, "report-disposition", key),
  ).toEqual({
    kind: "ready",
    value: { found: true, id: report, status: "rejected", revision: 2 },
  });
});
it("shows each report's disposition and its latest decision only for an available source", async () => {
  const queue = await fixture({
    queueState: [{ id: report, state: "escalated", revision: 2, decision: 3 }],
  }).db.moderationQueue(token, circle);
  expect(queue).toMatchObject({
    kind: "ready",
    value: {
      items: [
        {
          id: report,
          disposition: "escalated",
          dispositionRevision: 2,
          decisionRevision: 3,
        },
      ],
    },
  });
  const unavailable = await fixture({
    post: null,
    queueState: [{ id: report, state: "open", revision: 1, decision: 3 }],
  }).db.moderationQueue(token, circle);
  expect(unavailable).toMatchObject({
    kind: "ready",
    value: { items: [{ target: null, decisionRevision: null }] },
  });
});
