import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { ObjectStorage } from "../../src/evidence.ts";
import { config } from "../../src/config.ts";
import { sampleFeedbackStore } from "../../src/sample-feedback.ts";
const database = "postgresql://dne:sample@127.0.0.1:54329/dne_dev";
it("keeps review settlement off unless explicitly enabled in local configuration", () => {
  expect(config({ DNE_DATABASE_URL: database }).reviewTimeWrites).toBe(false);
  for (const value of ["enabled", "disabled"])
    expect(
      config({ DNE_DATABASE_URL: database, DNE_REVIEW_TIME_WRITES: value })
        .reviewTimeWrites,
    ).toBe(value === "enabled");
  for (const value of ["", "true", "yes", "ENABLED"])
    expect(() =>
      config({ DNE_DATABASE_URL: database, DNE_REVIEW_TIME_WRITES: value }),
    ).toThrow("DNE_REVIEW_TIME_WRITES must be enabled or disabled.");
  expect(() =>
    config({
      DNE_DATABASE_URL: database,
      DNE_REVIEW_TIME_WRITES: "enabled",
      DNE_APP_MODE: "live",
    }),
  ).toThrow("Live application hosting");
});
it("refuses allocated publication before any database or object access when paused or live", async () => {
  const connect = vi.fn(() => {
    throw Error("must not connect");
  });
  const pool = { connect } as unknown as Pool;
  const objects = {} as ObjectStorage;
  const id = "11111111-1111-4111-8111-111111111111";
  for (const options of [
    undefined,
    { reviewTimeWrites: false, mode: "test" as const },
    { reviewTimeWrites: true, mode: "live" as const },
  ]) {
    const store = sampleFeedbackStore(pool, objects, options);
    expect(
      await store.publish("a".repeat(64), id, 1, id, {
        allocationId: id,
        grantId: id,
        intervals: {
          preparationStart: null,
          preparationEnd: null,
          reviewStart: new Date(
            Math.floor(Date.now() / 60000) * 60000 - 120000,
          ),
          reviewEnd: new Date(Math.floor(Date.now() / 60000) * 60000 - 60000),
        },
      }),
    ).toEqual({ kind: "unavailable" });
  }
  expect(connect).not.toHaveBeenCalled();
});
