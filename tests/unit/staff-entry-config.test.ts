import { expect, it } from "vitest";
import { config } from "../../src/config.ts";
const env = {
  DNE_DATABASE_URL:
    "postgresql://localhost/dne_test_0123456789abcdef0123456789abcdef",
  DNE_APP_MODE: "test",
  DNE_PORT: "0",
};
it("STAFF-05-OFF local staff entry requires explicit enabled configuration and rejects ambiguous settings", () => {
  expect(config(env).localStaffEntry).toBe(false);
  expect(
    config({ ...env, DNE_LOCAL_STAFF_ENTRY: "disabled" }).localStaffEntry,
  ).toBe(false);
  expect(
    config({ ...env, DNE_LOCAL_STAFF_ENTRY: "enabled" }).localStaffEntry,
  ).toBe(true);
  for (const value of ["true", "1", "", "Enabled"])
    expect(() => config({ ...env, DNE_LOCAL_STAFF_ENTRY: value })).toThrow(
      "DNE_LOCAL_STAFF_ENTRY must be enabled or disabled.",
    );
  expect(() =>
    config({ ...env, DNE_APP_MODE: "live", DNE_LOCAL_STAFF_ENTRY: "enabled" }),
  ).toThrow("Live application hosting");
});
