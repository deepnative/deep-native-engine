import { expect, it } from "vitest";
import { config } from "../../src/config.ts";
const env = {
  DNE_DATABASE_URL:
    "postgresql://localhost/dne_test_0123456789abcdef0123456789abcdef",
  DNE_APP_MODE: "test",
  DNE_PORT: "0",
};
it("TESTISSUE-08 issuance defaults off, requires explicit enablement, and cannot authorize live hosting", () => {
  expect(config(env).localTestUnitIssuance).toBe(false);
  expect(
    config({ ...env, DNE_LOCAL_TEST_UNIT_ISSUANCE: "disabled" })
      .localTestUnitIssuance,
  ).toBe(false);
  expect(
    config({ ...env, DNE_LOCAL_TEST_UNIT_ISSUANCE: "enabled" })
      .localTestUnitIssuance,
  ).toBe(true);
  for (const value of ["", "true", "1", "Enabled", "enabled "])
    expect(() =>
      config({ ...env, DNE_LOCAL_TEST_UNIT_ISSUANCE: value }),
    ).toThrow("DNE_LOCAL_TEST_UNIT_ISSUANCE must be enabled or disabled.");
  expect(() =>
    config({
      ...env,
      DNE_APP_MODE: "live",
      DNE_LOCAL_TEST_UNIT_ISSUANCE: "enabled",
    }),
  ).toThrow("Live application hosting");
});
