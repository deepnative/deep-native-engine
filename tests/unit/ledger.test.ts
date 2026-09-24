import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { LedgerFailure, syntheticLedger } from "../../src/ledger.ts";

const member = "00000000-0000-4000-8000-000000000001";
const grant = "00000000-0000-4000-8000-000000000002";
const reservation = "00000000-0000-4000-8000-000000000003";
const fingerprint = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");

function database(rows: Record<string, unknown> = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT request_fingerprint"))
      return { rows: rows.event ? [rows.event] : [] };
    if (sql.includes("SELECT 1 FROM learners"))
      return { rows: rows.member === false ? [] : [{}] };
    if (sql.includes("SELECT g.available FROM synthetic_entitlement_grants"))
      return {
        rows: rows.grant === false ? [] : [{ available: rows.available ?? 4 }],
      };
    if (sql.includes("SELECT r.grant_id"))
      return {
        rows:
          rows.reservation === false
            ? []
            : [
                {
                  grant_id: grant,
                  quantity: 2,
                  state: rows.state ?? "reserved",
                },
              ],
      };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  const connect = vi.fn().mockResolvedValue(client);
  return {
    query,
    client,
    connect,
    ledger: syntheticLedger({ connect } as unknown as Pool),
  };
}

it("rejects malformed synthetic requests before any database connection", async () => {
  const db = database();
  const calls = [
    () => db.ledger.grant("bad", "coach_minutes", 1, "a"),
    () => db.ledger.grant(member, "other" as never, 1, "a"),
    () => db.ledger.grant(member, "coach_minutes", 0, "a"),
    () => db.ledger.grant(member, "coach_minutes", 1.5, "a"),
    () => db.ledger.grant(member, "coach_minutes", 100_001, "a"),
    () => db.ledger.grant(member, "coach_minutes", 1, ""),
    () => db.ledger.grant(member, "coach_minutes", 1, "a".repeat(121)),
    () => db.ledger.reserve(member, "bad", 1, "a"),
    () => db.ledger.reserve(member, grant, -1, "a"),
    () => db.ledger.consume(member, "bad", "a"),
    () => db.ledger.release("bad", reservation, "a"),
  ];
  for (const call of calls)
    await expect(call()).rejects.toMatchObject({ code: "invalid_request" });
  expect(db.connect).not.toHaveBeenCalled();
});

it("creates only an explicit, active-member synthetic grant and commits its event", async () => {
  const db = database();
  const id = await db.ledger.grant(member, "coach_minutes", 4, "fixture-grant");
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(
    db.query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO synthetic_entitlement_grants"),
    ),
  ).toBe(true);
  expect(
    db.query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO synthetic_entitlement_events"),
    ),
  ).toBe(true);
  expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  expect(db.client.release).toHaveBeenCalledOnce();
});

it("does not grant to an unavailable member and rolls back", async () => {
  const db = database({ member: false });
  await expect(
    db.ledger.grant(member, "review_minutes", 2, "no-member"),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
});

it("replays only the exact request for a key without a second mutation", async () => {
  const input = {
    operation: "grant",
    memberId: member,
    category: "coach_minutes",
    quantity: 4,
  };
  const db = database({
    event: { request_fingerprint: fingerprint(input), result_id: grant },
  });
  expect(await db.ledger.grant(member, "coach_minutes", 4, "same-key")).toBe(
    grant,
  );
  expect(
    db.query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO synthetic_entitlement_grants"),
    ),
  ).toBe(false);
  expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  await expect(
    db.ledger.grant(member, "review_minutes", 4, "same-key"),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
});

it("reserves only an available balance on the member-owned grant", async () => {
  const db = database();
  const id = await db.ledger.reserve(member, grant, 2, "reserve-key");
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(
    db.query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO synthetic_entitlement_reservations"),
    ),
  ).toBe(true);
  expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  for (const [caseName, config, code] of [
    ["missing", { grant: false }, "unavailable"],
    ["last unit", { available: 1 }, "insufficient"],
  ] as const) {
    const blocked = database(config);
    await expect(
      blocked.ledger.reserve(member, grant, 2, caseName),
    ).rejects.toMatchObject({ code });
    expect(blocked.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  }
});

it("consumes or releases only an unsettled owned reservation", async () => {
  for (const operation of ["consume", "release"] as const) {
    const db = database();
    expect(await db.ledger[operation](member, reservation, operation)).toBe(
      reservation,
    );
    expect(
      db.query.mock.calls.some(([sql]) =>
        String(sql).includes(
          operation === "consume"
            ? "consumed=consumed+$2"
            : "available=available+$2",
        ),
      ),
    ).toBe(true);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  }
  const missing = database({ reservation: false });
  await expect(
    missing.ledger.consume(member, reservation, "missing"),
  ).rejects.toMatchObject({ code: "unavailable" });
  const settled = database({ state: "released" });
  await expect(
    settled.ledger.release(member, reservation, "settled"),
  ).rejects.toMatchObject({ code: "already_settled" });
});

it("hides database failures, releases connections, and tolerates failed rollback", async () => {
  const db = database();
  db.query.mockRejectedValueOnce(new Error("synthetic-secret-marker"));
  db.query.mockRejectedValueOnce(new Error("rollback unavailable"));
  await expect(
    db.ledger.grant(member, "coach_minutes", 1, "failure"),
  ).rejects.toEqual(new LedgerFailure("unavailable"));
  expect(db.client.release).toHaveBeenCalledOnce();
  const noConnection = syntheticLedger({
    connect: vi.fn().mockRejectedValue(new Error("synthetic-secret-marker")),
  } as unknown as Pool);
  await expect(
    noConnection.grant(member, "coach_minutes", 1, "failure"),
  ).rejects.toEqual(new LedgerFailure("unavailable"));
});
