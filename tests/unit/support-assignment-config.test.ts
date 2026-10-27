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
it("SI-01 private support intake is an explicit default-off setting with strict values", () => {
  expect(config(env).privateSupportIntake).toBe(false);
  expect(
    config({ ...env, DNE_PRIVATE_SUPPORT_INTAKE: "disabled" })
      .privateSupportIntake,
  ).toBe(false);
  expect(
    config({ ...env, DNE_PRIVATE_SUPPORT_INTAKE: "enabled" })
      .privateSupportIntake,
  ).toBe(true);
  for (const value of ["", "true", "ENABLED", "enabled "])
    expect(() => config({ ...env, DNE_PRIVATE_SUPPORT_INTAKE: value })).toThrow(
      "DNE_PRIVATE_SUPPORT_INTAKE must be enabled or disabled.",
    );
});
it("SI-01 private support intake is allowed in the existing hosted configuration without enabling live providers", () => {
  const hosted = {
    DNE_PUBLIC_ORIGIN: "https://engine.deepnative.io",
    DNE_DATABASE_URL:
      "postgresql://app:unit-only@deepnative.postgres.database.azure.com/deepnative?sslmode=verify-full",
    DNE_AZURE_BLOB_ACCOUNT_URL: "https://deepnative.blob.core.windows.net",
    DNE_AZURE_BLOB_CONTAINER: "private-evidence",
    DNE_AZURE_MANAGED_IDENTITY_CLIENT_ID:
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  expect(config(hosted).privateSupportIntake).toBe(false);
  const enabled = config({ ...hosted, DNE_PRIVATE_SUPPORT_INTAKE: "enabled" });
  expect(enabled.privateSupportIntake).toBe(true);
  expect(enabled.hosted?.origin).toBe(hosted.DNE_PUBLIC_ORIGIN);
  expect(enabled.mode).toBe("demo");
});
