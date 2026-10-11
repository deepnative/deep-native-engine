import { expect, it, vi } from "vitest";
import request from "supertest";
import { config } from "../../src/config.ts";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import { STAFF_ROLES } from "../../src/authorization.ts";
import { withLoopback } from "../support/loopback-server.ts";
it("REVIEW-GRANT-05 explicitly selects disabled, enabled or recovery-only without enabling live hosting", () => {
  const env = {
    DNE_DATABASE_URL:
      "postgresql://localhost/dne_test_0123456789abcdef0123456789abcdef",
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
  };
  expect(config(env).reviewTimeGrantAdministration).toBe("disabled");
  for (const value of ["disabled", "enabled", "recovery-only"])
    expect(
      config({ ...env, DNE_REVIEW_TIME_GRANT_ADMINISTRATION: value })
        .reviewTimeGrantAdministration,
    ).toBe(value);
  for (const value of ["", "true", "1", "Enabled", "recovery"])
    expect(() =>
      config({ ...env, DNE_REVIEW_TIME_GRANT_ADMINISTRATION: value }),
    ).toThrow(
      "DNE_REVIEW_TIME_GRANT_ADMINISTRATION must be disabled, enabled or recovery-only.",
    );
});
it.each(STAFF_ROLES)(
  "REVIEW-GRANT-01 %s receives only its current tool/reference navigation, including rollback",
  async (role) => {
    const port = {
      open: vi.fn(),
      selfReference: vi.fn(),
      check: vi.fn(),
      grant: vi.fn(),
      history: vi.fn(),
      receipt: vi.fn(),
      recover: vi.fn(),
      revoke: vi.fn(),
      recoverRevoke: vi.fn(),
    };
    for (const mode of [
      "enabled",
      "recovery-only",
      "disabled",
      undefined,
    ] as const) {
      const options = {
        origin: "http://127.0.0.1:3000",
        secret: "invented",
        mode: "test" as const,
        localStaffEntry: true,
        reviewTimeGrantAdministration: mode,
        reviewTimeGrantAdmin: port,
        staffEntry: {
          admit: vi.fn(async () => ({
            kind: "ready" as const,
            role,
            deadline: performance.now() + 60000,
          })),
        },
      };
      await withLoopback(app({} as Store, options), async (server) => {
        const response = await request(server)
          .get("/staff")
          .set("Host", "127.0.0.1:3000")
          .set("Cookie", `dne_staff=${"a".repeat(64)}`)
          .expect(200);
        expect(
          response.text.includes('href="/operator/review-time-grants"'),
        ).toBe(
          role === "platform_admin" &&
            (mode === "enabled" || mode === "recovery-only"),
        );
        expect(
          response.text.includes('href="/review/review-time-reference"'),
        ).toBe(role === "reviewer" && mode === "enabled");
      });
    }
    for (const method of Object.values(port))
      expect(method).not.toHaveBeenCalled();
  },
);
it("REVIEW-GRANT-01 mounted administration uses the final bound origin and current selected credential", async () => {
  const token = "a".repeat(64);
  const port = {
    open: vi.fn(async () => ({
      kind: "ready" as const,
      creationEnabled: true,
      deadline: performance.now() + 60000,
    })),
    selfReference: vi.fn(),
    check: vi.fn(),
    grant: vi.fn(),
    history: vi.fn(),
    receipt: vi.fn(),
    recover: vi.fn(),
    revoke: vi.fn(),
    recoverRevoke: vi.fn(),
  };
  const options = {
    origin: "http://127.0.0.1:0",
    secret: "invented",
    mode: "test" as const,
    localStaffEntry: true,
    reviewTimeGrantAdministration: "enabled" as const,
    reviewTimeGrantAdmin: port,
  };
  const application = app({} as Store, options);
  options.origin = "http://127.0.0.1:4319";
  await withLoopback(application, async (server) => {
    const accepted = await request(server)
      .get("/operator/review-time-grants")
      .set("Host", "127.0.0.1:4319")
      .set("Cookie", `dne_staff=${token}`)
      .expect(200);
    expect(accepted.text).toContain("Check exact references");
    expect(port.open).toHaveBeenCalledExactlyOnceWith(token);
    await request(server)
      .get("/operator/review-time-grants")
      .set("Host", "127.0.0.1:0")
      .set("Cookie", `dne_staff=${token}`)
      .expect(403);
    expect(port.open).toHaveBeenCalledTimes(1);
  });
});
