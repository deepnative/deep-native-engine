import { expect, it } from "vitest";
import {
  supportIntakePage,
  supportIntakeRecoveryPage,
  supportMemberDetailPage,
  supportNoticePage,
  supportOperatorDetailPage,
  supportOperatorWorklistPage,
  supportOwnerHistoryPage,
} from "../../src/support-request-views.ts";
import type {
  SupportMemberDetail,
  SupportOperatorDetail,
} from "../../src/support-requests.ts";
const date = new Date("2026-10-02T12:00:00Z"),
  id = "11111111-1111-4111-8111-111111111111";
const member: SupportMemberDetail = {
  requestId: id,
  receivedAt: date,
  acknowledgedAt: null,
  resolvedAt: null,
  withdrawnAt: null,
  coverageState: "unverified",
  subject: "Invented <subject>",
  body: "  Sample <body>\n",
  replies: { items: [], nextCursor: null },
};
const operator: SupportOperatorDetail = {
  ...member,
  body: member.body!,
  grantId: "grant",
  messages: { items: [], nextCursor: null },
};
const keys = {
  acknowledge: "ack-key",
  reply: "reply-key",
  note: "note-key",
  resolve: "resolve-key",
};
it("makes intake deliberate, bounded and honest before any request exists", () => {
  const html = supportIntakePage("csrf", "receipt-key");
  expect(html).toContain('action="/support"');
  expect(html).toContain('name="idempotencyKey" value="receipt-key"');
  expect(html).toContain('maxlength="120"');
  expect(html).toContain('maxlength="2000"');
  expect(html).toContain('name="synthetic" value="yes" required');
  expect(html).not.toContain(" checked");
  expect(html).not.toContain('role="alert"');
  expect(html).toContain("coverage unverified");
  expect(html).toContain("no response deadline");
});
it("links every invalid field while safely preserving exact attempted text and receipt key", () => {
  const html = supportIntakePage(
    "csrf",
    'key"',
    { subject: '  <img>"', body: "\n</textarea><script>\n", synthetic: true },
    [
      { field: "subject", message: "<subject problem>" },
      { field: "body", message: "body problem" },
      { field: "synthetic", message: "consent problem" },
      { field: "support-form", message: "form problem" },
    ],
  );
  for (const field of ["subject", "body", "synthetic"]) {
    expect(html).toContain(`aria-describedby="${field}-error"`);
    expect(html).toContain(`href="#${field}"`);
  }
  expect(html).toContain('href="#support-form"');
  expect(html).toContain('id="support-form" tabindex="-1"');
  expect(html).toContain('value="  &lt;img&gt;&quot;"');
  expect(html).toContain("\n&lt;/textarea&gt;&lt;script&gt;\n</textarea>");
  expect(html).toContain('value="key&quot;"');
  expect(html).toContain(" checked");
  expect(html).not.toContain("<script>");
});
it("shows bounded empty and populated owner histories with text-free withdrawal receipts", () => {
  expect(supportOwnerHistoryPage({ items: [], nextCursor: null })).toContain(
    "No private support requests on this page",
  );
  const html = supportOwnerHistoryPage({
    items: [
      member,
      {
        ...member,
        withdrawnAt: date,
        subject: "MUST NOT LEAK",
        acknowledgedAt: date,
        resolvedAt: date,
      },
    ],
    nextCursor: "opaque+/=",
  });
  expect(html).toContain("Invented &lt;subject&gt;");
  expect(html).not.toContain("MUST NOT LEAK");
  expect(html).toContain("Withdrawn request");
  expect(html).toContain("Acknowledged locally");
  expect(html).toContain("Resolved locally");
  expect(html).toContain('datetime="2026-10-02T12:00:00.000Z"');
  expect(html).toContain("/support?after=opaque%2B%2F%3D");
  expect(html).toContain("at most 20");
});
it("renders only member-visible replies and retains independent acknowledgement and resolution", () => {
  const empty = supportMemberDetailPage(member, "csrf");
  expect(empty).toContain("No separate acknowledgement recorded");
  expect(empty).toContain("Open; no resolution recorded");
  expect(empty).toContain("No member-visible reply");
  const html = supportMemberDetailPage(
    {
      ...member,
      resolvedAt: date,
      replies: {
        items: [
          {
            id: "reply",
            body: "  <reply>\n",
            attribution: "Synthetic operator",
            createdAt: date,
          },
        ],
        nextCursor: "cursor",
      },
    },
    "csrf",
  );
  expect(html).toContain("Synthetic operator");
  expect(html).toContain("  &lt;reply&gt;\n</pre>");
  expect(html).toContain(`/support/${id}?after=cursor`);
  expect(html).toContain("No separate acknowledgement recorded");
  expect(html).toContain("does not establish member satisfaction");
  expect(html).toContain("Withdraw request text");
  expect(html).not.toContain("Internal note");
  expect(html).not.toContain("grantId");
});
it("suppresses all content, replies and forms for a withdrawn member receipt", () => {
  const html = supportMemberDetailPage(
    {
      ...member,
      withdrawnAt: date,
      replies: {
        items: [
          {
            id: "reply",
            body: "PRIVATE REPLY",
            attribution: "Synthetic operator",
            createdAt: date,
          },
        ],
        nextCursor: "PRIVATE CURSOR",
      },
    },
    "csrf",
  );
  for (const text of [
    "Invented",
    "Sample",
    "PRIVATE REPLY",
    "PRIVATE CURSOR",
    "<form",
  ])
    expect(html).not.toContain(text);
  expect(html).toContain("content-free receipt remains");
  expect(html).toContain("/member/export");
});
it("provides only exact-granted operator navigation with bounded worklist pages", () => {
  expect(
    supportOperatorWorklistPage({ items: [], nextCursor: null }),
  ).toContain("No currently granted requests");
  const html = supportOperatorWorklistPage({
    items: [operator],
    nextCursor: "operator cursor",
  });
  expect(html).toContain(`/operator/support/${id}?grant=grant`);
  expect(html).toContain("after=operator%20cursor");
  expect(html).toContain("Opening a request does not acknowledge it");
});
it("keeps acknowledgement, internal notes, member replies and resolution as separate deliberate actions", () => {
  const html = supportOperatorDetailPage(operator, "csrf", keys);
  for (const path of ["acknowledge", "notes", "replies", "resolve"])
    expect(html).toContain(`action="/operator/support/${id}/${path}"`);
  for (const key of Object.values(keys))
    expect(html).toContain(`name="idempotencyKey" value="${key}"`);
  expect(html).toContain("Internal note—staff only");
  expect(html).toContain("Reply visible to member");
  expect(html).toContain("No operator messages on this page");
  expect(html).toContain("No separate acknowledgement recorded");
  const acknowledged = supportOperatorDetailPage(
    { ...operator, acknowledgedAt: date },
    "csrf",
    keys,
  );
  expect(acknowledged).not.toContain(
    `action="/operator/support/${id}/acknowledge"`,
  );
  expect(acknowledged).toContain('action="/operator/support/');
});
it.each(["reply", "note"] as const)(
  "safely preserves an invalid %s only in its own form with an accessible error",
  (kind) => {
    const html = supportOperatorDetailPage(operator, "csrf", keys, {
      kind,
      body: "\n</textarea><img>\n",
      message: "<invalid message>",
    });
    expect(html).toContain(`href="#${kind}-body"`);
    expect(html).toContain(`aria-describedby="${kind}-error"`);
    expect(html).toContain("\n&lt;/textarea&gt;&lt;img&gt;\n</textarea>");
    expect(html).not.toContain("<img>");
    const other = kind === "reply" ? "note" : "reply";
    expect(html).toContain(
      `id="${other}-body" name="body" maxlength="2000" rows="5" required></textarea>`,
    );
  },
);
it("labels mixed staff history, pages with its exact grant, and makes resolved requests read-only", () => {
  const html = supportOperatorDetailPage(
    {
      ...operator,
      resolvedAt: date,
      messages: {
        items: [
          {
            id: "1",
            kind: "reply",
            body: "Visible <reply>",
            attribution: "Synthetic operator",
            createdAt: date,
          },
          {
            id: "2",
            kind: "internal-note",
            body: "Private <note>",
            attribution: "Synthetic operator",
            createdAt: date,
          },
        ],
        nextCursor: "next",
      },
    },
    "csrf",
    keys,
  );
  expect(html).toContain('data-support-message="reply"');
  expect(html).toContain('data-support-message="internal-note"');
  expect(html).toContain("Private &lt;note&gt;");
  expect(html).toContain(`?grant=grant&amp;after=next`);
  expect(html).toContain("This request cannot be reopened");
  expect(html).not.toContain("<form");
  expect(html).toContain("No separate acknowledgement recorded");
});
it("makes uncertain intake recovery read-only, retains its exact receipt key, and escapes all text", () => {
  const html = supportIntakeRecoveryPage(
    "original/key",
    { subject: "<subject>", body: "</textarea><script>", synthetic: true },
    "<uncertain>",
  );
  expect(html).toContain("/support/receipts/original%2Fkey");
  expect(html).toContain("readonly");
  expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;");
  expect(html).not.toContain("<form");
  expect(html).toContain("Nothing is submitted automatically");
  const error = supportNoticePage(
    "<title>",
    "<message>",
    '/support?after="',
    "<label>",
  );
  expect(error).toContain("&lt;title&gt;");
  expect(error).toContain("&lt;message&gt;");
  expect(error).toContain("&lt;label&gt;");
  expect(error).toContain("after=&quot;");
});
