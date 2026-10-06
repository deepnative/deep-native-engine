import { expect, it } from "vitest";
import {
  assignmentHomePage,
  assignmentReferencePage,
  assignmentConfirmPage,
  assignmentHistoryPage,
  assignmentReceiptPage,
  assignmentNoticePage,
  type AssignmentAttempt,
} from "../../src/support-assignment-views.ts";
import type { AssignmentHistory } from "../../src/support-assignment.ts";
const at = new Date("2026-10-06T12:00:00.000Z");
const attempt: AssignmentAttempt = {
  requestId: 'request/<"',
  staffId: 'operator/<"',
  idempotencyKey: 'original/key<"',
  startsAt: "2026-10-06T12:00:00.000Z",
  expiresAt: "2026-10-06T13:00:00.000Z",
};
it("lets administrators check only exact references and inspect without choosing an authority or directory", () => {
  const html = assignmentHomePage('csrf"<');
  expect(html).toContain(
    'method="post" action="/operator/support-assignment/check"',
  );
  expect(html).toContain(
    'method="get" action="/operator/support-assignment/history"',
  );
  expect(html).toContain('value="csrf&quot;&lt;"');
  expect(html).toContain("Original submission key (optional)");
  for (const field of ["actor", "role", "purpose", "workspace", "credential"])
    expect(html).not.toContain(`name="${field}"`);
  expect(html).toContain(
    "does not list members, operators or private requests",
  );
});
it("shows only the operator's own noncredential reference and finite expiry", () => {
  const html = assignmentReferencePage({
    staffId: attempt.staffId,
    expiresAt: at,
    token: "SECRET",
    memberId: "PRIVATE_MEMBER",
  } as Parameters<typeof assignmentReferencePage>[0]);
  expect(html).toContain("data-assignment-id>operator/&lt;&quot;");
  expect(html).toContain("not a sign-in credential");
  expect(html.match(/>2026-10-06T12:00:00.000Z</g)).toHaveLength(1);
  expect(html).not.toContain("SECRET");
  expect(html).not.toContain("PRIVATE_MEMBER");
});
it("requires deliberate finite confirmation while preserving exact escaped references and key", () => {
  const html = assignmentConfirmPage('csrf"<', attempt, at);
  expect(html).toContain("Maximum operator credential expiry");
  expect(html).toContain(
    'name="idempotencyKey" value="original/key&lt;&quot;"',
  );
  expect(html).toContain('name="requestId" value="request/&lt;&quot;"');
  expect(html).toContain('name="staffId" value="operator/&lt;&quot;"');
  expect(html).toContain('name="confirm" value="yes" required');
  expect(html).toContain("Assign this request</button>");
  expect(html).not.toMatch(/<input\b[^>]*\bchecked(?:\s|=|>)/);
  expect(html).not.toContain("readonly");
  expect(
    assignmentConfirmPage("csrf", { ...attempt, startsAt: "", expiresAt: "" }),
  ).not.toContain("Maximum operator credential expiry");
});
const history: AssignmentHistory = {
  requestId: attempt.requestId,
  observedAt: at,
  withdrawn: false,
  nextCursor: null,
  items: [
    {
      grantId: 'grant/<"',
      requestId: attempt.requestId,
      staffId: attempt.staffId,
      role: "operator",
      startsAt: at,
      expiresAt: at,
      createdAt: at,
      revokedAt: null,
      state: "expired",
    },
  ],
};
it("keeps history content-free, revokes expired/ineffective grants explicitly and encodes bounded continuation", () => {
  const html = assignmentHistoryPage(
    "csrf",
    {
      ...history,
      nextCursor: 'cursor+/<"',
      items: [
        {
          ...history.items[0]!,
          state: "ineffective",
          subject: "PRIVATE_SUBJECT",
          memberId: "PRIVATE_MEMBER",
          key: "OTHER_ADMIN_KEY",
        } as AssignmentHistory["items"][number],
      ],
    },
    attempt.idempotencyKey,
  );
  expect(html).toContain('data-grant="grant/&lt;&quot;"');
  expect(html).toContain("ineffective</dd>");
  expect(html).toContain("Assigned staff reference</dt>");
  expect(
    assignmentHistoryPage("csrf", {
      ...history,
      items: [{ ...history.items[0]!, role: "platform_admin" }],
    }),
  ).toContain("platform_admin</dd>");
  expect(html).toContain(
    'method="post" action="/operator/support-assignment/revoke"',
  );
  expect(html).toContain('name="grantId" value="grant/&lt;&quot;"');
  expect(html).toContain('name="confirm" value="yes" required');
  expect(html).toContain(
    "requestId=request%2F%3C%22&amp;key=original%2Fkey%3C%22&amp;after=cursor%2B%2F%3C%22",
  );
  expect(html).toContain("Viewing history does not change grants");
  for (const secret of ["PRIVATE_SUBJECT", "PRIVATE_MEMBER", "OTHER_ADMIN_KEY"])
    expect(html).not.toContain(secret);
  expect(assignmentHistoryPage("csrf", history)).toContain("expired</dd>");
});
it("makes withdrawn/revoked history and empty observations honest without reactivating authority", () => {
  const html = assignmentHistoryPage("csrf", {
    ...history,
    withdrawn: true,
    items: [{ ...history.items[0]!, state: "revoked", revokedAt: at }],
  });
  expect(html).toContain("request has been withdrawn");
  expect(html).toContain("already been revoked");
  expect(html).not.toContain('action="/operator/support-assignment/revoke"');
  expect(html).not.toContain("Next assignments");
  const empty = assignmentHistoryPage("csrf", { ...history, items: [] });
  expect(empty).toContain("No saved assignments found on this observation");
  expect(empty).toContain(
    "earlier unconfirmed request may still need inspection",
  );
  expect(empty).not.toContain("<form");
});
it("shows only the saved receipt and exact own-key inspection without automatic action", () => {
  const html = assignmentReceiptPage(
    'Recorded <"',
    { requestId: attempt.requestId, grantId: 'grant/<"' },
    attempt.idempotencyKey,
  );
  expect(html).toContain("Recorded &lt;&quot;");
  expect(html).toContain("data-assignment-grant>grant/&lt;&quot;");
  expect(html).toContain(
    "requestId=request%2F%3C%22&amp;key=original%2Fkey%3C%22",
  );
  expect(html).not.toContain("<form");
  expect(
    assignmentReceiptPage("Revoked", {
      requestId: "request",
      grantId: "grant",
    }),
  ).not.toContain("Your original submission key");
});
it("preserves possibly committed payload for an unchecked explicit retry after exact-key inspection", () => {
  const html = assignmentNoticePage(
    'Possibly committed <"',
    { requestId: attempt.requestId, key: attempt.idempotencyKey },
    attempt,
    'csrf"<',
  );
  expect(html).toContain("Possibly committed &lt;&quot;");
  expect(html).toContain("Inspect its saved state first");
  expect(html).toContain(
    'name="idempotencyKey" value="original/key&lt;&quot;"',
  );
  expect(html).toContain(
    'name="startsAt" type="text" value="2026-10-06T12:00:00.000Z" maxlength="24" readonly required',
  );
  expect(html).toContain(
    'name="expiresAt" type="text" value="2026-10-06T13:00:00.000Z" maxlength="24" readonly required',
  );
  expect(html).toContain("Retry this exact assignment</button>");
  expect(html).not.toMatch(/<input\b[^>]*\bchecked(?:\s|=|>)/);
  expect(html).not.toContain("setTimeout");
  expect(html).not.toContain("http-equiv");
});
it("keeps unavailable states read-only without a complete validated retry context", () => {
  for (const html of [
    assignmentNoticePage("Unavailable"),
    assignmentNoticePage("Unavailable", { requestId: "request" }),
    assignmentNoticePage("Unavailable", undefined, attempt),
  ]) {
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Retry this exact assignment");
    expect(html).toContain("Support assignment unavailable");
  }
  expect(
    assignmentNoticePage("Unavailable", { requestId: "request" }),
  ).toContain('href="/operator/support-assignment/history?requestId=request"');
});
