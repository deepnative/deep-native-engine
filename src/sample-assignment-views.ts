import { escape, hidden, page } from "./views.ts";
import {
  SAMPLE_ASSIGNMENT_PATH as base,
  SAMPLE_ASSIGNMENT_PAGE_SIZE,
  type SampleAssignmentCheck,
  type SampleAssignmentHistory,
  type SampleAssignmentInput,
  type SampleAssignmentReferences,
  type SampleAssignmentRow,
  type SampleAssignmentSource,
  type SampleReviewerReference,
} from "./sample-assignment-values.ts";

const notice = `<p class="eyebrow">PRIVATE LOCAL SAMPLE FEEDBACK</p><p>This assigns access to one exact invented sample version. It is not qualified review or funded service. It does not provide staff credentials, review minutes or access to other samples.</p>`;
const navigation = `<p><a href="${base}">Private sample assignments</a> · <a href="/staff">Your staff tools</a> · <a href="/learn">Your learning space</a></p>`;
const alert = (message: string) => `<p role="alert">${escape(message)}</p>`;
const time = (value: string) =>
  `<time datetime="${escape(value)}">${escape(value)}</time>`;
const field = (name: string, value: string | number) =>
  `<input type="hidden" name="${name}" value="${escape(String(value))}">`;
function sourceFields(source: SampleAssignmentSource) {
  return (
    field("evidenceId", source.evidenceId) +
    field("sourceRevision", source.sourceRevision)
  );
}
function historyPath(source: SampleAssignmentSource, after?: string) {
  const query = `evidenceId=${encodeURIComponent(source.evidenceId)}&sourceRevision=${encodeURIComponent(String(source.sourceRevision))}`;
  return `${base}/history?${query}${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`;
}
function recoveryForm(csrf: string, operationId?: string) {
  return `<form method="post" action="${base}/recover" target="_blank" rel="noopener">${hidden(escape(csrf))}<label for="recoverOperationId">Original operation key</label><input id="recoverOperationId" name="operationId" type="text" value="${escape(operationId ?? "")}" maxlength="36"${operationId === undefined ? "" : " readonly"} required><p>Inspect only your own original operation key. Inspection creates no assignment and opens a separate tab so the original retry form stays available.</p><button type="submit">Inspect saved assignment in a new tab</button></form>`;
}
function assignmentForm(
  csrf: string,
  input: SampleAssignmentInput,
  retry: boolean,
) {
  return `<form method="post" action="${base}/assign">${hidden(escape(csrf))}${sourceFields(input)}${field("reviewerId", input.reviewerId)}${field("operationId", input.operationId)}<dl><dt>Exact sample ID</dt><dd>${escape(input.evidenceId)}</dd><dt>Exact source version</dt><dd>${escape(String(input.sourceRevision))}</dd><dt>Reviewer reference</dt><dd>${escape(input.reviewerId)}</dd><dt>Original operation key</dt><dd>${escape(input.operationId)}</dd></dl><label for="startsAt">Starts at (UTC)</label><input id="startsAt" name="startsAt" type="text" value="${escape(input.startsAt)}" maxlength="24"${retry ? " readonly" : ""} required><label for="expiresAt">Expires at (UTC)</label><input id="expiresAt" name="expiresAt" type="text" value="${escape(input.expiresAt)}" maxlength="24"${retry ? " readonly" : ""} required><p>Use exact UTC timestamps ending in Z, including milliseconds. The finite window must not exceed the reviewer's current credential expiry. Current permission and authority are checked again on submission; checking these references does not grant access.</p><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I confirm this exact sample, reviewer and finite UTC window.</span></label><button type="submit">${retry ? "Retry this exact assignment" : "Assign private sample feedback"}</button></form>`;
}
function rowDetails(row: SampleAssignmentRow) {
  return `<dl><dt>Exact sample grant ID</dt><dd>${escape(row.exactGrantId)}</dd><dt>Operation receipt</dt><dd${row.receiptId === null ? "" : ` data-receipt="${escape(row.receiptId)}"`}>${row.receiptId === null ? "No operation receipt (legacy grant)" : escape(row.receiptId)}</dd><dt>Exact sample ID</dt><dd>${escape(row.evidenceId)}</dd><dt>Exact source version</dt><dd>${escape(String(row.sourceRevision))}</dd><dt>Reviewer reference</dt><dd>${escape(row.reviewerId)}</dd><dt>Starts at (UTC)</dt><dd>${time(row.startsAt)}</dd><dt>Expires at (UTC)</dt><dd>${time(row.expiresAt)}</dd><dt>Created at (UTC)</dt><dd>${time(row.createdAt)}</dd><dt>Observed state</dt><dd>${escape(row.state)}</dd>${row.revokedAt === null ? "" : `<dt>Revoked at (UTC)</dt><dd>${time(row.revokedAt)}</dd>`}</dl>`;
}
function revokeForm(row: SampleAssignmentRow, csrf: string) {
  return row.canRevoke
    ? `<form method="post" action="${base}/revoke">${hidden(escape(csrf))}${sourceFields(row)}${field("exactGrantId", row.exactGrantId)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I confirm revoking this exact sample grant only.</span></label><button type="submit">Revoke this exact sample grant</button></form>`
    : `<p>This observed historical row has no revocation action available. It does not restore access.</p>`;
}

export function sampleAssignmentForm(
  csrf: string,
  attemptRefs?: Partial<SampleAssignmentReferences>,
  message?: string,
): string {
  return page(
    "Assign private sample feedback",
    `<section class="reading">${notice}<h1>Assign private sample feedback</h1>${message === undefined ? "" : alert(message)}<p>Ask the member for the exact sample ID and version from their private evidence page, and ask the reviewer for their own reviewer reference. This page does not list members, reviewers or private samples.</p><form method="post" action="${base}/check">${hidden(escape(csrf))}<label for="evidenceId">Exact sample ID</label><input id="evidenceId" name="evidenceId" type="text" value="${escape(attemptRefs?.evidenceId ?? "")}" maxlength="36" required><label for="sourceRevision">Exact source version</label><input id="sourceRevision" name="sourceRevision" type="number" min="1" max="20" value="${escape(String(attemptRefs?.sourceRevision ?? ""))}" required><label for="reviewerId">Reviewer reference</label><input id="reviewerId" name="reviewerId" type="text" value="${escape(attemptRefs?.reviewerId ?? "")}" maxlength="36" required><button type="submit">Check exact sample references</button></form><h2>Inspect exact sample history</h2><form method="get" action="${base}/history"><label for="historyEvidenceId">Sample ID to inspect</label><input id="historyEvidenceId" name="evidenceId" type="text" maxlength="36" required><label for="historyRevision">Source version to inspect</label><input id="historyRevision" name="sourceRevision" type="number" min="1" max="20" required><button type="submit">Inspect exact sample history</button></form><h2>Inspect an original operation</h2>${recoveryForm(csrf)}${navigation}</section>`,
  );
}

export function sampleAssignmentCheck(
  check: SampleAssignmentCheck,
  csrf: string,
  operationId: string,
  attemptWindow?: Pick<SampleAssignmentInput, "startsAt" | "expiresAt">,
): string {
  const input: SampleAssignmentInput = {
    evidenceId: check.evidenceId,
    sourceRevision: check.sourceRevision,
    reviewerId: check.reviewerId,
    operationId,
    startsAt: attemptWindow?.startsAt ?? "",
    expiresAt: attemptWindow?.expiresAt ?? "",
  };
  return page(
    "Confirm private sample assignment",
    `<section class="reading">${notice}<h1>Confirm private sample assignment</h1><p>The exact source was eligible at this check. Current consent, safety, source version, reviewer role and finite authority still govern submission and later access.</p><p>Maximum reviewer credential expiry (UTC): ${time(check.reviewerExpiresAt)}</p>${assignmentForm(csrf, input, false)}${navigation}</section>`,
  );
}

export function sampleAssignmentHistory(
  history: SampleAssignmentHistory,
  csrf: string,
): string {
  const rows = history.rows
    .map(
      (row) =>
        `<li data-exact-grant="${escape(row.exactGrantId)}">${rowDetails(row)}${revokeForm(row, csrf)}</li>`,
    )
    .join("");
  return page(
    "Private sample assignment history",
    `<section class="reading">${notice}<h1>Private sample assignment history</h1><p>Exact sample: ${escape(history.evidenceId)} · source version ${escape(String(history.sourceRevision))}</p><p>These retained structural observations are not guaranteed current access. Viewing history does not renew authority, change consent or record effort. Removing one exact grant preserves distinct overlapping grants and other samples; published owner feedback is separate.</p>${rows ? `<ul>${rows}</ul>` : "<p>No retained grants or receipts were found on this observation. This does not establish that no write committed; account or workspace erasure can remove receipt recovery.</p>"}<p>At most ${SAMPLE_ASSIGNMENT_PAGE_SIZE} rows per page. Each page checks current administrator authority again. Historical expiry or source removal does not imply renewed reviewer access.</p>${history.next === null ? "" : `<p><a href="${escape(historyPath(history, history.next))}">Next assignments</a></p>`}${navigation}</section>`,
  );
}

export function sampleAssignmentReceipt(
  row: SampleAssignmentRow,
  csrf: string,
  message?: string,
): string {
  return page(
    "Private sample assignment receipt",
    `<section class="reading">${notice}<h1>Private sample assignment receipt</h1>${message === undefined ? "" : alert(message)}${rowDetails(row)}<p>This receipt records a structural observation, not guaranteed current access or renewed authority. Inspect the exact history before any further action. Viewing it does not change consent, feedback or review minutes.</p><p><a href="${escape(historyPath(row))}">Inspect exact sample history</a></p>${revokeForm(row, csrf)}${navigation}</section>`,
  );
}

export function sampleAssignmentRecovery(
  message: string,
  csrf: string,
  attempt?: SampleAssignmentInput,
): string {
  return page(
    "Private sample assignment unavailable",
    `<section class="reading"><h1>Private sample assignment unavailable</h1>${alert(message)}${attempt === undefined ? "<p>Return to your retained original form, if available. A missing retained receipt does not establish that no write committed. Do not create a new operation key merely because recovery is absent.</p>" : `<p>The assignment may already have committed. Inspect its saved state in a new tab first; this original form retains your exact key and payload. Nothing is retried automatically. Any manual retry requires fresh confirmation and keeps the original payload; it does not create a new key or compensate for an uncertain result.</p>${recoveryForm(csrf, attempt.operationId)}${assignmentForm(csrf, attempt, true)}`}${navigation}</section>`,
  );
}

export function reviewerSampleReference(
  reference: SampleReviewerReference,
): string {
  return page(
    "Your reviewer reference",
    `<section class="reading"><h1>Your reviewer reference</h1><p>Share this exact reference with your trusted local administrator for one private sample version. It is not a sign-in credential and does not itself grant access or establish qualification.</p><dl><dt>Your reviewer reference</dt><dd data-reviewer-reference>${escape(reference.reviewerId)}</dd><dt>Credential expires at (UTC)</dt><dd>${time(reference.expiresAt)}</dd></dl><p>An administrator must explicitly confirm a finite exact assignment. Current role, source permission and exact grants still govern later access.</p><p><a href="/staff">Your staff tools</a> · <a href="/learn">Your learning space</a></p></section>`,
  );
}
