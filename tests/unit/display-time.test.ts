import { expect, it } from "vitest";
import {
  keepCodesTogether,
  noBreak,
  readableDay,
  readableRange,
  readableTime,
  timeTag,
} from "../../src/display-time.ts";

const start = new Date("2030-11-03T05:30:00.000Z");
const end = new Date("2030-11-03T06:30:00.000Z");

it("READABLE-01 writes an instant in words and always names the zone", () => {
  expect(readableTime(start)).toBe("November 3, 2030, 5:30 a.m. UTC");
  expect(readableTime("2030-11-03T17:05:09.000Z")).toBe(
    "November 3, 2030, 5:05 p.m. UTC",
  );
  expect(readableTime("2026-09-23T10:00:00Z")).toBe(
    "September 23, 2026, 10:00 a.m. UTC",
  );
  expect(readableTime("2030-01-01T00:00:00.000Z")).toBe(
    "January 1, 2030, 12:00 a.m. UTC",
  );
});

it("READABLE-02 converts to a saved zone across a daylight-saving change and states it", () => {
  // The same wall-clock hour differs by one hour either side of the change.
  expect(readableTime(start, "America/Toronto")).toBe(
    "November 3, 2030, 1:30 a.m. GMT-4 (America/Toronto)",
  );
  expect(readableTime(end, "America/Toronto")).toBe(
    "November 3, 2030, 1:30 a.m. GMT-5 (America/Toronto)",
  );
  // A date can differ from its UTC date once converted.
  expect(readableTime("2030-11-03T02:00:00.000Z", "America/Vancouver")).toBe(
    "November 2, 2030, 7:00 p.m. GMT-7 (America/Vancouver)",
  );
});

it("READABLE-03 falls back to a stated UTC time when a saved zone is invalid", () => {
  expect(readableTime(start, "not/a-zone")).toBe(
    "November 3, 2030, 5:30 a.m. UTC",
  );
  expect(readableTime(start, null)).toBe("November 3, 2030, 5:30 a.m. UTC");
});

it("READABLE-04 never echoes an unparseable value into the page", () => {
  for (const bad of ["<script>alert(1)</script>", "", new Date("nope")]) {
    expect(readableTime(bad)).toBe("Time unavailable");
    expect(readableDay(bad)).toBe("Date unavailable");
    expect(timeTag(bad)).toBe("Time unavailable");
    expect(readableRange(bad, end)).toBe("Time unavailable");
    expect(readableRange(start, bad)).toBe("Time unavailable");
  }
});

it("READABLE-05 reads a day-only value without moving it to another date", () => {
  expect(readableDay("2026-10-27")).toBe("October 27, 2026");
  expect(readableDay(new Date("2026-10-27T23:59:59.000Z"))).toBe(
    "October 27, 2026",
  );
  expect(readableDay("2026-10-27T00:00:00.000Z")).toBe("October 27, 2026");
});

it("READABLE-06 shortens a same-day range but keeps both dates otherwise", () => {
  expect(readableRange(start, end)).toBe(
    "November 3, 2030, 5:30 a.m. to 6:30 a.m. UTC",
  );
  expect(readableRange(start, new Date("2030-11-04T06:30:00.000Z"))).toBe(
    "November 3, 2030, 5:30 a.m. UTC to November 4, 2030, 6:30 a.m. UTC",
  );
  // The offset changes between the two ends, so sharing it would mislead.
  expect(readableRange(start, end, "America/Toronto")).toBe(
    "November 3, 2030, 1:30 a.m. GMT-4 (America/Toronto) to November 3, 2030, 1:30 a.m. GMT-5 (America/Toronto)",
  );
  // Same UTC date but a different local one, so both dates stay visible.
  expect(
    readableRange(
      "2030-11-03T02:00:00.000Z",
      "2030-11-03T09:00:00.000Z",
      "America/Vancouver",
    ),
  ).toBe(
    "November 2, 2030, 7:00 p.m. GMT-7 (America/Vancouver) to November 3, 2030, 1:00 a.m. GMT-8 (America/Vancouver)",
  );
});

it("READABLE-07 keeps the exact machine value in the datetime attribute", () => {
  expect(timeTag(new Date("2030-11-03T05:30:12.345Z"))).toBe(
    '<time datetime="2030-11-03T05:30:12.345Z">November 3, 2030, 5:30 a.m. UTC</time>',
  );
  expect(timeTag("2030-11-03T05:30:00Z", "America/Toronto")).toBe(
    '<time datetime="2030-11-03T05:30:00.000Z">November 3, 2030, 1:30 a.m. GMT-4 (America/Toronto)</time>',
  );
});

it("READABLE-08 keeps short codes and dates in free text on one line", () => {
  expect(noBreak("FND-003")).toBe('<span class="no-break">FND-003</span>');
  expect(
    keepCodesTogether("FND-002 and WF-001; reviewed 2026-10-27 by A&amp;B"),
  ).toBe(
    '<span class="no-break">FND-002</span> and <span class="no-break">WF-001</span>; reviewed <span class="no-break">2026-10-27</span> by A&amp;B',
  );
  // A long URL stays breakable, including the digits at its end.
  const url = "https://example.test/articles/6654000-best-practices-WF-001x";
  expect(keepCodesTogether(url)).toBe(url);
  expect(keepCodesTogether("https://example.test/WF-001")).toBe(
    "https://example.test/WF-001",
  );
});
