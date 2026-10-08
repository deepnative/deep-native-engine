import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  attendanceActors,
  attendanceExecute,
  attendanceSource,
  type AttendanceContext,
} from "../../src/event-attendance-transaction.ts";
const member = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  staff = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  workspace = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const now = new Date("2026-10-07T18:00:00.000Z"),
  expires = new Date(+now + 3600000);
function context() {
  const state = {
    actor: { id: member, kind: "member", expires, revoked: null } as
      | { id: string; kind: string; expires: Date; revoked: Date | null }
      | undefined,
    other: { id: staff, kind: "staff", expires, revoked: null },
    role: "platform_admin",
    otherRole: "platform_admin",
    missing: "",
    withdrawnAt: null as Date | null,
    cancelledAt: null as Date | null,
  };
  const calls: { sql: string; values?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    let rows: object[];
    if (sql.includes("FROM principals"))
      rows =
        values?.[0] === member
          ? state.actor
            ? [state.actor]
            : []
          : [state.other];
    else if (sql.includes("FROM staff_profiles"))
      rows = [
        { id: member, role: state.role },
        { id: staff, role: state.otherRole },
      ];
    else if (sql.includes('workspace_id AS "workspaceId"'))
      rows = [
        {
          workspaceId: workspace,
          eventId: "invented-rehearsal",
          eventVersion: 1,
        },
      ];
    else if (sql.includes("FROM workspaces")) rows = [{ id: workspace }];
    else if (sql.includes("FROM private_event_inventory"))
      rows = [{ title: "Invented rehearsal", startsAt: now, endsAt: expires }];
    else if (sql.includes("FROM private_event_cancellation_state"))
      rows = [{ cancelledAt: state.cancelledAt }];
    else if (sql.includes('withdrawn_at AS "withdrawnAt"'))
      rows = [{ withdrawnAt: state.withdrawnAt }];
    else throw Error("Unexpected private attendance unit query");
    if (state.missing && sql.includes(state.missing)) rows = [];
    return { rows, rowCount: rows.length };
  });
  const observe = vi.fn(async () => now);
  const ctx = {
    actorId: member,
    credentialHash: "invented-hash",
    expires: [expires],
    enteredAt: now,
    tx: { query, observe },
  } as unknown as AttendanceContext;
  return { state, calls, ctx, query, observe };
}
it("ATTEND-05 actors are locked once in sorted order before profiles and exact source ownership", async () => {
  const f = context();
  const result = await attendanceActors(
    f.ctx,
    [staff, member, staff],
    "member",
  );
  expect([...result.principals.keys()]).toEqual([member, staff]);
  expect(f.calls.slice(0, 2).map((item) => item.values?.[0])).toEqual([
    member,
    staff,
  ]);
  expect(f.calls[0]!.values?.[1]).toBe("invented-hash");
  expect(f.calls[1]!.values?.[1]).toBeNull();
  expect(f.calls[2]!.sql).toContain("ORDER BY principal_id FOR SHARE");
  expect(f.ctx.expires).toHaveLength(2);
  expect(f.observe).toHaveBeenCalledWith(f.ctx.expires);
});
it.each(["missing", "revoked", "staff", "member-as-admin", "wrong-role"])(
  "ATTEND-03/05 current actor denial %s stops before owning source",
  async (condition) => {
    const f = context();
    if (condition === "missing") f.state.actor = undefined;
    else if (condition === "revoked") f.state.actor!.revoked = now;
    else if (condition === "staff") f.state.actor!.kind = "staff";
    else if (condition === "wrong-role") {
      f.state.actor!.kind = "staff";
      f.state.role = "moderator";
    }
    await expect(
      attendanceActors(
        f.ctx,
        [],
        condition === "wrong-role" || condition === "member-as-admin"
          ? "platform_admin"
          : "member",
      ),
    ).rejects.toMatchObject({ kind: "denied" });
    expect(f.observe).not.toHaveBeenCalled();
  },
);
it("ATTEND-02 current selected platform administrator is rechecked rather than inferred from a member profile", async () => {
  const f = context();
  f.state.actor!.kind = "staff";
  expect(
    (await attendanceActors(f.ctx, [], "platform_admin")).principals.get(member)
      ?.kind,
  ).toBe("staff");
});
it("ATTEND-03/05 owning source rechecks ordered workspace, inventory, cancellation and exact registration", async () => {
  const f = context();
  f.state.withdrawnAt = now;
  f.state.cancelledAt = now;
  const result = await attendanceSource(f.ctx, staff, member);
  expect(result).toMatchObject({
    registrationId: staff,
    memberId: member,
    workspaceId: workspace,
    withdrawnAt: now,
    cancelledAt: now,
  });
  expect(
    f.calls.map(
      (item) =>
        item.sql.includes("FOR UPDATE") || item.sql.includes("FOR SHARE"),
    ),
  ).toEqual([false, true, true, true, true]);
  expect(f.calls.at(-1)?.values).toEqual([
    staff,
    member,
    workspace,
    "invented-rehearsal",
    1,
  ]);
});
it.each([
  'workspace_id AS "workspaceId"',
  "FROM workspaces",
  "FROM private_event_inventory",
  "FROM private_event_cancellation_state",
  'withdrawn_at AS "withdrawnAt"',
])(
  "ATTEND-03/05 missing current source %s denies without a private receipt",
  async (missing) => {
    const f = context();
    f.state.missing = missing;
    await expect(attendanceSource(f.ctx, staff, member)).rejects.toMatchObject({
      kind: "denied",
    });
    expect(f.observe).not.toHaveBeenCalled();
  },
);
it("ATTEND-03 invalid credential never acquires a database connection", async () => {
  const connect = vi.fn();
  expect(
    await attendanceExecute(
      { connect } as unknown as Pool,
      "invalid",
      false,
      async () => "private",
    ),
  ).toEqual({ kind: "denied" });
  expect(connect).not.toHaveBeenCalled();
});
it.each([true, false])(
  "ATTEND-05 finite credential discovery charges the original lifetime through read/write=%s handback",
  async (writing) => {
    const release = vi.fn();
    const calls: string[] = [];
    let found = true;
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        return {
          rows: sql.includes("WITH instant")
            ? [{ remaining: "60000", observed: now }]
            : sql.includes("FROM principals") && found
              ? [{ id: member, expires }]
              : [],
        };
      }),
      release,
    } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const result = await attendanceExecute(
      pool,
      "b".repeat(64),
      writing,
      async (ctx) => ({
        owner: ctx.actorId,
        entered: ctx.enteredAt,
        expiry: ctx.expires[0],
      }),
    );
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready")
      throw Error("Finite original unit result required");
    expect(result.value).toEqual({
      owner: member,
      entered: now,
      expiry: expires,
    });
    expect(result.deadline).toBeGreaterThan(performance.now());
    expect(calls.at(-1)).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
    found = false;
    expect(
      await attendanceExecute(
        pool,
        "b".repeat(64),
        writing,
        async () => "private",
      ),
    ).toEqual({ kind: "denied" });
    expect(calls.at(-1)).toBe("ROLLBACK");
  },
);
