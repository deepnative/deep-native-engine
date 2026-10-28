import type { Pool, PoolClient } from "pg";
import { expect, it, vi } from "vitest";
import {
  circleDiscussionStore,
  disabledCircleDiscussionStore,
} from "../../src/circle-discussion.ts";
const token = "a".repeat(64),
  circle = "everyday-ai";
const actor = "00000000-0000-4000-8000-000000000001",
  owner = "00000000-0000-4000-8000-000000000002",
  post = "00000000-0000-4000-8000-000000000003",
  report = "00000000-0000-4000-8000-000000000004",
  choice = "00000000-0000-4000-8000-000000000005",
  root = "00000000-0000-4000-8000-000000000007";
function fixture(writes = true) {
  const state = {
    identity: true,
    principal: true,
    workspace: true,
    report: true,
    source: true,
    reporterSharing: true,
    sourceSharing: true,
    root: false,
    rootExists: true,
    rootState: "visible",
    postState: "hidden",
    current: true,
    fail: "",
    releaseFail: false,
    decision: true,
  };
  const calls: { sql: string; values: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (state.fail && sql.includes(state.fail))
      throw Error("Invented private database detail");
    const rows = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (sql.startsWith("WITH instant"))
      return rows(
        state.current
          ? [{ n: 2, grant_active: true, remaining_ms: "60000" }]
          : [],
      );
    if (sql.startsWith("SELECT id FROM principals WHERE token_hash="))
      return rows(state.identity ? [{ id: actor }] : []);
    if (sql.includes("FROM principals WHERE id=ANY"))
      return rows([...(state.principal ? [{ id: actor }] : []), { id: owner }]);
    if (sql.includes("FROM workspaces WHERE owner_principal_id=ANY"))
      return rows([
        ...(state.workspace ? [{ owner_principal_id: actor }] : []),
        ...(state.source ? [{ owner_principal_id: owner }] : []),
      ]);
    if (sql.startsWith("SELECT id,target_id,category,created_at"))
      return rows(
        state.report && values[2] === report
          ? [
              {
                id: report,
                target_id: post,
                category: "privacy",
                createdAt: "2026-10-28T10:00:00Z",
                body: "private report field",
              },
            ]
          : [],
      );
    if (sql.startsWith("SELECT id,member_id,choice_id,root_id,state,revision"))
      return rows([
        {
          id: post,
          member_id: owner,
          choice_id: choice,
          root_id: state.root ? root : null,
          state: state.postState,
          revision: 2,
        },
        ...(state.root && state.rootExists
          ? [
              {
                id: root,
                member_id: owner,
                choice_id: choice,
                root_id: null,
                state: state.rootState,
                revision: 1,
              },
            ]
          : []),
      ]);
    if (sql.includes("FROM preview_circle_choices c"))
      return rows([
        ...(state.reporterSharing
          ? [{ id: actor, member_id: actor, pseudonym: "Private reporter" }]
          : []),
        ...(state.sourceSharing
          ? [{ id: choice, member_id: owner, pseudonym: "Private source" }]
          : []),
      ]);
    if (sql.startsWith("SELECT action,reason,old_revision"))
      return rows(
        state.decision
          ? [
              {
                action: "hidden",
                reason: "conduct",
                oldRevision: 1,
                newRevision: 2,
                occurredAt: "2026-10-28T10:01:00Z",
                body: "Private source",
                actor_id: "Private staff",
                fingerprint: "Private key",
              },
            ]
          : [],
      );
    return rows([]);
  });
  const release = vi.fn(() => {
    if (state.releaseFail) throw Error("Private release detail");
  });
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client),
    db = circleDiscussionStore(
      { connect } as unknown as Pool,
      "invented-notice-secret",
      writes,
    );
  return {
    state,
    calls,
    query,
    release,
    connect,
    db,
    read: () => db.reportModerationNotice(token, circle, report),
  };
}
it("RPTN-01/05 returns only the own receipt and eligible latest decision whitelist", async () => {
  const f = fixture(),
    r = await f.read();
  expect(r).toEqual({
    kind: "ready",
    value: {
      reportNoticeVersion: 1,
      circleId: circle,
      reportId: report,
      category: "privacy",
      reportedAt: "2026-10-28T10:00:00Z",
      targetStatus: "hidden",
      decision: {
        action: "hidden",
        reason: "conduct",
        oldRevision: 1,
        newRevision: 2,
        occurredAt: "2026-10-28T10:01:00Z",
      },
    },
  });
  for (const secret of [post, owner, actor, "Private"])
    expect(JSON.stringify(r)).not.toContain(secret);
  expect(f.calls.some((c) => /^(INSERT|UPDATE|DELETE)/.test(c.sql))).toBe(
    false,
  );
  expect(f.calls.some((c) => c.sql.startsWith("SELECT id,body"))).toBe(false);
  expect(f.release).toHaveBeenCalledOnce();
});
it("RPTN-01 does not invent a decision when none follows the report", async () => {
  const f = fixture();
  f.state.decision = false;
  expect(await f.read()).toMatchObject({
    kind: "ready",
    value: { decision: null },
  });
});
it.each(["source", "reporterSharing", "sourceSharing"] as const)(
  "RPTN-03 %s loss removes decision details without querying the audit",
  async (key) => {
    const f = fixture();
    f.state[key] = false;
    expect(await f.read()).toMatchObject({
      kind: "ready",
      value: { targetStatus: "unavailable", decision: null },
    });
    expect(
      f.calls.some((c) =>
        c.sql.includes("FROM preview_circle_moderation_audit"),
      ),
    ).toBe(false);
  },
);
it.each(["identity", "principal", "workspace", "report"] as const)(
  "RPTN-02 missing %s denies access",
  async (key) => {
    const f = fixture();
    f.state[key] = false;
    expect(await f.read()).toEqual({ kind: "denied" });
  },
);
it.each(["visible", "withdrawn"])(
  "RPTN-03 current %s target is accurately labelled",
  async (state) => {
    const f = fixture();
    f.state.postState = state;
    expect(await f.read()).toMatchObject({
      kind: "ready",
      value: {
        targetStatus: state === "visible" ? "reported" : "unavailable",
        decision: state === "visible" ? expect.any(Object) : null,
      },
    });
  },
);
it.each(["hidden", "missing"])(
  "RPTN-03 %s root removes a reply's decision",
  async (state) => {
    const f = fixture();
    f.state.root = true;
    if (state === "missing") f.state.rootExists = false;
    else f.state.rootState = "hidden";
    expect(await f.read()).toMatchObject({
      kind: "ready",
      value: { targetStatus: "unavailable", decision: null },
    });
  },
);
it("RPTN-03 a current visible root permits only the reply decision", async () => {
  const f = fixture();
  f.state.root = true;
  expect(await f.read()).toMatchObject({
    kind: "ready",
    value: { targetStatus: "hidden", decision: { action: "hidden" } },
  });
});
it("RPTN-03 a write pause never reads target decision data", async () => {
  const f = fixture(false);
  expect(await f.read()).toMatchObject({
    kind: "ready",
    value: { targetStatus: "unavailable", decision: null },
  });
  expect(
    f.calls.some((c) => c.sql.includes("FROM preview_circle_moderation_audit")),
  ).toBe(false);
});
it("RPTN-02 disabled and malformed inputs deny without connecting", async () => {
  const f = fixture();
  expect(
    await disabledCircleDiscussionStore().reportModerationNotice(
      token,
      circle,
      report,
    ),
  ).toEqual({ kind: "denied" });
  expect(await f.db.reportModerationNotice("bad", circle, report)).toEqual({
    kind: "denied",
  });
  expect(await f.db.reportModerationNotice(token, "unknown", report)).toEqual({
    kind: "denied",
  });
  expect(await f.db.reportModerationNotice(token, circle, "bad")).toEqual({
    kind: "invalid",
  });
  expect(f.connect).not.toHaveBeenCalled();
});
it("RPTN-04 final authority loss cannot return an observed decision", async () => {
  const f = fixture();
  f.state.current = false;
  expect(await f.read()).toEqual({ kind: "denied" });
});
it.each([
  "FROM preview_circle_reports",
  "FROM preview_circle_moderation_audit",
  "COMMIT",
])("RPTN-05 %s loss fails closed after cleanup", async (fail) => {
  const f = fixture();
  f.state.fail = fail;
  await expect(f.read()).rejects.toThrow(/unconfirmed|unavailable/);
  expect(f.release).toHaveBeenCalledOnce();
});
it("RPTN-05 a lost release handback never acknowledges a private notice", async () => {
  const f = fixture();
  f.state.releaseFail = true;
  await expect(f.read()).rejects.toThrow("unconfirmed");
});
