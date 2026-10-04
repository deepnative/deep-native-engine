import { expect, it } from "vitest";
import { config } from "../../src/config.ts";
const database = "postgresql://dne:sample@127.0.0.1:54329/dne_dev";
it("supports explicit discovery pause without authorizing live hosting", () => {
  expect(config({ DNE_DATABASE_URL: database }).reviewerWorklistReads).toBe(
    true,
  );
  for (const value of ["enabled", "disabled"])
    expect(
      config({ DNE_DATABASE_URL: database, DNE_REVIEWER_WORKLIST_READS: value })
        .reviewerWorklistReads,
    ).toBe(value === "enabled");
  for (const value of ["", "true", "ENABLED"])
    expect(() =>
      config({
        DNE_DATABASE_URL: database,
        DNE_REVIEWER_WORKLIST_READS: value,
      }),
    ).toThrow("DNE_REVIEWER_WORKLIST_READS must be enabled or disabled.");
  expect(() =>
    config({
      DNE_DATABASE_URL: database,
      DNE_REVIEWER_WORKLIST_READS: "enabled",
      DNE_APP_MODE: "live",
    }),
  ).toThrow("Live application hosting");
});
