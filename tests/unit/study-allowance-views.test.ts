import { expect, it } from "vitest";
import {
  studyAllowanceNotice,
  studyAllowancePage,
} from "../../src/study-allowance-views.ts";
import type { StudyAllowanceView } from "../../src/study-allowance-values.ts";

const start = new Date("2030-01-01T00:00:00.000Z"),
  end = new Date("2030-02-01T00:00:00.000Z");
const policy = {
  version: "study-allowance-test-v1",
  category: "study_requests" as const,
  periodLimit: 5,
  period: "utc_calendar_month" as const,
  eligibility: "current_member_explicit_claim" as const,
  grantSource: "test_configuration" as const,
  rateEstimateVersion: null,
  spendState: "test" as const,
};
const base: StudyAllowanceView = {
  policy,
  period: { start, end },
  claim: null,
  creationEnabled: true,
};
it("ALLOW-01 states every policy fact without implying a purchase", () => {
  const html = studyAllowancePage("csrf", base);
  for (const text of [
    "study-allowance-test-v1",
    "5 study requests, each calendar month (UTC)",
    "Any current member who chooses to claim it",
    "isn&#39;t bought",
    "never call a paid AI service",
  ])
    expect(html.replaceAll("'", "&#39;")).toContain(text);
});
it("ALLOW-02 offers an unticked confirmation bound to the version and month", () => {
  const html = studyAllowancePage("csrf", base);
  expect(html).toContain(`value="${start.toISOString()}"`);
  expect(html).toContain(
    'name="policyVersion" value="study-allowance-test-v1"',
  );
  expect(html).toMatch(/name="key" value="[0-9a-f-]{36}"/);
  expect(html).toContain('type="checkbox" name="confirm" value="yes" required');
  expect(html).not.toMatch(/name="confirm"[^>]* checked/);
});
it("ALLOW-02 shows a claim's balance and offers no second claim", () => {
  const html = studyAllowancePage("csrf", {
    ...base,
    claim: {
      id: "c",
      policyVersion: "study-allowance-test-v1",
      quantity: 5,
      periodStart: start,
      periodEnd: end,
      createdAt: start,
      available: 3,
      reserved: 1,
      consumed: 1,
      expired: 0,
    },
  });
  expect(html).toContain('<span data-field="available">3</span>');
  expect(html).toContain('<span data-field="reserved">1</span>');
  expect(html).toContain('<span data-field="consumed">1</span>');
  expect(html).toContain("carry over");
  expect(html).not.toContain("<form");
});
it("ALLOW-06 a paused or unset policy offers no claim", () => {
  const paused = studyAllowancePage("csrf", {
    ...base,
    creationEnabled: false,
  });
  expect(paused).toContain("New claims are paused");
  expect(paused).not.toContain("<form");
  const unset = studyAllowancePage("csrf", { ...base, policy: null });
  expect(unset).toContain("No study allowance is set up");
  expect(unset).not.toContain("<form");
});
it.each([
  ["unavailableRoute", "aren&#39;t available"],
  ["denied", "current session"],
  ["invalid", "Nothing was added"],
  ["conflict", "Nothing was added"],
  ["unavailable", "never adds a second"],
] as const)("ALLOW-06 the %s notice explains the outcome", (kind, text) => {
  expect(studyAllowanceNotice(kind).replaceAll("'", "&#39;")).toContain(text);
});
