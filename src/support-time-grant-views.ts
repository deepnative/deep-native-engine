import { escape, hidden, page } from "./views.ts";
import {
  SUPPORT_GRANT_PATH as base,
  SUPPORT_GRANT_PAGE_SIZE,
  type SupportMinuteCheck,
  type SupportMinuteInput,
  type SupportMinuteRevokeInput,
  type SupportMinuteRow,
  type SupportMinuteRevocation,
} from "./support-time-grant-values.ts";
export type SupportMinuteAttempt =
  | { kind: "grant"; input: SupportMinuteInput }
  | { kind: "revoke"; input: SupportMinuteRevokeInput };
const navigation = `<p><a href="${base}">Private support-minute permissions</a> · <a href="${base}/history">Your permission history</a> · <a href="/staff">Your staff tools</a></p>`;
const notice =
  '<p class="eyebrow">PRIVATE LOCAL SUPPORT MINUTES</p><p>One exact allocation-specific permission for invented local support. This creates no units, request-text assignment, staff identity or qualification. Request-text permission is independent: time permission alone reveals no request text or internal notes. Begin and settlement are separate explicit actions.</p>';
const field = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${escape(value)}">`;
function recoveryForm(csrf: string, revoke: boolean, key?: string) {
  return `<form method="post" action="${base}/${revoke ? "recover-revoke" : "recover"}" target="_blank" rel="noopener">${hidden(escape(csrf))}${key === undefined ? `<label for="${revoke ? "revokeOperation" : "grantOperation"}">Original ${revoke ? "revocation" : "permission"} operation key</label><input id="${revoke ? "revokeOperation" : "grantOperation"}" name="operationId" type="password" maxlength="36" autocomplete="off" required>` : field("operationId", key)}<button type="submit">Inspect saved ${revoke ? "revocation" : "permission"} in a new tab</button></form>`;
}
function grantForm(csrf: string, input: SupportMinuteInput, retry: boolean) {
  return `<form method="post" action="${base}/grant">${hidden(escape(csrf))}${field("requestId", input.requestId)}${field("allocationId", input.allocationId)}${field("operatorId", input.operatorId)}${field("operationId", input.operationId)}<dl><dt>Request reference</dt><dd>${escape(input.requestId)}</dd><dt>Allocation reference</dt><dd>${escape(input.allocationId)}</dd><dt>Operator reference</dt><dd>${escape(input.operatorId)}</dd></dl><label for="startsAt">Starts at (UTC)</label><input id="startsAt" name="startsAt" type="text" maxlength="24" value="${escape(input.startsAt)}"${retry ? " readonly" : ""} required><label for="expiresAt">Expires at (UTC)</label><input id="expiresAt" name="expiresAt" type="text" maxlength="24" value="${escape(input.expiresAt)}"${retry ? " readonly" : ""} required><p>Use UTC timestamps ending in Z with milliseconds. The window cannot outlive either current administrator or operator credential. References, source and authority are checked again when confirmed.</p><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I confirm this exact finite permission</span></label><button type="submit">${retry ? "Retry this exact permission" : "Grant support-minute permission"}</button></form>`;
}
function revokeForm(
  csrf: string,
  input: SupportMinuteRevokeInput,
  retry = false,
) {
  return `<form method="post" action="${base}/revoke">${hidden(escape(csrf))}${field("grantId", input.grantId)}${field("operationId", input.operationId)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I confirm revoking this exact permission only.</span></label><button type="submit">${retry ? "Retry this exact revocation" : "Revoke this exact permission"}</button></form>`;
}
function rowDetails(row: SupportMinuteRow) {
  return `<dl><dt>Permission reference</dt><dd data-support-time-grant-reference>${escape(row.grantId)}</dd><dt>Request reference</dt><dd>${escape(row.requestId)}</dd><dt>Allocation reference</dt><dd>${escape(row.allocationId)}</dd><dt>Operator reference</dt><dd>${escape(row.operatorId)}</dd><dt>Recipient role</dt><dd>${escape(row.role)}</dd><dt>Allocation state</dt><dd>${escape(row.allocationState)}</dd><dt>Reserved ceiling</dt><dd>${row.ceiling}</dd><dt>Observed permission state</dt><dd data-support-time-grant-state>${escape(row.state)}</dd><dt>Starts at (UTC)</dt><dd>${escape(row.startsAt)}</dd><dt>Expires at (UTC)</dt><dd>${escape(row.expiresAt)}</dd><dt>Created at (UTC)</dt><dd>${escape(row.createdAt)}</dd>${row.revokedAt === null ? "" : `<dt>Revoked at (UTC)</dt><dd>${escape(row.revokedAt)}</dd>`}</dl>${row.sourceAvailable ? "" : "<p>The source is unavailable. This retained permission metadata does not restore source access.</p>"}`;
}
export function supportMinuteForm(
  csrf: string,
  creationEnabled: boolean,
  writesEnabled = true,
) {
  return page(
    "Private support-minute permissions",
    `<section class="reading">${notice}<h1>Private support-minute permissions</h1>${creationEnabled ? `<p>Ask the member for their owned request and held-allocation references and ask the operator for their own reference. There is no member, operator or request directory here.</p><form method="post" action="${base}/check">${hidden(escape(csrf))}<label for="requestId">Request reference</label><input id="requestId" name="requestId" maxlength="36" required><label for="allocationId">Allocation reference</label><input id="allocationId" name="allocationId" maxlength="36" required><label for="operatorId">Operator reference</label><input id="operatorId" name="operatorId" maxlength="36" required><button type="submit">Check exact references</button></form>` : writesEnabled ? "<p>Recovery-only mode: new checks and permissions are paused. Your retained history, original operation inspection and exact revocation remain available.</p>" : "<p>Support writes are paused. Retained history and original operation inspection remain available; grant and revoke writes are unavailable.</p>"}<h2>Inspect an original operation</h2>${recoveryForm(csrf, false)}${recoveryForm(csrf, true)}${navigation}</section>`,
  );
}
export function supportMinuteCheck(
  check: SupportMinuteCheck,
  csrf: string,
  operationId: string,
) {
  return page(
    "Confirm support-minute permission",
    `<section class="reading">${notice}<h1>Confirm support-minute permission</h1><p>Checking references created no permission or allowance change.</p><dl><dt>Allocation state</dt><dd>${escape(check.allocationState)}</dd><dt>Reserved ceiling</dt><dd>${check.ceiling}</dd><dt>Maximum current authority expiry (UTC)</dt><dd>${escape(check.authorityExpiresAt)}</dd></dl>${grantForm(csrf, { requestId: check.requestId, allocationId: check.allocationId, operatorId: check.operatorId, operationId, startsAt: "", expiresAt: "" }, false)}${navigation}</section>`,
  );
}
export function supportMinuteReceipt(
  row: SupportMinuteRow,
  csrf: string,
  operationId: string,
  message?: string,
  revocation?: SupportMinuteRevocation,
  writesEnabled = true,
) {
  return page(
    "Support-minute permission receipt",
    `<section class="reading">${notice}<h1>Support-minute permission receipt</h1>${message === undefined ? "" : `<p role="alert">${escape(message)}</p>`}${revocation === undefined ? "" : `<p>Original revocation outcome: ${escape(revocation.outcome)}</p><p>Revocation receipt: <span data-support-time-revocation-reference>${escape(revocation.revocationReceiptId)}</span></p>`}${rowDetails(row)}<p>Reading this observation starts no effort and consumes nothing. Revocation changes only this exact permission; independent overlapping grants, request-text permissions and allocation accounting remain separate.</p><p><a href="${base}/${encodeURIComponent(row.grantId)}">Inspect this exact permission receipt</a></p>${row.canRevoke && writesEnabled ? revokeForm(csrf, { grantId: row.grantId, operationId }) : row.canRevoke ? "<p>Support permission writes are paused.</p>" : "<p>This permission has already been revoked.</p>"}${navigation}</section>`,
  );
}
export function supportMinuteHistory(history: {
  rows: SupportMinuteRow[];
  next: string | null;
}) {
  return page(
    "Your support-minute permission history",
    `<section class="reading">${notice}<h1>Your support-minute permission history</h1><p>Only permissions created by your current administrator identity. At most ${SUPPORT_GRANT_PAGE_SIZE} retained rows per page; every page checks fresh authority.</p>${history.rows.length ? `<ul>${history.rows.map((row) => `<li data-support-time-history-grant="${escape(row.grantId)}">${rowDetails(row)}<a href="${base}/${encodeURIComponent(row.grantId)}">Inspect exact permission</a></li>`).join("")}</ul>` : "<p>No retained permissions were found. This does not establish that an earlier write failed; account erasure removes its recovery.</p>"}${history.next === null ? "" : `<p><a href="${base}/history?after=${encodeURIComponent(history.next)}">Next permissions</a></p>`}${navigation}</section>`,
  );
}
export function supportMinuteRecovery(
  message: string,
  csrf: string,
  attempt?: SupportMinuteAttempt,
) {
  return page(
    "Support-minute permission unavailable",
    `<section class="reading"><h1>Support-minute permission unavailable</h1><p role="alert">${escape(message)}</p>${attempt === undefined ? "<p>A missing or unavailable receipt does not establish that no write committed. Return to the retained original form to inspect its original operation. Nothing is retried automatically.</p>" : `<p>The operation may already have committed. Inspect the saved original operation in a new tab before any manual retry. This form retains the original payload and key. Nothing is retried automatically.</p>${recoveryForm(csrf, attempt.kind === "revoke", attempt.input.operationId)}${attempt.kind === "grant" ? grantForm(csrf, attempt.input, true) : revokeForm(csrf, attempt.input, true)}`}${navigation}</section>`,
  );
}
