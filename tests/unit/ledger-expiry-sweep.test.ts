import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ExpirySweepFailure, syntheticLedger } from "../../src/ledger.ts";

const member = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const end = new Date("2026-02-01T00:00:00.000Z");
function fixture(state: "due" | "missing" | "future" | "expired" = "due") {
  const candidate = { id, member_id: member };
  let persisted = false;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT id,member_id")) return { rows: [candidate] };
    if (sql.includes("SELECT 1 FROM synthetic_entitlement_grants"))
      return { rows: [] };
    return { rows: [] };
  });
  const atomic = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT available,expires_at,expired_at"))
      return {
        rows:
          state === "missing"
            ? []
            : [
                {
                  available: 3,
                  expires_at: state === "future" ? new Date("2100-01-01") : end,
                  expired_at: state === "expired" ? end : null,
                },
              ],
      };
    if (sql.includes("INSERT INTO synthetic_entitlement_events"))
      persisted = true;
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query: atomic, release }));
  const ledger = syntheticLedger(
    { query, connect } as unknown as Pool,
    () => end,
  );
  return {
    ledger,
    query,
    atomic,
    connect,
    release,
    persisted: () => persisted,
  };
}
it.each([0, -1, 501, 1.5, NaN, Infinity, "1", null, undefined])(
  "rejects invalid batch size %s without reading the database",
  async (limit) => {
    const f = fixture();
    await expect(f.ledger.sweepExpired(limit as number)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(f.query).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it("reports only aggregate committed progress", async () => {
  const f = fixture();
  expect(await f.ledger.sweepExpired(1)).toEqual({
    processed: 1,
    skipped: 0,
    moreDue: false,
  });
  expect(f.persisted()).toBe(true);
});
it.each(["missing", "future", "expired"] as const)(
  "skips a %s grant without recording a new event",
  async (state) => {
    const f = fixture(state);
    expect(await f.ledger.sweepExpired(1)).toEqual({
      processed: 0,
      skipped: 1,
      moreDue: false,
    });
    expect(f.persisted()).toBe(false);
  },
);
it("reports remaining work without scanning an unbounded batch", async () => {
  const f = fixture();
  const query = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql) =>
    sql.includes("SELECT 1 FROM synthetic_entitlement_grants")
      ? { rows: [{}] as never }
      : query(sql),
  );
  expect(await f.ledger.sweepExpired(1)).toEqual({
    processed: 1,
    skipped: 0,
    moreDue: true,
  });
});
it("does not convert a database outage or write failure into a skipped candidate", async () => {
  const read = fixture();
  read.query.mockRejectedValueOnce(new Error("private-marker"));
  await expect(read.ledger.sweepExpired(1)).rejects.toEqual(
    new ExpirySweepFailure(0, 0),
  );
  const write = fixture();
  write.connect.mockRejectedValueOnce(new Error("private-marker"));
  await expect(write.ledger.sweepExpired(1)).rejects.toEqual(
    new ExpirySweepFailure(0, 0),
  );
  expect(write.persisted()).toBe(false);
});
it("retains aggregate committed/skipped progress when the final remaining-work read fails", async () => {
  for (const state of ["due", "missing"] as const) {
    const f = fixture(state);
    // Only the final read fails; selected candidates use the real expiry path.
    f.query
      .mockResolvedValueOnce({ rows: [{ id, member_id: member }] })
      .mockRejectedValueOnce(new Error("private-marker"));
    await expect(f.ledger.sweepExpired(1)).rejects.toEqual(
      new ExpirySweepFailure(
        state === "due" ? 1 : 0,
        state === "missing" ? 1 : 0,
      ),
    );
  }
});
it("fails closed if rollback cannot confirm a benign skip", async () => {
  const f = fixture("missing");
  const atomic = f.atomic.getMockImplementation()!;
  f.atomic.mockImplementation(async (sql) => {
    if (sql === "ROLLBACK") throw new Error("private-marker");
    return atomic(sql);
  });
  await expect(f.ledger.sweepExpired(1)).rejects.toEqual(
    new ExpirySweepFailure(0, 0),
  );
  expect(f.release).toHaveBeenCalledWith(true);
});
