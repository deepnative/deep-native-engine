import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { LedgerFailure, syntheticLedger } from "../../src/ledger.ts";

const member = "00000000-0000-4000-8000-000000000001";
const grant = "00000000-0000-4000-8000-000000000002";
const reservation = "00000000-0000-4000-8000-000000000003";
const window = {
  startsAt: "2020-01-01T00:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
};
const fingerprint = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");

function database(
  rows: Record<string, unknown> = {},
  now = () => new Date("2026-01-31T00:00:00.000Z"),
) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("SELECT request_fingerprint"))
      return { rows: rows.event ? [rows.event] : [] };
    if (sql.includes("SELECT 1 FROM learners"))
      return { rows: rows.member === false ? [] : [{}] };
    if (sql.includes("SELECT g.available,g.starts_at"))
      return {
        rows:
          rows.grant === false
            ? []
            : [
                {
                  available: rows.available ?? 4,
                  starts_at: rows.startsAt ?? new Date(window.startsAt),
                  expires_at: rows.expiresAt ?? new Date(window.expiresAt),
                  expired_at: rows.expiredAt ?? null,
                },
              ],
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
                  expires_at: rows.expiresAt ?? new Date(window.expiresAt),
                  expired_at: rows.expiredAt ?? null,
                },
              ],
      };
    if (sql.includes("SELECT available,expires_at,expired_at"))
      return {
        rows:
          rows.grant === false
            ? []
            : [
                {
                  available: rows.available ?? 4,
                  expires_at: rows.expiresAt ?? new Date(window.expiresAt),
                  expired_at: rows.expiredAt ?? null,
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
    ledger: syntheticLedger({ connect } as unknown as Pool, now),
  };
}

it("rejects malformed synthetic requests before any database connection", async () => {
  const db = database();
  const calls = [
    () => db.ledger.grant("bad", "coach_minutes", 1, "a", window),
    () => db.ledger.grant(member, "other" as never, 1, "a", window),
    () => db.ledger.grant(member, "coach_minutes", 0, "a", window),
    () => db.ledger.grant(member, "coach_minutes", 1.5, "a", window),
    () => db.ledger.grant(member, "coach_minutes", 100_001, "a", window),
    () => db.ledger.grant(member, "coach_minutes", 1, "", window),
    () => db.ledger.grant(member, "coach_minutes", 1, "a".repeat(121), window),
    () => db.ledger.reserve(member, "bad", 1, "a"),
    () => db.ledger.reserve(member, grant, -1, "a"),
    () => db.ledger.consume(member, "bad", "a"),
    () => db.ledger.release("bad", reservation, "a"),
    () => db.ledger.expire("bad", grant, "a"),
    () => db.ledger.expire(member, "bad", "a"),
    () => db.ledger.adjust("bad", grant, 1, "a"),
    () => db.ledger.adjust(member, "bad", 1, "a"),
    () => db.ledger.adjust(member, grant, 0, "a"),
    () => db.ledger.adjust(member, grant, 1.5, "a"),
    () =>
      db.ledger.grant(member, "coach_minutes", 1, "a", {
        ...window,
        startsAt: "bad",
      }),
    () =>
      db.ledger.grant(member, "coach_minutes", 1, "a", {
        ...window,
        expiresAt: "bad",
      }),
    () =>
      db.ledger.grant(member, "coach_minutes", 1, "a", {
        ...window,
        expiresAt: window.startsAt,
      }),
    () => db.ledger.grant(member, "coach_minutes", 1, "a", null as never),
  ];
  for (const call of calls)
    await expect(call()).rejects.toMatchObject({ code: "invalid_request" });
  expect(db.connect).not.toHaveBeenCalled();
});

it("creates only an explicit, active-member synthetic grant and commits its event", async () => {
  const db = database();
  const id = await db.ledger.grant(
    member,
    "coach_minutes",
    4,
    "fixture-grant",
    window,
  );
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
    db.ledger.grant(member, "review_minutes", 2, "no-member", window),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
});

it("replays only the exact request for a key without a second mutation", async () => {
  const input = {
    operation: "grant",
    memberId: member,
    category: "coach_minutes",
    quantity: 4,
    window,
  };
  const db = database({
    event: { request_fingerprint: fingerprint(input), result_id: grant },
  });
  expect(
    await db.ledger.grant(member, "coach_minutes", 4, "same-key", window),
  ).toBe(grant);
  expect(
    db.query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO synthetic_entitlement_grants"),
    ),
  ).toBe(false);
  expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  await expect(
    db.ledger.grant(member, "review_minutes", 4, "same-key", window),
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

it("stops reservations at the exact window boundary and expires available units once", async () => {
  const end = new Date("2026-02-28T00:00:00.000Z");
  let current = new Date("2026-02-27T23:59:59.999Z");
  const db = database({ expiresAt: end }, () => current);
  await expect(db.ledger.reserve(member, grant, 1, "before")).resolves.toMatch(
    /^[0-9a-f-]{36}$/,
  );
  current = end;
  await expect(db.ledger.reserve(member, grant, 1, "at")).rejects.toMatchObject(
    { code: "unavailable" },
  );
  expect(await db.ledger.expire(member, grant, "expiry")).toBe(grant);
  expect(
    db.query.mock.calls.some(([sql]) =>
      String(sql).includes("expired=expired+available"),
    ),
  ).toBe(true);
  const missing = database({ grant: false, expiresAt: end }, () => current);
  await expect(
    missing.ledger.expire(member, grant, "missing-expiry"),
  ).rejects.toMatchObject({ code: "unavailable" });
  const early = database(
    { expiresAt: end },
    () => new Date("2026-02-27T00:00:00.000Z"),
  );
  await expect(
    early.ledger.expire(member, grant, "early"),
  ).rejects.toMatchObject({ code: "unavailable" });
  const already = database({ expiresAt: end, expiredAt: end }, () => current);
  await expect(
    already.ledger.expire(member, grant, "already"),
  ).rejects.toMatchObject({ code: "already_settled" });
  await expect(
    already.ledger.reserve(member, grant, 1, "after-expiry"),
  ).rejects.toMatchObject({ code: "unavailable" });
  const notStarted = database({
    startsAt: new Date("2027-01-01T00:00:00.000Z"),
  });
  await expect(
    notStarted.ledger.reserve(member, grant, 1, "not-started"),
  ).rejects.toMatchObject({ code: "unavailable" });
});

it("uses the current clock when no test clock is injected", async () => {
  const db = database();
  const currentLedger = syntheticLedger({
    connect: db.connect,
  } as unknown as Pool);
  await expect(
    currentLedger.reserve(member, grant, 1, "default-clock"),
  ).resolves.toMatch(/^[0-9a-f-]{36}$/);
});

it("expires a late release while a late consume still settles reserved units", async () => {
  const end = new Date("2026-01-31T00:00:00.000Z");
  const late = database({ expiresAt: end }, () => end);
  await late.ledger.release(member, reservation, "release-after-end");
  expect(
    late.query.mock.calls.some(([sql]) =>
      String(sql).includes("expired=expired+$2"),
    ),
  ).toBe(true);
  const stamped = database({ expiredAt: end });
  await stamped.ledger.release(member, reservation, "release-after-sweep");
  expect(
    stamped.query.mock.calls.some(([sql]) =>
      String(sql).includes("expired=expired+$2"),
    ),
  ).toBe(true);
  await late.ledger.consume(member, reservation, "consume-after-end");
  expect(
    late.query.mock.calls.some(([sql]) =>
      String(sql).includes("consumed=consumed+$2"),
    ),
  ).toBe(true);
});

it("writes off only available units before expiry through an event", async () => {
  const db = database();
  expect(await db.ledger.adjust(member, grant, 2, "adjust-once")).toBe(grant);
  expect(
    db.query.mock.calls.some(([sql]) =>
      String(sql).includes("adjusted=adjusted+$2"),
    ),
  ).toBe(true);
  expect(
    db.query.mock.calls.some(
      ([sql, params]) =>
        String(sql).includes("INSERT INTO synthetic_entitlement_events") &&
        Array.isArray(params) &&
        params.includes("adjust"),
    ),
  ).toBe(true);
  const missing = database({ grant: false });
  await expect(
    missing.ledger.adjust(member, grant, 1, "missing-adjust"),
  ).rejects.toMatchObject({ code: "unavailable" });
  const short = database({ available: 1 });
  await expect(
    short.ledger.adjust(member, grant, 2, "short-adjust"),
  ).rejects.toMatchObject({ code: "insufficient" });
  const end = new Date("2026-01-31T00:00:00.000Z");
  const expired = database({ expiresAt: end }, () => end);
  await expect(
    expired.ledger.adjust(member, grant, 1, "late-adjust"),
  ).rejects.toMatchObject({ code: "unavailable" });
  const stamped = database({ expiredAt: end });
  await expect(
    stamped.ledger.adjust(member, grant, 1, "swept-adjust"),
  ).rejects.toMatchObject({ code: "unavailable" });
});

it("hides database failures, releases connections, and tolerates failed rollback", async () => {
  const db = database();
  db.query.mockRejectedValueOnce(new Error("synthetic-secret-marker"));
  db.query.mockRejectedValueOnce(new Error("rollback unavailable"));
  await expect(
    db.ledger.grant(member, "coach_minutes", 1, "failure", window),
  ).rejects.toEqual(new LedgerFailure("unavailable"));
  expect(db.client.release).toHaveBeenCalledOnce();
  const noConnection = syntheticLedger({
    connect: vi.fn().mockRejectedValue(new Error("synthetic-secret-marker")),
  } as unknown as Pool);
  await expect(
    noConnection.grant(member, "coach_minutes", 1, "failure", window),
  ).rejects.toEqual(new LedgerFailure("unavailable"));
});
