import { expect, it } from "vitest";
import { config } from "../../src/config.ts";
const base = {
  DNE_DATABASE_URL: "postgresql://dne:sample@127.0.0.1:54329/dne_dev",
};
it("requires explicit inspection opt-in and rejects ambiguous flags", () => {
  expect(config(base).localHoldInspectionReads).toBe(false);
  for (const value of ["enabled", "disabled"])
    expect(
      config({ ...base, DNE_LOCAL_AI_HOLD_INSPECTION: value })
        .localHoldInspectionReads,
    ).toBe(value === "enabled");
  for (const value of ["", "true", "ENABLED"])
    expect(() =>
      config({ ...base, DNE_LOCAL_AI_HOLD_INSPECTION: value }),
    ).toThrow("DNE_LOCAL_AI_HOLD_INSPECTION must be enabled or disabled.");
});
