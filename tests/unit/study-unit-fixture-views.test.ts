import { expect, it } from "vitest";
import {
  studyFixtureMemberPage,
  studyFixtureStaffPage,
  studyFixtureConfirmation,
  studyFixtureReceiptPage,
  studyFixtureNotice,
  studyFixtureUncommitted,
  type StudyFixtureAttempt,
} from "../../src/study-unit-fixture-views.ts";
import type { StudyFixtureReceipt } from "../../src/study-unit-fixture-values.ts";
const now = new Date("2026-10-08T13:00:00Z");
const receipt: StudyFixtureReceipt = {
  id: "<invented-request>",
  policy: "browser-study-fixture-v1",
  administratorId: "<invented-administrator>",
  createdAt: now,
  expiresAt: new Date("2026-10-08T13:30:00Z"),
  grantId: null,
  issuedAt: null,
  grantExpiresAt: null,
  withdrawnAt: null,
};
it("offers a deliberate exact-reference request without a directory, automatic allowance or checked confirmation", () => {
  const html = studyFixtureMemberPage("a".repeat(64), null, true, now);
  expect(html).toContain('name="administratorId"');
  expect(html).toContain("exactly three study requests");
  expect(html).toContain("no administrator directory");
  expect(html).toContain(`name="csrf" value="${"a".repeat(64)}"`);
  expect(html).not.toContain('<input type="checkbox"');
});
it("pauses new requests while explaining the retained owner actions", () => {
  const html = studyFixtureMemberPage("csrf", null, false, now);
  expect(html).toContain("issuance are paused");
  expect(html).toContain("account erasure remain available");
  expect(html).not.toContain('name="administratorId"');
});
it("keeps an original receipt and withdrawal available even when creation is paused", () => {
  const html = studyFixtureMemberPage("csrf", receipt, false, now);
  expect(html).toContain("&lt;invented-request&gt;");
  expect(html).toContain("pending");
  expect(html).toContain("Review fixture withdrawal");
  expect(html).not.toContain("<invented-request>");
  const withdrawn = studyFixtureMemberPage(
    "csrf",
    { ...receipt, withdrawnAt: now },
    true,
    now,
  );
  expect(withdrawn).toContain("cancelled");
  expect(withdrawn).not.toContain("Review fixture withdrawal");
});
it.each([true, false])(
  "lets the administrator deliberately share only a noncredential reference, including paused=%s",
  (enabled) => {
    const html = studyFixtureStaffPage("csrf", "<reference>", enabled);
    expect(html).toContain("&lt;reference&gt;");
    expect(html).toContain("does not sign anyone in");
    expect(html).toContain("Member-supplied request reference");
    expect(html.includes("issuance are paused")).toBe(!enabled);
  },
);
for (const kind of ["request", "issue", "withdraw"] as const) {
  const attempt: StudyFixtureAttempt = {
    kind,
    key: "<original-key>",
    checked: {
      policy: "browser-study-fixture-v1",
      requestId: "<exact-source>",
      unfamiliar: "<private-test>",
    },
  };
  it(`requires initially unchecked explicit ${kind} confirmation with original scope and escaped fields`, () => {
    const html = studyFixtureConfirmation("csrf", attempt);
    const base =
      kind === "issue"
        ? "/operator/study-test-units"
        : "/member/test-unit-request";
    expect(html).toContain(`action="${base}/${kind}"`);
    expect(html).toContain(
      'type="checkbox" name="confirm" value="yes" required',
    );
    expect(html).not.toContain('value="yes" checked');
    expect(html).toContain("&lt;original-key&gt;");
    expect(html).toContain("&lt;exact-source&gt;");
    expect(html).toContain("Exact reference");
    expect(html).not.toContain("<private-test>");
    expect(html.includes("Held and consumed history stays intact")).toBe(
      kind === "withdraw",
    );
  });
  it(`offers ${kind} inspection after uncertainty without automatic dispatch or a renewed key`, () => {
    const html = studyFixtureNotice("csrf", "<unavailable>", attempt);
    expect(html).toContain("&lt;unavailable&gt;");
    expect(html).toContain("Inspect original operation");
    expect(html).toContain("&lt;original-key&gt;");
    expect(html).not.toContain('name="confirm"');
    const recovery = studyFixtureUncommitted("csrf", attempt);
    expect(recovery).toContain("No owned receipt was found");
    expect(recovery).toContain("original finite deadline");
    expect(recovery).toContain("&lt;original-key&gt;");
    expect(recovery).not.toContain('value="yes" checked');
  });
}
it("uses generic unavailability without leaking attempted fields when no original instruction exists", () => {
  const html = studyFixtureNotice("csrf", "<unavailable>");
  expect(html).toContain("&lt;unavailable&gt;");
  expect(html).not.toContain("Inspect original operation");
});
it.each([true, false])(
  "shows immutable issued and withdrawn dates with role-appropriate navigation for staff=%s",
  (staff) => {
    const html = studyFixtureReceiptPage(
      {
        ...receipt,
        grantId: "invented-grant",
        issuedAt: now,
        grantExpiresAt: new Date("2026-10-08T13:15:00Z"),
        withdrawnAt: now,
      },
      now,
      staff,
    );
    expect(html).toContain("withdrawn");
    expect(html).toContain("2026-10-08T13:15:00.000Z");
    expect(html).toContain("Owner withdrawal");
    expect(html.includes("Export your retained records")).toBe(!staff);
    expect(html.includes("Local issuance work")).toBe(staff);
  },
);
