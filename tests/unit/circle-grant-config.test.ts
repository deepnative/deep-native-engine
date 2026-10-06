import { expect, it } from "vitest";
import { config } from "../../src/config.ts";
const env = {
  DNE_DATABASE_URL:
    "postgresql://localhost/dne_test_0123456789abcdef0123456789abcdef",
  DNE_APP_MODE: "test",
  DNE_PORT: "0",
};
it("CIRADM-08 local circle grant writes default off, require the exact opt-in, and cannot enable live hosting", () => {
  expect(config(env).localCircleAdmin).toBe(false);
  expect(
    config({ ...env, DNE_LOCAL_CIRCLE_ADMIN: "disabled" }).localCircleAdmin,
  ).toBe(false);
  expect(
    config({ ...env, DNE_LOCAL_CIRCLE_ADMIN: "enabled" }).localCircleAdmin,
  ).toBe(true);
  for (const value of ["true", "1", "", "Enabled", "enabled "])
    expect(() => config({ ...env, DNE_LOCAL_CIRCLE_ADMIN: value })).toThrow(
      "DNE_LOCAL_CIRCLE_ADMIN must be enabled or disabled.",
    );
  expect(() =>
    config({ ...env, DNE_APP_MODE: "live", DNE_LOCAL_CIRCLE_ADMIN: "enabled" }),
  ).toThrow(
    "Live application hosting requires a separately authorized configuration.",
  );
});
