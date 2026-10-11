import { escape, hidden, page } from "./views.ts";
import {
  REVIEW_GRANT_PATH as base,
  REVIEW_GRANT_PAGE_SIZE,
  type ReviewGrantCheck,
  type ReviewGrantInput,
  type ReviewGrantRevokeInput,
  type ReviewGrantRow,
  type ReviewGrantRevocation,
} from "./review-time-grant-values.ts";
export type ReviewGrantAttempt =
  | { kind: "grant"; input: ReviewGrantInput }
  | { kind: "revoke"; input: ReviewGrantRevokeInput };
const navigation = `<p><a href="${base}">Private review-minute permissions</a> · <a href="${base}/history">Your permission history</a> · <a href="/staff">Your staff tools</a></p>`;
const notice =
  '<p class="eyebrow">PRIVATE LOCAL REVIEW MINUTES</p><p>One exact allocation-specific permission for invented local review. This creates no units, sample assignment, staff identity or qualification. Separate current workspace and sample permissions are still required to begin or publish review.</p>';
const field = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${escape(value)}">`;
function recoveryForm(csrf: string, revoke: boolean, key?: string) {
  return `<form method="post" action="${base}/${revoke ? "recover-revoke" : "recover"}" target="_blank" rel="noopener">${hidden(escape(csrf))}${key === undefined ? `<label for="${revoke ? "revokeOperation" : "grantOperation"}">Original ${revoke ? "revocation" : "permission"} operation key</label><input id="${revoke ? "revokeOperation" : "grantOperation"}" name="operationId" type="password" maxlength="36" autocomplete="off" required>` : field("operationId", key)}<button type="submit">Inspect saved ${revoke ? "revocation" : "permission"} in a new tab</button></form>`;
}
function grantForm(csrf: string, input: ReviewGrantInput, retry: boolean) {
  return `<form method="post" action="${base}/grant">${hidden(escape(csrf))}${field("allocationId", input.allocationId)}${field("reviewerId", input.reviewerId)}${field("operationId", input.operationId)}<dl><dt>Allocation reference</dt><dd>${escape(input.allocationId)}</dd><dt>Reviewer reference</dt><dd>${escape(input.reviewerId)}</dd></dl><label for="startsAt">Starts at (UTC)</label><input id="startsAt" name="startsAt" type="text" maxlength="24" value="${escape(input.startsAt)}"${retry ? " readonly" : ""} required><label for="expiresAt">Expires at (UTC)</label><input id="expiresAt" name="expiresAt" type="text" maxlength="24" value="${escape(input.expiresAt)}"${retry ? " readonly" : ""} required><p>Use UTC timestamps ending in Z with milliseconds. The window cannot outlive either current administrator or reviewer credential. References, source and authority are checked again when confirmed.</p><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I confirm this exact finite permission</span></label><button type="submit">${retry ? "Retry this exact permission" : "Grant review-minute permission"}</button></form>`;
}
function revokeForm(
  csrf: string,
  input: ReviewGrantRevokeInput,
  retry = false,
) {
  return `<form method="post" action="${base}/revoke">${hidden(escape(csrf))}${field("grantId", input.grantId)}${field("operationId", input.operationId)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I confirm revoking this exact permission only.</span></label><button type="submit">${retry ? "Retry this exact revocation" : "Revoke this exact permission"}</button></form>`;
}
function rowDetails(row: ReviewGrantRow) {
  return `<dl><dt>Permission reference</dt><dd data-review-time-grant-reference>${escape(row.grantId)}</dd><dt>Allocation reference</dt><dd>${escape(row.allocationId)}</dd><dt>Reviewer reference</dt><dd>${escape(row.reviewerId)}</dd><dt>Source version</dt><dd>${row.sourceRevision}</dd><dt>Allocation state</dt><dd>${escape(row.allocationState)}</dd><dt>Reserved ceiling</dt><dd>${row.ceiling}</dd><dt>Observed permission state</dt><dd data-review-time-grant-state>${escape(row.state)}</dd><dt>Starts at (UTC)</dt><dd>${escape(row.startsAt)}</dd><dt>Expires at (UTC)</dt><dd>${escape(row.expiresAt)}</dd><dt>Created at (UTC)</dt><dd>${escape(row.createdAt)}</dd>${row.revokedAt === null ? "" : `<dt>Revoked at (UTC)</dt><dd>${escape(row.revokedAt)}</dd>`}</dl>${row.sourceAvailable ? "" : "<p>The source is unavailable. This retained permission metadata does not restore source access.</p>"}`;
}
export function reviewGrantForm(csrf: string, creationEnabled: boolean) {
  return page(
    "Private review-minute permissions",
    `<section class="reading">${notice}<h1>Private review-minute permissions</h1>${creationEnabled ? `<p>Ask the member for the allocation reference on their own review-minute receipt and ask the reviewer for their own reference. There is no member, reviewer or source directory here.</p><form method="post" action="${base}/check">${hidden(escape(csrf))}<label for="allocationId">Allocation reference</label><input id="allocationId" name="allocationId" maxlength="36" required><label for="reviewerId">Reviewer reference</label><input id="reviewerId" name="reviewerId" maxlength="36" required><button type="submit">Check exact references</button></form>` : "<p>Recovery-only mode: new checks and permissions are paused. Your retained history, original operation inspection and exact revocation remain available.</p>"}<h2>Inspect an original operation</h2>${recoveryForm(csrf, false)}${recoveryForm(csrf, true)}${navigation}</section>`,
  );
}
export function reviewGrantCheck(
  check: ReviewGrantCheck,
  csrf: string,
  operationId: string,
) {
  return page(
    "Confirm review-minute permission",
    `<section class="reading">${notice}<h1>Confirm review-minute permission</h1><p>Checking references created no permission or allowance change.</p><dl><dt>Source version</dt><dd>${check.sourceRevision}</dd><dt>Allocation state</dt><dd>${escape(check.allocationState)}</dd><dt>Reserved ceiling</dt><dd>${check.ceiling}</dd><dt>Maximum current authority expiry (UTC)</dt><dd>${escape(check.authorityExpiresAt)}</dd></dl>${grantForm(csrf, { allocationId: check.allocationId, reviewerId: check.reviewerId, operationId, startsAt: "", expiresAt: "" }, false)}${navigation}</section>`,
  );
}
export function reviewGrantReceipt(
  row: ReviewGrantRow,
  csrf: string,
  operationId: string,
  message?: string,
  revocation?: ReviewGrantRevocation,
) {
  return page(
    "Review-minute permission receipt",
    `<section class="reading">${notice}<h1>Review-minute permission receipt</h1>${message === undefined ? "" : `<p role="alert">${escape(message)}</p>`}${revocation === undefined ? "" : `<p>Original revocation outcome: ${escape(revocation.outcome)}</p><p>Revocation receipt: <span data-review-time-revocation-reference>${escape(revocation.revocationReceiptId)}</span></p>`}${rowDetails(row)}<p>Reading this observation starts no review and consumes nothing. Revocation changes only this exact permission; independent overlapping grants, sample feedback permissions and allocation accounting remain separate.</p><p><a href="${base}/${encodeURIComponent(row.grantId)}">Inspect this exact permission receipt</a></p>${row.canRevoke ? revokeForm(csrf, { grantId: row.grantId, operationId }) : "<p>This permission has already been revoked.</p>"}${navigation}</section>`,
  );
}
export function reviewGrantHistory(history: {
  rows: ReviewGrantRow[];
  next: string | null;
}) {
  return page(
    "Your review-minute permission history",
    `<section class="reading">${notice}<h1>Your review-minute permission history</h1><p>Only permissions created by your current administrator identity. At most ${REVIEW_GRANT_PAGE_SIZE} retained rows per page; every page checks fresh authority.</p>${history.rows.length ? `<ul>${history.rows.map((row) => `<li data-review-time-history-grant="${escape(row.grantId)}">${rowDetails(row)}<a href="${base}/${encodeURIComponent(row.grantId)}">Inspect exact permission</a></li>`).join("")}</ul>` : "<p>No retained permissions were found. This does not establish that an earlier write failed; account erasure removes its recovery.</p>"}${history.next === null ? "" : `<p><a href="${base}/history?after=${encodeURIComponent(history.next)}">Next permissions</a></p>`}${navigation}</section>`,
  );
}
export function reviewGrantRecovery(
  message: string,
  csrf: string,
  attempt?: ReviewGrantAttempt,
) {
  return page(
    "Review-minute permission unavailable",
    `<section class="reading"><h1>Review-minute permission unavailable</h1><p role="alert">${escape(message)}</p>${attempt === undefined ? "<p>A missing or unavailable receipt does not establish that no write committed. Return to the retained original form to inspect its original operation. Nothing is retried automatically.</p>" : `<p>The operation may already have committed. Inspect the saved original operation in a new tab before any manual retry. This form retains the original payload and key. Nothing is retried automatically.</p>${recoveryForm(csrf, attempt.kind === "revoke", attempt.input.operationId)}${attempt.kind === "grant" ? grantForm(csrf, attempt.input, true) : revokeForm(csrf, attempt.input, true)}`}${navigation}</section>`,
  );
}
