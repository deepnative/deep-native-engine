import { expect, it } from "vitest";
import {
  reviewGrantForm,
  reviewGrantCheck,
  reviewGrantReceipt,
  reviewGrantHistory,
  reviewGrantRecovery,
} from "../../src/review-time-grant-views.ts";
import type { ReviewGrantRow } from "../../src/review-time-grant-values.ts";
const key = "PRIVATE-REPLAY-KEY",
  input = {
    allocationId: "allocation",
    reviewerId: "reviewer",
    operationId: key,
    startsAt: "start",
    expiresAt: "end",
  },
  row: ReviewGrantRow = {
    ...input,
    grantId: "grant",
    sourceRevision: 1,
    allocationState: "allocated",
    ceiling: 20,
    createdAt: "created",
    revokedAt: null,
    state: "active",
    sourceAvailable: true,
    canRevoke: true,
  };
it("REVIEW-GRANT-01/02 gives exact references and explicit finite confirmation without visible replay identity", () => {
  expect(reviewGrantForm("csrf", true)).toContain("Check exact references");
  const paused = reviewGrantForm("csrf", false);
  expect(paused).toContain("Recovery-only");
  expect(paused).not.toContain("Check exact references");
  expect(paused).toContain('type="password"');
  const check = reviewGrantCheck(
    {
      ...input,
      sourceRevision: 1,
      ceiling: 20,
      allocationState: "allocated",
      authorityExpiresAt: "end",
    },
    "csrf",
    key,
  );
  expect(check).toContain("I confirm this exact finite permission");
  expect(check).toContain(`name="operationId" value="${key}"`);
  expect(check).not.toContain(`>${key}<`);
  expect(check).not.toMatch(/<input[^>]*name="confirm"[^>]*checked/);
});
it("REVIEW-GRANT-04/07 renders safe exact receipt and retained unavailable history", () => {
  expect(
    reviewGrantReceipt(row, "csrf", key, "<unsafe>", {
      revocationReceiptId: "revoke-receipt",
      outcome: "revoked",
    }),
  ).toContain("data-review-time-revocation-reference");
  expect(reviewGrantReceipt(row, "csrf", key, "<unsafe>")).toContain(
    "&lt;unsafe&gt;",
  );
  expect(reviewGrantReceipt(row, "csrf", key)).toContain(
    "Revoke this exact permission",
  );
  const revoked = reviewGrantReceipt(
    {
      ...row,
      state: "revoked",
      revokedAt: "revoked",
      sourceAvailable: false,
      canRevoke: false,
    },
    "csrf",
    key,
  );
  expect(revoked).toContain("source is unavailable");
  expect(revoked).not.toContain("Revoke this exact permission");
  expect(reviewGrantHistory({ rows: [row], next: "token" })).toContain(
    "Next permissions",
  );
  expect(reviewGrantHistory({ rows: [], next: null })).toContain(
    "No retained permissions",
  );
});
it("REVIEW-GRANT-06 retains exact hidden create/revoke operations with deliberate new-tab inspection and no automatic replay", () => {
  expect(reviewGrantRecovery("Unknown <source>", "csrf")).toContain(
    "Unknown &lt;source&gt;",
  );
  for (const kind of ["grant", "revoke"] as const) {
    const html = reviewGrantRecovery(
      "Unknown",
      "csrf",
      kind === "grant"
        ? { kind, input }
        : { kind, input: { grantId: "grant", operationId: key } },
    );
    expect(html).toContain('target="_blank" rel="noopener"');
    expect(html).toContain(
      kind === "grant"
        ? "Retry this exact permission"
        : "Retry this exact revocation",
    );
    expect(html).not.toContain(`>${key}<`);
    expect(html).not.toMatch(/<input[^>]*name="confirm"[^>]*checked/);
  }
});
