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
it("MOCK-07 practice session units default off and accept only an explicit setting", () => {
  expect(config(env).practiceSessionAllowance).toBe(false);
  expect(
    config({ ...env, DNE_PRACTICE_SESSION_ALLOWANCE: "enabled" })
      .practiceSessionAllowance,
  ).toBe(true);
  expect(() =>
    config({ ...env, DNE_PRACTICE_SESSION_ALLOWANCE: "yes" }),
  ).toThrow("DNE_PRACTICE_SESSION_ALLOWANCE must be enabled or disabled.");
  expect(() =>
    config({
      ...env,
      DNE_APP_MODE: "live",
      DNE_PRACTICE_SESSION_ALLOWANCE: "enabled",
    }),
  ).toThrow("Live application hosting");
});
