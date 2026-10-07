import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { eventAttendanceStore } from "../../src/event-attendance.ts";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const startsAt = "2026-10-07T18:00:00.000Z",
  expiresAt = "2026-10-07T19:00:00.000Z";
const checked = {
  registrationId: id,
  administratorId: id,
  eventId: "invented-rehearsal",
  eventVersion: 1,
  title: "Invented rehearsal",
  eventStartsAt: startsAt,
  eventEndsAt: expiresAt,
  startsAt,
  expiresAt,
};
it("ATTEND-03/08 every public attendance operation denies invalid credentials without acquiring private storage", async () => {
  const connect = vi.fn();
  const port = eventAttendanceStore({ connect } as unknown as Pool, {
    mode: "test",
    enabled: true,
    registration: true,
  });
  const token = "guessed";
  const results = await Promise.all([
    port.member(token, id),
    port.history(token),
    port.inspect(token, id, "permit", checked),
    port.administrator(token),
    port.checkPermission(token, { registrationId: id, administratorId: id }),
    port.permit(token, id, checked),
    port.withdraw(token, id, id),
    port.permission(token, id),
    port.checkObservation(token, id),
    port.observe(token, id, {
      permissionId: id,
      registrationId: id,
      eventId: checked.eventId,
      eventVersion: 1,
      startsAt,
      expiresAt,
    }),
    port.checkRemoval(token, id),
    port.remove(token, id, { registrationId: id, observationId: id }),
  ]);
  expect(results).toHaveLength(12);
  expect(results.every((result) => result.kind === "denied")).toBe(true);
  expect(connect).not.toHaveBeenCalled();
});
it("ATTEND-08 runtime authority uses its captured switches rather than a subsequently mutated caller object", async () => {
  const connect = vi
    .fn()
    .mockRejectedValue(Error("Invented unavailable connection"));
  const options = { mode: "test" as const, enabled: true, registration: true };
  const port = eventAttendanceStore(
    { connect } as unknown as Pool,
    options,
    "invented-history-secret",
  );
  options.enabled = false;
  options.registration = false;
  expect(
    await port.checkPermission("b".repeat(64), {
      registrationId: id,
      administratorId: id,
    }),
  ).toEqual({ kind: "unavailable" });
  expect(connect).toHaveBeenCalledOnce();
});
