import { expect, it } from "vitest";
import { config } from "../../src/config.ts";

const hosted = {
  DNE_PUBLIC_ORIGIN: "https://engine.deepnative.io",
  DNE_DATABASE_URL:
    "postgresql://app:unit-only@deepnative.postgres.database.azure.com/deepnative?sslmode=verify-full",
  DNE_AZURE_BLOB_ACCOUNT_URL: "https://deepnative.blob.core.windows.net",
  DNE_AZURE_BLOB_CONTAINER: "private-evidence",
  DNE_AZURE_MANAGED_IDENTITY_CLIENT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

it("HOSTED-01 admits an explicitly configured HTTPS application with verified-TLS PostgreSQL and private managed storage", () => {
  const settings = config(hosted);
  expect(settings.origin).toBe("https://engine.deepnative.io");
  expect(settings.databaseUrl).toBe(hosted.DNE_DATABASE_URL);
  expect(settings).toHaveProperty(
    "hosted.blobAccountUrl",
    hosted.DNE_AZURE_BLOB_ACCOUNT_URL,
  );
  expect(settings).toHaveProperty("hosted.blobContainer", "private-evidence");
  expect(settings).toHaveProperty(
    "hosted.managedIdentityClientId",
    hosted.DNE_AZURE_MANAGED_IDENTITY_CLIENT_ID,
  );
});

it("HOSTED-01 retains local defaults and the existing provider refusal", () => {
  const local = config({ DNE_DATABASE_URL: "postgresql://localhost/dne_demo" });
  expect(local.hosted).toBeUndefined();
  expect(local.origin).toBe("http://127.0.0.1:3000");
  expect(() => config({ DNE_DATABASE_URL: hosted.DNE_DATABASE_URL })).toThrow(
    "loopback",
  );
  expect(() => config({ ...hosted, DNE_APP_MODE: "live" })).toThrow(
    "Live application hosting",
  );
});

it.each([
  "",
  "not a URL",
  "http://engine.deepnative.io",
  "https://engine.deepnative.io/",
  "https://engine.deepnative.io/path",
  "https://engine.deepnative.io?q=1",
  "https://engine.deepnative.io#fragment",
  "https://user:password@engine.deepnative.io",
  "https://engine.deepnative.io:8443",
  "https://localhost",
  "https://127.0.0.1",
  "https://[::1]",
  "https://a.localhost",
  "https://.",
  "https://-invalid.example",
])(
  "HOSTED-01 rejects a noncanonical or nonpublic HTTPS origin: %s",
  (origin) => {
    expect(() => config({ ...hosted, DNE_PUBLIC_ORIGIN: origin })).toThrow();
  },
);

it("HOSTED-01 refuses public impersonation", () => {
  expect(() => config({ ...hosted, DNE_DEMO_IMPERSONATION: "true" })).toThrow();
});

it.each([
  "DNE_AZURE_BLOB_ACCOUNT_URL",
  "DNE_AZURE_BLOB_CONTAINER",
  "DNE_AZURE_MANAGED_IDENTITY_CLIENT_ID",
])("HOSTED-01 refuses incomplete managed storage: %s", (key) => {
  expect(() => config({ ...hosted, [key]: undefined })).toThrow();
  expect(() =>
    config({
      DNE_DATABASE_URL: "postgresql://localhost/dne_demo",
      [key]: hosted[key as keyof typeof hosted],
    }),
  ).toThrow();
});

it.each([
  ["DNE_AZURE_BLOB_ACCOUNT_URL", "http://deepnative.blob.core.windows.net"],
  [
    "DNE_AZURE_BLOB_ACCOUNT_URL",
    "https://deepnative.blob.core.windows.net?sig=private",
  ],
  ["DNE_AZURE_BLOB_ACCOUNT_URL", "https://attacker.example"],
  ["DNE_AZURE_BLOB_CONTAINER", ""],
  ["DNE_AZURE_BLOB_CONTAINER", "a"],
  ["DNE_AZURE_BLOB_CONTAINER", "a--private"],
  ["DNE_AZURE_BLOB_CONTAINER", "../private"],
  ["DNE_AZURE_MANAGED_IDENTITY_CLIENT_ID", "not-an-identity"],
])("HOSTED-01 rejects invalid %s without exposing its value", (key, value) => {
  expect(() => config({ ...hosted, [key]: value })).toThrow(
    "Hosted application configuration is incomplete or invalid.",
  );
});

it.each([
  "https://app:password@db.example/deepnative?sslmode=verify-full",
  "postgresql://app:password@db.example/deepnative?sslmode=verify-full#fragment",
  "postgresql://db.example/deepnative?sslmode=verify-full",
  "postgresql://app@db.example/deepnative?sslmode=verify-full",
  "postgresql://app:password@db.example/deepnative",
  "postgresql://app:password@db.example/deepnative?sslmode=require",
  "postgresql://app:password@db.example/deepnative?sslcert=unexpected",
  "postgresql://app:password@db.example/deepnative?sslmode=verify-full&sslmode=disable",
  "postgresql://app:password@db.example/?sslmode=verify-full",
  "postgresql://app:password@db.example/dne_demo?sslmode=verify-full",
  "postgresql://app:password@localhost/deepnative?sslmode=verify-full",
])(
  "HOSTED-01 rejects missing TLS validation or cross-environment databases %#",
  (database) => {
    expect(() => config({ ...hosted, DNE_DATABASE_URL: database })).toThrow();
  },
);

it("HOSTED-01 keeps hosted-mode test databases isolated to generated loopback names", () => {
  const testDatabase =
    "postgresql://app:unit-only@127.0.0.1/dne_test_0123456789abcdef0123456789abcdef?sslmode=verify-full";
  expect(
    config({ ...hosted, DNE_APP_MODE: "test", DNE_DATABASE_URL: testDatabase })
      .origin,
  ).toBe(hosted.DNE_PUBLIC_ORIGIN);
  for (const database of [
    hosted.DNE_DATABASE_URL,
    "postgresql://app:unit-only@127.0.0.1/dne_demo?sslmode=verify-full",
  ])
    expect(() =>
      config({ ...hosted, DNE_APP_MODE: "test", DNE_DATABASE_URL: database }),
    ).toThrow();
});

it("HOSTED-11 accepts only explicit passwordless managed-identity database authentication", () => {
  const passwordless = {
    ...hosted,
    DNE_DATABASE_AUTH: "managed-identity",
    DNE_DATABASE_URL:
      "postgresql://dne_engine@pg-deepnative.postgres.database.azure.com/deepnative?sslmode=verify-full",
  };
  expect(config(passwordless)).toHaveProperty(
    "hosted.databaseAuthentication",
    "managed-identity",
  );
  for (const overrides of [
    { DNE_DATABASE_AUTH: "typo" },
    { DNE_DATABASE_URL: hosted.DNE_DATABASE_URL },
    { DNE_PUBLIC_ORIGIN: undefined },
    {
      DNE_DATABASE_URL:
        "postgresql://dne_engine@attacker.example/deepnative?sslmode=verify-full",
    },
    {
      DNE_DATABASE_URL:
        "postgresql://dne_engine@pg-deepnative.postgres.database.azure.com/deepnative?sslmode=require",
    },
  ])
    expect(() => config({ ...passwordless, ...overrides })).toThrow();
});
