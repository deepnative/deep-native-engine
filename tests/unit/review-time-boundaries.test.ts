import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { reviewTimeStore } from "../../src/review-time-store.ts";
import { reviewTimeGrants } from "../../src/review-time-grants.ts";
import { reviewIntervalMinutes } from "../../src/review-time.ts";
const id = "11111111-1111-4111-8111-111111111111",
  token = "a".repeat(64);
const start = new Date("2026-10-04T12:00:00Z"),
  end = new Date("2026-10-04T12:10:00Z");
const intervals = {
  reviewStart: start,
  reviewEnd: end,
  preparationStart: null,
  preparationEnd: null,
};
it("counts adjacent whole-minute work and preparation without double-counting", () => {
  expect(reviewIntervalMinutes(intervals)).toEqual({
    review: 10,
    preparation: 0,
  });
  expect(
    reviewIntervalMinutes({
      ...intervals,
      preparationStart: new Date(+start - 300000),
      preparationEnd: start,
    }),
  ).toEqual({ review: 10, preparation: 5 });
  expect(
    reviewIntervalMinutes({
      ...intervals,
      preparationStart: end,
      preparationEnd: new Date(+end + 300000),
    }),
  ).toEqual({ review: 10, preparation: 5 });
});
it.each([
  { reviewEnd: start },
  { reviewStart: end },
  { reviewEnd: new Date(+end + 1000) },
  { reviewStart: new Date(NaN) },
  { reviewEnd: new Date(NaN) },
  { preparationStart: start },
  { preparationEnd: end },
  { preparationStart: start, preparationEnd: end },
  {
    preparationStart: new Date(+start - 60000),
    preparationEnd: new Date(+start + 60000),
  },
  { reviewEnd: new Date(+start + 121 * 60000) },
])("rejects invalid or overlapping effort intervals %j", (change) => {
  expect(reviewIntervalMinutes({ ...intervals, ...change })).toBeNull();
});
it("rejects malformed owner operations before acquiring a database connection", async () => {
  const connect = vi.fn(() => {
    throw Error("must not connect");
  });
  const store = reviewTimeStore({ connect } as unknown as Pool, {
    enabled: true,
    mode: "test",
  });
  for (const invalid of ["", "not-a-uuid"]) {
    expect((await store.allocate(token, invalid, id, 20)).kind).toBe("denied");
    expect((await store.allocate(token, id, invalid, 20)).kind).toBe("denied");
    expect((await store.receipt(token, invalid)).kind).toBe("denied");
    expect((await store.cancel(token, invalid)).kind).toBe("denied");
    expect((await store.history(token, invalid)).kind).toBe("denied");
  }
  for (const ceiling of [0, -1, 121, 1.5, NaN, Infinity])
    expect((await store.allocate(token, id, id, ceiling)).kind).toBe("denied");
  expect((await store.history("invalid-token")).kind).toBe("denied");
  expect(connect).not.toHaveBeenCalled();
});
it.each([
  { enabled: false, mode: "test" as const },
  { enabled: true, mode: "live" as const },
])(
  "refuses new work under paused or live configuration %j",
  async (options) => {
    const connect = vi.fn(() => {
      throw Error("must not connect");
    });
    const pool = { connect } as unknown as Pool;
    expect(
      (await reviewTimeStore(pool, options).allocate(token, id, id, 20)).kind,
    ).toBe("unavailable");
    expect(
      (
        await reviewTimeGrants(pool, options).grant(
          token,
          id,
          id,
          start,
          end,
          id,
        )
      ).kind,
    ).toBe("unavailable");
    expect(connect).not.toHaveBeenCalled();
  },
);
it("rejects malformed grant authority and time windows before connecting", async () => {
  const connect = vi.fn(() => {
    throw Error("must not connect");
  });
  const grants = reviewTimeGrants({ connect } as unknown as Pool, {
    enabled: true,
    mode: "test",
  });
  expect((await grants.grant("invalid", id, id, start, end, id)).kind).toBe(
    "denied",
  );
  for (const args of [
    ["bad", id, id],
    [id, "bad", id],
    [id, id, "bad"],
  ])
    expect(
      (await grants.grant(token, args[0]!, args[1]!, start, end, args[2]!))
        .kind,
    ).toBe("denied");
  for (const [a, b] of [
    [new Date(NaN), end],
    [start, new Date(NaN)],
    [end, start],
    [start, start],
  ])
    expect((await grants.grant(token, id, id, a!, b!, id)).kind).toBe("denied");
  expect((await grants.revoke("invalid", id)).kind).toBe("denied");
  expect((await grants.revoke(token, "invalid")).kind).toBe("denied");
  expect(connect).not.toHaveBeenCalled();
});
it("withholds owner and administrator operations on connection failure without leaking diagnostics", async () => {
  const connect = vi
    .fn()
    .mockRejectedValue(Error("private database diagnostic"));
  const pool = { connect } as unknown as Pool;
  const owned = reviewTimeStore(pool, { enabled: true, mode: "test" }),
    grants = reviewTimeGrants(pool, { enabled: true, mode: "test" });
  for (const response of [
    await owned.allocate(token, id, id, 20),
    await owned.receipt(token, id),
    await owned.cancel(token, id),
    await owned.history(token),
    await grants.grant(token, id, id, start, end, id),
    await grants.revoke(token, id),
  ])
    expect(response).toEqual({ kind: "unavailable" });
});
