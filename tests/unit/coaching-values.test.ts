import { expect, it } from "vitest";
import {
  coachingMonth,
  coachingDuration,
  coachingMinutes,
  coachingSubtotal,
  parseCoachingDuration,
} from "../../src/coaching-values.ts";
it("HOUR03 accepts real UTC calendar months and respects month/leap-year duration limits", () => {
  for (const value of [
    null,
    0,
    "",
    "2024-2",
    "2024-13",
    "0000-01",
    "2024-00",
    "2024-01-01",
  ])
    expect(coachingMonth(value)).toBe(false);
  expect(coachingMonth("2024-02")).toBe(true);
  for (const [month, max] of [
    ["2024-02", 41760],
    ["2023-02", 40320],
    ["2024-04", 43200],
    ["2024-01", 44640],
  ] as const) {
    expect(coachingMinutes(month, 0)).toBe(true);
    expect(coachingMinutes(month, max)).toBe(true);
    expect(coachingMinutes(month, max + 1)).toBe(false);
  }
  for (const value of [-1, 1.5, Infinity, NaN, "2"])
    expect(coachingMinutes("2024-02", value)).toBe(false);
  expect(coachingMinutes("bad", 1)).toBe(false);
});
it("HOUR03 rounds once half up, retains zero and rejects unsafe or excessive invoice money", () => {
  for (const [minutes, rate, result] of [
    [90, 12000, 18000],
    [90, 8000, 12000],
    [1, 10000, 167],
    [1, 1, 0],
    [30, 1, 1],
    [0, 12000, 0],
    [60, 1000000000, 1000000000],
  ] as const)
    expect(coachingSubtotal(minutes, rate)).toBe(result);
  for (const [minutes, rate] of [
    [-1, 100],
    [1.5, 100],
    [1, -1],
    [1, 0],
    [1, 1000000001],
    [Number.MAX_SAFE_INTEGER, 100],
    [61, 1000000000],
  ])
    expect(coachingSubtotal(minutes!, rate!)).toBeNull();
});
it("HOUR03 parses explicit whole hours and additional minutes without fractional, signed or coercible input", () => {
  expect(parseCoachingDuration("1", "30")).toBe(90);
  expect(parseCoachingDuration("0", "0")).toBe(0);
  expect(parseCoachingDuration("1", "59")).toBe(119);
  for (const [hours, minutes] of [
    [null, "0"],
    ["0", null],
    ["1.5", "0"],
    ["1", "-1"],
    ["1", "60"],
    ["01", "1"],
    ["10000", "1"],
    ["1", "01"],
  ])
    expect(parseCoachingDuration(hours, minutes)).toBeNull();
});

it("HOUR04 uses singular and plural duration labels without rounding the saved quantity", () => {
  expect(coachingDuration(0)).toBe("0 hours 0 minutes");
  expect(coachingDuration(1)).toBe("0 hours 1 minute");
  expect(coachingDuration(60)).toBe("1 hour 0 minutes");
  expect(coachingDuration(121)).toBe("2 hours 1 minute");
});
