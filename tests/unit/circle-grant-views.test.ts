import { expect, it } from "vitest";
import {
  circleGrantHomePage,
  circleGrantReferencePage,
  circleGrantConfirmPage,
  circleGrantReceiptPage,
  circleGrantHistoryPage,
  circleGrantNoticePage,
} from "../../src/circle-grant-views.ts";
import type {
  CircleGrantAttempt,
  CircleGrantCheck,
  CircleGrantPage,
  RetainedCircleGrant,
  AbsentCircleGrant,
} from "../../src/circle-grant-values.ts";
const at = new Date("2026-10-06T12:00:00.000Z");
const attempt: CircleGrantAttempt = {
  staffId: 'staff/<"',
  circleId: 'circle/<"',
  idempotencyKey: 'original/key/<"',
  expiresAt: at.toISOString(),
};
const check: CircleGrantCheck = {
  staffId: attempt.staffId,
  circleId: attempt.circleId,
  role: "moderator",
  expiresAt: at,
  creationEnabled: true,
};
const retained: RetainedCircleGrant = {
  ...attempt,
  source: "retained",
  grantId: 'grant/<"',
  role: "moderator",
  purpose: 'purpose/<"',
  createdBy: 'admin/<"',
  startsAt: at,
  expiresAt: at,
  createdAt: at,
  revokedAt: null,
  state: "expired",
};
const absent: AbsentCircleGrant = {
  ...attempt,
  source: "absent",
  grantId: retained.grantId,
  state: "source-absent",
  audit: [
    { action: "created", actorId: 'actor/<"', at },
    { action: "revoked", actorId: "admin", at },
  ],
};
const history: CircleGrantPage = {
  ...attempt,
  observedAt: at,
  items: [retained],
  nextCursor: null,
};
function safe(html: string) {
  expect(html).not.toMatch(/<input\b[^>]*\bchecked(?:\s|=|>)/);
  expect(html).not.toContain("<script");
  expect(html).not.toContain('method="get"');
  for (const href of html.matchAll(/href="([^"]*)"/g))
    expect(href[1]).not.toContain("?");
  expect(html).not.toContain('name="credential"');
  expect(html).not.toContain('name="role"');
  expect(html).not.toContain('name="purpose"');
}
it("CIRADM-01 lets current administrators check an exact target or their own reference without a directory", () => {
  const html = circleGrantHomePage('csrf"<', {
    reference: check,
    creationEnabled: true,
  });
  expect(html).toContain("data-circle-admin>staff/&lt;&quot;");
  expect(html).toContain('value="csrf&quot;&lt;"');
  expect(html).toContain('name="staffId" value="self"');
  expect(html).toContain('id="selfCircleId"');
  expect(html).toContain('action="/operator/circle-grants/check"');
  expect(html).toContain('action="/operator/circle-grants/inspect"');
  expect(html).toContain('action="/operator/circle-grants/history"');
  expect(html).toContain('name="lookupKind"');
  expect(html).toContain('value="key"');
  expect(html).toContain('value="grant"');
  expect(html).toContain(
    "does not list staff, members or private circle content",
  );
  expect(html).not.toContain('name="confirm"');
  safe(html);
});
it("CIRADM-08 keeps protected inspection and history available while suppressing new creation", () => {
  const html = circleGrantHomePage("csrf", {
    reference: check,
    creationEnabled: false,
  });
  expect(html).toContain("Creating circle grants is paused");
  expect(html).not.toContain('action="/operator/circle-grants/check"');
  expect(html).toContain('action="/operator/circle-grants/inspect"');
  expect(html).toContain('action="/operator/circle-grants/history"');
  safe(html);
});
it("CIRADM-01 displays only the current staff member's structural reference", () => {
  const html = circleGrantReferencePage({
    ...check,
    role: "platform_admin",
    credential: "SECRET",
    member: "PRIVATE",
  } as typeof check);
  expect(html).toContain("data-circle-reference>staff/&lt;&quot;");
  expect(html).toContain("platform_admin</dd>");
  expect(html).toContain("not a sign-in credential");
  expect(html).not.toContain("SECRET");
  expect(html).not.toContain("PRIVATE</dd>");
  safe(html);
});
it("CIRADM-02 requires deliberate finite confirmation and fixes the original target, circle and key", () => {
  const html = circleGrantConfirmPage("csrf", check, attempt);
  for (const [name, value] of [
    ["staffId", "staff/&lt;&quot;"],
    ["circleId", "circle/&lt;&quot;"],
    ["idempotencyKey", "original/key/&lt;&quot;"],
  ])
    expect(html).toContain(`name="${name}" value="${value}" readonly required`);
  expect(html).toContain(
    'name="expiresAt" type="text" maxlength="24" value="2026-10-06T12:00:00.000Z" required',
  );
  expect(html).toContain('name="confirm" value="yes" required');
  expect(html).toContain("Access starts at database creation time");
  expect(html).toContain("Fixed moderation purpose: circle-discussion-test-v1");
  expect(html).toContain("Maximum target credential expiry");
  expect(html).toContain("Create this circle grant</button>");
  safe(html);
  const paused = circleGrantConfirmPage(
    "csrf",
    { ...check, creationEnabled: false },
    attempt,
  );
  expect(paused).not.toContain('action="/operator/circle-grants/create"');
  expect(paused).toContain("This check does not create access");
});
it("CIRADM-03 permits exact expired/ineffective grant revocation, preserving unrelated overlapping grants", () => {
  const html = circleGrantReceiptPage(
    "csrf",
    attempt,
    { ...retained, state: "ineffective" },
    attempt.idempotencyKey,
  );
  expect(html).toContain("data-circle-grant>grant/&lt;&quot;");
  expect(html).toContain("ineffective</dd>");
  expect(html).toContain("purpose/&lt;&quot;");
  expect(html).toContain('action="/operator/circle-grants/revoke"');
  expect(html).toContain('name="grantId" value="grant/&lt;&quot;"');
  expect(html).toContain("this exact grant only");
  expect(html).toContain('name="lookupValue" value="original/key/&lt;&quot;"');
  safe(html);
  const revoked = circleGrantReceiptPage("csrf", attempt, {
    ...retained,
    revokedAt: at,
    state: "revoked",
  });
  expect(revoked).toContain("Revoked at (UTC)");
  expect(revoked).toContain("already been revoked");
  expect(revoked).not.toContain('action="/operator/circle-grants/revoke"');
  expect(revoked).not.toContain("Your original submission key");
});
it("CIRADM-04 treats missing inspection as uncertainty and never automatically retries or regenerates a key", () => {
  const html = circleGrantReceiptPage("csrf", attempt, null);
  expect(html).toContain(
    "does not prove that an earlier submission did not commit",
  );
  expect(html).not.toContain('action="/operator/circle-grants/create"');
  safe(html);
  const notice = circleGrantNoticePage(
    "csrf",
    'Unavailable <"',
    attempt,
    attempt,
    true,
  );
  expect(notice).toContain('role="alert">Unavailable &lt;&quot;');
  expect(notice).toContain(
    'action="/operator/circle-grants/inspect" target="_blank" rel="noopener"',
  );
  expect(notice).toContain(
    'name="expiresAt" type="text" maxlength="24" value="2026-10-06T12:00:00.000Z" readonly required',
  );
  expect(notice).toContain("Retry this exact grant</button>");
  expect(notice).toContain("Nothing is retried automatically");
  safe(notice);
});
it("CIRADM-04 retains the instruction without offering an unauthorized retry", () => {
  const html = circleGrantNoticePage("csrf", "Denied", attempt);
  expect(html).toContain("Original expiry</dt>");
  expect(html).toContain("original/key/&lt;&quot;");
  expect(html).not.toContain('action="/operator/circle-grants/create"');
  expect(html).toContain('action="/operator/circle-grants/inspect"');
  safe(html);
  const plain = circleGrantNoticePage("csrf", "Denied");
  expect(plain).not.toContain("Original expiry");
  expect(plain).not.toContain('action="/operator/circle-grants/inspect"');
  safe(plain);
});
it("CIRADM-06 binds continuation to exact staff/circle through POST and shows states only as observations", () => {
  const html = circleGrantHistoryPage("csrf", {
    ...history,
    nextCursor: 'cursor/+<"',
    items: [retained, { ...retained, grantId: "second", state: "future" }],
  });
  expect(html).toContain("At most 20 grants per page");
  expect(html).toContain("preserves distinct overlapping grants");
  expect(html).toContain('name="after" value="cursor/+&lt;&quot;"');
  expect(html).toContain('name="staffId" value="staff/&lt;&quot;"');
  expect(html).toContain('name="circleId" value="circle/&lt;&quot;"');
  expect(html).toContain("future</dd>");
  expect(html).toContain("do not guarantee future access");
  safe(html);
  const empty = circleGrantHistoryPage("csrf", { ...history, items: [] });
  expect(empty).toContain("unknown outcome");
  expect(empty).not.toContain("Next grants");
  expect(empty).not.toContain('action="/operator/circle-grants/revoke"');
});
it("CIRADM-07 displays only surviving audit facts for erased sources without reconstructing missing role/key/window", () => {
  const html = circleGrantReceiptPage("csrf", attempt, {
    ...absent,
    purpose: "PRIVATE_PURPOSE",
    role: "PRIVATE_ROLE",
    expiresAt: at,
    idempotencyKey: "ERASED_KEY",
  } as AbsentCircleGrant);
  expect(html).toContain("source-absent</dd>");
  expect(html).toContain("created by actor/&lt;&quot;");
  expect(html).toContain("revoked by admin");
  expect(html).toContain("cannot be reconstructed");
  for (const text of [
    "PRIVATE_PURPOSE",
    "PRIVATE_ROLE",
    "ERASED_KEY",
    "Expires at (UTC)",
    'action="/operator/circle-grants/revoke"',
  ])
    expect(html).not.toContain(text);
  safe(html);
  expect(
    circleGrantHistoryPage("csrf", { ...history, items: [absent] }),
  ).toContain("source-absent</dd>");
});
