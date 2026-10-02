import { expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import type { ApplicationMode } from "../../src/adapters.ts";
import type {
  LedgerReconciliationSnapshot,
  LedgerReconciliationStore,
} from "../../src/ledger-reconciliation.ts";
import { disabledTrackStore } from "../../src/track-readiness.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
const token = "a".repeat(64),
  secret = "synthetic-route-test",
  origin = "http://127.0.0.1:3000",
  path = "/operator/ledger-reconciliation";
const value: LedgerReconciliationSnapshot = {
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
    observed: {
      grants: 0,
      reservations: 0,
      events: 0,
      completions: 0,
      granted: 0,
      available: 0,
      reserved: 0,
      consumed: 0,
      expired: 0,
      adjusted: 0,
    },
    events: {
      grant: 0,
      reserve: 0,
      consume: 0,
      release: 0,
      expire: 0,
      adjust: 0,
    },
    completion: {
      attachedQuantity: 0,
      deliveredMinutes: 0,
      preparationMinutes: 0,
      consumedWithoutAttachment: 0,
    },
    reconciliation: {
      status: "consistent",
      grants: 0,
      reservations: 0,
      events: 0,
      completions: 0,
    },
  })),
};
function fixture(mode: ApplicationMode = "test") {
  const session = vi.fn<Store["session"]>().mockResolvedValue({ kind: "new" }),
    store = { session } as unknown as Store;
  const snapshot = vi
    .fn<LedgerReconciliationStore["snapshot"]>()
    .mockResolvedValue({ kind: "ready", value });
  const registry = vi.fn().mockResolvedValue([]);
  const application = app(store, {
    origin,
    secret,
    mode,
    ledgerReconciliation: { snapshot },
    tracks: { ...disabledTrackStore(), registry },
  });
  const get = (url = path, cookie = token, host = "127.0.0.1:3000") =>
    withLoopback(application, (server) =>
      request(server)
        .get(url)
        .set("Host", host)
        .set("Cookie", `${COOKIE}=${cookie}`),
    );
  return { get, application, snapshot, session, registry };
}
it.each(["demo", "test"] as const)(
  "serves a read-only no-store report through actual %s app middleware using only the cookie actor",
  async (mode) => {
    const f = fixture(mode),
      response = await f.get();
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.text.match(/data-ledger-category=/g)).toHaveLength(5);
    expect(response.text).toContain('datetime="2026-10-02T12:00:00.000Z"');
    expect(response.text).not.toContain(token);
    expect(response.text).not.toContain("<form");
    expect(f.snapshot).toHaveBeenCalledExactlyOnceWith(token);
    expect(f.session).not.toHaveBeenCalled();
  },
);
it("links the actual operator registry to the report without loading member state", async () => {
  const f = fixture(),
    response = await f.get("/operator/experts");
  expect(response.status).toBe(200);
  expect(response.text).toContain('href="/operator/ledger-reconciliation"');
  expect(f.registry).toHaveBeenCalledExactlyOnceWith(token);
  expect(f.session).not.toHaveBeenCalled();
  expect(f.snapshot).not.toHaveBeenCalled();
});
it("makes live mode unavailable before any synthetic lookup", async () => {
  const f = fixture("live"),
    response = await f.get();
  expect(response.status).toBe(404);
  expect(response.text).toContain("unavailable in live mode");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(f.snapshot).not.toHaveBeenCalled();
});
it.each([
  "?memberId=private",
  "?role=platform_admin",
  "?category=coach_minutes",
  "?after=a&after=b",
  "?filter[]=a",
  "?__proto__=staff",
])(
  "rejects unapproved scope %s without reading or echoing it",
  async (query) => {
    const f = fixture(),
      response = await f.get(path + query);
    expect(response.status).toBe(400);
    expect(response.text).toContain("does not accept query fields");
    expect(response.text).not.toContain("data-field=");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(f.snapshot).not.toHaveBeenCalled();
  },
);
it.each([
  ["denied", 403, "not available to this session"],
  ["unavailable", 503, "No report results are shown"],
] as const)(
  "renders %s without a partial snapshot or automatic retry",
  async (kind, status, message) => {
    const f = fixture();
    f.snapshot.mockResolvedValue({ kind });
    const response = await f.get();
    expect(response.status).toBe(status);
    expect(response.text).toContain(message);
    expect(response.text).not.toContain("data-field=");
    expect(response.text).not.toContain("<time");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(f.snapshot).toHaveBeenCalledTimes(1);
  },
);
it("suppresses database error text and allows only a later explicit fresh read to recover", async () => {
  const f = fixture();
  f.snapshot.mockRejectedValueOnce(
    new Error("PRIVATE-DB-DETAIL member-id SQL rollback uncertain"),
  );
  const failed = await f.get();
  expect(failed.status).toBe(503);
  expect(failed.text).not.toMatch(
    /PRIVATE-DB-DETAIL|member-id|SQL|rollback uncertain|data-field=/,
  );
  expect(failed.text).toContain("Nothing is retried automatically");
  expect(f.snapshot).toHaveBeenCalledTimes(1);
  expect((await f.get()).status).toBe(200);
  expect(f.snapshot).toHaveBeenCalledTimes(2);
});
it("rejects an unrecognized Host before reaching the report store", async () => {
  const f = fixture(),
    response = await f.get(path, token, "evil.invalid");
  expect(response.status).toBe(403);
  expect(response.text).toContain("Unrecognized address");
  expect(f.snapshot).not.toHaveBeenCalled();
});
it("passes a freshly generated session token for malformed cookies and never trusts the supplied actor text", async () => {
  const f = fixture();
  f.snapshot.mockResolvedValue({ kind: "denied" });
  const response = await f.get(path, "platform_admin");
  expect(response.status).toBe(403);
  expect(f.snapshot).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/^[a-f0-9]{64}$/),
  );
  expect(response.text).not.toContain("platform_admin");
});
it("provides no write route even with a valid Origin and CSRF token", async () => {
  const f = fixture();
  const response = await withLoopback(f.application, (server) =>
    request(server)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf: csrf(token, secret) }),
  );
  expect(response.status).toBe(404);
  expect(f.snapshot).not.toHaveBeenCalled();
});
