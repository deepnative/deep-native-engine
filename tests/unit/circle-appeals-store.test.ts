import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import {
  circleDiscussionStore,
  disabledCircleDiscussionStore,
  type CircleAppeal,
  type CircleDiscussionStore,
} from "../../src/circle-discussion.ts";

const token = "a".repeat(64),
  staffToken = "b".repeat(64),
  circle = "everyday-ai";
const owner = "00000000-0000-4000-8000-000000000001",
  choice = "00000000-0000-4000-8000-000000000002";
const postId = "00000000-0000-4000-8000-000000000003",
  staff = "00000000-0000-4000-8000-000000000004";
const grant = "00000000-0000-4000-8000-000000000005",
  id = "00000000-0000-4000-8000-000000000006",
  key = "00000000-0000-4000-8000-000000000007";
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const requestDigest = () =>
  digest({ circle, postId, decisionRevision: 2, reason: "recheck_rule" });
const resolutionDigest = () =>
  digest({
    circle,
    id,
    outcome: "uphold",
    revision: 2,
    reason: "rule_applies",
  });
const retained = () => ({
  id,
  postId,
  decisionRevision: 2,
  decisionReason: "privacy",
  decisionAt: "2026-10-28T10:00:00Z",
  requestReason: "recheck_rule",
  requestedAt: "2026-10-28T10:01:00Z",
  state: "pending" as CircleAppeal["state"],
  closedAt: null as string | null,
  postState: "hidden" as CircleAppeal["postState"],
  postRevision: 2,
  sharedEligible: true,
  resolutionReason: null as string | null,
  resolvedRevision: null as number | null,
  actor_id: "must-not-project",
  fingerprint: "must-not-project",
  body: "must-not-project",
});
function fixture(writes = true) {
  const state = {
    identity: true,
    principal: true,
    workspace: true,
    joined: true,
    chosen: true,
    staffObservation: true,
    role: true,
    grant: true,
    ownerPost: true,
    body: true,
    metadata: true,
    foreign: false,
    observedAppeal: true,
    lockedAppeal: true,
    postState: "hidden" as CircleAppeal["postState"],
    postRevision: 2,
    sharedEligible: true,
    decision: { new_revision: 2, action: "hidden" } as {
      new_revision: number;
      action: string;
    } | null,
    rows: [retained()],
    queue: [{ id, post_id: postId }],
    count: 0,
    priorRequest: null as { id: string; fingerprint: string } | null,
    duplicate: null as { id: string; fingerprint: string } | null,
    priorResolution: null as {
      id: string;
      resolution_fingerprint: string;
      resolved_revision: number;
    } | null,
    actionKeyUsed: false,
    appealState: "pending",
    decisionRevision: 2,
    current: true,
    failure: "",
    releaseFailure: false,
    receipt: { id, status: "pending", revision: 2 } as {
      id: string;
      status: string;
      revision: number;
    } | null,
  };
  const commands: string[] = [],
    changes: { sql: string; values: unknown[] }[] = [];
  const query = vi.fn(
    async (
      sql: string,
      values: unknown[] = [],
    ): Promise<{ rows: unknown[]; rowCount: number }> => {
      commands.push(sql);
      if (state.failure && sql.includes(state.failure))
        throw Error("Invented query loss");
      const result = (rows: unknown[]) => ({ rows, rowCount: rows.length });
      if (sql.startsWith("WITH instant"))
        return result(
          state.current
            ? [
                {
                  n: (values[0] as string[]).length,
                  grant_active: true,
                  remaining_ms: "60000",
                },
              ]
            : [],
        );
      if (sql.startsWith("SELECT a.id,a.post_id")) return result(state.rows);
      if (sql.startsWith("SELECT p.id,p.state,p.revision"))
        return result(
          state.ownerPost
            ? [
                {
                  id: postId,
                  state: state.postState,
                  revision: state.postRevision,
                  sharedEligible: state.sharedEligible,
                },
              ]
            : [],
        );
      if (sql.startsWith("SELECT id FROM principals WHERE token_hash"))
        return result(state.identity ? [{ id: owner }] : []);
      if (sql.includes("JOIN authorized_staff_profiles s ON"))
        return result(
          state.staffObservation
            ? [{ id: staff, grant_id: grant, role: "moderator" }]
            : [],
        );
      if (sql.includes("FROM principals WHERE id=ANY"))
        return result(
          state.principal
            ? (values[0] as string[]).map((p) => ({
                id: p,
                kind: p === staff ? "staff" : "member",
              }))
            : [],
        );
      if (sql.includes("FROM workspaces WHERE owner_principal_id=ANY"))
        return result(state.workspace ? [{ owner_principal_id: owner }] : []);
      if (sql.startsWith("SELECT role FROM authorized_staff_profiles"))
        return result(state.role ? [{ role: "moderator" }] : []);
      if (sql.startsWith("SELECT id FROM preview_circle_moderator_grants"))
        return result(state.grant ? [{ id: grant }] : []);
      if (sql.includes("FROM preview_circle_memberships WHERE"))
        return result(
          state.joined ? [{ member_id: owner, generation: "1" }] : [],
        );
      if (sql.startsWith("SELECT c.id,c.member_id,c.pseudonym"))
        return result(
          state.chosen
            ? [
                {
                  id: choice,
                  member_id: owner,
                  pseudonym: "Peer aaaaaaaaaaaaaaaa",
                },
              ]
            : [],
        );
      if (
        sql.startsWith("SELECT id,member_id,choice_id,root_id,state,revision")
      )
        return result(
          state.metadata
            ? [
                {
                  id: postId,
                  member_id: state.foreign ? staff : owner,
                  choice_id: choice,
                  root_id: null,
                  state: state.postState,
                  revision: state.postRevision,
                },
              ]
            : [],
        );
      if (sql.startsWith("SELECT id,body,state,revision"))
        return result(
          state.body
            ? [
                {
                  id: postId,
                  body: "Invented currently shared source",
                  state: state.postState,
                  revision: state.postRevision,
                  createdAt: "2026-10-28T10:00:00Z",
                },
              ]
            : [],
        );
      if (sql.startsWith("SELECT new_revision,action"))
        return result(state.decision ? [state.decision] : []);
      if (sql.startsWith("SELECT action FROM preview_circle_moderation_audit"))
        return result(
          state.decision ? [{ action: state.decision.action }] : [],
        );
      if (sql.startsWith("SELECT count(*)::int n FROM preview_circle_appeals"))
        return result([{ n: state.count }]);
      if (sql.startsWith("SELECT id,fingerprint FROM preview_circle_appeals"))
        return result(
          sql.includes("member_id=$1")
            ? state.priorRequest
              ? [state.priorRequest]
              : []
            : state.duplicate
              ? [state.duplicate]
              : [],
        );
      if (sql.startsWith("SELECT id,post_id FROM preview_circle_appeals"))
        return result(state.queue);
      if (sql.startsWith("SELECT post_id FROM preview_circle_appeals"))
        return result(state.observedAppeal ? [{ post_id: postId }] : []);
      if (sql.startsWith("SELECT id,resolution_fingerprint"))
        return result(state.priorResolution ? [state.priorResolution] : []);
      if (sql.startsWith("SELECT state,decision_revision"))
        return result(
          state.lockedAppeal
            ? [
                {
                  state: state.appealState,
                  decision_revision: state.decisionRevision,
                },
              ]
            : [],
        );
      if (sql.startsWith("SELECT state FROM preview_circle_appeals"))
        return result(state.lockedAppeal ? [{ state: state.appealState }] : []);
      if (sql.startsWith("SELECT 1 FROM preview_circle_moderation_audit"))
        return result(state.actionKeyUsed ? [{}] : []);
      if (sql.startsWith("SELECT id,state AS status"))
        return result(state.receipt ? [state.receipt] : []);
      if (sql.startsWith("INSERT ") || sql.startsWith("UPDATE "))
        changes.push({ sql, values });
      return result([]);
    },
  );
  const release = vi.fn(() => {
    if (state.releaseFailure) throw Error("Invented release loss");
  });
  const connect = vi.fn(
    async () => ({ query, release }) as unknown as PoolClient,
  );
  return {
    state,
    commands,
    changes,
    query,
    release,
    connect,
    db: circleDiscussionStore(
      { connect } as unknown as Pool,
      "invented-appeal-unit",
      writes,
    ),
  };
}
const operations = (db: CircleDiscussionStore, t = token, c = circle) => ({
  page: () => db.appeals(t, c, postId),
  history: () => db.appealHistory(t, c),
  receipt: () => db.appealReceipt(t, c, id),
  request: () => db.requestAppeal(t, c, postId, key, 2, "recheck_rule", true),
  withdraw: () => db.withdrawAppeal(t, c, id, true),
  queue: () => db.appealQueue(t, c),
  resolve: () => db.resolveAppeal(t, c, id, key, "uphold", 2, "rule_applies"),
});
afterEach(() => vi.restoreAllMocks());

it("MODA-02 disables every new operation and denies malformed actor/circle before acquiring data", async () => {
  for (const call of Object.values(operations(disabledCircleDiscussionStore())))
    expect(await call()).toEqual({ kind: "denied" });
  for (const [t, c] of [
    ["invalid", circle],
    [token, "unknown"],
  ]) {
    const f = fixture();
    for (const call of Object.values(operations(f.db, t, c)))
      expect(await call()).toEqual({ kind: "denied" });
    expect(f.connect).not.toHaveBeenCalled();
  }
});
it("MODA-06 pause denies new shared requests/actions while retaining current owner's history and withdrawal", async () => {
  const f = fixture(false),
    calls = operations(f.db);
  for (const name of ["request", "queue", "resolve"] as const)
    expect(await calls[name]()).toEqual({ kind: "denied" });
  expect(f.connect).not.toHaveBeenCalled();
  expect(await calls.history()).toMatchObject({
    kind: "ready",
    value: { items: [{ availability: "write_paused" }] },
  });
  expect(await calls.withdraw()).toEqual({ kind: "ready", value: { id } });
});
it("MODA-02 rejects invalid references, revisions, structured reasons and confirmation before opening a transaction", async () => {
  const f = fixture();
  expect(await f.db.appeals(token, circle, "bad")).toEqual({ kind: "invalid" });
  expect(await f.db.appealReceipt(token, circle, "bad")).toEqual({
    kind: "invalid",
  });
  for (const args of [
    ["bad", key, 2, "other", true],
    [postId, "bad", 2, "other", true],
    [postId, key, 1.5, "other", true],
    [postId, key, 1, "other", true],
    [postId, key, 2, "private text", true],
    [postId, key, 2, "other", false],
  ] as const)
    expect(
      await f.db.requestAppeal(
        token,
        circle,
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
      ),
    ).toEqual({
      kind: "invalid",
    });
  expect(await f.db.withdrawAppeal(token, circle, "bad", true)).toEqual({
    kind: "invalid",
  });
  expect(await f.db.withdrawAppeal(token, circle, id, false)).toEqual({
    kind: "invalid",
  });
  for (const args of [
    ["bad", key, "uphold", 2, "rule_applies"],
    [id, "bad", "uphold", 2, "rule_applies"],
    [id, key, "uphold", 1.5, "rule_applies"],
    [id, key, "uphold", 1, "rule_applies"],
    [id, key, "restore", 2, "rule_applies"],
    [id, key, "uphold", 2, "decision_corrected"],
    [id, key, "unknown", 2, "other"],
  ] as const)
    expect(
      await f.db.resolveAppeal(
        token,
        circle,
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
      ),
    ).toEqual({
      kind: "invalid",
    });
  expect(f.connect).not.toHaveBeenCalled();
});
it.each(["identity", "principal", "workspace"] as const)(
  "MODA-06 private reads and withdrawal withhold data without current %s",
  async (gate) => {
    const f = fixture();
    f.state[gate] = false;
    for (const name of [
      "page",
      "history",
      "receipt",
      "withdraw",
      "request",
    ] as const)
      expect(await operations(f.db)[name]()).toEqual({ kind: "denied" });
    expect(f.commands).not.toContain("COMMIT");
  },
);
it("MODA-01 new current hidden decision offers a request without retaining another body", async () => {
  const f = fixture();
  f.state.rows = [];
  expect(await f.db.appeals(token, circle, postId)).toEqual({
    kind: "ready",
    value: {
      postId,
      postState: "hidden",
      postRevision: 2,
      decisionRevision: 2,
      canRequest: true,
      items: [],
    },
  });
  expect(f.changes).toEqual([]);
});
it.each([
  "unshared",
  "visible",
  "older",
  "restored",
  "missing",
  "bound",
  "existing",
])("MODA-01/02 page never offers an invalid new request: %s", async (cause) => {
  const f = fixture();
  f.state.rows = cause === "existing" ? [retained()] : [];
  if (cause === "unshared") f.state.sharedEligible = false;
  if (cause === "visible") f.state.postState = "visible";
  if (cause === "older") f.state.decision!.new_revision = 3;
  if (cause === "restored") f.state.decision!.action = "restored";
  if (cause === "missing") f.state.decision = null;
  if (cause === "bound") f.state.count = 200;
  expect(await f.db.appeals(token, circle, postId)).toMatchObject({
    kind: "ready",
    value: { canRequest: false },
  });
});
it("MODA-06 missing own contribution and unknown receipt fail closed; empty own history remains valid", async () => {
  const f = fixture();
  f.state.ownerPost = false;
  expect(await f.db.appeals(token, circle, postId)).toEqual({ kind: "denied" });
  f.state.rows = [];
  expect(await f.db.appealReceipt(token, circle, id)).toEqual({
    kind: "denied",
  });
  expect(await f.db.appealHistory(token, circle)).toEqual({
    kind: "ready",
    value: { appealsVersion: 1, circleId: circle, items: [] },
  });
});
it.each([
  "available",
  "unavailable",
  "withdrawn-source",
  "superseded-revision",
  "superseded-state",
  "upheld",
  "restored",
  "withdrawn",
])(
  "MODA-05/06 whitelists retained projection and accurately labels %s",
  async (kind) => {
    const f = fixture(),
      row = f.state.rows[0]!;
    if (kind === "unavailable") row.sharedEligible = false;
    if (kind === "withdrawn-source") row.postState = "withdrawn";
    if (kind === "superseded-revision") row.postRevision = 4;
    if (kind === "superseded-state") row.postState = "visible";
    if (["upheld", "restored", "withdrawn"].includes(kind)) {
      row.state = kind as CircleAppeal["state"];
      row.closedAt = "2026-10-28T10:02:00Z";
    }
    if (kind === "upheld" || kind === "restored") {
      row.resolutionReason =
        kind === "upheld" ? "rule_applies" : "decision_corrected";
      row.resolvedRevision = kind === "upheld" ? 2 : 3;
    }
    const result = await f.db.appealReceipt(token, circle, id);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw Error("Missing retained record");
    expect(result.value.availability).toBe(
      ["upheld", "restored", "withdrawn"].includes(kind)
        ? "closed"
        : kind.startsWith("superseded")
          ? "superseded"
          : kind === "unavailable" || kind === "withdrawn-source"
            ? "unavailable"
            : "available",
    );
    expect(JSON.stringify(result.value)).not.toContain("must-not-project");
    expect(result.value.resolution !== null).toBe(
      kind === "upheld" || kind === "restored",
    );
  },
);
it("MODA-06 an impossible over-bound read throws rather than truncating a purported complete export", async () => {
  const f = fixture();
  f.state.rows = Array.from({ length: 201 }, retained);
  await expect(f.db.appealHistory(token, circle)).rejects.toThrow(
    "operation unavailable",
  );
  expect(f.commands).toContain("ROLLBACK");
  expect(f.commands).not.toContain("COMMIT");
});
it.each(["joined", "chosen", "metadata", "body", "foreign"] as const)(
  "MODA-02 request requires current eligible owned source: %s",
  async (gate) => {
    const f = fixture();
    if (gate === "foreign") f.state.foreign = true;
    else f.state[gate] = false;
    expect(
      await f.db.requestAppeal(
        token,
        circle,
        postId,
        key,
        2,
        "recheck_rule",
        true,
      ),
    ).toEqual({ kind: "denied" });
    expect(f.changes).toEqual([]);
  },
);
it.each(["prior", "duplicate"] as const)(
  "MODA-02 %s request replays only matching canonical payload",
  async (kind) => {
    const f = fixture(),
      prior = { id, fingerprint: requestDigest() };
    if (kind === "prior") f.state.priorRequest = prior;
    else f.state.duplicate = prior;
    expect(
      await f.db.requestAppeal(
        token,
        circle,
        postId,
        key,
        2,
        "recheck_rule",
        true,
      ),
    ).toEqual({ kind: "ready", value: { id } });
    prior.fingerprint = "changed";
    expect(
      await f.db.requestAppeal(
        token,
        circle,
        postId,
        key,
        2,
        "recheck_rule",
        true,
      ),
    ).toEqual({ kind: "conflict" });
    expect(f.changes).toEqual([]);
  },
);
it.each(["visible", "stale", "missing-decision", "restored-decision", "bound"])(
  "MODA-02 refuses non-current or over-bound request: %s",
  async (cause) => {
    const f = fixture();
    if (cause === "visible") f.state.postState = "visible";
    if (cause === "stale") f.state.postRevision = 4;
    if (cause === "missing-decision") f.state.decision = null;
    if (cause === "restored-decision") f.state.decision!.action = "restored";
    if (cause === "bound") f.state.count = 200;
    expect(
      await f.db.requestAppeal(
        token,
        circle,
        postId,
        key,
        2,
        "recheck_rule",
        true,
      ),
    ).toEqual({ kind: cause === "bound" ? "limit" : "conflict" });
    expect(f.changes).toEqual([]);
  },
);
it("MODA-01 confirmed request retains only structured fields after current authority checks", async () => {
  const f = fixture(),
    result = await f.db.requestAppeal(
      token,
      circle,
      postId,
      key,
      2,
      "recheck_rule",
      true,
    );
  expect(result.kind).toBe("ready");
  expect(f.changes).toHaveLength(1);
  expect(f.changes[0]!.values.slice(1)).toEqual([
    owner,
    circle,
    postId,
    2,
    "recheck_rule",
    key,
    requestDigest(),
  ]);
  expect(JSON.stringify(f.changes)).not.toContain(
    "Invented currently shared source",
  );
  expect(f.commands.filter((sql) => sql === "COMMIT")).toHaveLength(1);
});
it.each(["missing", "withdrawn", "upheld", "pending"])(
  "MODA-05 withdrawal handles retained %s state without rewriting a terminal result",
  async (state) => {
    const f = fixture();
    f.state.lockedAppeal = state !== "missing";
    f.state.appealState = state;
    expect(await f.db.withdrawAppeal(token, circle, id, true)).toEqual({
      kind:
        state === "missing"
          ? "denied"
          : state === "upheld"
            ? "conflict"
            : "ready",
      ...(["pending", "withdrawn"].includes(state) ? { value: { id } } : {}),
    });
    expect(f.changes).toHaveLength(state === "pending" ? 1 : 0);
  },
);
it.each([
  "staffObservation",
  "principal",
  "workspace",
  "role",
  "grant",
] as const)(
  "MODA-03 queue/action deny absent current %s authority",
  async (gate) => {
    const f = fixture();
    f.state[gate] = false;
    const expected = gate === "workspace" ? "ready" : "denied";
    // Missing owner workspace hides its source; the current moderator may see an empty queue.
    expect((await f.db.appealQueue(staffToken, circle)).kind).toBe(expected);
    expect(
      await f.db.resolveAppeal(
        staffToken,
        circle,
        id,
        key,
        "uphold",
        2,
        "rule_applies",
      ),
    ).toEqual({ kind: "denied" });
    expect(f.changes).toEqual([]);
  },
);
it("MODA-03 queue omits unavailable or concurrently withdrawn source requests and rejects malformed cursors", async () => {
  const f = fixture();
  expect(await f.db.appealQueue(staffToken, circle, "bad")).toEqual({
    kind: "invalid",
  });
  f.state.body = false;
  expect(await f.db.appealQueue(staffToken, circle)).toEqual({
    kind: "ready",
    value: { items: [], nextCursor: null },
  });
  f.state.body = true;
  f.state.rows = [];
  expect(await f.db.appealQueue(staffToken, circle)).toEqual({
    kind: "ready",
    value: { items: [], nextCursor: null },
  });
});
it("MODA-03 queue preserves valid grant-bound pagination and emits only the current page", async () => {
  const f = fixture();
  f.state.queue = Array.from({ length: 21 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`,
    post_id: postId,
  }));
  const first = await f.db.appealQueue(staffToken, circle);
  expect(first.kind).toBe("ready");
  if (first.kind !== "ready") throw Error("Missing page");
  expect(first.value.items).toHaveLength(20);
  expect(first.value.nextCursor).toBeTruthy();
  expect(
    (await f.db.appealQueue(staffToken, circle, first.value.nextCursor!)).kind,
  ).toBe("ready");
});
it.each([
  "missing",
  "source",
  "body",
  "withdrawn",
  "wrong-decision",
  "newer",
  "visible",
])("MODA-04 resolution cannot act on %s source/request", async (cause) => {
  const f = fixture();
  if (cause === "missing") f.state.observedAppeal = false;
  if (cause === "source") f.state.metadata = false;
  if (cause === "body") f.state.body = false;
  if (cause === "withdrawn") f.state.appealState = "withdrawn";
  if (cause === "wrong-decision") f.state.decisionRevision = 4;
  if (cause === "newer") f.state.postRevision = 4;
  if (cause === "visible") f.state.postState = "visible";
  expect(
    await f.db.resolveAppeal(
      staffToken,
      circle,
      id,
      key,
      "uphold",
      2,
      "rule_applies",
    ),
  ).toEqual({
    kind: ["missing", "source", "body"].includes(cause) ? "denied" : "conflict",
  });
  expect(f.changes).toEqual([]);
});
it("MODA-04 missing locked request and conflicting original resolution key cannot acknowledge success", async () => {
  const f = fixture();
  f.state.lockedAppeal = false;
  expect(
    await f.db.resolveAppeal(
      staffToken,
      circle,
      id,
      key,
      "uphold",
      2,
      "rule_applies",
    ),
  ).toEqual({ kind: "denied" });
  f.state.priorResolution = {
    id,
    resolution_fingerprint: resolutionDigest(),
    resolved_revision: 2,
  };
  expect(
    await f.db.resolveAppeal(
      staffToken,
      circle,
      id,
      key,
      "uphold",
      2,
      "rule_applies",
    ),
  ).toEqual({ kind: "ready", value: { id, revision: 2 } });
  f.state.priorResolution.id = postId;
  expect(
    await f.db.resolveAppeal(
      staffToken,
      circle,
      id,
      key,
      "uphold",
      2,
      "rule_applies",
    ),
  ).toEqual({ kind: "conflict" });
  f.state.priorResolution.id = id;
  f.state.priorResolution.resolution_fingerprint = "changed";
  expect(
    await f.db.resolveAppeal(
      staffToken,
      circle,
      id,
      key,
      "uphold",
      2,
      "rule_applies",
    ),
  ).toEqual({ kind: "conflict" });
});
it.each(["uphold", "restore"] as const)(
  "MODA-04 %s records only one terminal structured result and expected existing restoration audit",
  async (outcome) => {
    const f = fixture();
    expect(
      await f.db.resolveAppeal(
        staffToken,
        circle,
        id,
        key,
        outcome,
        2,
        outcome === "uphold" ? "rule_applies" : "decision_corrected",
      ),
    ).toEqual({
      kind: "ready",
      value: { id, revision: outcome === "uphold" ? 2 : 3 },
    });
    expect(f.changes).toHaveLength(outcome === "uphold" ? 1 : 3);
    expect(f.changes.at(-1)!.values.slice(0, 5)).toEqual([
      id,
      outcome === "uphold" ? "upheld" : "restored",
      staff,
      "moderator",
      key,
    ]);
  },
);
it("MODA-04 restoration refuses a key already attached to a different moderation action", async () => {
  const f = fixture();
  f.state.actionKeyUsed = true;
  expect(
    await f.db.resolveAppeal(
      staffToken,
      circle,
      id,
      key,
      "restore",
      2,
      "decision_corrected",
    ),
  ).toEqual({ kind: "conflict" });
  expect(f.changes).toEqual([]);
});
it.each(["appeal", "appeal-resolution"])(
  "MODA-07 %s original-key receipt is current-authorized, content-free and honestly absent",
  async (kind) => {
    const f = fixture();
    expect(
      await f.db.reconcile(
        kind === "appeal" ? token : staffToken,
        circle,
        kind,
        key,
      ),
    ).toEqual({ kind: "ready", value: { found: true, ...f.state.receipt } });
    f.state.receipt = null;
    expect(
      await f.db.reconcile(
        kind === "appeal" ? token : staffToken,
        circle,
        kind,
        key,
      ),
    ).toEqual({
      kind: "ready",
      value: { found: false, id: null, status: null, revision: null },
    });
  },
);
it.each([
  "page",
  "history",
  "receipt",
  "request",
  "withdraw",
  "queue",
  "resolve",
] as const)(
  "MODA-07 %s never acknowledges data after final authorization or COMMIT/release uncertainty",
  async (name) => {
    const f = fixture();
    f.state.current = false;
    expect(await operations(f.db)[name]()).toEqual({ kind: "denied" });
    f.state.current = true;
    f.state.failure = "COMMIT";
    await expect(operations(f.db)[name]()).rejects.toThrow(
      "outcome unconfirmed",
    );
    f.state.failure = "";
    f.state.releaseFailure = true;
    await expect(operations(f.db)[name]()).rejects.toThrow(
      "outcome unconfirmed",
    );
  },
);
