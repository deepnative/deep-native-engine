import { expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import type { ApplicationMode } from "../../src/adapters.ts";
import {
  capacityGroup,
  decodeReviewTime,
  disabledStaffCapacityStore,
  type StaffCapacityStore,
} from "../../src/staff-capacity.ts";
import type { Store } from "../../src/store.ts";
import { disabledTrackStore } from "../../src/track-readiness.ts";
import { COOKIE } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #123 CAP-03/08/10 at the route boundary, with an invented snapshot.
const token = "a".repeat(64),
  path = "/operator/staff-capacity",
  value = {
    asOf: new Date("2026-11-08T12:00:00Z"),
    groups: [
      capacityGroup("coaching", []),
      capacityGroup("formal-review", [
        {
          service: "formal-review",
          current: true,
          verified: true,
          staffActive: true,
          backupVerified: true,
          capacityMinutes: 240,
          committedMinutes: 60,
          slotMinutes: 60,
          heldSlots: 0,
        },
      ]),
    ] as [ReturnType<typeof capacityGroup>, ReturnType<typeof capacityGroup>],
    reviewTime: decodeReviewTime({
      open: 0,
      openMinutes: "0",
      granted: 0,
      grantedMinutes: "0",
      reviewers: 0,
      unrostered: 0,
      unrosteredMinutes: "0",
      unrosteredReviewers: 0,
      waiting: 0,
      waitingMinutes: "0",
      completed: 0,
      reviewMinutes: "0",
      preparationMinutes: "0",
    }),
  };
const members = {
  session: vi.fn(async () => ({ kind: "none" })),
} as unknown as Store;
function application(
  store: StaffCapacityStore,
  mode: ApplicationMode = "test",
) {
  return app(members, {
    origin: "http://127.0.0.1:3000",
    secret: "invented-capacity-route-test",
    mode,
    tracks: disabledTrackStore(),
    staffCapacity: store,
  });
}
const read = (a: ReturnType<typeof app>, url = path) =>
  withLoopback(a, (s) =>
    request(s)
      .get(url)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );

it("CAP-03 shows declared, committed and available minutes from the snapshot", async () => {
  const snapshot = vi.fn(async () => ({ kind: "ready" as const, value }));
  const r = await read(application({ snapshot }));
  expect(r.status).toBe(200);
  expect(snapshot).toHaveBeenCalledWith(token);
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.text).toMatch(/data-field="formal-review.available">120 min/);
  expect(r.text).toMatch(/data-field="coaching.available">Not recorded/);
});

it("CAP-08 live mode refuses before reading anything", async () => {
  const snapshot = vi.fn(async () => ({ kind: "ready" as const, value }));
  const r = await read(application({ snapshot }, "live"));
  expect(r.status).toBe(404);
  expect(r.text).toContain("no live figures");
  expect(r.text).not.toMatch(/\d+ min/);
  expect(snapshot).not.toHaveBeenCalled();
});

it("CAP-08 denial and query fields show no figures", async () => {
  const snapshot = vi.fn(async () => ({ kind: "denied" as const }));
  const denied = await read(application({ snapshot }));
  expect(denied.status).toBe(403);
  expect(denied.text).not.toMatch(/\d+ min/);
  snapshot.mockClear();
  const query = await read(
    application({ snapshot }),
    `${path}?service=coaching`,
  );
  expect(query.status).toBe(400);
  expect(snapshot).not.toHaveBeenCalled();
});

it("CAP-10 an unconfirmed snapshot shows no figures", async () => {
  const r = await read(application(disabledStaffCapacityStore()));
  expect(r.status).toBe(503);
  expect(r.text).toContain("could not be confirmed");
});
