import { expect, it } from "vitest";
import { defaultWindow, upcomingExample } from "../../src/staff-window.ts";

const now = new Date("2026-11-02T18:04:05.678Z");

it("STAFF-WINDOW-01 starts now and lasts one day when the credential allows it", () => {
  expect(defaultWindow("2026-11-09T00:00:00.000Z", now)).toEqual({
    startsAt: "2026-11-02T18:04:05.678Z",
    expiresAt: "2026-11-03T18:04:05.678Z",
  });
});
it("STAFF-WINDOW-01 never ends after the target credential's expiry", () => {
  expect(defaultWindow(new Date("2026-11-02T21:43:19.758Z"), now)).toEqual({
    startsAt: "2026-11-02T18:04:05.678Z",
    expiresAt: "2026-11-02T21:43:19.758Z",
  });
});
it("STAFF-WINDOW-02 suggests a future start on the hour", () => {
  expect(upcomingExample(now)).toBe("2026-11-03T18:00:00.000Z");
});
