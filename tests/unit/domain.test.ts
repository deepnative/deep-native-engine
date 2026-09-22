import { describe, it, expect } from "vitest";
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
    expect(
      config({
        DNE_DATABASE_URL: "postgres://localhost/dne_dev",
        DNE_PORT: "4000",
        DNE_DEMO_IMPERSONATION: "true",
      }),
    ).toMatchObject({ port: 4000, demoImpersonation: true });
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
      ).toEqual({ background, goal: "everyday" }),
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
