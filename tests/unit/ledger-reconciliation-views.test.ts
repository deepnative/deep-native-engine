import { expect, it } from "vitest";
import {
  ledgerReconciliationPage,
  ledgerReconciliationUnavailablePage,
} from "../../src/ledger-reconciliation-views.ts";
import type {
  LedgerReconciliationCategory,
  LedgerReconciliationSnapshot,
} from "../../src/ledger-reconciliation.ts";
function fixture(): LedgerReconciliationSnapshot {
  return {
    scope: "synthetic-local-preview",
    asOf: new Date("2026-10-02T12:34:56Z"),
    categories: (
      [
        ["coach_minutes", "minutes"],
        ["review_minutes", "minutes"],
        ["support_minutes", "minutes"],
        ["mock_sessions", "sessions"],
        ["study_requests", "requests"],
      ] as const
    ).map(([category, unit]) => ({
      category,
      unit,
      observed: {
        grants: 0,
        reservations: 0,
        events: 0,
        completions: 0,
        granted: 0,
        available: 0,
        reserved: 0,
        consumed: 0,
        expired: 0,
        adjusted: 0,
      },
      events: {
        grant: 0,
        reserve: 0,
        consume: 0,
        release: 0,
        expire: 0,
        adjust: 0,
      },
      completion: {
        attachedQuantity: 0,
        deliveredMinutes: 0,
        preparationMinutes: 0,
        consumedWithoutAttachment: 0,
      },
      reconciliation: {
        status: "consistent",
        grants: 0,
        reservations: 0,
        events: 0,
        completions: 0,
      },
    })),
  };
}
it("presents five zero categories without claiming use, mixed-unit totals or external reconciliation", () => {
  const html = ledgerReconciliationPage(fixture());
  expect(html.match(/data-ledger-category=/g)).toHaveLength(5);
  expect(html.match(/No retained records to compare/g)).toHaveLength(5);
  for (const category of [
    "Coach minutes",
    "Review minutes",
    "Support minutes",
    "Mock sessions",
    "Study requests",
  ])
    expect(html).toContain(`<strong>${category}</strong>`);
  expect(html).toContain('datetime="2026-10-02T12:34:56.000Z"');
  expect(html).toContain(
    "Categories use different units and are never added together",
  );
  expect(html).toContain(
    "Available units are not bookable or qualified capacity",
  );
  expect(html).toContain(
    "Zero observed records do not establish service use or external reconciliation",
  );
  expect(html).toContain(
    "attribution is unrecorded; timestamps do not prove it",
  );
  expect(html).toContain(
    "Invoice, collected cash, provider, job and manual-source reconciliation are unavailable",
  );
  expect(html).toContain(
    "Qualified capacity, booked service, revenue, actual cost and production entitlement policy are unavailable",
  );
  expect(html).not.toContain("<form");
  expect(html).not.toContain("Grand total");
  expect(html).not.toContain(" open>");
});
it("reports exact integer fields and preparation once, while ordinary unattached consumption stays valid", () => {
  const snapshot = fixture();
  snapshot.categories[1] = {
    category: "review_minutes",
    unit: "minutes",
    observed: {
      grants: 1,
      reservations: 2,
      events: 5,
      completions: 1,
      granted: Number.MAX_SAFE_INTEGER,
      available: 8,
      reserved: 7,
      consumed: 90,
      expired: 4,
      adjusted: 3,
    },
    events: {
      grant: 1,
      reserve: 2,
      consume: 2,
      release: 0,
      expire: 0,
      adjust: 0,
    },
    completion: {
      attachedQuantity: 60,
      deliveredMinutes: 45,
      preparationMinutes: 15,
      consumedWithoutAttachment: 1,
    },
    reconciliation: {
      status: "consistent",
      grants: 0,
      reservations: 0,
      events: 0,
      completions: 0,
    },
  };
  const html = ledgerReconciliationPage(snapshot);
  const review = html
    .split('data-ledger-category="review_minutes"')[1]!
    .split("</details>")[0]!;
  for (const [field, value] of Object.entries(snapshot.categories[1]!.observed))
    expect(review).toContain(`data-field="observed.${field}">${value}</dd>`);
  expect(review).toContain('data-field="completion.attachedQuantity">60</dd>');
  expect(review).toContain('data-field="completion.deliveredMinutes">45</dd>');
  expect(review).toContain(
    'data-field="completion.preparationMinutes">15</dd>',
  );
  expect(review).toContain(
    'data-field="completion.consumedWithoutAttachment">1</dd>',
  );
  expect(review).toContain("include delivery and preparation once");
  expect(review).toContain("not itself a discrepancy");
  expect(review).not.toContain("No retained records");
  expect(
    html.match(/Completion attachments are unsupported for this category/g),
  ).toHaveLength(2);
  const study = html
    .split('data-ledger-category="study_requests"')[1]!
    .split("</details>")[0]!;
  expect(study).toContain("Attached requests");
  expect(study).not.toContain('data-field="completion.deliveredMinutes"');
  expect(study).toContain("minute breakdown: not applicable");
});
it.each(["grants", "reservations", "events", "completions"] as const)(
  "keeps a retained %s discrepancy visible even if other record groups are empty",
  (group) => {
    const snapshot = fixture(),
      row = snapshot.categories[0]!;
    row.observed[group] = 2;
    row.reconciliation.status = "discrepancies";
    row.reconciliation[group] = 2;
    const html = ledgerReconciliationPage(snapshot),
      category = html
        .split('data-ledger-category="coach_minutes"')[1]!
        .split("</details>")[0]!;
    expect(category).toMatch(/^ open>/);
    expect(category).toContain("Structural discrepancies detected");
    expect(category).toContain(`data-field="reconciliation.${group}">2</dd>`);
    expect(category).toContain("This report makes no correction");
    expect(category).not.toContain("No retained records");
    expect(category).toContain("not a net difference or an additive total");
  },
);
it("preserves each affected-record group without adding or cancelling discrepancies", () => {
  const snapshot = fixture();
  snapshot.categories[0]!.reconciliation = {
    status: "discrepancies",
    grants: 2,
    reservations: 4,
    events: 6,
    completions: 8,
  };
  const html = ledgerReconciliationPage(snapshot);
  for (const [field, value] of [
    ["grants", 2],
    ["reservations", 4],
    ["events", 6],
    ["completions", 8],
  ] as const)
    expect(html).toContain(
      `data-field="reconciliation.${field}">${value}</dd>`,
    );
  expect(html).toContain("Groups may overlap");
});
it("projects only approved aggregate fields even when a caller supplies extra private metadata", () => {
  const snapshot = fixture();
  const row: LedgerReconciliationCategory & {
    memberId: string;
    reference: string;
    request_fingerprint: string;
  } = {
    ...snapshot.categories[0]!,
    memberId: "PRIVATE-MEMBER",
    reference: "PRIVATE-REFERENCE",
    request_fingerprint: "PRIVATE-FINGERPRINT",
  };
  snapshot.categories[0] = row;
  expect(ledgerReconciliationPage(snapshot)).not.toMatch(
    /PRIVATE-(MEMBER|REFERENCE|FINGERPRINT)/,
  );
});
it.each([
  ["denied", "not available to this session"],
  ["unavailable", "No report results are shown"],
  ["live", "unavailable in live mode"],
  ["query", "does not accept query fields or filters"],
] as const)(
  "offers a safe explicit recovery link for %s without any report",
  (kind, message) => {
    const html = ledgerReconciliationUnavailablePage(kind);
    expect(html).toContain(message);
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="/operator/ledger-reconciliation"');
    expect(html).not.toContain("data-field=");
    expect(html).not.toContain("<time");
    expect(html).not.toContain("<script");
  },
);
