import { it, expect, vi } from "vitest";
import type { Pool } from "pg";
import {
  availabilityStore,
  disabledAvailabilityStore,
  localSlotTime,
  validSlotWindow,
} from "../../src/availability.ts";

const start = new Date("2026-11-02T15:00:00.000Z");
const end = new Date("2026-11-02T16:00:00.000Z");
const now = new Date("2026-11-01T12:00:00.000Z");
const registryId = "11111111-1111-4111-8111-111111111111";
const slotId = "22222222-2222-4222-8222-222222222222";

function database(rows: Array<unknown[]>, failure = false) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => {
    if (failure) throw new Error("private database detail");
    return { rows: rows.shift() ?? [], rowCount: 1 };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return {
    query,
    release,
    connect,
    store: availabilityStore({ query, connect } as unknown as Pool),
  };
}

it("rejects malformed, elapsed and non-hour slot windows", () => {
  expect(validSlotWindow(start, end, now)).toBe(true);
  expect(validSlotWindow(new Date("invalid"), end, now)).toBe(false);
  expect(validSlotWindow(start, new Date("invalid"), now)).toBe(false);
  expect(validSlotWindow(now, end, now)).toBe(false);
  expect(validSlotWindow(start, new Date(end.getTime() + 1), now)).toBe(false);
  expect(validSlotWindow(null as unknown as Date, end, now)).toBe(false);
  expect(validSlotWindow(start, null as unknown as Date, now)).toBe(false);
});

it("renders the repeated local hour with its actual offset and rejects invalid zones", () => {
  const first = localSlotTime(
    new Date("2026-11-01T05:30:00.000Z"),
    "America/Toronto",
  );
  const second = localSlotTime(
    new Date("2026-11-01T06:30:00.000Z"),
    "America/Toronto",
  );
  expect(first).toContain("GMT-04:00");
  expect(second).toContain("GMT-05:00");
  expect(localSlotTime(start, "not/a-zone")).toBeNull();
});

it("keeps the fallback store entirely non-authoring", async () => {
  const store = disabledAvailabilityStore();
  expect(await store.list()).toEqual([]);
  expect(await store.create("operator", registryId, start, end)).toBeNull();
  expect(await store.retire("operator", slotId)).toBe(false);
});

it("lists only database-filtered public slot metadata", async () => {
  const row = {
    id: slotId,
    domain: "education",
    serviceType: "coaching",
    startsAt: start,
    endsAt: end,
  };
  const db = database([[row]]);
  expect(await db.store.list()).toEqual([row]);
  expect(db.query.mock.calls[0]![0]).toContain("verified_at IS NOT NULL");
  expect(db.query.mock.calls[0]![0]).not.toContain("qualification_ref AS");
});

it("rejects invalid operator, registry and instant inputs before opening a transaction", async () => {
  const db = database([]);
  expect(await db.store.create("", registryId, start, end)).toBeNull();
  expect(await db.store.create("operator", "bad", start, end)).toBeNull();
  expect(await db.store.create("operator", registryId, now, end)).toBeNull();
  expect(db.connect).not.toHaveBeenCalled();
});

it("denies an ungranted operator and an absent registry row", async () => {
  const denied = database([[], [], []]);
  expect(
    await denied.store.create("operator", registryId, start, end),
  ).toBeNull();
  expect(denied.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
  const absent = database([[], [{ id: "operator-id" }], [], []]);
  expect(
    await absent.store.create("operator", registryId, start, end),
  ).toBeNull();
  expect(absent.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
});

it("refuses unverified or overlapping windows within the same serialized staff boundary", async () => {
  const prefix = [[], [{ id: "operator-id" }], [{ staff_id: "staff-id" }], []];
  const unverified = database([...prefix, [], [], []]);
  expect(
    await unverified.store.create("operator", registryId, start, end),
  ).toBeNull();
  const overlapping = database([
    ...prefix,
    [{ id: registryId }],
    [{ id: slotId }],
    [],
  ]);
  expect(
    await overlapping.store.create("operator", registryId, start, end),
  ).toBeNull();
  expect(
    overlapping.query.mock.calls.some(([sql]) =>
      String(sql).includes("pg_advisory_xact_lock"),
    ),
  ).toBe(true);
});

it("creates a verified nonoverlapping hour and rolls back on database failure", async () => {
  const accepted = database([
    [],
    [{ id: "operator-id" }],
    [{ staff_id: "staff-id" }],
    [],
    [{ id: registryId }],
    [],
    [],
    [],
  ]);
  expect(
    await accepted.store.create("operator", registryId, start, end),
  ).toMatch(/^[0-9a-f-]{36}$/);
  expect(accepted.query.mock.calls.at(-1)![0]).toBe("COMMIT");
  expect(accepted.release).toHaveBeenCalledOnce();
  const broken = database([], true);
  await expect(
    broken.store.create("operator", registryId, start, end),
  ).rejects.toThrow("private database detail");
  expect(broken.release).toHaveBeenCalledOnce();
});

it("retires only a valid slot with a current scoped operator", async () => {
  const db = database([]);
  expect(await db.store.retire("operator", slotId)).toBe(true);
  expect(db.query.mock.calls[0]![0]).toContain("sp.role IN");
  expect(await db.store.retire("", slotId)).toBe(false);
  expect(await db.store.retire("operator", "bad")).toBe(false);
  expect(db.query).toHaveBeenCalledTimes(1);
});
