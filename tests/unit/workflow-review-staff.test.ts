import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkflowReviewContext } from "../../src/workflow-review-transaction.ts";
const f = vi.hoisted(() => ({
  execute: vi.fn(),
  actors: vi.fn(),
  workspace: vi.fn(),
  bundle: vi.fn(),
  worklist: vi.fn(),
}));
vi.mock("../../src/workflow-review-transaction.ts", async (original) => ({
  ...(await original<
    typeof import("../../src/workflow-review-transaction.ts")
  >()),
  reviewExecute: f.execute,
  reviewActors: f.actors,
  reviewWorkspace: f.workspace,
}));
vi.mock("../../src/workflow-registry.ts", () => ({ workflowBundle: f.bundle }));
vi.mock("../../src/workflow-review-worklist.ts", () => ({
  workflowReviewWorklist: () => f.worklist,
}));
import { workflowReviewStaffStore } from "../../src/workflow-review-staff.ts";
import { SampleFeedbackFailure } from "../../src/sample-feedback-lifetime.ts";
const secret = "invented-staff-domain-secret",
  token = "a".repeat(64),
  pool = {} as Pool;
const adminId = "11111111-1111-4111-8111-111111111111",
  memberId = "22222222-2222-4222-8222-222222222222",
  moderatorId = "33333333-3333-4333-8333-333333333333",
  requestId = "44444444-4444-4444-8444-444444444444",
  instanceId = "55555555-5555-4555-8555-555555555555",
  grantId = "66666666-6666-4666-8666-666666666666",
  operationId = "77777777-7777-4777-8777-777777777777";
const createdAt = new Date("2026-10-07T09:00:00.000Z"),
  starts = new Date("2026-10-07T09:05:00.000Z"),
  expires = new Date("2026-10-07T10:00:00.000Z");
const intent = {
  id: requestId,
  memberId,
  instanceId,
  workflowId: "WF-001",
  workflowVersion: 1,
  revision: 1,
  createdAt,
  expires,
  withdrawn: null as Date | null,
};
const source = { instanceId, revision: 1 };
const checked = {
  actorId: adminId,
  requestId,
  moderatorId,
  instanceId,
  revision: 1,
  startsAt: starts.toISOString(),
  expiresAt: expires.toISOString(),
};
const discovery = {
  request: requestId,
  moderator: moderatorId,
  administrator: adminId,
};
const historical = {
  ...discovery,
  starts,
  expires,
  revoked: null as Date | null,
  expired: false,
  scheduled: false,
  authority: true,
};
const lockedGrant = {
  id: grantId,
  request: requestId,
  moderator: moderatorId,
  starts,
  expires,
  revoked: null as Date | null,
};
const readingGrant = {
  ...lockedGrant,
  administrator: adminId,
  instance: instanceId,
  revision: 1,
  scheduled: false,
};
const port = (enabled = true, mode: "test" | "live" = "test") =>
  workflowReviewStaffStore(pool, { enabled, mode }, secret);
function packet(value: unknown = checked, raw?: string) {
  const text = Buffer.from(raw ?? JSON.stringify(value)).toString("base64url");
  return `${text}.${createHmac("sha256", secret).update(`workflow-review-assignment-v1\0${text}`).digest("base64url")}`;
}
function transaction(
  results: (unknown[] | { rows: unknown[]; rowCount: number })[],
  actorId = adminId,
) {
  const query = vi.fn().mockImplementation(async () => {
    const next = results.shift();
    if (!next) throw Error("Unexpected fixture query");
    return Array.isArray(next) ? { rows: next, rowCount: next.length } : next;
  });
  const ctx = {
    actorId,
    expires: [expires],
    tx: {
      query,
      bounded: async <T>(use: () => Promise<T>) => use(),
      observe: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as WorkflowReviewContext;
  f.execute.mockImplementation(async (_pool, _token, _writing, use) => {
    try {
      return { ...(await use(ctx)), deadline: performance.now() + 60000 };
    } catch (error) {
      if (error instanceof SampleFeedbackFailure) return { kind: error.kind };
      throw error;
    }
  });
  return { ctx, query };
}
function principals() {
  return new Map([
    [
      memberId,
      { id: memberId, kind: "member", expires, revoked: null as Date | null },
    ],
    [
      moderatorId,
      { id: moderatorId, kind: "staff", expires, revoked: null as Date | null },
    ],
    [
      adminId,
      { id: adminId, kind: "staff", expires, revoked: null as Date | null },
    ],
  ]);
}
beforeEach(() => {
  vi.clearAllMocks();
  f.bundle.mockResolvedValue({ version: 1 });
  f.actors.mockResolvedValue({
    principals: principals(),
    profiles: new Map([
      [moderatorId, "moderator"],
      [adminId, "platform_admin"],
    ]),
  });
  f.workspace.mockResolvedValue("owned-workspace");
});
it("WFREV-08 live staff operations are unavailable without authority or metadata acquisition", async () => {
  const p = port(true, "live");
  for (const call of [
    () => p.entry(token, "platform_admin"),
    () => p.check(token, requestId, moderatorId),
    () => p.assign(token, packet(), operationId, "yes"),
    () => p.revoke(token, grantId, operationId, "yes"),
    () => p.read(token, grantId),
    () => p.receipt(token, grantId),
    () => p.inspect(token, operationId),
    () => p.list(token),
  ])
    expect(await call()).toEqual({ kind: "unavailable" });
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.worklist).not.toHaveBeenCalled();
});
it("WFREV-08 creation pause preserves only existing authority paths", async () => {
  expect(await port(false).check(token, requestId, moderatorId)).toEqual({
    kind: "unavailable",
  });
  expect(await port(false).assign(token, packet(), operationId, "yes")).toEqual(
    { kind: "unavailable" },
  );
  expect(f.execute).not.toHaveBeenCalled();
  f.worklist.mockResolvedValue({ kind: "ready", entries: [], next: null });
  expect(await port(false).list(token, "opaque")).toMatchObject({
    kind: "ready",
  });
  expect(f.worklist).toHaveBeenCalledWith(token, "opaque");
});
it.each(["platform_admin", "moderator"] as const)(
  "WFREV-02 current %s entry uses only database UTC defaults and own expiry",
  async (role) => {
    transaction([[{ starts, ends: expires }]]);
    expect(await port().entry(token, role)).toMatchObject({
      kind: "ready",
      actorId: adminId,
      startsAt: starts.toISOString(),
      endsAt: expires.toISOString(),
      expiresAt: expires.toISOString(),
      enabled: true,
    });
    expect(f.actors).toHaveBeenCalledWith(expect.any(Object), [], role);
  },
);
it.each([
  { request: "bad", moderator: moderatorId },
  { request: requestId, moderator: "bad" },
])(
  "WFREV-02 invalid assignment references %j never acquire authority",
  async (value) => {
    expect(await port().check(token, value.request, value.moderator)).toEqual({
      kind: "invalid",
    });
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it.each([
  null,
  { startsAt: starts.toISOString() },
  { startsAt: "bad", expiresAt: expires.toISOString() },
  { startsAt: starts.toISOString(), expiresAt: "bad" },
  { startsAt: expires.toISOString(), expiresAt: starts.toISOString() },
  { startsAt: createdAt.toISOString(), expiresAt: "2026-10-07T11:00:00.000Z" },
])(
  "WFREV-02 invalid UTC interval %j never acquires authority",
  async (window) => {
    expect(
      await port().check(
        token,
        requestId,
        moderatorId,
        window as { startsAt: string; expiresAt: string },
      ),
    ).toEqual({ kind: "invalid" });
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it.each([
  undefined,
  { startsAt: starts.toISOString(), expiresAt: expires.toISOString() },
])(
  "WFREV-02 exact checked assignment binds all finite identities and window %j",
  async (window) => {
    transaction([[intent], [source], [intent], [{ starts, expires }]]);
    const result = await port().check(token, requestId, moderatorId, window);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw Error("Checked assignment required");
    expect(
      JSON.parse(
        Buffer.from(result.checked.split(".")[0]!, "base64url").toString(
          "utf8",
        ),
      ),
    ).toEqual(checked);
    expect(result.startsAt).toBe(starts.toISOString());
    expect(result.expiresAt).toBe(expires.toISOString());
  },
);
it.each(["expiry-ceiling", "expired", "before-intent"])(
  "WFREV-02 valid-shaped window %s still denies outside authority",
  async (reason) => {
    const window =
      reason === "expiry-ceiling"
        ? {
            startsAt: starts.toISOString(),
            expiresAt: "2026-10-07T10:01:00.000Z",
          }
        : reason === "expired"
          ? {
              startsAt: createdAt.toISOString(),
              expiresAt: starts.toISOString(),
            }
          : {
              startsAt: "2026-10-07T08:59:00.000Z",
              expiresAt: "2026-10-07T09:30:00.000Z",
            };
    transaction([[intent], [source], [intent], [{ starts, expires }]]);
    expect(
      await port().check(token, requestId, moderatorId, window),
    ).toMatchObject({ kind: "invalid" });
  },
);
it.each(["missing", "wrong-kind", "revoked", "wrong-role"])(
  "WFREV-03 required related authority %s denies before source projection",
  async (reason) => {
    const ps = principals();
    if (reason === "missing") ps.delete(memberId);
    if (reason === "wrong-kind")
      ps.set(memberId, { ...ps.get(memberId)!, kind: "staff" });
    if (reason === "revoked")
      ps.set(memberId, { ...ps.get(memberId)!, revoked: createdAt });
    f.actors.mockResolvedValue({
      principals: ps,
      profiles: new Map([
        [moderatorId, reason === "wrong-role" ? "operator" : "moderator"],
        [adminId, "platform_admin"],
      ]),
    });
    const t = transaction([[intent]]);
    expect(await port().check(token, requestId, moderatorId)).toEqual({
      kind: "denied",
    });
    expect(t.query).toHaveBeenCalledTimes(1);
  },
);
it.each([
  "missing-request",
  "changed-request",
  "withdrawn",
  "missing-source",
  "new-instance",
  "new-revision",
  "missing-bundle",
  "stale-bundle",
])("WFREV-04 exact assignment source %s denies", async (reason) => {
  if (reason === "missing-bundle") f.bundle.mockResolvedValue(null);
  if (reason === "stale-bundle") f.bundle.mockResolvedValue({ version: 2 });
  const current =
      reason === "missing-source"
        ? []
        : [
            {
              ...source,
              ...(reason === "new-instance"
                ? { instanceId: grantId }
                : reason === "new-revision"
                  ? { revision: 2 }
                  : {}),
            },
          ],
    locked =
      reason === "changed-request"
        ? [{ ...intent, revision: 2 }]
        : reason === "withdrawn"
          ? [{ ...intent, withdrawn: createdAt }]
          : [intent];
  transaction(
    reason === "missing-request" ? [[]] : [[intent], current, locked],
  );
  expect(await port().check(token, requestId, moderatorId)).toEqual({
    kind: "denied",
  });
});
it("WFREV-04 request disappearing after discovery denies", async () => {
  transaction([[intent], [source], []]);
  expect(await port().check(token, requestId, moderatorId)).toEqual({
    kind: "denied",
  });
});
it.each([null, 7, "", "x".repeat(2049), "bad.packet", "abc." + "A".repeat(43)])(
  "WFREV-02 forged assignment packet %j never acquires authority",
  async (value) => {
    expect(await port().assign(token, value, operationId, "yes")).toEqual({
      kind: "invalid",
    });
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it.each([
  null,
  7,
  [],
  {},
  { ...checked, extra: "unknown" },
  { ...checked, actorId: "bad" },
  { ...checked, revision: 1.5 },
  { ...checked, revision: 0 },
  { ...checked, startsAt: "bad" },
  { ...checked, expiresAt: 7 },
  { ...checked, expiresAt: "bad" },
  { ...checked, expiresAt: "2026-10-07T10:00:00+00:00" },
  { ...checked, startsAt: expires.toISOString() },
  { ...checked, expiresAt: "2026-10-07T11:00:00.000Z" },
])("WFREV-02 authenticated malformed assignment %j denies", async (value) => {
  expect(await port().assign(token, packet(value), operationId, "yes")).toEqual(
    { kind: "invalid" },
  );
  expect(f.execute).not.toHaveBeenCalled();
});
it("WFREV-02 authenticated malformed assignment JSON denies", async () => {
  expect(
    await port().assign(token, packet(checked, "{broken"), operationId, "yes"),
  ).toEqual({ kind: "invalid" });
});
it.each([
  { key: "bad", confirm: "yes" },
  { key: operationId, confirm: "no" },
])(
  "WFREV-02 assignment requires original UUID and deliberate confirmation %j",
  async (value) => {
    expect(
      await port().assign(token, packet(), value.key, value.confirm),
    ).toEqual({ kind: "invalid" });
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it("WFREV-02 checked assignment belongs only to its administrator", async () => {
  transaction([], moderatorId);
  expect(await port().assign(token, packet(), operationId, "yes")).toEqual({
    kind: "denied",
  });
});
it.each([{ instanceId: grantId }, { revision: 2 }])(
  "WFREV-04 changed signed source %j conflicts after current intent fencing",
  async (change) => {
    transaction([[intent], [source], [intent]]);
    expect(
      await port().assign(
        token,
        packet({ ...checked, ...change }),
        operationId,
        "yes",
      ),
    ).toMatchObject({ kind: "conflict" });
  },
);
it.each(["actor", "kind", "instruction"])(
  "WFREV-06 assignment key with changed %s conflicts",
  async (changed) => {
    const op = {
      actor: adminId,
      kind: "assign",
      instruction: checked,
      receipt: grantId,
      ...(changed === "actor"
        ? { actor: moderatorId }
        : changed === "kind"
          ? { kind: "revoke" }
          : { instruction: { ...checked, revision: 2 } }),
    };
    transaction([[intent], [source], [intent], [op]]);
    expect(
      await port().assign(token, packet(), operationId, "yes"),
    ).toMatchObject({ kind: "conflict" });
  },
);
it.each([null, createdAt])(
  "WFREV-06 exact assignment replay retains receipt and revocation %s",
  async (revoked) => {
    const t = transaction([
      [intent],
      [source],
      [intent],
      [
        {
          actor: adminId,
          kind: "assign",
          instruction: checked,
          receipt: grantId,
        },
      ],
      [{ ...lockedGrant, revoked }],
    ]);
    expect(
      await port().assign(token, packet(), operationId, "yes"),
    ).toMatchObject({
      kind: "replayed",
      grant: { grantId, revokedAt: revoked?.toISOString() ?? null },
    });
    expect(t.query).toHaveBeenCalledTimes(5);
  },
);
it("WFREV-06 erased assignment receipt cannot be recreated by original-key replay", async () => {
  transaction([
    [intent],
    [source],
    [intent],
    [
      {
        actor: adminId,
        kind: "assign",
        instruction: checked,
        receipt: grantId,
      },
    ],
    [],
  ]);
  expect(await port().assign(token, packet(), operationId, "yes")).toEqual({
    kind: "denied",
  });
});
it("WFREV-06 existing unrevoked grant conflicts without creating another", async () => {
  transaction([[intent], [source], [intent], [], [{ id: grantId }]]);
  expect(
    await port().assign(token, packet(), operationId, "yes"),
  ).toMatchObject({ kind: "conflict" });
});
it("WFREV-06 losing global assignment reservation never inserts a grant", async () => {
  transaction([
    [intent],
    [source],
    [intent],
    [],
    [],
    { rows: [], rowCount: 0 },
  ]);
  expect(
    await port().assign(token, packet(), operationId, "yes"),
  ).toMatchObject({ kind: "conflict" });
});
it("WFREV-02 explicit exact assignment stores the checked finite window without copied note", async () => {
  const t = transaction([
    [intent],
    [source],
    [intent],
    [],
    [],
    { rows: [{}], rowCount: 1 },
    [],
  ]);
  const result = await port().assign(token, packet(), operationId, "yes");
  expect(result).toMatchObject({
    kind: "applied",
    grant: {
      requestId,
      moderatorId,
      startsAt: checked.startsAt,
      expiresAt: checked.expiresAt,
      revokedAt: null,
    },
  });
  expect(t.query.mock.calls[6]![1]).toContain(checked.startsAt);
  expect(t.query.mock.calls[6]![1]).toContain(checked.expiresAt);
});
const readDiscovery = { requestId, moderatorId, administratorId: adminId };
it.each(["missing", "another-moderator"])(
  "WFREV-03 discovery %s denies before source lookup",
  async (reason) => {
    const t = transaction(
      [
        reason === "missing"
          ? []
          : [{ ...readDiscovery, moderatorId: adminId }],
      ],
      moderatorId,
    );
    expect(await port().read(token, grantId)).toEqual({ kind: "denied" });
    expect(t.query).toHaveBeenCalledTimes(1);
  },
);
it.each([
  "missing",
  "revoked",
  "scheduled",
  "instance",
  "revision",
  "moderator",
  "administrator",
  "request",
])(
  "WFREV-03 current grant %s denies before reading raw note",
  async (reason) => {
    const changed =
      reason === "missing"
        ? []
        : [
            {
              ...readingGrant,
              ...(reason === "revoked"
                ? { revoked: createdAt }
                : reason === "scheduled"
                  ? { scheduled: true }
                  : reason === "instance"
                    ? { instance: grantId }
                    : reason === "revision"
                      ? { revision: 2 }
                      : reason === "moderator"
                        ? { moderator: adminId }
                        : reason === "administrator"
                          ? { administrator: moderatorId }
                          : reason === "request"
                            ? { request: grantId }
                            : {}),
            },
          ];
    const t = transaction(
      [[readDiscovery], [intent], [source], [intent], changed],
      moderatorId,
    );
    expect(await port().read(token, grantId)).toEqual({ kind: "denied" });
    expect(t.query).toHaveBeenCalledTimes(5);
  },
);
it("WFREV-03 vanished note denies despite matching metadata", async () => {
  transaction(
    [[readDiscovery], [intent], [source], [intent], [readingGrant], []],
    moderatorId,
  );
  expect(await port().read(token, grantId)).toEqual({ kind: "denied" });
});
it("WFREV-03 only exact current permitted moderator obtains the original note", async () => {
  const t = transaction(
    [
      [readDiscovery],
      [intent],
      [source],
      [intent],
      [readingGrant],
      [{ note: "Invented exact permitted note" }],
    ],
    moderatorId,
  );
  expect(await port().read(token, grantId)).toMatchObject({
    kind: "ready",
    workflowId: "WF-001",
    workflowVersion: 1,
    revision: 1,
    note: "Invented exact permitted note",
    expiresAt: expires.toISOString(),
  });
  expect(t.query.mock.calls[5]![1]).toEqual([instanceId, 1]);
});
it.each(["receipt", "read", "inspect"] as const)(
  "WFREV staff %s invalid reference does not acquire authority",
  async (method) => {
    expect(await port()[method](token, "bad")).toEqual({ kind: "invalid" });
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it.each([
  { grant: "bad", key: operationId, confirm: "yes" },
  { grant: grantId, key: "bad", confirm: "yes" },
  { grant: grantId, key: operationId, confirm: "no" },
])("WFREV-05 invalid revocation %j never acquires authority", async (value) => {
  expect(
    await port().revoke(token, value.grant, value.key, value.confirm),
  ).toEqual({ kind: "invalid" });
  expect(f.execute).not.toHaveBeenCalled();
});
it("WFREV-05 missing exact grant denies revocation", async () => {
  transaction([[]]);
  expect(await port().revoke(token, grantId, operationId, "yes")).toEqual({
    kind: "denied",
  });
});
it.each([
  "missing-intent",
  "changed-owner",
  "missing-grant",
  "changed-request",
  "changed-moderator",
])("WFREV-05 revocation discovery becoming %s denies", async (reason) => {
  transaction([
    [discovery],
    [intent],
    [],
    reason === "missing-intent"
      ? []
      : [
          {
            ...intent,
            ...(reason === "changed-owner" ? { memberId: adminId } : {}),
          },
        ],
    reason === "missing-grant"
      ? []
      : [
          {
            ...lockedGrant,
            ...(reason === "changed-request"
              ? { request: grantId }
              : reason === "changed-moderator"
                ? { moderator: adminId }
                : {}),
          },
        ],
  ]);
  expect(await port().revoke(token, grantId, operationId, "yes")).toEqual({
    kind: "denied",
  });
});
it.each(["actor", "kind", "receipt", "instruction"])(
  "WFREV-06 revoke original key changed %s conflicts",
  async (changed) => {
    const op = {
      actor: adminId,
      kind: "revoke",
      receipt: grantId,
      instruction: { grantId },
      ...(changed === "actor"
        ? { actor: moderatorId }
        : changed === "kind"
          ? { kind: "assign" }
          : changed === "receipt"
            ? { receipt: requestId }
            : { instruction: { grantId: requestId } }),
    };
    transaction([[discovery], [intent], [], [intent], [lockedGrant], [op]]);
    expect(
      await port().revoke(token, grantId, operationId, "yes"),
    ).toMatchObject({ kind: "conflict" });
  },
);
it("WFREV-06 losing global revoke reservation leaves grant unchanged", async () => {
  transaction([
    [discovery],
    [intent],
    [],
    [intent],
    [lockedGrant],
    [],
    { rows: [], rowCount: 0 },
  ]);
  expect(await port().revoke(token, grantId, operationId, "yes")).toMatchObject(
    { kind: "conflict" },
  );
});
it.each([null, createdAt])(
  "WFREV-05 deliberate revocation retains first ending timestamp %s",
  async (revoked) => {
    const results: unknown[][] = [
      [discovery],
      [intent],
      [],
      [intent],
      [{ ...lockedGrant, revoked }],
      [],
      [{}],
    ];
    if (!revoked) results.push([{ revoked: createdAt }]);
    transaction(results);
    expect(
      await port().revoke(token, grantId, operationId, "yes"),
    ).toMatchObject({
      kind: "applied",
      grant: { revokedAt: createdAt.toISOString() },
    });
  },
);
it.each([null, createdAt])(
  "WFREV-06 exact original revocation replay is metadata only %s",
  async (revoked) => {
    const t = transaction([
      [discovery],
      [intent],
      [],
      [intent],
      [{ ...lockedGrant, revoked }],
      [
        {
          actor: adminId,
          kind: "revoke",
          receipt: grantId,
          instruction: { grantId },
        },
      ],
    ]);
    expect(
      await port().revoke(token, grantId, operationId, "yes"),
    ).toMatchObject({
      kind: "replayed",
      grant: { revokedAt: revoked?.toISOString() ?? null },
    });
    expect(t.query).toHaveBeenCalledTimes(6);
  },
);
it("WFREV-06 unknown operation inspection never creates permission", async () => {
  transaction([[]]);
  expect(await port().inspect(token, operationId)).toMatchObject({
    kind: "ready",
    grant: null,
  });
  expect(f.actors).toHaveBeenCalledWith(
    expect.any(Object),
    [],
    "platform_admin",
  );
});
it.each([
  { actor: moderatorId, kind: "assign", receipt: grantId },
  { actor: adminId, kind: "assign", receipt: null },
  { actor: adminId, kind: "request", receipt: grantId },
  { actor: adminId, kind: null, receipt: grantId },
])(
  "WFREV-06 foreign/tombstoned/unrelated operation %j denies inspection",
  async (op) => {
    transaction([[op]]);
    expect(await port().inspect(token, operationId)).toEqual({
      kind: "denied",
    });
  },
);
it.each([true, false])(
  "WFREV-06 owned original inspection rechecks immutable operation same=%s",
  async (same) => {
    const op = { actor: adminId, kind: "assign", receipt: grantId };
    transaction([
      [op],
      [discovery],
      [intent],
      [source],
      [intent],
      [historical],
      [same ? op : { ...op, receipt: requestId }],
    ]);
    expect(await port().inspect(token, operationId)).toMatchObject({
      kind: same ? "ready" : "denied",
    });
  },
);
it("WFREV-07 a foreign receipt with no own action denies before source metadata", async () => {
  const t = transaction([
    [{ ...discovery, administrator: moderatorId }],
    [intent],
    [],
  ]);
  expect(await port().receipt(token, grantId)).toEqual({ kind: "denied" });
  expect(t.query).toHaveBeenCalledTimes(3);
});
it("WFREV-07 administrator's own exact revocation permits its canonical metadata receipt", async () => {
  transaction([
    [{ ...discovery, administrator: moderatorId }],
    [intent],
    [{ operation_id: operationId }],
    [source],
    [intent],
    [{ ...historical, administrator: moderatorId, revoked: createdAt }],
  ]);
  expect(await port().receipt(token, grantId)).toMatchObject({
    kind: "ready",
    grant: { grantId, state: "revoked" },
  });
});
it("WFREV-07 missing discovered canonical grant denies", async () => {
  transaction([[]]);
  expect(await port().receipt(token, grantId)).toEqual({ kind: "denied" });
});
it.each([
  "missing-intent",
  "missing-grant",
  "owner",
  "instance",
  "revision",
  "request",
  "moderator",
  "administrator",
])(
  "WFREV-07 canonical receipt's %s changing behind discovery denies",
  async (reason) => {
    const lockedIntent =
        reason === "missing-intent"
          ? []
          : [
              {
                ...intent,
                ...(reason === "owner"
                  ? { memberId: adminId }
                  : reason === "instance"
                    ? { instanceId: grantId }
                    : reason === "revision"
                      ? { revision: 2 }
                      : {}),
              },
            ],
      grant =
        reason === "missing-grant"
          ? []
          : [
              {
                ...historical,
                ...(reason === "request"
                  ? { request: grantId }
                  : reason === "moderator"
                    ? { moderator: adminId }
                    : reason === "administrator"
                      ? { administrator: moderatorId }
                      : {}),
              },
            ];
    transaction([[discovery], [intent], [source], lockedIntent, grant]);
    expect(await port().receipt(token, grantId)).toEqual({ kind: "denied" });
  },
);
it.each([
  {
    state: "revoked",
    grant: { ...historical, revoked: createdAt },
    intent,
    source,
    bundle: { version: 1 },
  },
  {
    state: "withdrawn",
    grant: historical,
    intent: { ...intent, withdrawn: createdAt },
    source,
    bundle: { version: 1 },
  },
  {
    state: "expired",
    grant: { ...historical, expired: true },
    intent,
    source,
    bundle: { version: 1 },
  },
  {
    state: "superseded",
    grant: historical,
    intent,
    source: null,
    bundle: { version: 1 },
  },
  {
    state: "superseded",
    grant: historical,
    intent,
    source: { ...source, instanceId: grantId },
    bundle: { version: 1 },
  },
  {
    state: "superseded",
    grant: historical,
    intent,
    source: { ...source, revision: 2 },
    bundle: { version: 1 },
  },
  { state: "unavailable", grant: historical, intent, source, bundle: null },
  {
    state: "unavailable",
    grant: historical,
    intent,
    source,
    bundle: { version: 2 },
  },
  {
    state: "unavailable",
    grant: { ...historical, authority: false },
    intent,
    source,
    bundle: { version: 1 },
  },
  {
    state: "scheduled",
    grant: { ...historical, scheduled: true },
    intent,
    source,
    bundle: { version: 1 },
  },
  {
    state: "recorded",
    grant: historical,
    intent,
    source,
    bundle: { version: 1 },
  },
])(
  "WFREV-04/05/07 retained receipt projects $state without asserting private reading",
  async (value) => {
    f.bundle.mockResolvedValue(value.bundle);
    transaction([
      [discovery],
      [intent],
      value.source ? [value.source] : [],
      [value.intent],
      [value.grant],
    ]);
    const result = await port().receipt(token, grantId);
    expect(result).toMatchObject({
      kind: "ready",
      grant: {
        grantId,
        state: value.state,
        revokedAt: value.grant.revoked?.toISOString() ?? null,
      },
    });
    expect(result).not.toHaveProperty("note");
  },
);
