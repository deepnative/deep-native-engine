import { expect, it } from "vitest";
import { config } from "../../src/config.ts";
const env = {
  DNE_APP_MODE: "test",
  DNE_DATABASE_URL:
    "postgresql://localhost/dne_test_0123456789abcdef0123456789abcdef",
};
it("ATTEND-08 attendance is default off and accepts only explicit enabled/disabled configuration", () => {
  expect(config(env).eventAttendance).toBe(false);
  expect(
    config({ ...env, DNE_EVENT_ATTENDANCE: "disabled" }).eventAttendance,
  ).toBe(false);
  expect(
    config({ ...env, DNE_EVENT_ATTENDANCE: "enabled" }).eventAttendance,
  ).toBe(true);
  for (const value of ["yes", "", "true"])
    expect(() => config({ ...env, DNE_EVENT_ATTENDANCE: value })).toThrow(
      "DNE_EVENT_ATTENDANCE must be enabled or disabled.",
    );
});
