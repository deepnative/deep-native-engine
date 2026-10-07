import { expect, it } from "vitest";
import {
  workflowReviewHistoryPage,
  workflowReviewReceiptPage,
  workflowReviewRecoveryPage,
} from "../../src/workflow-review-views.ts";
import type { WorkflowReviewReceipt } from "../../src/workflow-review.ts";
const value: WorkflowReviewReceipt = {
  requestId: "invented-request",
  workflowId: "WF-001",
  workflowVersion: 1,
  instanceId: "invented-source",
  revision: 1,
  expiresAt: "fixed-expiry",
  createdAt: "original-created",
  withdrawnAt: null,
  state: "pending",
};
it("WFREV-04 pending member receipt offers explicit permission withdrawal without claiming review completion", () => {
  const html = workflowReviewReceiptPage(
    value,
    "invented-csrf",
    "original-operation",
  );
  expect(html).toContain('action="/workflow-feedback/review/withdraw"');
  expect(html).toContain("keeping my own note");
  expect(html).toContain("Neither state means the note has been read");
  expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
});
it("WFREV-04 withdrawn receipt retains own note and history access without inviting renewed permission", () => {
  const html = workflowReviewReceiptPage(
    { ...value, state: "withdrawn", withdrawnAt: "withdrawal-date" },
    "csrf",
    "key",
  );
  expect(html).toContain("Your permission is withdrawn");
  expect(html).not.toContain('action="/workflow-feedback/review/withdraw"');
  expect(html).toContain("/workflow-feedback/WF-001");
  expect(html).toContain("/workflow-feedback/review/history");
});
it("WFREV-07 metadata history preserves opaque continuation and escapes references", () => {
  const html = workflowReviewHistoryPage(
    [{ ...value, requestId: 'request"><script>' }],
    "opaque / + cursor",
  );
  expect(html).toContain("request&quot;&gt;&lt;script&gt;");
  expect(html).toContain(encodeURIComponent("opaque / + cursor"));
  expect(html).toContain("metadata only");
});
it("WFREV-07 empty history has no invented continuation", () => {
  const html = workflowReviewHistoryPage([], null);
  expect(html).toContain("No private review requests on this page");
  expect(html).not.toContain("Next private review requests");
});
it.each([
  undefined,
  { operationId: "key" },
  { operationId: "key", checked: 'source"><script>' },
  { operationId: "key", requestId: 'request"><script>' },
])(
  "WFREV-06 recovery preserves only provided original instructions %j without automatic dispatch",
  (original) => {
    const html = workflowReviewRecoveryPage(
      "Failure <script>",
      "csrf",
      original,
    );
    expect(html).toContain("Failure &lt;script&gt;");
    expect(html).toContain("no automatic retry");
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
    if (original)
      expect(html).toContain(
        'action="/workflow-feedback/review/inspect" target="_blank" rel="noopener"',
      );
    else
      expect(html).not.toContain('action="/workflow-feedback/review/inspect"');
    if (original && "checked" in original) {
      expect(html).toContain('action="/workflow-feedback/review/request"');
      expect(html).toContain("source&quot;&gt;&lt;script&gt;");
    }
    if (original && "requestId" in original) {
      expect(html).toContain('action="/workflow-feedback/review/withdraw"');
      expect(html).toContain("request&quot;&gt;&lt;script&gt;");
    }
  },
);
