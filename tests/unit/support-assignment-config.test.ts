import { expect, it } from "vitest";
import { config } from "../../src/config.ts";
const env = {
  DNE_DATABASE_URL:
    "postgresql://localhost/dne_test_0123456789abcdef0123456789abcdef",
  DNE_APP_MODE: "test",
  DNE_PORT: "0",
};
it("SUPADM-08-READS-ROLLBACK browser support administration is explicitly enabled and defaults off", () => {
  expect(config(env).localSupportAssignment).toBe(false);
  expect(
    config({ ...env, DNE_LOCAL_SUPPORT_ASSIGNMENT: "disabled" })
      .localSupportAssignment,
  ).toBe(false);
  expect(
    config({ ...env, DNE_LOCAL_SUPPORT_ASSIGNMENT: "enabled" })
      .localSupportAssignment,
  ).toBe(true);
  for (const value of ["", "true", "ENABLED", "enabled "])
    expect(() =>
      config({ ...env, DNE_LOCAL_SUPPORT_ASSIGNMENT: value }),
    ).toThrow("DNE_LOCAL_SUPPORT_ASSIGNMENT must be enabled or disabled.");
  expect(() =>
    config({
      ...env,
      DNE_APP_MODE: "live",
      DNE_LOCAL_SUPPORT_ASSIGNMENT: "enabled",
    }),
  ).toThrow(
    "Live application hosting requires a separately authorized configuration.",
  );
});
