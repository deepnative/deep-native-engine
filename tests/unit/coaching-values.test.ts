import { expect, it } from "vitest";
import {
  coachingMonth,
  coachingDuration,
  coachingMinutes,
  coachingSubtotal,
  parseCoachingDuration,
  addDays,
  addMonths,
  coachingDate,
  coachingPeriodKey,
  effectiveSchedules,
  monthPeriod,
  periodContaining,
  periodLabel,
  recentPeriods,
  scheduleLabel,
  type BillingSchedule,
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

// #832 slice B: administrator-defined billing periods.
const schedule = (
  version: number,
  startsOn: string,
  days: number | null,
  setOn = "2026-01-01",
): BillingSchedule => ({
  version,
  unit: days === null ? "month" : "days",
  days,
  startsOn,
  setOn,
});
it("PERIOD832-01 two-week, weekly, daily and custom periods run back to back from the first start date", () => {
  const two = [schedule(1, "2026-11-02", 14)];
  expect(periodContaining(two, "2026-11-01")).toBeNull();
  expect(periodContaining(two, "2026-11-02")).toEqual({
    key: "2026-11-02",
    start: "2026-11-02",
    end: "2026-11-15",
    days: 14,
  });
  expect(periodContaining(two, "2026-11-15")!.key).toBe("2026-11-02");
  expect(periodContaining(two, "2026-11-16")).toMatchObject({
    start: "2026-11-16",
    end: "2026-11-29",
  });
  // Across a year end and a leap day.
  expect(periodContaining(two, "2028-03-01")).toMatchObject({
    start: "2028-02-21",
    end: "2028-03-05",
    days: 14,
  });
  expect(
    periodContaining([schedule(1, "2026-11-02", 1)], "2026-11-20"),
  ).toEqual({
    key: "2026-11-20",
    start: "2026-11-20",
    end: "2026-11-20",
    days: 1,
  });
  expect(
    periodContaining([schedule(1, "2026-11-02", 31)], "2026-12-03"),
  ).toMatchObject({ start: "2026-12-03", end: "2027-01-02", days: 31 });
  expect(
    recentPeriods([schedule(1, "2026-11-02", 7)], "2026-11-20", 60).map(
      (p) => p.key,
    ),
  ).toEqual(["2026-11-16", "2026-11-09", "2026-11-02"]);
  expect(recentPeriods(two, "2026-12-31", 2)).toHaveLength(2);
  expect(recentPeriods(two, "2026-10-01", 5)).toEqual([]);
});
it("PERIOD832-01 a one-month period runs to the day before the same day next month, using the last day of shorter months", () => {
  const mid = [schedule(1, "2026-11-15", null)];
  expect(periodContaining(mid, "2026-11-15")).toEqual({
    key: "2026-11-15",
    start: "2026-11-15",
    end: "2026-12-14",
    days: 30,
  });
  expect(periodContaining(mid, "2026-12-14")!.key).toBe("2026-11-15");
  expect(periodContaining(mid, "2027-01-03")).toMatchObject({
    start: "2026-12-15",
    end: "2027-01-14",
  });
  const last = [schedule(1, "2027-01-31", null)];
  expect(periodContaining(last, "2027-02-10")).toMatchObject({
    start: "2027-01-31",
    end: "2027-02-27",
    days: 28,
  });
  expect(periodContaining(last, "2027-02-28")).toMatchObject({
    start: "2027-02-28",
    end: "2027-03-30",
  });
  expect(periodContaining(last, "2027-03-31")).toMatchObject({
    start: "2027-03-31",
    end: "2027-04-29",
  });
  expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
  expect(addMonths("2026-11-15", -11)).toBe("2025-12-15");
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(monthPeriod("2028-02")).toEqual({
    key: "2028-02",
    start: "2028-02-01",
    end: "2028-02-29",
    days: 29,
  });
});
it("PERIOD832-04 a changed length applies from the next period, and a setting replaced before it starts never applies", () => {
  // Two weeks from 2 Nov; on 20 Nov the administrator chooses one week,
  // which starts when the current period (16 to 29 Nov) ends.
  const changed = [
    schedule(1, "2026-11-02", 14, "2026-11-01"),
    schedule(2, "2026-11-30", 7, "2026-11-20"),
  ];
  expect(periodContaining(changed, "2026-11-29")).toMatchObject({
    start: "2026-11-16",
    end: "2026-11-29",
  });
  expect(periodContaining(changed, "2026-11-30")).toMatchObject({
    start: "2026-11-30",
    end: "2026-12-06",
    days: 7,
  });
  expect(recentPeriods(changed, "2026-12-08", 9).map((p) => p.days)).toEqual([
    7, 7, 14, 14,
  ]);
  // Before the one-week setting starts, a 10-day one replaces it.
  const replaced = [...changed, schedule(3, "2026-11-30", 10, "2026-11-25")];
  expect(effectiveSchedules(replaced).map((s) => s.version)).toEqual([1, 3]);
  expect(periodContaining(replaced, "2026-12-08")).toMatchObject({
    start: "2026-11-30",
    end: "2026-12-09",
  });
  // A first setting replaced before its start date is gone entirely.
  const moved = [
    schedule(1, "2026-12-01", 14, "2026-11-10"),
    schedule(2, "2026-12-08", 7, "2026-11-12"),
  ];
  expect(periodContaining(moved, "2026-12-03")).toBeNull();
  expect(periodContaining(moved, "2026-12-08")!.days).toBe(7);
  // A later setting that does not fall on a boundary still ends the period.
  expect(
    periodContaining(
      [
        schedule(1, "2026-11-02", 14, "2026-11-01"),
        schedule(2, "2026-11-20", 7, "2026-11-18"),
      ],
      "2026-11-17",
    ),
  ).toEqual({
    key: "2026-11-16",
    start: "2026-11-16",
    end: "2026-11-19",
    days: 4,
  });
});
it("PERIOD832-07 period keys, setting names and period names read plainly", () => {
  for (const key of ["2026-11", "2026-11-16", "2028-02-29"])
    expect(coachingPeriodKey(key)).toBe(true);
  for (const key of [
    "2026-13",
    "2026-02-30",
    "2026-11-1",
    "0000-01-01",
    5,
    null,
  ])
    expect(coachingPeriodKey(key)).toBe(false);
  expect(coachingDate("2026-11")).toBe(false);
  expect(
    [7, 14, null, 1, 10].map((days) =>
      scheduleLabel({ unit: days === null ? "month" : "days", days }),
    ),
  ).toEqual(["1 week", "2 weeks", "1 month", "1 day", "10 days"]);
  expect(periodLabel({ key: "2026-10" })).toBe("October 2026");
  expect(
    periodLabel({ key: "2026-11-16", start: "2026-11-16", end: "2026-11-29" }),
  ).toBe("16 Nov 2026 to 29 Nov 2026");
  expect(
    periodLabel({ key: "2026-11-16", start: "2026-11-16", end: "2026-11-16" }),
  ).toBe("16 Nov 2026");
  expect(periodLabel({ key: "2026-11-16" })).toBe("Period from 16 Nov 2026");
});
