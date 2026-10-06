import { expect, it } from "vitest";
import { config } from "../../src/config.ts";
const env = {
  DNE_DATABASE_URL:
    "postgresql://localhost/dne_test_0123456789abcdef0123456789abcdef",
  DNE_APP_MODE: "test",
  DNE_PORT: "0",
};
it("EVCANCEL-08 cancellation administration defaults off, requires explicit opt-in and cannot enable live hosting", () => {
  expect(config(env).localEventAdmin).toBe(false);
  expect(
    config({ ...env, DNE_LOCAL_EVENT_ADMIN: "disabled" }).localEventAdmin,
  ).toBe(false);
  expect(
    config({ ...env, DNE_LOCAL_EVENT_ADMIN: "enabled" }).localEventAdmin,
  ).toBe(true);
  for (const value of ["", "true", "1", "Enabled", "enabled "])
    expect(() => config({ ...env, DNE_LOCAL_EVENT_ADMIN: value })).toThrow(
      "DNE_LOCAL_EVENT_ADMIN must be enabled or disabled.",
    );
  expect(() =>
    config({ ...env, DNE_APP_MODE: "live", DNE_LOCAL_EVENT_ADMIN: "enabled" }),
  ).toThrow("Live application hosting");
});
