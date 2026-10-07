import { expect, it } from "vitest";
import {
  attendanceId,
  attendanceScope,
  attendanceChecked,
  attendanceObservationChecked,
  attendanceRemovalChecked,
} from "../../src/event-attendance-values.ts";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const starts = "2026-10-07T18:00:00.000Z",
  ends = "2026-10-07T19:00:00.000Z";
const checked = {
  registrationId: id,
  administratorId: id,
  eventId: "invented-rehearsal",
  eventVersion: 1,
  title: "Invented private rehearsal",
  eventStartsAt: starts,
  eventEndsAt: ends,
  startsAt: starts,
  expiresAt: ends,
};
const observation = {
  permissionId: id,
  registrationId: id,
  eventId: checked.eventId,
  eventVersion: 1,
  startsAt: starts,
  expiresAt: ends,
};
it("ATTEND-01/02/04 exact canonical instructions preserve the deliberate scope", () => {
  expect(attendanceScope({ registrationId: id, administratorId: id })).toEqual({
    registrationId: id,
    administratorId: id,
  });
  expect(attendanceChecked(checked)).toEqual(checked);
  expect(attendanceObservationChecked(observation)).toEqual(observation);
  expect(
    attendanceRemovalChecked({ registrationId: id, observationId: id }),
  ).toEqual({ registrationId: id, observationId: id });
});
it.each([
  undefined,
  null,
  false,
  1,
  "reference",
  [],
  {},
  { ...checked, extra: true },
])(
  "ATTEND-01/02 exact instruction rejects ambiguous or additional fields %j",
  (input) => {
    expect(attendanceChecked(input)).toBeNull();
    expect(attendanceObservationChecked(input)).toBeNull();
    expect(attendanceRemovalChecked(input)).toBeNull();
    expect(attendanceScope(input)).toBeNull();
  },
);
it.each([undefined, 1, "", "guessed", id.toUpperCase(), id + "x"])(
  "ATTEND-01 references reject noncanonical identifiers %j",
  (input) => {
    expect(attendanceId(input)).toBe(false);
    expect(
      attendanceScope({ registrationId: input, administratorId: id }),
    ).toBeNull();
    expect(
      attendanceScope({ registrationId: id, administratorId: input }),
    ).toBeNull();
    expect(
      attendanceRemovalChecked({ registrationId: input, observationId: id }),
    ).toBeNull();
    expect(
      attendanceRemovalChecked({ registrationId: id, observationId: input }),
    ).toBeNull();
    expect(
      attendanceObservationChecked({ ...observation, permissionId: input }),
    ).toBeNull();
    expect(
      attendanceObservationChecked({ ...observation, registrationId: input }),
    ).toBeNull();
  },
);
it.each([
  ["administratorId", "guessed"],
  ["eventId", 2],
  ["eventId", "Invalid_event"],
  ["eventVersion", 1.5],
  ["eventVersion", 0],
  ["eventVersion", 1000001],
  ["title", 1],
  ["title", "   "],
  ["title", "x".repeat(1001)],
  ["eventStartsAt", 1],
  ["eventStartsAt", "y".repeat(24)],
  ["eventStartsAt", "2026-10-07T18:00:00+00:00"],
  ["eventStartsAt", "2026-10-32T18:00:00.000Z"],
  ["eventEndsAt", "wrong"],
  ["startsAt", "wrong"],
  ["expiresAt", "wrong"],
  ["startsAt", "2026-10-07T17:59:59.999Z"],
  ["expiresAt", "2026-10-07T19:00:00.001Z"],
  ["expiresAt", starts],
])(
  "ATTEND-01 permission rejects invalid %s without widening the checked window",
  (field, value) => {
    expect(
      attendanceChecked({ ...checked, [field as string]: value }),
    ).toBeNull();
  },
);
it.each([
  ["eventId", 2],
  ["eventId", "Invalid_event"],
  ["eventVersion", 1.5],
  ["eventVersion", 0],
  ["eventVersion", 1000001],
  ["startsAt", "wrong"],
  ["expiresAt", "wrong"],
  ["expiresAt", starts],
])(
  "ATTEND-02 observation rejects invalid %s rather than accepting a backdated instruction",
  (field, value) => {
    expect(
      attendanceObservationChecked({
        ...observation,
        [field as string]: value,
      }),
    ).toBeNull();
  },
);
