import { expect, it } from "vitest";
import {
  supportTimeLink,
  supportTimeOperatorPage,
  supportTimeWorklistPage,
} from "../../src/support-time-views.ts";
import type { OperatorSupportTimeReceipt } from "../../src/support-time.ts";

const receipt: OperatorSupportTimeReceipt = {
  allocationId: "invented-allocation",
  requestId: 'invented/request"<',
  grantId: 'invented/grant"<',
  ceiling: 20,
  state: "allocated",
  held: 20,
  consumed: 0,
  released: 0,
  supportMinutes: 0,
  preparationMinutes: 0,
  canBegin: true,
  canRecord: false,
};
it("links only the exact allocation and grant with encoded identifiers", () => {
  expect(supportTimeLink(receipt)).toBe(
    "/operator/support-time/invented%2Frequest%22%3C?allocation=invented-allocation&grant=invented%2Fgrant%22%3C",
  );
});
it("makes empty granted worklists honest and read-only", () => {
  const html = supportTimeWorklistPage({ items: [], nextCursor: null });
  expect(html).toContain("No current support-time grants on this page");
  expect(html).toContain(
    "Opening a receipt does not begin work or consume minutes",
  );
  expect(html).not.toContain("<form");
  expect(html).not.toContain("Older support-time grants");
});
it("shows bounded content-free grant receipts and encodes paging and displayed identifiers", () => {
  const html = supportTimeWorklistPage({
    items: [receipt],
    nextCursor: 'cursor+/<"',
  });
  expect(html).toContain("20 held, 0 consumed, 0 released");
  expect(html).toContain("invented/request&quot;&lt;");
  expect(html).toContain("after=cursor%2B%2F%3C%22");
  expect(html).not.toContain('invented/request"<');
  expect(html).toContain("At most 20 grants per page");
});
it("requires separate deliberate begin confirmation and carries escaped grant and CSRF fields", () => {
  const html = supportTimeOperatorPage(receipt, 'csrf"<');
  expect(html).toContain(
    'action="/operator/support-time/invented%2Frequest%22%3C/begin"',
  );
  expect(html).toContain('name="grantId" value="invented/grant&quot;&lt;"');
  expect(html).toContain('value="csrf&quot;&lt;"');
  expect(html).toContain('name="confirm" value="yes" required');
  expect(html).not.toContain("Record and settle test effort");
  expect(html).toContain("it is not automatically refunded");
  expect(html).toContain("does not expose private request text");
});
it("offers mandatory support and optional paired preparation fields only after a permitted begin", () => {
  const html = supportTimeOperatorPage(
    { ...receipt, state: "begun", canBegin: false, canRecord: true },
    "csrf",
  );
  expect(html).not.toContain("Begin support test effort</button>");
  expect(html).toContain("Record and settle test effort</button>");
  expect(html).toContain('name="supportStart" type="text"');
  expect(html).toContain('name="supportEnd" type="text"');
  expect(html).toContain("Support start (UTC)");
  expect(html).toContain("Preparation start (UTC, optional)");
  expect(html).toContain("Use both preparation fields or leave both blank");
  expect(html).toContain("confirmed 20-minute ceiling");
  expect(html).toContain("does not resolve or acknowledge the support request");
  expect(html.match(/ required>/g)).toHaveLength(3);
});
it.each(["completed", "needs_reconciliation"] as const)(
  "keeps a %s receipt read-only and distinguishes unresolved work from settled effort",
  (state) => {
    const html = supportTimeOperatorPage(
      {
        ...receipt,
        state,
        canBegin: false,
        canRecord: false,
        held: state === "completed" ? 0 : 20,
        consumed: state === "completed" ? 15 : 0,
        released: state === "completed" ? 5 : 0,
      },
      "csrf",
    );
    expect(html).not.toContain("<form");
    expect(html).toContain(`State: ${state}`);
    expect(html).toContain(
      "No paid staffing, live service, real costs or qualified approval",
    );
    expect(html.includes("Keep the hold for reconciliation")).toBe(
      state === "needs_reconciliation",
    );
  },
);
