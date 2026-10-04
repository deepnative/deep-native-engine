import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  disabledEventEnrollmentStore,
  eventEnrollmentStore,
  type EventEnrollmentReceipt,
  type EventEnrollmentStore,
} from "../../src/event-enrollments.ts";
import type { EventPreview } from "../../src/events.ts";
const id = "00000000-0000-4000-8000-000000000001";
const event: EventPreview = {
  id: "rehearsal",
  version: 1,
  status: "current",
  title: "Invented event",
  description: "Local sample",
  agenda: [],
  goals: ["everyday"],
  domainTags: [],
  itRoles: [],
  startsAt: "2100-01-01T12:00:00.000Z",
  endsAt: "2100-01-01T13:00:00.000Z",
  fixtureCapacity: 2,
  localRegistration: true,
};
const receipt: EventEnrollmentReceipt = {
  id,
  eventId: event.id,
  eventVersion: 1,
  title: event.title,
  startsAt: new Date(event.startsAt),
  endsAt: new Date(event.endsAt),
  createdAt: new Date("2029-01-01"),
  withdrawnAt: null,
};
const inventory = {
  title: event.title,
  startsAt: receipt.startsAt,
  endsAt: receipt.endsAt,
  capacity: 2,
};
function fixture(
  options: {
    mode?: "demo" | "test" | "live";
    enabled?: boolean;
    catalog?: readonly EventPreview[];
    principal?: boolean;
    workspace?: boolean;
    valid?: boolean;
    future?: boolean;
    inventory?: Partial<typeof inventory> | null;
    prior?: EventEnrollmentReceipt | null;
    active?: string;
    seats?: number[];
    history?: EventEnrollmentReceipt[];
    current?: { withdrawn_at: Date | null } | null;
    failAt?: string;
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (options.failAt && sql.includes(options.failAt))
      throw Error("Private database diagnostic");
    if (sql.startsWith("SELECT id,expires_at"))
      return {
        rows:
          options.principal === false
            ? []
            : [{ id: "owner", expires_at: new Date("2100-12-01") }],
      };
    if (sql.startsWith("SELECT id FROM workspaces"))
      return {
        rows: options.workspace === false ? [] : [{ id: "owned-workspace" }],
      };
    if (sql.includes("AS valid"))
      return {
        rows: [
          {
            valid: options.valid !== false,
            remaining: "60000",
            observed: new Date(),
          },
        ],
      };
    if (sql.includes("AS future"))
      return { rows: [{ future: options.future !== false }] };
    if (sql.startsWith("SELECT title,starts_at"))
      return {
        rows:
          options.inventory === null
            ? []
            : [{ ...inventory, ...options.inventory }],
      };
    if (sql.startsWith("SELECT seat_number"))
      return {
        rows: (options.seats ?? []).map((seat_number) => ({ seat_number })),
      };
    if (sql.includes("SELECT id FROM private_event_enrollments"))
      return { rows: options.active ? [{ id: options.active }] : [] };
    if (sql.startsWith("SELECT withdrawn_at"))
      return {
        rows:
          options.current === null
            ? []
            : [options.current ?? { withdrawn_at: null }],
      };
    if (sql.includes("ORDER BY e.id LIMIT 21"))
      return { rows: options.history ?? [] };
    if (sql.startsWith("SELECT e.id,"))
      return { rows: options.prior ? [options.prior] : [] };
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn(),
    connect = vi.fn(async () => ({ query, release }));
  const store = eventEnrollmentStore({ connect } as unknown as Pool, {
    mode: options.mode ?? "test",
    enabled: options.enabled ?? true,
    catalog: options.catalog ?? [event],
  });
  return { store, connect, query, release };
}
const operations = {
  preview: (s: EventEnrollmentStore, token = "owner-token") =>
    s.preview(token, event.id, 1),
  enroll: (s: EventEnrollmentStore, token = "owner-token") =>
    s.enroll(token, event.id, 1, id),
  receipt: (s: EventEnrollmentStore, token = "owner-token") =>
    s.receipt(token, id),
  history: (s: EventEnrollmentStore, token = "owner-token") => s.history(token),
  withdraw: (s: EventEnrollmentStore, token = "owner-token") =>
    s.withdraw(token, id),
};
const denied = (operation: keyof typeof operations) =>
  operation === "enroll"
    ? { kind: "unavailable" }
    : operation === "withdraw"
      ? "unavailable"
      : null;
it("keeps disabled and live stores inert for every operation", async () => {
  const live = fixture({ mode: "live" });
  for (const [name, call] of Object.entries(operations)) {
    expect(await call(disabledEventEnrollmentStore())).toEqual(
      denied(name as keyof typeof operations),
    );
    expect(await call(live.store)).toEqual(
      denied(name as keyof typeof operations),
    );
  }
  expect(live.connect).not.toHaveBeenCalled();
});
it("rejects malformed identifiers, versions, cursors and tokens before acquisition", async () => {
  const f = fixture();
  for (const version of [0, -1, 1.1, NaN, 1000001]) {
    expect(await f.store.preview("token", event.id, version)).toBeNull();
    expect(await f.store.enroll("token", event.id, version, id)).toEqual({
      kind: "unavailable",
    });
  }
  for (const invalid of ["", "UPPER", "x".repeat(81), "<script>"]) {
    expect(await f.store.preview("token", invalid, 1)).toBeNull();
    expect(await f.store.enroll("token", invalid, 1, id)).toEqual({
      kind: "unavailable",
    });
  }
  expect(await f.store.preview("token", "unknown", 1)).toBeNull();
  expect(await f.store.enroll("token", event.id, 1, "bad")).toEqual({
    kind: "unavailable",
  });
  expect(await f.store.receipt("token", "bad")).toBeNull();
  expect(await f.store.history("token", "bad")).toBeNull();
  expect(await f.store.withdraw("token", "bad")).toBe("unavailable");
  for (const call of Object.values(operations)) {
    await call(f.store, " ");
    await call(f.store, null as unknown as string);
  }
  expect(f.connect).not.toHaveBeenCalled();
});
it.each(Object.keys(operations) as (keyof typeof operations)[])(
  "denies %s without a current principal, workspace or valid DB observation",
  async (name) => {
    for (const options of [
      { principal: false },
      { workspace: false },
      { valid: false },
    ]) {
      const f = fixture(options);
      expect(await operations[name](f.store)).toEqual(denied(name));
      expect(f.query.mock.calls.flat()).not.toContain("COMMIT");
      expect(f.release).toHaveBeenCalledWith(expect.any(Error));
    }
  },
);
it("uses current authority and owned state for a nonbinding availability snapshot", async () => {
  const f = fixture({ active: id, seats: [1] });
  expect(await f.store.preview("token", event.id, 1)).toEqual({
    event,
    canEnroll: true,
    remaining: 1,
    activeReceiptId: id,
  });
  expect(f.query).toHaveBeenCalledWith(
    expect.stringContaining("owner_principal_id=$1"),
    ["owner"],
  );
  expect(f.query).toHaveBeenCalledWith(
    expect.stringContaining("workspace_id=$2"),
    ["owner", "owned-workspace", event.id, 1],
  );
  expect(
    await fixture({ inventory: null }).store.preview("token", event.id, 1),
  ).toMatchObject({ canEnroll: true, remaining: 2, activeReceiptId: null });
  for (const options of [
    { enabled: false },
    { future: false },
    { inventory: { title: "Changed" } },
  ])
    expect(
      await fixture(options).store.preview("token", event.id, 1),
    ).toMatchObject({ canEnroll: false, remaining: null });
});
it("refuses paused, absent, retired and non-opted-in new registrations", async () => {
  for (const options of [
    { enabled: false },
    { catalog: [] },
    { catalog: [{ ...event, status: "retired" as const }] },
    { catalog: [{ ...event, localRegistration: false }] },
  ]) {
    const f = fixture(options);
    expect(await f.store.enroll("token", event.id, 1, id)).toEqual({
      kind: "unavailable",
    });
    expect(
      f.query.mock.calls.some(([sql]) =>
        sql.startsWith("INSERT INTO private_event_inventory"),
      ),
    ).toBe(false);
  }
});
it("reconciles exact original attempts and denies their reuse for a different version", async () => {
  expect(
    await fixture({ prior: receipt, enabled: false }).store.enroll(
      "token",
      event.id,
      1,
      id,
    ),
  ).toEqual({ kind: "replayed", receiptId: id });
  for (const prior of [
    { ...receipt, eventVersion: 2 },
    { ...receipt, eventId: "other-event" },
  ])
    expect(
      await fixture({ prior }).store.enroll("token", event.id, 1, id),
    ).toEqual({ kind: "conflict" });
  expect(
    await fixture({ active: id }).store.enroll("token", event.id, 1, id),
  ).toEqual({ kind: "already-enrolled", receiptId: id });
});
it("pins complete immutable inventory before choosing a bounded free seat", async () => {
  for (const changed of [
    null,
    { title: "other" },
    { capacity: 1 },
    { startsAt: new Date("2099-01-01") },
    { endsAt: new Date("2099-01-01") },
  ])
    expect(
      await fixture({ inventory: changed }).store.enroll(
        "token",
        event.id,
        1,
        id,
      ),
    ).toEqual({ kind: "unavailable" });
  const f = fixture({ seats: [1], mode: "demo" });
  expect(await f.store.enroll("token", event.id, 1, id)).toEqual({
    kind: "enrolled",
    receiptId: id,
  });
  expect(f.query).toHaveBeenCalledWith(
    expect.stringContaining("INSERT INTO private_event_enrollments"),
    [id, "owner", "owned-workspace", event.id, 1, 2, 2],
  );
  expect(
    await fixture({ seats: [1, 2] }).store.enroll("token", event.id, 1, id),
  ).toEqual({ kind: "full" });
});
it("withholds corrupt or uncertain seat state rather than inventing availability", async () => {
  for (const seats of [[0], [3], [1, 2, 3]]) {
    const f = fixture({ seats });
    await expect(f.store.enroll("token", event.id, 1, id)).rejects.toThrow(
      /^Private event registration unavailable$/,
    );
    expect(
      f.query.mock.calls.some(([sql]) =>
        sql.startsWith("INSERT INTO private_event_enrollments"),
      ),
    ).toBe(false);
  }
  for (const failAt of [
    "SELECT id,expires_at",
    "INSERT INTO private_event_enrollments",
    "COMMIT",
  ])
    await expect(
      fixture({ failAt }).store.enroll("token", event.id, 1, id),
    ).rejects.toThrow(/^Private event registration unavailable$/);
});
it("reads only owned receipts and limits history to twenty with continuation", async () => {
  expect(await fixture({ prior: receipt }).store.receipt("token", id)).toEqual(
    receipt,
  );
  expect(await fixture().store.receipt("token", id)).toBeNull();
  const rows = Array.from({ length: 21 }, (_, i) => ({
    ...receipt,
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  }));
  const f = fixture({ history: rows });
  expect(await f.store.history("token", id)).toEqual({
    items: rows.slice(0, 20),
    nextCursor: rows[19]!.id,
  });
  expect(f.query).toHaveBeenCalledWith(
    expect.stringContaining("ORDER BY e.id LIMIT 21"),
    ["owner", "owned-workspace", id],
  );
  expect(await fixture().store.history("token")).toEqual({
    items: [],
    nextCursor: null,
  });
});
it("withdraws only an owned exact attempt, preserving terminal state on replay", async () => {
  expect(await fixture().store.withdraw("token", id)).toBe("unavailable");
  expect(
    await fixture({ prior: receipt, current: null }).store.withdraw(
      "token",
      id,
    ),
  ).toBe("unavailable");
  const done = fixture({
    prior: receipt,
    current: { withdrawn_at: new Date() },
  });
  expect(await done.store.withdraw("token", id)).toBe("already-withdrawn");
  expect(
    done.query.mock.calls.some(([sql]) =>
      sql.startsWith("UPDATE private_event_enrollments"),
    ),
  ).toBe(false);
  const f = fixture({ prior: receipt, enabled: false });
  expect(await f.store.withdraw("token", id)).toBe("withdrawn");
  expect(f.query).toHaveBeenCalledWith(
    expect.stringContaining("UPDATE private_event_enrollments"),
    [id],
  );
});
