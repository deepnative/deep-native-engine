import { expect, it } from "vitest";
import {
  sampleAssignmentForm,
  sampleAssignmentCheck,
  sampleAssignmentHistory,
  sampleAssignmentReceipt,
  sampleAssignmentRecovery,
  reviewerSampleReference,
} from "../../src/sample-assignment-views.ts";
import {
  SAMPLE_ASSIGNMENT_PATH as base,
  type SampleAssignmentInput,
  type SampleAssignmentRow,
} from "../../src/sample-assignment-values.ts";

const input: SampleAssignmentInput = {
  evidenceId: 'sample/<"',
  sourceRevision: 2,
  reviewerId: 'reviewer/<"',
  operationId: 'original/<"',
  startsAt: "2026-10-06T12:00:00.000Z",
  expiresAt: "2026-10-06T13:00:00.000Z",
};
const row: SampleAssignmentRow = {
  ...input,
  exactGrantId: 'grant/<"',
  receiptId: 'receipt/<"',
  createdAt: input.startsAt,
  revokedAt: null,
  state: "active",
  canRevoke: true,
};
function withSecrets<T>(value: T) {
  return {
    ...value,
    title: "PRIVATE_TITLE",
    credential: "SECRET",
    memberId: "PRIVATE_MEMBER",
    source: "PRIVATE_SOURCE",
    feedback: "PRIVATE_FEEDBACK",
  };
}
function formAt(html: string, action: string) {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)];
  const result = forms.find(([form]) => form.includes(`action="${action}"`));
  expect(result, `Expected user form for ${action}`).toBeDefined();
  return result![0];
}
function inputAt(html: string, name: string) {
  const tag = [...html.matchAll(/<input\b[^>]*>/g)].find(([tag]) =>
    tag.includes(`name="${name}"`),
  );
  expect(tag, `Expected input ${name}`).toBeDefined();
  return tag![0];
}
function fieldValue(html: string, name: string, encodedValue: string) {
  expect(inputAt(html, name)).toContain(`value="${encodedValue}"`);
}
function unchecked(html: string) {
  expect(html).not.toMatch(/<input\b[^>]*\bchecked(?:\s|=|>)/);
}

it("REVADM-01 offers exact references without directories or authority overrides", () => {
  const html = sampleAssignmentForm('csrf"<');
  expect(html).toContain("<h1>Assign private sample feedback</h1>");
  const check = formAt(html, `${base}/check`);
  expect(check).toContain('method="post"');
  expect(check).toContain('name="csrf" value="csrf&quot;&lt;"');
  for (const name of ["evidenceId", "sourceRevision", "reviewerId"])
    expect(check).toContain(`name="${name}"`);
  for (const name of [
    "actor",
    "memberId",
    "workspaceId",
    "submissionId",
    "role",
    "purpose",
    "deadline",
    "credential",
  ])
    expect(html).not.toContain(`name="${name}"`);
  expect(html).toContain("does not list members, reviewers or private samples");
  expect(formAt(html, `${base}/history`)).toContain('method="get"');
  const recover = formAt(html, `${base}/recover`);
  expect(recover).toContain('method="post"');
  expect(recover).toContain('name="operationId"');
  expect(html).not.toContain("operationId=");
});

it("REVADM-06 preserves only safe attempted references and escapes field errors", () => {
  const html = sampleAssignmentForm(
    "csrf",
    withSecrets(input),
    'Cannot check <sample> "now"',
  );
  fieldValue(html, "evidenceId", "sample/&lt;&quot;");
  fieldValue(html, "sourceRevision", "2");
  fieldValue(html, "reviewerId", "reviewer/&lt;&quot;");
  expect(html).toContain(
    'role="alert">Cannot check &lt;sample&gt; &quot;now&quot;',
  );
  expect(html).not.toContain("PRIVATE_TITLE");
  expect(html).not.toContain("SECRET");
  fieldValue(
    sampleAssignmentForm("csrf", { sourceRevision: 0 }),
    "sourceRevision",
    "0",
  );
});

it("REVADM-02 requires explicit finite confirmation of the exact checked sample and reviewer", () => {
  const html = sampleAssignmentCheck(
    { ...input, sourceStatus: "eligible", reviewerExpiresAt: input.expiresAt },
    'csrf"<',
    input.operationId,
  );
  const form = formAt(html, `${base}/assign`);
  expect(html).toContain("Confirm private sample assignment");
  expect(html).toContain("Maximum reviewer credential expiry");
  expect(form).toContain('name="operationId" value="original/&lt;&quot;"');
  fieldValue(form, "evidenceId", "sample/&lt;&quot;");
  fieldValue(form, "sourceRevision", "2");
  fieldValue(form, "reviewerId", "reviewer/&lt;&quot;");
  expect(form).toContain('name="startsAt"');
  expect(form).toContain('name="expiresAt"');
  expect(form).toContain('name="confirm" value="yes" required');
  unchecked(form);
  expect(form).not.toContain("readonly");
  expect(html).toContain("not qualified review or funded service");
});

it("REVADM-02 preserves a corrected finite window without exposing extra check metadata", () => {
  const html = sampleAssignmentCheck(
    withSecrets({
      ...input,
      sourceStatus: "eligible" as const,
      reviewerExpiresAt: input.expiresAt,
    }),
    "csrf",
    input.operationId,
    { startsAt: 'start/<"', expiresAt: 'end/<"' },
  );
  expect(html).toContain(
    'name="startsAt" type="text" value="start/&lt;&quot;"',
  );
  expect(html).toContain('name="expiresAt" type="text" value="end/&lt;&quot;"');
  expect(html).not.toContain("PRIVATE_TITLE");
  expect(html).not.toContain("PRIVATE_MEMBER");
  unchecked(html);
});

it("REVADM-04/08 exposes content-free exact history and revokes only the selected grant", () => {
  const html = sampleAssignmentHistory(
    {
      evidenceId: input.evidenceId,
      sourceRevision: 2,
      rows: [
        withSecrets({
          ...row,
          state: "expired" as const,
          operationId: "OTHER_KEY",
        }),
      ],
      next: 'cursor+/<"',
    },
    'csrf"<',
  );
  expect(html).toContain('data-exact-grant="grant/&lt;&quot;"');
  expect(html).toContain("expired</dd>");
  expect(html).toContain("receipt/&lt;&quot;");
  const revoke = formAt(html, `${base}/revoke`);
  expect(revoke).toContain('name="exactGrantId" value="grant/&lt;&quot;"');
  fieldValue(revoke, "evidenceId", "sample/&lt;&quot;");
  fieldValue(revoke, "sourceRevision", "2");
  expect(revoke).toContain('name="confirm" value="yes" required');
  unchecked(revoke);
  expect(html).toContain(
    "evidenceId=sample%2F%3C%22&amp;sourceRevision=2&amp;after=cursor%2B%2F%3C%22",
  );
  expect(html).toContain("distinct overlapping grants");
  for (const secret of ["PRIVATE_TITLE", "PRIVATE_FEEDBACK", "OTHER_KEY"])
    expect(html).not.toContain(secret);
});

it("REVADM-08 retains revoked and source-removed receipts without fabricating legacy receipts or authority", () => {
  const html = sampleAssignmentHistory(
    {
      evidenceId: input.evidenceId,
      sourceRevision: 2,
      rows: [
        {
          ...row,
          revokedAt: input.expiresAt,
          state: "revoked",
          canRevoke: false,
        },
        {
          ...row,
          exactGrantId: "legacy",
          receiptId: null,
          state: "removed",
          canRevoke: false,
        },
      ],
      next: null,
    },
    "csrf",
  );
  expect(html).toContain("revoked</dd>");
  expect(html).toContain("removed</dd>");
  expect(html).toContain("No operation receipt (legacy grant)");
  expect(html).not.toContain(`action="${base}/revoke"`);
  expect(html).not.toContain("Next assignments</a>");
  expect(html).toContain("not guaranteed current access");
});

it("REVADM-08 makes an empty historical observation honest and read-only", () => {
  const html = sampleAssignmentHistory(
    { evidenceId: input.evidenceId, sourceRevision: 2, rows: [], next: null },
    "csrf",
  );
  expect(html).toContain("No retained grants or receipts were found");
  expect(html).toContain("does not establish that no write committed");
  expect(html).not.toContain(`action="${base}/revoke"`);
});

it("REVADM-04/08 shows safe receipt state and exact history without keys or source content", () => {
  const html = sampleAssignmentReceipt(
    withSecrets({ ...row, operationId: "PRIVATE_KEY" }),
    'csrf"<',
    "Recorded <observation>",
  );
  expect(html).toContain("Recorded &lt;observation&gt;");
  expect(html).toContain('data-receipt="receipt/&lt;&quot;"');
  expect(html).toContain("active</dd>");
  expect(html).toContain("evidenceId=sample%2F%3C%22&amp;sourceRevision=2");
  expect(formAt(html, `${base}/revoke`)).toContain(
    'name="csrf" value="csrf&quot;&lt;"',
  );
  for (const secret of ["PRIVATE_KEY", "PRIVATE_MEMBER", "PRIVATE_SOURCE"])
    expect(html).not.toContain(secret);
  expect(
    sampleAssignmentReceipt(
      { ...row, state: "ineffective", canRevoke: false },
      "csrf",
    ),
  ).toContain("ineffective</dd>");
});

it("REVADM-05 preserves uncertain original payload and unchecked manual retry while inspecting by POST in a separate tab", () => {
  const html = sampleAssignmentRecovery(
    "Unknown <result>",
    'csrf"<',
    withSecrets(input),
  );
  expect(html).toContain("Unknown &lt;result&gt;");
  expect(html).toContain("may already have committed");
  const inspect = formAt(html, `${base}/recover`);
  expect(inspect).toContain('method="post"');
  expect(inspect).toContain('target="_blank"');
  expect(inspect).toContain('rel="noopener"');
  fieldValue(inspect, "operationId", "original/&lt;&quot;");
  for (const name of [
    "evidenceId",
    "sourceRevision",
    "reviewerId",
    "startsAt",
    "expiresAt",
  ])
    expect(inspect).not.toContain(`name="${name}"`);
  const retry = formAt(html, `${base}/assign`);
  for (const name of [
    "operationId",
    "evidenceId",
    "sourceRevision",
    "reviewerId",
    "startsAt",
    "expiresAt",
  ])
    expect(retry).toContain(`name="${name}"`);
  expect(retry).toContain(
    'value="2026-10-06T12:00:00.000Z" maxlength="24" readonly',
  );
  expect(retry).toContain(
    'value="2026-10-06T13:00:00.000Z" maxlength="24" readonly',
  );
  expect(retry).toContain("Retry this exact assignment");
  unchecked(retry);
  expect(html).not.toContain("operationId=");
  expect(html).not.toContain("SECRET");
  expect(html).not.toContain("PRIVATE_SOURCE");
  expect(html).not.toMatch(
    /<script|localStorage|sessionStorage|http-equiv="refresh"/,
  );
});

it("REVADM-05 does not offer a new write when only an absent-receipt observation is available", () => {
  const html = sampleAssignmentRecovery(
    "No retained receipt was found; this does not establish that no write committed",
    "csrf",
  );
  expect(html).toContain("does not establish that no write committed");
  expect(html).toContain("original form");
  expect(html).not.toContain(`action="${base}/assign"`);
  expect(html).not.toContain('name="operationId"');
});

it("REVADM-01/06 shows only the current reviewer's noncredential reference and escaped expiry", () => {
  const html = reviewerSampleReference(
    withSecrets({ reviewerId: input.reviewerId, expiresAt: 'expiry/<"' }),
  );
  expect(html).toContain("Your reviewer reference");
  expect(html).toContain("data-reviewer-reference>reviewer/&lt;&quot;");
  expect(html).toContain("expiry/&lt;&quot;");
  expect(html).toContain("not a sign-in credential");
  expect(html).not.toContain("SECRET");
  expect(html).not.toContain("PRIVATE_MEMBER");
});
