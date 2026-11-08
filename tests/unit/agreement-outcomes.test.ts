import type { Pool } from "pg";
import request from "supertest";
import { expect, it, vi } from "vitest";
import type { ApplicationMode } from "../../src/adapters.ts";
import {
  agreementGroup,
  agreementOutcomesStore,
  decodeAgreementCounts,
  disabledAgreementOutcomesStore,
  readAgreementOutcomes,
  share,
  type AgreementOutcomesStore,
} from "../../src/agreement-outcomes.ts";
import { agreementOutcomesPage } from "../../src/agreement-outcomes-views.ts";
import { app } from "../../src/app.ts";
import { COOKIE } from "../../src/session.ts";
import type { Store } from "../../src/store.ts";
import { disabledTrackStore } from "../../src/track-readiness.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #123 AGREE: course agreement outcomes, with invented counts only.
const asOf = new Date("2026-11-08T12:00:00Z"),
  offeredAt = new Date("2026-11-01T09:00:00Z"),
  acceptedAt = new Date("2026-11-02T09:00:00Z");
const row = (test: boolean, extra: Record<string, unknown> = {}) => ({
  test,
  offered: 5,
  accepted: 3,
  waiting: 1,
  withdrawn: 1,
  active: 2,
  cancelled: 1,
  firstOffered: offeredAt,
  lastOffered: offeredAt,
  firstAccepted: acceptedAt,
  lastAccepted: acceptedAt,
  ...extra,
});

function respond(rows: {
  allowed?: unknown[];
  outcomes?: unknown[];
  asOf?: unknown[];
}) {
  return async (sql: string) => {
    if (sql.includes("authorized_staff_profiles"))
      return { rows: rows.allowed ?? [{ "?column?": 1 }] };
    if (sql.includes("FROM simple_invoice_plans"))
      return { rows: rows.outcomes ?? [] };
    if (sql.includes('now() AS "asOf"'))
      return { rows: rows.asOf ?? [{ asOf }] };
    return { rows: [] };
  };
}
function pool(answer: (sql: string) => unknown, release = vi.fn()) {
  const queries: string[] = [];
  const query = vi.fn(async (sql: string) => {
    queries.push(sql);
    return answer(sql);
  });
  return {
    fake: { connect: async () => ({ query, release }) } as unknown as Pool,
    queries,
    release,
  };
}
const client = (rows: Parameters<typeof respond>[0]) => ({
  query: respond(rows) as never,
});

it("AGREE-04 a share of nothing names the empty denominator instead of 0%", () => {
  expect(share(0, 0, "No agreements offered")).toBe("No agreements offered");
  expect(share(0, 4, "None accepted")).toBe("0 of 4 (0%)");
  expect(share(2, 3, "None accepted")).toBe("2 of 3 (67%)");
});

it("AGREE-02 outcomes must partition their denominators", () => {
  const counts = decodeAgreementCounts(row(false));
  expect(agreementGroup(counts).consistent).toBe(true);
  expect(agreementGroup({ ...counts, waiting: 2 }).consistent).toBe(false);
  expect(agreementGroup({ ...counts, accepted: 2 }).consistent).toBe(false);
});

it("AGREE-01 rejects malformed counts and dates before they reach the page", () => {
  for (const bad of [
    { offered: -1 },
    { accepted: "3" },
    { waiting: 1.5 },
    { firstOffered: "2026-11-01" },
    { lastAccepted: new Date(Number.NaN) },
  ])
    expect(() => decodeAgreementCounts(row(false, bad))).toThrow(
      "Agreement outcome row invalid",
    );
});

it("AGREE-01/03 reads real and test agreements apart, empty groups as zero", async () => {
  const both = await readAgreementOutcomes(
    client({
      outcomes: [
        row(false),
        row(true, {
          offered: 1,
          accepted: 0,
          waiting: 1,
          active: 0,
          cancelled: 0,
          withdrawn: 0,
        }),
      ],
    }),
  );
  expect(both.asOf).toEqual(asOf);
  expect(both.real).toMatchObject({
    offered: 5,
    accepted: 3,
    consistent: true,
  });
  expect(both.test).toMatchObject({
    offered: 1,
    accepted: 0,
    consistent: true,
  });
  const none = await readAgreementOutcomes(client({}));
  expect(none.real).toMatchObject({
    offered: 0,
    firstOffered: null,
    consistent: true,
  });
  expect(none.test.offered).toBe(0);
});

it("AGREE-03 a duplicate or untyped group, or a missing clock, is refused", async () => {
  for (const outcomes of [
    [row(false), row(false)],
    [row(true), { ...row(true), test: "true" }],
  ])
    await expect(readAgreementOutcomes(client({ outcomes }))).rejects.toThrow(
      "Agreement outcome row invalid",
    );
  await expect(readAgreementOutcomes(client({ asOf: [] }))).rejects.toThrow(
    "Agreement outcome row missing",
  );
});

it("AGREE-03 the query counts only explicit non-test terms as real", async () => {
  const f = pool(respond({ outcomes: [row(false)] }));
  await agreementOutcomesStore(f.fake).snapshot("a".repeat(64));
  const sql = f.queries.find((q) => q.includes("FROM simple_invoice_plans"))!;
  expect(sql).toContain("terms->'sample' IS DISTINCT FROM 'false'::jsonb");
  expect(sql).not.toMatch(/recipient_|owner_id|created_by|terms->>'total/);
});

it("AGREE-06 reads one snapshot as a platform administrator, rolls back and releases", async () => {
  const f = pool(respond({ outcomes: [row(false)] }));
  const result = await agreementOutcomesStore(f.fake).snapshot("a".repeat(64));
  expect(result).toMatchObject({
    kind: "ready",
    value: { real: { offered: 5 } },
  });
  expect(f.queries[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
  expect(
    f.queries.find((q) => q.includes("authorized_staff_profiles")),
  ).toContain("s.role='platform_admin'");
  expect(f.queries.at(-1)).toBe("ROLLBACK");
  expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
});

it("AGREE-06 a malformed token is refused before connecting; other staff are denied", async () => {
  const connect = vi.fn();
  expect(
    await agreementOutcomesStore({ connect } as unknown as Pool).snapshot("x"),
  ).toEqual({ kind: "denied" });
  expect(connect).not.toHaveBeenCalled();
  const f = pool(respond({ allowed: [] }));
  expect(await agreementOutcomesStore(f.fake).snapshot("b".repeat(64))).toEqual(
    {
      kind: "denied",
    },
  );
  expect(f.queries.some((q) => q.includes("simple_invoice_plans"))).toBe(false);
  expect(f.queries.at(-1)).toBe("ROLLBACK");
});

it("AGREE-06 a failed connection, read or rollback shows no figures", async () => {
  expect(
    await agreementOutcomesStore({
      connect: async () => {
        throw new Error("down");
      },
    } as unknown as Pool).snapshot("c".repeat(64)),
  ).toEqual({ kind: "unavailable" });
  const missing = pool(respond({ asOf: [] }));
  expect(
    await agreementOutcomesStore(missing.fake).snapshot("c".repeat(64)),
  ).toEqual({ kind: "unavailable" });
  const release = vi.fn();
  const f = pool((sql) => {
    if (sql === "ROLLBACK") return Promise.reject(new Error("gone"));
    return respond({})(sql);
  }, release);
  expect(await agreementOutcomesStore(f.fake).snapshot("d".repeat(64))).toEqual(
    {
      kind: "unavailable",
    },
  );
  expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  expect(
    await disabledAgreementOutcomesStore().snapshot("e".repeat(64)),
  ).toEqual({
    kind: "unavailable",
  });
});

it("AGREE-01/02/04/05 the page shows rates over their denominators, dates and empty groups", async () => {
  const value = await readAgreementOutcomes(client({ outcomes: [row(false)] }));
  const html = agreementOutcomesPage(value);
  expect(html).toMatch(/data-field="real.offered">5</);
  expect(html).toMatch(/data-field="real.acceptance">3 of 5 \(60%\)</);
  expect(html).toMatch(/data-field="real.withdrawn">1</);
  expect(html).toMatch(/data-field="real.cancellation">1 of 3 \(33%\)</);
  expect(html).toContain(
    "Withdrawn before acceptance (still counted as offered)",
  );
  expect(html).toMatch(/data-field="test.acceptance">No agreements offered</);
  expect(html).toMatch(/data-field="test.cancellation">None accepted</);
  expect(html).toMatch(/data-field="test.firstOffered">None</);
  expect(html).toContain(`datetime="${offeredAt.toISOString()}"`);
  expect(html).toContain(`datetime="${asOf.toISOString()}"`);
  expect(html).toContain("Cancellation has no recorded date");
  expect(html).not.toContain("data-agreement-status");
  const broken = agreementOutcomesPage({
    ...value,
    real: { ...value.real, consistent: false },
  });
  expect(broken).toContain('data-agreement-status="inconsistent"');
});

const members = {
  session: vi.fn(async () => ({ kind: "none" })),
} as unknown as Store;
const path = "/operator/course-agreements",
  token = "a".repeat(64);
function application(
  store: AgreementOutcomesStore,
  mode: ApplicationMode = "test",
) {
  return app(members, {
    origin: "http://127.0.0.1:3000",
    secret: "invented-agreement-route-test",
    mode,
    tracks: disabledTrackStore(),
    agreementOutcomes: store,
  });
}
const read = (a: ReturnType<typeof app>, url = path) =>
  withLoopback(a, (s) =>
    request(s)
      .get(url)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );

it("AGREE-01/06 the route shows the snapshot without caching it", async () => {
  const value = await readAgreementOutcomes(client({ outcomes: [row(false)] }));
  const snapshot = vi.fn(async () => ({ kind: "ready" as const, value }));
  const r = await read(application({ snapshot }));
  expect(r.status).toBe(200);
  expect(snapshot).toHaveBeenCalledWith(token);
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.text).toContain("Course agreement outcomes");
});

it("AGREE-06 live mode, denial, query fields and an unconfirmed snapshot show no figures", async () => {
  const snapshot = vi.fn(async () => ({ kind: "denied" as const }));
  const live = await read(application({ snapshot }, "live"));
  expect(live.status).toBe(404);
  expect(live.text).toContain("no live figures");
  expect(snapshot).not.toHaveBeenCalled();
  const query = await read(application({ snapshot }), `${path}?group=real`);
  expect(query.status).toBe(400);
  expect(snapshot).not.toHaveBeenCalled();
  const denied = await read(application({ snapshot }));
  expect(denied.status).toBe(403);
  expect(denied.headers["cache-control"]).toBe("no-store");
  expect(denied.text).not.toMatch(/ of \d+ \(/);
  const down = await read(application(disabledAgreementOutcomesStore()));
  expect(down.status).toBe(503);
  expect(down.text).toContain("could not be confirmed");
});
