import { escape, hidden, page } from "./views.ts";
import type {
  AssignmentReference,
  AssignmentHistory,
} from "./support-assignment.ts";

export interface AssignmentAttempt {
  requestId: string;
  staffId: string;
  idempotencyKey: string;
  startsAt: string;
  expiresAt: string;
}
export interface AssignmentRecovery {
  requestId: string;
  key?: string;
}
const base = "/operator/support-assignment";
const notice = `<p class="eyebrow">PRIVATE LOCAL SUPPORT</p><p>This assigns access to one invented support request. It does not provide staffed coverage, qualified review, paid service or effort minutes.</p>`;
const navigation = `<p><a href="${base}">Support request assignments</a> · <a href="/staff">Your staff tools</a> · <a href="/learn">Your learning space</a></p>`;
function historyPath(requestId: string, key?: string, after?: string) {
  let path = `${base}/history?requestId=${encodeURIComponent(requestId)}`;
  if (key !== undefined) path += `&key=${encodeURIComponent(key)}`;
  if (after !== undefined) path += `&after=${encodeURIComponent(after)}`;
  return path;
}
function time(value: Date) {
  const text = escape(value.toISOString());
  return `<time datetime="${text}">${text}</time>`;
}
function assignmentForm(
  csrf: string,
  attempt: AssignmentAttempt,
  retry: boolean,
) {
  return `<form method="post" action="${base}/assign">${hidden(escape(csrf))}<input type="hidden" name="requestId" value="${escape(attempt.requestId)}"><input type="hidden" name="staffId" value="${escape(attempt.staffId)}"><input type="hidden" name="idempotencyKey" value="${escape(attempt.idempotencyKey)}"><dl><dt>Exact request receipt ID</dt><dd>${escape(attempt.requestId)}</dd><dt>Exact operator assignment ID</dt><dd>${escape(attempt.staffId)}</dd><dt>Original submission key</dt><dd>${escape(attempt.idempotencyKey)}</dd></dl><label for="startsAt">Starts at (UTC)</label><input id="startsAt" name="startsAt" type="text" value="${escape(attempt.startsAt)}" maxlength="24"${retry ? " readonly" : ""} required><label for="expiresAt">Expires at (UTC)</label><input id="expiresAt" name="expiresAt" type="text" value="${escape(attempt.expiresAt)}" maxlength="24"${retry ? " readonly" : ""} required><p>Use exact UTC timestamps ending in Z, including milliseconds. The expiry must be later than the start and no later than the operator credential expiry. Access and current authority are checked again when you submit.</p><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I confirm this exact request, operator and finite UTC window.</span></label><button type="submit">${retry ? "Retry this exact assignment" : "Assign this request"}</button></form>`;
}
export function assignmentHomePage(csrf: string): string {
  return page(
    "Support request assignments",
    `<section class="reading">${notice}<h1>Support request assignments</h1><p>Obtain the exact request reference from the member's receipt and the operator's own assignment reference. This page does not list members, operators or private requests.</p><form method="post" action="${base}/check">${hidden(escape(csrf))}<label for="requestId">Exact request receipt ID</label><input id="requestId" name="requestId" type="text" maxlength="36" required><label for="staffId">Exact operator assignment ID</label><input id="staffId" name="staffId" type="text" maxlength="36" required><button type="submit">Check exact references</button></form><h2>Inspect an exact request</h2><form method="get" action="${base}/history"><label for="historyRequestId">Request receipt ID to inspect</label><input id="historyRequestId" name="requestId" type="text" maxlength="36" required><label for="historyKey">Original submission key (optional)</label><input id="historyKey" name="key" type="text" maxlength="36"><p>Use your original key to inspect an unconfirmed assignment. Inspection does not create or revoke access.</p><button type="submit">Inspect saved assignment state</button></form>${navigation}</section>`,
  );
}
export function assignmentReferencePage(
  reference: AssignmentReference,
): string {
  return page(
    "My local assignment ID",
    `<section class="reading"><h1>My local assignment ID</h1><p>Share this exact reference with your trusted local administrator for a specific support request. It is not a sign-in credential and does not itself grant access.</p><dl><dt>My assignment ID</dt><dd data-assignment-id>${escape(reference.staffId)}</dd><dt>Credential expires at (UTC)</dt><dd>${time(reference.expiresAt)}</dd></dl><p>An administrator must confirm an exact finite assignment. Your current role, credential and that grant still govern access.</p><p><a href="/staff">Your staff tools</a> · <a href="/learn">Your learning space</a></p></section>`,
  );
}
export function assignmentConfirmPage(
  csrf: string,
  attempt: AssignmentAttempt,
  operatorExpiresAt?: Date,
): string {
  return page(
    "Confirm support assignment",
    `<section class="reading">${notice}<h1>Confirm support assignment</h1><p>Allow this operator to view and respond only to this request during the window you confirm. This does not grant effort recording or access to other requests.</p>${operatorExpiresAt ? `<p>Maximum operator credential expiry (UTC): ${time(operatorExpiresAt)}</p>` : ""}${assignmentForm(csrf, attempt, false)}${navigation}</section>`,
  );
}
export function assignmentHistoryPage(
  csrf: string,
  history: AssignmentHistory,
  key?: string,
): string {
  const items = history.items
    .map(
      (item) =>
        `<li data-grant="${escape(item.grantId)}"><dl><dt>Grant ID</dt><dd>${escape(item.grantId)}</dd><dt>Request receipt ID</dt><dd>${escape(item.requestId)}</dd><dt>Assigned staff reference</dt><dd>${escape(item.staffId)}</dd><dt>Recorded role</dt><dd>${escape(item.role)}</dd><dt>Starts at (UTC)</dt><dd>${time(item.startsAt)}</dd><dt>Expires at (UTC)</dt><dd>${time(item.expiresAt)}</dd><dt>Created at (UTC)</dt><dd>${time(item.createdAt)}</dd><dt>Observed state</dt><dd>${escape(item.state)}</dd>${item.revokedAt ? `<dt>Revoked at (UTC)</dt><dd>${time(item.revokedAt)}</dd>` : ""}</dl>${item.revokedAt ? "<p>This exact grant has already been revoked.</p>" : `<form method="post" action="${base}/revoke">${hidden(escape(csrf))}<input type="hidden" name="requestId" value="${escape(history.requestId)}"><input type="hidden" name="grantId" value="${escape(item.grantId)}"><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I confirm revoking this exact grant only.</span></label><button type="submit">Revoke this grant</button></form>`}</li>`,
    )
    .join("");
  return page(
    "Support assignment history",
    `<section class="reading">${notice}<h1>Support assignment history</h1><p>Exact request: ${escape(history.requestId)}</p><p>States observed at ${time(history.observedAt)}. They describe that observation, not guaranteed future access.</p>${key !== undefined ? `<p>Your original submission key: ${escape(key)}</p>` : ""}${history.withdrawn ? "<p>The request has been withdrawn. This history does not restore access.</p>" : ""}${items ? `<ul>${items}</ul>` : "<p>No saved assignments found on this observation. An earlier unconfirmed request may still need inspection; nothing is retried automatically.</p>"}<p>At most 20 assignments per page. Revoking one grant preserves distinct overlapping grants; each grant's own window and current role still apply. Expired or ineffective grants remain individually revocable. Viewing history does not change grants, service records or effort minutes.</p>${history.nextCursor ? `<p><a href="${escape(historyPath(history.requestId, key, history.nextCursor))}">Next assignments</a></p>` : ""}${navigation}</section>`,
  );
}
export function assignmentReceiptPage(
  title: string,
  receipt: { requestId: string; grantId: string },
  key?: string,
): string {
  return page(
    title,
    `<section class="reading">${notice}<h1>${escape(title)}</h1><dl><dt>Request receipt ID</dt><dd>${escape(receipt.requestId)}</dd><dt>Grant ID</dt><dd data-assignment-grant>${escape(receipt.grantId)}</dd>${key !== undefined ? `<dt>Your original submission key</dt><dd>${escape(key)}</dd>` : ""}</dl><p><a href="${escape(historyPath(receipt.requestId, key))}">Inspect saved assignment state</a></p><p>Inspect the exact current state before any further action. Nothing is automatically retried or reassigned.</p>${navigation}</section>`,
  );
}
export function assignmentNoticePage(
  message: string,
  recovery?: AssignmentRecovery,
  attempt?: AssignmentAttempt,
  csrf?: string,
): string {
  return page(
    "Support assignment unavailable",
    `<section class="reading"><h1>Support assignment unavailable</h1><p role="alert">${escape(message)}</p>${recovery ? `<p><a href="${escape(historyPath(recovery.requestId, recovery.key))}">Inspect saved assignment state</a></p>` : ""}${attempt && csrf !== undefined ? `<p>The assignment may already have committed. Inspect its saved state first. Any explicit retry below keeps your original submission key and payload; it never creates a new key automatically. Changing its payload conflicts with a saved submission.</p>${assignmentForm(csrf, attempt, true)}` : ""}${navigation}</section>`,
  );
}
