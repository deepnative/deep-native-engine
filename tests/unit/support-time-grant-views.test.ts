import { expect, it } from "vitest";
import {
  supportMinuteForm,
  supportMinuteCheck,
  supportMinuteReceipt,
  supportMinuteHistory,
  supportMinuteRecovery,
} from "../../src/support-time-grant-views.ts";
import type { SupportMinuteRow } from "../../src/support-time-grant-values.ts";
const key = "PRIVATE-REPLAY-KEY",
  input = {
    requestId: "request",
    allocationId: "allocation",
    operatorId: "reviewer",
    operationId: key,
    startsAt: "start",
    expiresAt: "end",
  },
  row: SupportMinuteRow = {
    ...input,
    grantId: "grant",
    role: "operator",
    allocationState: "allocated",
    ceiling: 20,
    createdAt: "created",
    revokedAt: null,
    state: "active",
    sourceAvailable: true,
    canRevoke: true,
  };
it("SUPPORT-GRANT-01/02 gives exact references and explicit finite confirmation without visible replay identity", () => {
  expect(supportMinuteForm("csrf", true)).toContain("Check exact references");
  const paused = supportMinuteForm("csrf", false);
  expect(paused).toContain("Recovery-only");
  expect(paused).not.toContain("Check exact references");
  expect(paused).toContain('type="password"');
  const check = supportMinuteCheck(
    {
      ...input,
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
it("SUPPORT-GRANT-04/07 renders safe exact receipt and retained unavailable history", () => {
  expect(
    supportMinuteReceipt(row, "csrf", key, "<unsafe>", {
      revocationReceiptId: "revoke-receipt",
      outcome: "revoked",
    }),
  ).toContain("data-support-time-revocation-reference");
  expect(supportMinuteReceipt(row, "csrf", key, "<unsafe>")).toContain(
    "&lt;unsafe&gt;",
  );
  expect(supportMinuteReceipt(row, "csrf", key)).toContain(
    "Revoke this exact permission",
  );
  const revoked = supportMinuteReceipt(
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
  expect(supportMinuteHistory({ rows: [row], next: "token" })).toContain(
    "Next permissions",
  );
  expect(supportMinuteHistory({ rows: [], next: null })).toContain(
    "No retained permissions",
  );
});
it("SUPPORT-GRANT-06 retains exact hidden create/revoke operations with deliberate new-tab inspection and no automatic replay", () => {
  expect(supportMinuteRecovery("Unknown <source>", "csrf")).toContain(
    "Unknown &lt;source&gt;",
  );
  for (const kind of ["grant", "revoke"] as const) {
    const html = supportMinuteRecovery(
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
it("SUPPORT-GRANT-08 support write pause retains readback while hiding grant and revoke controls", () => {
  const form = supportMinuteForm("csrf", false, false);
  expect(form).toContain("Support writes are paused");
  expect(form).not.toContain("Check exact references");
  expect(form).toContain("Inspect saved permission");
  const receipt = supportMinuteReceipt(
    row,
    "csrf",
    key,
    undefined,
    undefined,
    false,
  );
  expect(receipt).toContain("Support permission writes are paused");
  expect(receipt).not.toContain("Revoke this exact permission");
});
