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
const practicePolicy = {
  ...policy,
  version: "mock-allowance-test-v1",
  category: "mock_sessions" as const,
  periodLimit: 3,
};
it("MOCK-01 practice sessions have separate rules and a separate unticked claim", () => {
  const html = studyAllowancePage("csrf", {
    ...base,
    practice: { policy: practicePolicy, claim: null },
  });
  expect(html).toContain("3 practice sessions, each calendar month (UTC)");
  expect(html).toContain("mock-allowance-test-v1");
  expect(html).toContain("I want this month's 3 practice sessions.");
  expect(html).toContain("Claim this month's practice sessions");
  expect(html).not.toMatch(/name="confirm"[^>]*checked/);
});
it("MOCK-01 a practice claim shows what's left, and retained claims stay readable", () => {
  const html = studyAllowancePage("csrf", {
    ...base,
    creationEnabled: false,
    practice: {
      policy: null,
      claim: {
        id: "c",
        policyVersion: "mock-allowance-test-v1",
        quantity: 3,
        periodStart: base.period.start,
        periodEnd: base.period.end,
        createdAt: base.period.start,
        available: 2,
        reserved: 0,
        consumed: 1,
        expired: 0,
      },
    },
  });
  expect(html).toContain('<span data-field="practice-available">2</span>');
  expect(html).toContain('<span data-field="practice-consumed">1</span>');
  expect(html).toContain("give its unit back");
});
it("MOCK-07 no practice section without units, and pause or no policy offers no form", () => {
  expect(studyAllowancePage("csrf", { ...base, practice: null })).not.toContain(
    "Practice sessions",
  );
  const paused = studyAllowancePage("csrf", {
    ...base,
    claim: null,
    creationEnabled: false,
    practice: { policy: practicePolicy, claim: null },
  });
  expect(paused).toContain("New practice session claims are paused");
  expect(paused).not.toContain("<form");
  expect(
    studyAllowancePage("csrf", {
      ...base,
      practice: { policy: null, claim: null },
    }),
  ).toContain("No practice session allowance is set up");
});
it("WALK-01 names each allowance and lays them out as peers", () => {
  const html = studyAllowancePage("csrf", {
    ...base,
    practice: { policy: null, claim: null },
  });
  expect(html).toContain("<h2>Study requests</h2>");
  expect(html).toContain("<h2>Practice sessions</h2>");
  // `.reading section` indents numbered lesson steps; allowances are not steps.
  expect(html).not.toMatch(/<section[^>]*>/);
});
const earlierMonth = {
  category: "study_requests" as const,
  policyVersion: "study-allowance-test-v1",
  quantity: 5,
  periodStart: new Date("2029-12-01T00:00:00.000Z"),
  periodEnd: start,
  used: 2,
  held: 1,
  endedUnused: 2,
};
it("RENEW-01 earlier months show what happened to each month's units, never as left to use", () => {
  const html = studyAllowancePage("csrf", {
    ...base,
    earlier: [
      {
        ...earlierMonth,
        category: "mock_sessions",
        policyVersion: "mock-allowance-test-v1",
        quantity: 3,
        used: 3,
        held: 0,
        endedUnused: 0,
      },
      earlierMonth,
    ],
    olderOmitted: false,
  });
  expect(html).toContain("<h2>Earlier months</h2>");
  expect(html).toContain("December 2029 · Practice sessions");
  expect(html).toContain("December 2029 · Study requests");
  expect(html.indexOf("Practice sessions</h3>")).toBeLessThan(
    html.indexOf("Study requests</h3>"),
  );
  for (const field of [
    '<span data-field="earlier-claimed">5</span>',
    '<span data-field="earlier-used">2</span>',
    '<span data-field="earlier-held">1</span>',
    '<span data-field="earlier-ended">2</span>',
  ])
    expect(html).toContain(field);
  const history = html.slice(html.indexOf("Earlier months"));
  expect(history).not.toContain("Left to use");
  expect(history).not.toContain("<form");
  expect(html).not.toContain("records download");
});
it("RENEW-02 nothing renews by itself, and a claimed month says when the next opens", () => {
  const unclaimed = studyAllowancePage("csrf", {
    ...base,
    earlier: [earlierMonth],
    olderOmitted: false,
  });
  expect(unclaimed).toContain("Nothing renews automatically");
  expect(unclaimed.replaceAll("&#39;", "'")).toContain("weren't carried over");
  const claimed = studyAllowancePage("csrf", {
    ...base,
    claim: {
      id: "c",
      policyVersion: "study-allowance-test-v1",
      quantity: 5,
      periodStart: start,
      periodEnd: end,
      createdAt: start,
      available: 5,
      reserved: 0,
      consumed: 0,
      expired: 0,
    },
  });
  expect(claimed).toContain("The next month opens");
  expect(claimed).toContain(end.toISOString());
  expect(studyAllowancePage("csrf", base)).toContain("No earlier months yet.");
});
it("RENEW-03 a unit still held from an earlier month explains how it ends", () => {
  const html = studyAllowancePage("csrf", {
    ...base,
    earlier: [earlierMonth],
  });
  expect(html).toContain("can still finish");
  expect(html).toContain(
    "doesn&#39;t move to this month".replace("&#39;", "'"),
  );
  const settled = studyAllowancePage("csrf", {
    ...base,
    earlier: [{ ...earlierMonth, held: 0 }],
  });
  expect(settled).not.toContain("can still finish");
});
it("RENEW-04 older months point to the records download", () => {
  const html = studyAllowancePage("csrf", {
    ...base,
    earlier: [earlierMonth],
    olderOmitted: true,
  });
  expect(html).toContain("last 12 months");
  expect(html).toContain('href="/member/export"');
});
