import { expect, it } from "vitest";
import { config } from "../../src/config.ts";
const env = {
  DNE_DATABASE_URL:
    "postgresql://localhost/dne_test_0123456789abcdef0123456789abcdef",
  DNE_APP_MODE: "test",
  DNE_PORT: "0",
};
it("REVADM-06 assignment creation is explicitly enabled, defaults off and cannot enable live hosting", () => {
  expect(config(env).sampleAssignmentAdministration).toBe(false);
  expect(
    config({ ...env, DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION: "disabled" })
      .sampleAssignmentAdministration,
  ).toBe(false);
  expect(
    config({ ...env, DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION: "enabled" })
      .sampleAssignmentAdministration,
  ).toBe(true);
  for (const value of ["true", "1", "", "Enabled", "enabled "])
    expect(() =>
      config({ ...env, DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION: value }),
    ).toThrow(
      "DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION must be enabled or disabled.",
    );
  expect(() =>
    config({
      ...env,
      DNE_APP_MODE: "live",
      DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION: "enabled",
    }),
  ).toThrow(
    "Live application hosting requires a separately authorized configuration.",
  );
});
