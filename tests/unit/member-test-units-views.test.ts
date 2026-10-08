import { expect, it } from "vitest";
import {
  memberTestUnitsPage,
  memberTestUnitsUnavailablePage,
} from "../../src/member-test-units-views.ts";
import {
  testUnitCategories,
  type MemberTestUnitSnapshot,
} from "../../src/member-test-units.ts";
import { availabilityPage } from "../../src/views.ts";
function fixture(): MemberTestUnitSnapshot {
  return {
    scope: "synthetic-local-preview",
    asOf: new Date("2026-10-02T12:00:00Z"),
    categories: testUnitCategories.map(([category, unit]) => ({
      category,
      unit,
      grants: 0,
      granted: 0,
      usable: 0,
      future: 0,
      awaitingExpiry: 0,
      held: 0,
      consumed: 0,
      expired: 0,
      adjusted: 0,
      nextExpiry: null,
      nextStart: null,
    })),
  };
}
it("makes an empty test grant state explicit without offering a paid or free plan", () => {
  const html = memberTestUnitsPage(fixture());
  expect(html).toContain(
    "No local test grants are configured for this session",
  );
  expect(html.match(/No local test grant in this category/g)).toHaveLength(5);
  expect(html).toContain(
    "does not define a foundation allowance or a paid plan",
  );
  expect(html).toContain('datetime="2026-10-02T12:00:00.000Z"');
  expect(html).not.toContain("<form");
});
it("shows separate observed quantities and earliest affected times without a mixed-unit total or automatic release", () => {
  const value = fixture();
  Object.assign(value.categories[0]!, {
    grants: 1,
    granted: 100,
    usable: 60,
    held: 20,
    future: 10,
    consumed: 5,
    expired: 3,
    adjusted: 2,
    nextExpiry: new Date("2026-11-01T00:00:00Z"),
    nextStart: new Date("2026-12-01T00:00:00Z"),
  });
  const html = memberTestUnitsPage(value);
  expect(html).not.toContain(
    "No local test grants are configured for this session",
  );
  expect(html).toContain('<span data-field="usable">60</span> minutes');
  expect(html).toContain('<span data-field="held">20</span> minutes');
  expect(html).toContain("Other units may have different deadlines");
  expect(html).toContain('datetime="2026-12-01T00:00:00.000Z"');
  expect(html).toContain("Held units remain held until an explicit outcome");
  expect(html).toContain(
    "contains no historical ledger or private learning content",
  );
  expect(html).toContain(
    'href="/member/export">Download retained test-unit history',
  );
  expect(html).toContain("stored counters differ from current usable balances");
  expect(html).not.toContain("Total credits");
  expect(html).toContain("0</span> sessions");
  expect(html).toContain("0</span> requests");
});
it.each(["denied", "unavailable", "live", "query"] as const)(
  "keeps the %s failure view without private balance values",
  (kind) => {
    const html = memberTestUnitsUnavailablePage(kind);
    expect(html).toContain("Test-unit summary unavailable");
    expect(html).not.toContain("data-field=");
    expect(html).toContain('href="/member/test-units"');
  },
);
it("links existing sample availability to the private reader without granting anything", () => {
  expect(availabilityPage([], "UTC")).toContain('href="/member/test-units"');
});

it("TESTISSUE-08 an installed fixture reader links deliberate request/withdrawal and distinguishes owner withdrawal from elapsed expiry", () => {
  const html = memberTestUnitsPage(fixture(), true);
  expect(html).toContain('href="/member/test-unit-request"');
  expect(html).toContain(
    "Expired totals also include unused study units you explicitly withdrew",
  );
  expect(html).toContain("withdrawal does not mean it elapsed naturally");
  expect(html).not.toContain("<form");
});
