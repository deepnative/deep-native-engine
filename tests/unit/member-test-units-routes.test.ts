import { expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import { COOKIE } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
import type { ApplicationMode } from "../../src/adapters.ts";
import type {
  MemberTestUnitsStore,
  MemberTestUnitSnapshot,
} from "../../src/member-test-units.ts";
const value: MemberTestUnitSnapshot = {
  scope: "synthetic-local-preview",
  asOf: new Date("2026-10-02T12:00:00Z"),
  categories: (
    [
      ["coach_minutes", "minutes"],
      ["review_minutes", "minutes"],
      ["support_minutes", "minutes"],
      ["mock_sessions", "sessions"],
      ["study_requests", "requests"],
    ] as const
  ).map(([category, unit]) => ({
    category,
    unit,
    grants: 1,
    granted: 100,
    usable: 60,
    future: 0,
    awaitingExpiry: 0,
    held: 20,
    consumed: 10,
    expired: 5,
    adjusted: 5,
    nextExpiry: new Date("2027-01-01T00:00:00Z"),
    nextStart: null,
  })),
};
it("lets a current member inspect their own configured test-unit quantities without exposing IDs or mutating them", async () => {
  const snapshot = vi
    .fn<MemberTestUnitsStore["snapshot"]>()
    .mockResolvedValue({ kind: "ready", value });
  const application = app(
    { session: vi.fn() } as unknown as Store,
    {
      origin: "http://127.0.0.1:3000",
      secret: "synthetic-route-test",
      mode: "test",
      memberTestUnits: { snapshot },
    } as Parameters<typeof app>[1],
  );
  const response = await withLoopback(application, (server) =>
    request(server)
      .get("/member/test-units")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${"a".repeat(64)}`),
  );
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.text).toContain("Your local test units");
  expect(response.text).toContain("60");
  expect(snapshot).toHaveBeenCalledExactlyOnceWith("a".repeat(64));
});

function fixture(mode: ApplicationMode = "test") {
  const snapshot = vi
      .fn<MemberTestUnitsStore["snapshot"]>()
      .mockResolvedValue({ kind: "ready", value: structuredClone(value) }),
    session = vi.fn();
  const application = app({ session } as unknown as Store, {
    origin: "http://127.0.0.1:3000",
    secret: "synthetic-route-test",
    mode,
    memberTestUnits: { snapshot },
  });
  const get = (path = "/member/test-units", host = "127.0.0.1:3000") =>
    withLoopback(application, (server) =>
      request(server)
        .get(path)
        .set("Host", host)
        .set("Cookie", `${COOKIE}=${"a".repeat(64)}`),
    );
  return { application, snapshot, session, get };
}
it.each(["demo", "test"] as const)(
  "serves the private view in %s mode without a secondary session or settlement reader",
  async (mode) => {
    const f = fixture(mode),
      response = await f.get();
    expect(response.status).toBe(200);
    expect(response.text.match(/data-test-unit-category=/g)).toHaveLength(5);
    expect(response.text).toContain('href="/member/test-units/download"');
    expect(response.text).not.toContain("<form");
    expect(f.session).not.toHaveBeenCalled();
  },
);
it.each(["/member/test-units/download", "/member/test-units/download/"])(
  "downloads only the approved current-summary fields at %s",
  async (path) => {
    const f = fixture();
    const input = structuredClone(value) as typeof value & {
      memberId?: string;
    };
    input.memberId = "private owner marker";
    Object.assign(input.categories[0]!, {
      grantId: "private grant marker",
      prompt: "private learning text",
      nextStart: new Date("2027-01-01T00:00:00Z"),
    });
    input.categories[1]!.nextExpiry = null as unknown as Date;
    f.snapshot.mockResolvedValue({ kind: "ready", value: input });
    const response = await f.get(path);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="local-test-units.json"',
    );
    expect(response.body.asOf).toBe("2026-10-02T12:00:00.000Z");
    expect(Object.keys(response.body).sort()).toEqual([
      "asOf",
      "categories",
      "scope",
    ]);
    expect(Object.keys(response.body.categories[0]).sort()).toEqual(
      [
        "adjusted",
        "awaitingExpiry",
        "category",
        "consumed",
        "expired",
        "future",
        "granted",
        "grants",
        "held",
        "nextExpiry",
        "nextStart",
        "unit",
        "usable",
      ].sort(),
    );
    expect(response.body.categories[0]).toMatchObject({
      usable: 60,
      held: 20,
      nextStart: "2027-01-01T00:00:00.000Z",
    });
    expect(response.body.categories[1].nextExpiry).toBeNull();
    expect(response.text).not.toMatch(/private|grantId|prompt|memberId/);
    expect(f.snapshot).toHaveBeenCalledExactlyOnceWith("a".repeat(64));
  },
);
it.each(["/member/test-units", "/member/test-units/download"])(
  "makes live-mode route %s unavailable before reading synthetic state",
  async (path) => {
    const f = fixture("live"),
      response = await f.get(path);
    expect(response.status).toBe(404);
    expect(response.text).toContain("unavailable in live mode");
    expect(f.snapshot).not.toHaveBeenCalled();
  },
);
it.each([
  "?memberId=private",
  "?category=study_requests",
  "?after=a&after=b",
  "?filter[]=secret",
  "?__proto__=staff",
])(
  "rejects client-supplied scope %s without reading or echoing it",
  async (query) => {
    const f = fixture(),
      response = await f.get("/member/test-units/download" + query);
    expect(response.status).toBe(400);
    expect(response.text).toContain("does not accept query fields");
    expect(response.text).not.toContain("secret");
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(f.snapshot).not.toHaveBeenCalled();
  },
);
it.each(["denied", "unavailable"] as const)(
  "returns a safe %s view rather than zero or an attachment",
  async (kind) => {
    const f = fixture();
    f.snapshot.mockResolvedValue({ kind });
    const response = await f.get("/member/test-units/download");
    expect(response.status).toBe(kind === "denied" ? 403 : 503);
    expect(response.text).not.toContain("data-field=");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-disposition"]).toBeUndefined();
  },
);
it("contains unexpected database exceptions without exposing their text or fabricating zero", async () => {
  const f = fixture();
  f.snapshot.mockRejectedValue(Error("private DB marker"));
  const response = await f.get();
  expect(response.status).toBe(503);
  expect(response.text).not.toContain("private DB marker");
  expect(response.text).toContain("No balance was returned");
});
it("never attaches a failed download if a dependency violates its timestamp contract", async () => {
  const f = fixture();
  f.snapshot.mockResolvedValue({
    kind: "ready",
    value: { ...value, asOf: new Date(NaN) },
  });
  const response = await f.get("/member/test-units/download");
  expect(response.status).toBe(503);
  expect(response.headers["content-disposition"]).toBeUndefined();
});
it("keeps an unwired store unavailable instead of showing an invented empty allowance", async () => {
  const application = app({ session: vi.fn() } as unknown as Store, {
    origin: "http://127.0.0.1:3000",
    secret: "synthetic-route-test",
    mode: "test",
  });
  const response = await withLoopback(application, (server) =>
    request(server).get("/member/test-units").set("Host", "127.0.0.1:3000"),
  );
  expect(response.status).toBe(503);
});
it("does not read balances on a foreign host or a write method", async () => {
  const f = fixture(),
    host = await f.get("/member/test-units", "foreign.invalid");
  expect(host.status).toBe(403);
  const write = await withLoopback(f.application, (server) =>
    request(server).post("/member/test-units").set("Host", "127.0.0.1:3000"),
  );
  expect(write.status).not.toBe(200);
  expect(f.snapshot).not.toHaveBeenCalled();
});

it("TESTISSUE-08 app wiring exposes fixture navigation only from the installed private reader", async () => {
  const snapshot = vi
    .fn<MemberTestUnitsStore["snapshot"]>()
    .mockResolvedValue({ kind: "ready", value });
  const application = app({ session: vi.fn() } as unknown as Store, {
    origin: "http://127.0.0.1:3000",
    secret: "invented-fixture-wiring",
    mode: "test",
    memberTestUnits: { snapshot },
    studyUnitFixtures: {} as NonNullable<
      Parameters<typeof app>[1]["studyUnitFixtures"]
    >,
    localTestUnitIssuance: true,
  });
  const result = await withLoopback(application, (s) =>
    request(s)
      .get("/member/test-units")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${"a".repeat(64)}`)
      .expect(200),
  );
  expect(result.text).toContain('href="/member/test-unit-request"');
  expect(result.text).toContain(
    "withdrawal does not mean it elapsed naturally",
  );
  expect(snapshot).toHaveBeenCalledTimes(1);
});
