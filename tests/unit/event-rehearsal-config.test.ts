import { expect, it } from "vitest";
import { config } from "../../src/config.ts";
const env = {
  DNE_DATABASE_URL:
    "postgresql://localhost/dne_test_0123456789abcdef0123456789abcdef",
  DNE_APP_MODE: "test",
  DNE_PORT: "0",
};
it("REHSCHED-08 rehearsal scheduling defaults off, requires explicit opt-in and cannot enable live hosting", () => {
  expect(config(env).eventScheduling).toBe(false);
  expect(
    config({ ...env, DNE_LOCAL_EVENT_SCHEDULING: "disabled" }).eventScheduling,
  ).toBe(false);
  expect(
    config({ ...env, DNE_LOCAL_EVENT_SCHEDULING: "enabled" }).eventScheduling,
  ).toBe(true);
  for (const value of ["", "true", "1", "Enabled", "enabled "])
    expect(() => config({ ...env, DNE_LOCAL_EVENT_SCHEDULING: value })).toThrow(
      "DNE_LOCAL_EVENT_SCHEDULING must be enabled or disabled.",
    );
  expect(() =>
    config({
      ...env,
      DNE_APP_MODE: "live",
      DNE_LOCAL_EVENT_SCHEDULING: "enabled",
    }),
  ).toThrow("Live application hosting");
});
