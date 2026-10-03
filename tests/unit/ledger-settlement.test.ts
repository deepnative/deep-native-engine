import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import {
  LedgerFailure,
  syntheticLedger,
  type SyntheticCompletion,
} from "../../src/ledger.ts";

const member = "00000000-0000-4000-8000-000000000001";
const grant = "00000000-0000-4000-8000-000000000002";
const reservation = "00000000-0000-4000-8000-000000000003";
const completion: SyntheticCompletion = {
  reference: "synthetic:review-001",
  category: "review_minutes",
  deliveredMinutes: 20,
  preparationMinutes: 10,
};

function database(
  options: {
    missing?: boolean;
    state?: string;
    category?: string;
    quantity?: number;
    referenceUsed?: boolean;
    supportLinked?: boolean;
    event?: { request_fingerprint: string; result_id: string };
  } = {},
) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.startsWith("SELECT 1 FROM support_time_units"))
      return { rows: options.supportLinked ? [{}] : [] };
    if (sql.includes("SELECT request_fingerprint"))
      return { rows: options.event ? [options.event] : [] };
    if (sql.includes("SELECT 1 FROM synthetic_entitlement_settlements"))
      return { rows: options.referenceUsed ? [{}] : [] };
    if (sql.includes("SELECT r.grant_id"))
      return {
        rows: options.missing
          ? []
          : [
              {
                grant_id: grant,
                state: options.state ?? "reserved",
                category: options.category ?? "review_minutes",
                quantity: options.quantity ?? 30,
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
it("refuses formal completion of a reservation already belonging to a support allocation", async () => {
  const db = database({ supportLinked: true });
  await expect(
    db.ledger.settleCompletion(
      member,
      reservation,
      "foreign-domain",
      completion,
    ),
  ).rejects.toEqual(new LedgerFailure("unavailable"));
  expect(
    db.query.mock.calls.some(([sql]) =>
      sql.includes("INSERT INTO synthetic_entitlement_settlements"),
    ),
  ).toBe(false);
  expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
});

it("rejects incomplete, non-synthetic and non-whole completion payloads before connecting", async () => {
  const db = database();
  const malformed = [
    null,
    undefined,
    {},
    { ...completion, reference: "real-service-001" },
    { ...completion, reference: "synthetic:" },
    { ...completion, reference: "synthetic:private text" },
    { ...completion, reference: "synthetic:" + "a".repeat(111) },
    { ...completion, reference: 1 },
    { ...completion, category: "coach_minutes" },
    { ...completion, category: "mock_sessions" },
    { ...completion, deliveredMinutes: 0 },
    { ...completion, deliveredMinutes: 0.5 },
    { ...completion, deliveredMinutes: 100_001 },
    { ...completion, preparationMinutes: undefined },
    { ...completion, preparationMinutes: -1 },
    { ...completion, preparationMinutes: 0.5 },
    { ...completion, preparationMinutes: Number.NaN },
    { ...completion, preparationMinutes: 100_000 },
    {
      reference: "synthetic:study-001",
      category: "study_requests",
      quantity: 2,
    },
    {
      reference: "synthetic:study-001",
      category: "study_requests",
      quantity: undefined,
    },
  ];
  for (const value of malformed)
    await expect(
      db.ledger.settleCompletion(
        member,
        reservation,
        "invalid",
        value as SyntheticCompletion,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  for (const args of [
    ["bad", reservation, "invalid"],
    [member, "bad", "invalid"],
    [member, reservation, ""],
  ] as const)
    await expect(
      db.ledger.settleCompletion(args[0], args[1], args[2], completion),
    ).rejects.toMatchObject({ code: "invalid_request" });
  expect(db.connect).not.toHaveBeenCalled();
});

it.each([
  completion,
  {
    reference: "synthetic:support-001",
    category: "support_minutes",
    deliveredMinutes: 30,
    preparationMinutes: 0,
  },
  { reference: "synthetic:study-001", category: "study_requests", quantity: 1 },
] satisfies SyntheticCompletion[])(
  "records an exact synthetic completion for $category",
  async (value) => {
    const quantity = value.category === "study_requests" ? 1 : 30;
    const db = database({ category: value.category, quantity });
    const result = await db.ledger.settleCompletion(
      member,
      reservation,
      "completion",
      value,
    );
    expect(result).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(db.client.release).toHaveBeenCalledOnce();
  },
);

it.each([
  [{ missing: true }, "unavailable"],
  [{ category: "support_minutes" }, "unavailable"],
  [{ quantity: 31 }, "unavailable"],
  [{ state: "consumed" }, "already_settled"],
  [{ state: "released" }, "already_settled"],
  [{ referenceUsed: true }, "idempotency_conflict"],
] as const)(
  "rolls back an unavailable or settled reservation: %j",
  async (options, code) => {
    const db = database(options);
    await expect(
      db.ledger.settleCompletion(member, reservation, "denied", completion),
    ).rejects.toMatchObject({ code });
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(db.client.release).toHaveBeenCalledOnce();
  },
);

it("replays only the canonical exact payload and distinguishes a plain consume", async () => {
  const input = {
    operation: "consume",
    memberId: member,
    reservationId: reservation,
    completion,
  };
  const db = database({
    event: {
      request_fingerprint: createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex"),
      result_id: "original-settlement",
    },
  });
  expect(
    await db.ledger.settleCompletion(member, reservation, "replay", {
      preparationMinutes: 10,
      deliveredMinutes: 20,
      category: "review_minutes",
      reference: "synthetic:review-001",
    }),
  ).toBe("original-settlement");
  await expect(
    db.ledger.settleCompletion(member, reservation, "replay", {
      ...completion,
      preparationMinutes: 9,
    }),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(
    db.ledger.consume(member, reservation, "replay"),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(db.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});

it("captures the completion value before asynchronous work can observe caller mutation", async () => {
  const db = database();
  const value = { ...completion };
  const pending = db.ledger.settleCompletion(
    member,
    reservation,
    "captured",
    value,
  );
  value.reference = "synthetic:changed";
  await pending;
  const insert = db.query.mock.calls.find(([sql]) =>
    sql.includes("INSERT INTO synthetic_entitlement_settlements"),
  );
  expect(insert?.[1]).toContain("synthetic:review-001");
  expect(insert?.[1]).not.toContain("synthetic:changed");
});

it("maps settlement persistence and connection failures without returning diagnostics", async () => {
  const db = database();
  db.query.mockRejectedValueOnce(new Error("synthetic-sensitive-marker"));
  await expect(
    db.ledger.settleCompletion(member, reservation, "failure", completion),
  ).rejects.toEqual(new LedgerFailure("unavailable"));
  expect(db.client.release).toHaveBeenCalledOnce();
  db.connect.mockRejectedValueOnce(new Error("synthetic-sensitive-marker"));
  await expect(
    db.ledger.settleCompletion(
      member,
      reservation,
      "connect-failure",
      completion,
    ),
  ).rejects.toEqual(new LedgerFailure("unavailable"));
});
