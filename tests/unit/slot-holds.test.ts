import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { SlotHoldFailure, syntheticSlotHolds } from "../../src/slot-holds.ts";

const member = "11111111-1111-4111-8111-111111111111";
const slot = "22222222-2222-4222-8222-222222222222";
const grant = "33333333-3333-4333-8333-333333333333";
const held = "44444444-4444-4444-8444-444444444444";
const current = new Date("2026-09-27T17:00:00.000Z");
const deadline = new Date("2026-09-27T17:30:00.000Z");
const fp = (payload: unknown) =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

function database(
  result: { rows: Array<{ id: string }> } | Error = { rows: [{ id: held }] },
) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { query, pool: { query } as unknown as Pool };
}

it("validates every identifier, key, clock and explicit deadline before querying", async () => {
  const db = database();
  const holds = syntheticSlotHolds(db.pool, () => current);
  for (const call of [
    () => holds.hold("bad", slot, grant, "key", deadline),
    () => holds.hold(null as never, slot, grant, "key", deadline),
    () => holds.hold(member, "bad", grant, "key", deadline),
    () => holds.hold(member, slot, "bad", "key", deadline),
    () => holds.hold(member, slot, grant, "", deadline),
    () => holds.hold(member, slot, grant, null as never, deadline),
    () => holds.hold(member, slot, grant, "a".repeat(121), deadline),
    () => holds.hold(member, slot, grant, "key", null as never),
    () => holds.hold(member, slot, grant, "key", new Date("invalid")),
    () => holds.hold(member, slot, grant, "key", current),
    () => holds.expire("bad", "key"),
    () => holds.expire(null as never, "key"),
    () => holds.expire(held, ""),
  ])
    await expect(call()).rejects.toMatchObject({ code: "invalid_request" });
  expect(db.query).not.toHaveBeenCalled();
  const badClock = syntheticSlotHolds(db.pool, () => new Date("invalid"));
  await expect(
    badClock.hold(member, slot, grant, "key", deadline),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(badClock.expire(held, "key")).rejects.toMatchObject({
    code: "invalid_request",
  });
  expect(new SlotHoldFailure("unavailable").message).toContain("unavailable");
});

it("passes canonical fingerprints and explicit UTC instants to the atomic database functions", async () => {
  const db = database();
  const holds = syntheticSlotHolds(db.pool, () => current);
  expect(await holds.hold(member, slot, grant, "hold-key", deadline)).toBe(
    held,
  );
  expect(db.query.mock.calls[0]![0]).toContain("synthetic_hold_slot");
  expect(db.query.mock.calls[0]![1]).toEqual([
    member,
    slot,
    grant,
    "hold-key",
    fp({
      operation: "slot_hold",
      memberId: member,
      slotId: slot,
      grantId: grant,
      quantity: 60,
      deadline: deadline.toISOString(),
    }),
    deadline,
    current,
  ]);
  expect(await holds.expire(held, "expire-key")).toBe(held);
  expect(db.query.mock.calls[1]![0]).toContain("synthetic_expire_slot_hold");
  expect(db.query.mock.calls[1]![1]).toEqual([
    held,
    "expire-key",
    fp({ operation: "slot_expire", holdId: held }),
    current,
  ]);
  const defaultClock = syntheticSlotHolds(db.pool);
  expect(
    await defaultClock.hold(
      member,
      slot,
      grant,
      "default-clock",
      new Date(Date.now() + 3600_000),
    ),
  ).toBe(held);
});

it("maps transaction failures to bounded codes without exposing database detail", async () => {
  const cases = [
    ["DN001", "invalid_request"],
    ["DN002", "unavailable"],
    ["DN003", "insufficient"],
    ["DN004", "already_settled"],
    ["DN005", "idempotency_conflict"],
    ["23505", "unavailable"],
  ] as const;
  for (const [dbCode, expected] of cases) {
    const error = Object.assign(new Error("private database detail"), {
      code: dbCode,
    });
    const holds = syntheticSlotHolds(database(error).pool, () => current);
    await expect(
      holds.hold(member, slot, grant, "key", deadline),
    ).rejects.toMatchObject({ code: expected });
    await expect(holds.expire(held, "key")).rejects.toMatchObject({
      code: expected,
    });
  }
  for (const error of [new Error("private detail"), null, "private detail"]) {
    const db = database();
    db.query.mockRejectedValueOnce(error);
    await expect(
      syntheticSlotHolds(db.pool, () => current).hold(
        member,
        slot,
        grant,
        "key",
        deadline,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
  }
  const empty = syntheticSlotHolds(database({ rows: [] }).pool, () => current);
  await expect(
    empty.hold(member, slot, grant, "key", deadline),
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(empty.expire(held, "key")).rejects.toMatchObject({
    code: "unavailable",
  });
});
