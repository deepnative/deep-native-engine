import { expect, it, vi } from "vitest";
import request from "supertest";
import type { Pool } from "pg";
import { app } from "../../src/app.ts";
import type { ApplicationMode } from "../../src/adapters.ts";
import {
  disabledMyStaffTimeStore,
  myStaffTime,
  myStaffTimeStore,
  type MyStaffTimeStore,
} from "../../src/my-staff-time.ts";
import {
  myStaffTimePage,
  myStaffTimeUnavailablePage,
} from "../../src/my-staff-time-views.ts";
import type { Store } from "../../src/store.ts";
import { disabledTrackStore } from "../../src/track-readiness.ts";
import { COOKIE } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #193 MYTIME with invented rows only.
const asOf = new Date("2026-11-09T12:00:00Z"),
  starts = new Date("2026-11-01T00:00:00Z"),
  ends = new Date("2026-12-01T00:00:00Z"),
  row = {
    id: "record-a",
    service: "coaching",
    domain: "education",
    startsAt: starts,
    endsAt: ends,
    current: true,
    verified: true,
    staffActive: true,
    backupVerified: true,
    capacityMinutes: 300,
    committedMinutes: 60,
    slotMinutes: "120",
    heldSlots: 0,
  },
  heldRow = {
    record: "record-a",
    startsAt: new Date("2026-11-10T15:00:00Z"),
    endsAt: new Date("2026-11-10T16:00:00Z"),
  };

it("MYTIME-01/02 a covered record keeps its held slots and room left", () => {
  const value = myStaffTime(
    asOf,
    [row, { ...row, id: "record-b", service: "formal-review" }],
    [heldRow, { ...heldRow, record: "record-elsewhere" }],
  );
  expect(value.notCurrent).toBe(0);
  expect(value.records).toEqual([
    {
      service: "coaching",
      domain: "education",
      startsAt: starts,
      endsAt: ends,
      standing: "covered",
      capacityMinutes: 300,
      committedMinutes: 60,
      slotMinutes: 120,
      held: [{ startsAt: heldRow.startsAt, endsAt: heldRow.endsAt }],
      roomMinutes: 120,
    },
    expect.objectContaining({
      service: "formal-review",
      held: [],
      roomMinutes: 120,
    }),
  ]);
});

it("MYTIME-03 records that aren't covered offer no room; lapsed ones are only counted", () => {
  const value = myStaffTime(
    asOf,
    [
      { ...row, id: "u", verified: false },
      { ...row, id: "i", staffActive: false },
      { ...row, id: "b", backupVerified: false },
      { ...row, id: "n", current: false },
      { ...row, id: "o", committedMinutes: 240 },
    ],
    [],
  );
  expect(value.notCurrent).toBe(1);
  expect(value.records.map((r) => [r.standing, r.roomMinutes])).toEqual([
    ["unverified", null],
    ["inactive", null],
    ["no_backup", null],
    ["covered", -60],
  ]);
  const html = myStaffTimePage(value);
  expect(html).toContain(
    "hasn't been verified, so it isn't qualified coverage",
  );
  expect(html).toContain("your staff access isn't current");
  expect(html).toContain("your named backup has no current verified record");
  expect(html).toMatch(/data-field="3.room">Over by 60 min/);
  expect(html).toContain("1 of your records is outside its window or retired");
  expect(myStaffTimePage({ ...value, notCurrent: 2 })).toContain(
    "2 of your records are outside their window or retired",
  );
});

it("MYTIME-01..05 the page shows times only and says queued work isn't time", () => {
  const html = myStaffTimePage(myStaffTime(asOf, [row], [heldRow]));
  expect(html).toContain("<h1>My booked time</h1>");
  expect(html).toMatch(/data-field="0.capacity">300 min/);
  expect(html).toMatch(/data-field="0.committed">60 min/);
  expect(html).toMatch(/data-field="0.slots">120 min/);
  expect(html).toMatch(/data-field="0.held">1/);
  expect(html).toMatch(/data-field="0.room">120 min/);
  expect(html).toContain(heldRow.startsAt.toISOString());
  expect(html).toContain(
    "Queued review or support requests are not available time and set no due date.",
  );
  expect(html).not.toContain("record-a");
  expect(html).not.toContain("data-not-current");
  const none = myStaffTimePage(myStaffTime(asOf, [], []));
  expect(none).toContain(
    "You have no current roster record, so nothing is bookable with you.",
  );
  expect(none).not.toMatch(/\d+ min/);
  expect(
    myStaffTimePage(myStaffTime(asOf, [{ ...row, domain: "<b>x</b>" }], [])),
  ).toContain("&lt;b&gt;x&lt;/b&gt;");
  for (const kind of ["denied", "unavailable", "live", "query"] as const)
    expect(myStaffTimeUnavailablePage(kind)).not.toMatch(/\d+ min/);
});

it("MYTIME malformed rows are refused rather than shown", () => {
  expect(() => myStaffTime(new Date(Number.NaN), [], [])).toThrow("not a time");
  expect(() => myStaffTime(asOf, [{ ...row, domain: " " }], [])).toThrow(
    "not text",
  );
  expect(() =>
    myStaffTime(asOf, [row], [{ ...heldRow, startsAt: "soon" }]),
  ).toThrow("not a time");
  expect(() => myStaffTime(asOf, [{ ...row, service: "support" }], [])).toThrow(
    "service is unknown",
  );
});

function pool(
  answer: (sql: string, values?: unknown[]) => unknown,
  release = vi.fn(),
) {
  const queries: [string, unknown[] | undefined][] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    queries.push([sql, values]);
    return answer(sql, values);
  });
  return {
    fake: { connect: async () => ({ query, release }) } as unknown as Pool,
    queries,
    release,
  };
}
const respond =
  (rows: {
    self?: unknown[];
    records?: unknown[];
    held?: unknown[];
    asOf?: unknown[];
  }) =>
  (sql: string) => {
    if (sql.includes("synthetic_slot_holds")) return { rows: rows.held ?? [] };
    if (sql.includes("FROM expert_registry e WHERE"))
      return { rows: rows.records ?? [] };
    if (sql.includes("FROM principals"))
      return { rows: rows.self ?? [{ id: "me" }] };
    if (sql.includes('now() AS "asOf"'))
      return { rows: rows.asOf ?? [{ asOf }] };
    return { rows: [] };
  };

it("MYTIME-01/06 reads one read-only snapshot for the signed-in staff member only", async () => {
  const f = pool(respond({ records: [row], held: [heldRow] }));
  const result = await myStaffTimeStore(f.fake).snapshot("a".repeat(64));
  expect(result).toMatchObject({
    kind: "ready",
    value: { asOf, records: [{ roomMinutes: 120, held: [{}] }] },
  });
  expect(f.queries[0]![0]).toBe(
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  for (const [sql, values] of f.queries.filter(([sql]) =>
    sql.includes("expert_registry"),
  )) {
    expect(sql).toContain("e.staff_id=$1");
    expect(values).toEqual(["me"]);
  }
  expect(f.queries.at(-1)![0]).toBe("ROLLBACK");
  expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
});

it("MYTIME-05 a malformed token or non-staff session is refused before any record is read", async () => {
  const connect = vi.fn();
  expect(
    await myStaffTimeStore({ connect } as unknown as Pool).snapshot("nope"),
  ).toEqual({ kind: "denied" });
  expect(connect).not.toHaveBeenCalled();
  const f = pool(respond({ self: [] }));
  expect(await myStaffTimeStore(f.fake).snapshot("b".repeat(64))).toEqual({
    kind: "denied",
  });
  expect(f.queries.some(([sql]) => sql.includes("expert_registry"))).toBe(
    false,
  );
  expect(f.queries.at(-1)![0]).toBe("ROLLBACK");
});

it("MYTIME a failed connection, read or rollback shows no figures", async () => {
  expect(
    await myStaffTimeStore({
      connect: async () => {
        throw new Error("down");
      },
    } as unknown as Pool).snapshot("c".repeat(64)),
  ).toEqual({ kind: "unavailable" });
  const missing = pool(respond({ asOf: [] }));
  expect(await myStaffTimeStore(missing.fake).snapshot("c".repeat(64))).toEqual(
    { kind: "unavailable" },
  );
  const release = vi.fn();
  const f = pool((sql) => {
    if (sql === "ROLLBACK") return Promise.reject(new Error("gone"));
    return respond({})(sql);
  }, release);
  expect(await myStaffTimeStore(f.fake).snapshot("d".repeat(64))).toEqual({
    kind: "unavailable",
  });
  expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  expect(await disabledMyStaffTimeStore().snapshot("e".repeat(64))).toEqual({
    kind: "unavailable",
  });
});

const token = "a".repeat(64),
  path = "/review/my-time",
  members = {
    session: vi.fn(async () => ({ kind: "none" })),
  } as unknown as Store;
function application(store: MyStaffTimeStore, mode: ApplicationMode = "test") {
  return app(members, {
    origin: "http://127.0.0.1:3000",
    secret: "invented-my-time-route-test",
    mode,
    tracks: disabledTrackStore(),
    myStaffTime: store,
  });
}
const read = (a: ReturnType<typeof app>, url = path) =>
  withLoopback(a, (s) =>
    request(s)
      .get(url)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );

it("MYTIME-05 the route shows the snapshot, never caches, and refuses live mode, queries and denial", async () => {
  const value = myStaffTime(asOf, [row], [heldRow]);
  const snapshot = vi.fn(async () => ({ kind: "ready" as const, value }));
  const shown = await read(application({ snapshot }));
  expect(shown.status).toBe(200);
  expect(snapshot).toHaveBeenCalledWith(token);
  expect(shown.headers["cache-control"]).toBe("no-store");
  expect(shown.text).toMatch(/data-field="0.room">120 min/);
  snapshot.mockClear();
  const live = await read(application({ snapshot }, "live"));
  expect(live.status).toBe(404);
  expect(live.text).toContain("no live figures");
  const query = await read(application({ snapshot }), `${path}?staff=other`);
  expect(query.status).toBe(400);
  expect(snapshot).not.toHaveBeenCalled();
  const denied = await read(
    application({ snapshot: async () => ({ kind: "denied" }) }),
  );
  expect(denied.status).toBe(403);
  expect(denied.headers["cache-control"]).toBe("no-store");
  expect(denied.text).not.toMatch(/\d+ min/);
  const down = await read(application(disabledMyStaffTimeStore()));
  expect(down.status).toBe(503);
  expect(down.text).toContain("could not be confirmed");
});
