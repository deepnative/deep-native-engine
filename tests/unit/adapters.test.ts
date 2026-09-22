import { describe, expect, it } from "vitest";
import {
  ADAPTER_KINDS,
  adapterReadiness,
  applicationMode,
  demoImpersonation,
  deterministicAdapter,
  deterministicRegistry,
  validateDatabaseIsolation,
} from "../../src/adapters.ts";
import { syntheticSeed } from "../../src/demo-seed.ts";

describe("environment isolation", () => {
  it("defaults to demo and accepts each named mode", () => {
    expect(applicationMode(undefined)).toBe("demo");
    for (const mode of ["demo", "test", "live"])
      expect(applicationMode(mode)).toBe(mode);
    expect(() => applicationMode("production")).toThrow("DNE_APP_MODE");
  });

  it("allows explicit demo impersonation only outside live mode", () => {
    expect(demoImpersonation(undefined, "demo")).toBe(false);
    expect(demoImpersonation("false", "test")).toBe(false);
    expect(demoImpersonation("true", "demo")).toBe(true);
    expect(() => demoImpersonation("yes", "demo")).toThrow(
      "must be true or false",
    );
    expect(() => demoImpersonation("true", "live")).toThrow(
      "cannot run in live mode",
    );
  });

  it("keeps demo, random test and live database targets separate", () => {
    expect(() =>
      validateDatabaseIsolation(
        "demo",
        new URL("postgresql://localhost/dne_dev"),
      ),
    ).not.toThrow();
    expect(() =>
      validateDatabaseIsolation(
        "demo",
        new URL("postgresql://remote.invalid/dne_dev"),
      ),
    ).toThrow("Demo mode");
    expect(() =>
      validateDatabaseIsolation(
        "demo",
        new URL(
          "postgresql://localhost/dne_test_0123456789abcdef0123456789abcdef",
        ),
      ),
    ).toThrow("Demo mode");
    expect(() =>
      validateDatabaseIsolation(
        "test",
        new URL(
          "postgresql://localhost/dne_test_0123456789abcdef0123456789abcdef",
        ),
      ),
    ).not.toThrow();
    expect(() =>
      validateDatabaseIsolation(
        "test",
        new URL("postgresql://localhost/dne_test_shared"),
      ),
    ).toThrow("isolated random");
    expect(() =>
      validateDatabaseIsolation(
        "live",
        new URL("postgresql://database.internal/dne_live"),
      ),
    ).not.toThrow();
    for (const target of [
      "postgresql://localhost/dne_live",
      "postgresql://database.internal/dne_test_backup",
    ])
      expect(() => validateDatabaseIsolation("live", new URL(target))).toThrow(
        "live-only",
      );
  });
});

describe("adapter readiness", () => {
  it("uses every deterministic demo adapter without credentials", () => {
    const states = adapterReadiness({}, "demo");
    expect(states.map((state) => state.kind)).toEqual(ADAPTER_KINDS);
    expect(states.every((state) => state.state === "simulated")).toBe(true);
    expect(states.every((state) => state.message.includes("no external"))).toBe(
      true,
    );
  });

  it("disables cross-environment modes and rejects unknown modes", () => {
    const [ai] = adapterReadiness({ DNE_AI_MODE: "live" }, "demo");
    expect(ai).toMatchObject({
      kind: "ai",
      requestedMode: "live",
      state: "disabled",
      missing: [],
    });
    expect(ai!.message).toContain("disabled in demo");
    expect(() => adapterReadiness({ DNE_AI_MODE: "maybe" }, "demo")).toThrow(
      "DNE_AI_MODE",
    );
  });

  it("reports missing live settings without exposing supplied secrets", () => {
    const secret = "private-secret-value";
    const states = adapterReadiness({ DNE_LIVE_AI_API_KEY: secret }, "live");
    const ai = states.find((state) => state.kind === "ai")!;
    expect(ai.state).toBe("disabled");
    expect(ai.missing).toEqual(["DNE_LIVE_AI_ENDPOINT"]);
    expect(JSON.stringify(states)).not.toContain(secret);
  });

  it("rejects a demo/test bucket and recognizes complete live-only settings", () => {
    const env: NodeJS.ProcessEnv = {
      DNE_LIVE_AI_ENDPOINT: "https://ai.example.invalid",
      DNE_LIVE_AI_API_KEY: "ai-secret",
      DNE_LIVE_PAYMENT_ACCOUNT: "live-account",
      DNE_LIVE_PAYMENT_WEBHOOK_SECRET: "payment-secret",
      DNE_LIVE_STORAGE_BUCKET: "test-shared",
      DNE_LIVE_STORAGE_REGION: "region",
      DNE_LIVE_CALENDAR_ACCOUNT: "calendar-account",
      DNE_LIVE_CALENDAR_TOKEN: "calendar-secret",
      DNE_LIVE_EMAIL_SENDER: "noreply@example.invalid",
      DNE_LIVE_EMAIL_API_KEY: "email-secret",
      DNE_LIVE_AUTH_ISSUER: "https://auth.example.invalid",
      DNE_LIVE_AUTH_CLIENT_ID: "client-id",
      DNE_LIVE_ANALYTICS_ENDPOINT: "https://analytics.example.invalid",
      DNE_LIVE_ANALYTICS_WRITE_KEY: "analytics-secret",
    };
    const unsafe = adapterReadiness(env, "live");
    expect(unsafe.find((state) => state.kind === "storage")).toMatchObject({
      state: "disabled",
      missing: [],
    });
    env.DNE_LIVE_STORAGE_BUCKET = "live-private";
    const ready = adapterReadiness(env, "live");
    expect(ready.every((state) => state.state === "configured")).toBe(true);
    expect(JSON.stringify(ready)).not.toContain("secret");
  });
});

describe("deterministic adapter and synthetic fixtures", () => {
  it("resolves only enabled adapters for its exact demo/test mode", async () => {
    const registry = deterministicRegistry({}, "test");
    await expect(
      registry.adapter("ai", "test").execute("plan", {}),
    ).resolves.toMatchObject({ kind: "ai", mode: "test", state: "simulated" });
    expect(() => registry.adapter("ai", "live")).toThrow(
      "disabled in test application mode",
    );

    const disabled = deterministicRegistry({ DNE_AI_MODE: "live" }, "test");
    expect(() => disabled.adapter("ai", "test")).toThrow(
      "execution is disabled",
    );
  });

  it("returns the same labelled result and never claims a side effect", async () => {
    const adapter = deterministicAdapter("email", "test");
    const first = await adapter.execute("send", { template: "welcome" });
    const second = await adapter.execute("send", { template: "welcome" });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: "email",
      mode: "test",
      state: "simulated",
    });
    expect(first.reference).toMatch(/^test_[a-f0-9]{24}$/);
    expect(first.message).toContain("no external side effect");
  });

  it.each(["", "x".repeat(81)])(
    "rejects unsafe operation %j",
    async (operation) =>
      expect(
        deterministicAdapter("ai", "demo").execute(operation, {}),
      ).rejects.toThrow("between 1 and 80"),
  );

  it("contains labelled cross-audience, membership and staff states", () => {
    const seed = syntheticSeed();
    expect(seed.label).toContain("Synthetic demo data");
    expect(new Set(seed.members.map((member) => member.background))).toEqual(
      new Set(["explorer", "professional", "technical"]),
    );
    expect(seed.members.some((member) => member.goals.length > 1)).toBe(true);
    expect(new Set(seed.members.map((member) => member.membership))).toEqual(
      new Set(["foundation", "test-coaching"]),
    );
    expect(
      seed.members.every((member) =>
        member.address.endsWith("@example.invalid"),
      ),
    ).toBe(true);
    expect(new Set(seed.staff.map((person) => person.role))).toEqual(
      new Set(["coach", "reviewer", "editor", "moderator", "operator"]),
    );
    expect(
      seed.staff
        .filter((person) => person.role === "coach")
        .map((person) => person.assignment),
    ).toEqual(["assigned", "revoked"]);
  });
});
