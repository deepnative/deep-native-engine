import { expect, it } from "vitest";
import {
  studyAllowanceInstruction,
  studyAllowanceLedgerKey,
  studyAllowancePeriod,
} from "../../src/study-allowance-values.ts";

it.each([
  ["2030-01-15T12:00:00.000Z", "2030-01-01", "2030-02-01"],
  ["2030-01-31T23:59:59.999Z", "2030-01-01", "2030-02-01"],
  ["2030-02-01T00:00:00.000Z", "2030-02-01", "2030-03-01"],
  ["2028-02-29T12:00:00.000Z", "2028-02-01", "2028-03-01"],
  ["2030-12-31T23:59:59.999Z", "2030-12-01", "2031-01-01"],
])("ALLOW-04 %s falls in the UTC month from %s to %s", (at, start, end) => {
  const period = studyAllowancePeriod(new Date(at));
  expect(period.start.toISOString()).toBe(`${start}T00:00:00.000Z`);
  expect(period.end.toISOString()).toBe(`${end}T00:00:00.000Z`);
});
it("ALLOW-03 builds one stable ledger key per member and month", () => {
  const start = new Date("2030-01-01T00:00:00.000Z");
  expect(studyAllowanceLedgerKey("member", start)).toBe(
    "study-allowance:member:2030-01",
  );
});
const policyVersion = "study-allowance-test-v1",
  periodStart = "2030-01-01T00:00:00.000Z";
it("accepts an exact version and month start, and drops anything else", () => {
  expect(
    studyAllowanceInstruction({
      policyVersion,
      periodStart,
      quantity: 100000,
    }),
  ).toEqual({ policyVersion, periodStart });
});
it.each([
  [null],
  ["text"],
  [{ policyVersion, periodStart: 5 }],
  [{ policyVersion: 5, periodStart }],
  [{ policyVersion: "premium-unlimited", periodStart }],
  [{ policyVersion: "study-allowance-test-v0", periodStart }],
  [{ policyVersion, periodStart: "soon" }],
  [{ policyVersion, periodStart: "2030-13-01T00:00:00.000Z" }],
  [{ policyVersion, periodStart: "2030-02-31T00:00:00.000Z" }],
  [{ policyVersion, periodStart: "2030-01-02T00:00:00.000Z" }],
])("ALLOW-06 refuses the malformed instruction %j", (value) => {
  expect(studyAllowanceInstruction(value)).toBeNull();
});
