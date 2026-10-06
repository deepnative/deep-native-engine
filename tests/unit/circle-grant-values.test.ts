import { expect, it } from "vitest";
import {
  circleGrantId,
  circleGrantCircle,
  circleGrantRole,
  circleGrantUtc,
} from "../../src/circle-grant-values.ts";

it("CIRADM-01 accepts canonical exact UUID references without treating credentials or malformed values as references", () => {
  expect(circleGrantId("00000000-0000-4000-8000-000000000001")).toBe(true);
  for (const value of [
    null,
    undefined,
    42,
    "self",
    "",
    "00000000-0000-4000-7000-000000000001",
    "00000000-0000-9000-8000-000000000001",
    "00000000-0000-4000-8000-00000000000A",
    "00000000-0000-4000-8000-000000000001\n",
  ])
    expect(circleGrantId(value)).toBe(false);
});
it("CIRADM-01 accepts only current eligible moderation roles and the three existing exact circles", () => {
  for (const circle of [
    "everyday-ai",
    "professional-work",
    "technical-practice",
  ])
    expect(circleGrantCircle(circle)).toBe(true);
  for (const value of [null, 1, "EVERYDAY-AI", "everyday-ai ", "unknown"])
    expect(circleGrantCircle(value)).toBe(false);
  for (const role of ["moderator", "platform_admin"])
    expect(circleGrantRole(role)).toBe(true);
  for (const role of ["learner", "reviewer", "operator", "staff", null, {}])
    expect(circleGrantRole(role)).toBe(false);
});
it("CIRADM-02 accepts exact finite UTC milliseconds and rejects normalized, impossible or noncanonical dates", () => {
  const text = "2026-10-06T12:00:00.000Z";
  expect(circleGrantUtc(text)?.toISOString()).toBe(text);
  for (const value of [
    null,
    new Date(),
    "",
    "2026-10-06T12:00:00Z",
    "2026-10-06T12:00:00.000+00:00",
    "2026-02-30T12:00:00.000Z",
    "2026-13-01T12:00:00.000Z",
    "2026-10-06T24:00:00.000Z",
    "2026-10-06T12:00:00.000Z\n",
  ])
    expect(circleGrantUtc(value)).toBeNull();
});
