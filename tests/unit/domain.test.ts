import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../src/config.ts";
import { exercise } from "../../src/content.ts";
import { profile, submission } from "../../src/validation.ts";
import { token, csrf, validCsrf } from "../../src/session.ts";
const database = "postgresql://dne:sample@127.0.0.1:54329/dne_dev";
describe("local-only configuration", () => {
  it("uses a loopback origin and a fresh CSRF secret", () => {
    const c = config({ DNE_DATABASE_URL: database });
    expect(c.port).toBe(3000);
    expect(c.origin).toBe("http://127.0.0.1:3000");
    expect(c.secret).toHaveLength(64);
    expect(c.mode).toBe("demo");
    expect(c.adapters.every((adapter) => adapter.state === "simulated")).toBe(
      true,
    );
    expect(c.demoImpersonation).toBe(false);
    expect(c.privateStorageRoot).toContain(".dne-private");
    expect(
      config({
        DNE_DATABASE_URL: "postgres://localhost/dne_dev",
        DNE_PORT: "4000",
        DNE_DEMO_IMPERSONATION: "true",
      }),
    ).toMatchObject({ port: 4000, demoImpersonation: true });
    expect(
      config({
        DNE_DATABASE_URL: database,
        DNE_PRIVATE_STORAGE_ROOT: "/tmp/dne-private-test",
      }).privateStorageRoot,
    ).toBe(join(realpathSync("/tmp"), "dne-private-test"));
  });
  it("rejects the served public tree from another cwd and through a symlink", () => {
    const original = process.cwd();
    const temporary = mkdtempSync(join(tmpdir(), "dne-config-"));
    const publicRoot = fileURLToPath(new URL("../../public", import.meta.url));
    const alias = join(temporary, "private-alias");
    symlinkSync(publicRoot, alias);
    try {
      process.chdir(temporary);
      expect(() =>
        config({
          DNE_DATABASE_URL: database,
          DNE_PRIVATE_STORAGE_ROOT: publicRoot,
        }),
      ).toThrow("cannot be served publicly");
      expect(() =>
        config({ DNE_DATABASE_URL: database, DNE_PRIVATE_STORAGE_ROOT: alias }),
      ).toThrow("cannot be served publicly");
    } finally {
      process.chdir(original);
      rmSync(temporary, { recursive: true, force: true });
    }
  });
  it.each([
    {},
    { DNE_DATABASE_URL: "invalid" },
    { DNE_DATABASE_URL: "https://localhost/db" },
    { DNE_DATABASE_URL: "postgres://remote.invalid/db" },
    { DNE_DATABASE_URL: database + "?host=remote.invalid" },
    { DNE_DATABASE_URL: database + "?%68ost=remote.invalid&host=localhost" },
    { DNE_DATABASE_URL: database + "#fragment" },
    { DNE_DATABASE_URL: database, DNE_APP_MODE: "live" },
    {
      DNE_DATABASE_URL: "postgresql://localhost/dne_test_shared",
      DNE_APP_MODE: "test",
    },
    { DNE_DATABASE_URL: database, DNE_PRIVATE_STORAGE_ROOT: "" },
    { DNE_DATABASE_URL: database, DNE_PRIVATE_STORAGE_ROOT: "public" },
    {
      DNE_DATABASE_URL: database,
      DNE_PRIVATE_STORAGE_ROOT: "public/evidence",
    },
  ])("rejects missing, malformed or remote/overridden targets %j", (env) =>
    expect(() => config(env)).toThrow(),
  );
  it.each(["0", "-1", "65536", "1.5", "oops", ""])(
    "rejects invalid port %s",
    (port) =>
      expect(() =>
        config({ DNE_DATABASE_URL: database, DNE_PORT: port }),
      ).toThrow(),
  );
});
describe("learner inputs", () => {
  it.each(["explorer", "professional", "technical"])(
    "accepts %s without identity, job or payment fields",
    (background) =>
      expect(
        profile({ background, goal: "everyday", synthetic: "yes" }),
      ).toEqual({
        background,
        goal: "everyday",
        backgroundTags: [],
        domainTags: [],
        itRoles: [],
        experience: null,
        exploratory: false,
        timezone: null,
        weeklyMinutes: null,
      }),
  );
  it.each([
    {},
    { background: [], goal: "work", synthetic: "yes" },
    { background: "owner", goal: "work", synthetic: "yes" },
    { background: "explorer", goal: [] },
    { background: "explorer", goal: "admin", synthetic: "yes" },
    { background: "explorer", goal: "work", synthetic: "no" },
    { background: "__proto__", goal: "work", synthetic: "yes" },
  ])("rejects invalid profile %j", (body) => expect(profile(body)).toBeNull());
  it("accepts overlapping interests and an exploratory path without a work identity", () => {
    expect(
      profile({
        background: "explorer",
        goal: "work",
        synthetic: "yes",
        background_tags: ["professional", "technical"],
        domain_tags: ["education", "creative"],
        it_roles: ["security", "product"],
        experience: "some",
        exploratory: "yes",
        timezone: "America/Toronto",
        weekly_minutes: "60",
      }),
    ).toEqual({
      background: "explorer",
      goal: "work",
      backgroundTags: ["professional", "technical"],
      domainTags: ["education", "creative"],
      itRoles: ["security", "product"],
      experience: "some",
      exploratory: true,
      timezone: "America/Toronto",
      weeklyMinutes: 60,
    });
  });
  it.each([
    { background_tags: ["technical", "technical"] },
    { background_tags: "admin" },
    { background_tags: ["explorer", "professional", "technical", "explorer"] },
    { domain_tags: ["education", "unknown"] },
    { it_roles: ["software", 9] },
    { experience: "expert" },
    { experience: [] },
    { exploratory: "no" },
    { timezone: "Mars/Olympus" },
    { timezone: " America/Toronto " },
    { timezone: "x".repeat(65) },
    { timezone: 42 },
    { weekly_minutes: "0" },
    { weekly_minutes: "31" },
    { weekly_minutes: 30 },
  ])("rejects unsupported optional choices %j", (extra) =>
    expect(
      profile({
        background: "explorer",
        goal: "everyday",
        synthetic: "yes",
        ...extra,
      }),
    ).toBeNull(),
  );
  it("accepts a small weekly budget and UTC without inventing paid access", () => {
    expect(
      profile({
        background: "explorer",
        goal: "everyday",
        synthetic: "yes",
        timezone: "UTC",
        weekly_minutes: "15",
      }),
    ).toMatchObject({ timezone: "UTC", weeklyMinutes: 15 });
  });
  it("allows an unfinished draft but validates every completed answer", () => {
    expect(submission({ intent: "draft" })).toMatchObject({
      instruction: "",
      verification: "",
      complete: false,
      errors: [],
    });
    expect(submission({ intent: "complete" }).errors).toHaveLength(2);
    expect(
      submission({
        intent: "complete",
        instruction: "  " + "a".repeat(20) + "  ",
        verification: "b".repeat(20),
        checked: "yes",
      }),
    ).toMatchObject({
      instruction: "a".repeat(20),
      complete: true,
      errors: [],
    });
    expect(
      submission({ intent: "draft", instruction: [], verification: [] }).errors,
    ).toEqual([]);
  });
  it("rejects unknown actions, oversize answers and incomplete attestations", () => {
    expect(submission({}).errors).toHaveLength(1);
    expect(
      submission({ intent: "draft", instruction: "a".repeat(2001) }).errors,
    ).toHaveLength(1);
    expect(
      submission({ intent: "draft", verification: "a".repeat(1001) }).errors,
    ).toHaveLength(1);
    expect(
      submission({
        intent: "complete",
        instruction: "a".repeat(20),
        verification: "short",
        checked: "yes",
      }).errors,
    ).toHaveLength(1);
    expect(
      submission({
        intent: "complete",
        instruction: "a".repeat(2000),
        verification: "b".repeat(1000),
        checked: "yes",
      }).errors,
    ).toEqual([]);
  });
  it.each(["everyday", "work", "build"] as const)(
    "provides a useful noncoding example for %s",
    (goal) => {
      const p = exercise(goal);
      expect(p.title.length).toBeGreaterThan(10);
      expect(p.brief).toContain("Draft instructions");
      expect(p.check.length).toBeGreaterThan(40);
    },
  );
});
describe("preview tokens and CSRF", () => {
  it("preserves valid tokens and generates unpredictable replacements", () => {
    const a = token(undefined);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(token(a)).toBe(a);
    expect(token("short")).not.toBe(a);
    expect(token([])).not.toBe(a);
  });
  it("binds CSRF to both session and secret, rejecting malformed input", () => {
    const a = token(undefined),
      signed = csrf(a, "secret");
    expect(validCsrf(signed, a, "secret")).toBe(true);
    expect(validCsrf(signed, token(undefined), "secret")).toBe(false);
    expect(validCsrf(signed, a, "other")).toBe(false);
    expect(validCsrf(undefined, a, "secret")).toBe(false);
    expect(validCsrf("not-a-token", a, "secret")).toBe(false);
  });
});

it("normalizes the default HTTP port for origin checks", () => {
  expect(
    config({
      DNE_DATABASE_URL: "postgresql://127.0.0.1/dne_dev",
      DNE_PORT: "80",
    }).origin,
  ).toBe("http://127.0.0.1");
});
