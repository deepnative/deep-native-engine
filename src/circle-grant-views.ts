import { CIRCLES } from "./circles.ts";
import { CIRCLE_DISCUSSION_POLICY } from "./circle-discussion.ts";
import { escape, hidden, page } from "./views.ts";
import type {
  CircleGrantAdmin,
  CircleGrantAttempt,
  CircleGrantCheck,
  CircleGrantPage,
  CircleGrantRecord,
  CircleGrantReference,
  CircleGrantScope,
} from "./circle-grant-values.ts";

const base = "/operator/circle-grants";
const navigation = `<p><a href="${base}">Circle moderation grants</a> · <a href="/moderate/circle-reference">My moderation reference</a> · <a href="/staff">Your staff tools</a></p>`;
const notice = `<p class="eyebrow">PRIVATE LOCAL CIRCLES</p><p>Grant finite moderation access to one exact circle. This does not confer paid benefits, qualified coverage or access to other circles. Use invented information only.</p>`;
const field = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${escape(value)}">`;
const scopeFields = (scope: CircleGrantScope) =>
  field("staffId", scope.staffId) + field("circleId", scope.circleId);
const time = (date: Date) => {
  const value = escape(date.toISOString());
  return `<time datetime="${value}">${value}</time>`;
};
function circles(id = "circleId") {
  return `<label for="${id}">Exact circle</label><select id="${id}" name="circleId" required>${CIRCLES.map((circle) => `<option value="${escape(circle.id)}">${escape(circle.title)} (${escape(circle.id)})</option>`).join("")}</select>`;
}
function scopeInputs(prefix: string) {
  return `<label for="${prefix}StaffId">Exact staff reference</label><input id="${prefix}StaffId" name="staffId" type="text" maxlength="36" required><label for="${prefix}CircleId">Exact circle ID</label><input id="${prefix}CircleId" name="circleId" type="text" maxlength="80" required>`;
}
function inspectForm(
  csrf: string,
  scope: CircleGrantScope,
  kind: "key" | "grant",
  value: string,
) {
  return `<form method="post" action="${base}/inspect" target="_blank" rel="noopener">${hidden(escape(csrf))}${scopeFields(scope)}${field("lookupKind", kind)}${field("lookupValue", value)}<button type="submit">Inspect saved grant state in a new tab</button></form>`;
}
function historyForm(csrf: string, scope: CircleGrantScope, after?: string) {
  return `<form method="post" action="${base}/history">${hidden(escape(csrf))}${scopeFields(scope)}${after === undefined ? "" : field("after", after)}<button type="submit">${after === undefined ? "Inspect grant history" : "Next grants"}</button></form>`;
}
function creationForm(
  csrf: string,
  attempt: CircleGrantAttempt,
  retry: boolean,
) {
  return `<form method="post" action="${base}/create">${hidden(escape(csrf))}<label for="staffId">Exact staff reference</label><input id="staffId" name="staffId" value="${escape(attempt.staffId)}" readonly required><label for="circleId">Exact circle ID</label><input id="circleId" name="circleId" value="${escape(attempt.circleId)}" readonly required><label for="idempotencyKey">Original submission key</label><input id="idempotencyKey" name="idempotencyKey" value="${escape(attempt.idempotencyKey)}" readonly required><label for="expiresAt">Expires at (UTC)</label><input id="expiresAt" name="expiresAt" type="text" maxlength="24" value="${escape(attempt.expiresAt)}"${retry ? " readonly" : ""} required><p>Fixed moderation purpose: ${escape(CIRCLE_DISCUSSION_POLICY)}.</p><p>Use an exact UTC timestamp ending in Z, including milliseconds. Access starts at database creation time. Current authority and the finite expiry are checked again on submission.</p><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I confirm this exact staff reference, circle and finite expiry.</span></label><button type="submit">${retry ? "Retry this exact grant" : "Create this circle grant"}</button></form>`;
}
function record(
  csrf: string,
  scope: CircleGrantScope,
  value: CircleGrantRecord,
) {
  const identity = `<dt>Grant ID</dt><dd data-circle-grant>${escape(value.grantId)}</dd><dt>Staff reference</dt><dd>${escape(value.staffId)}</dd><dt>Exact circle</dt><dd>${escape(value.circleId)}</dd><dt>Observed state</dt><dd>${escape(value.state)}</dd>`;
  if (value.source === "absent") {
    return `<article data-grant="${escape(value.grantId)}"><dl>${identity}</dl><p>The grant source is absent. Its original role, purpose, submission key and time window are not retained here and cannot be reconstructed. This history does not restore access.</p><ul>${value.audit.map((event) => `<li>${escape(event.action)} by ${escape(event.actorId)} at ${time(event.at)}</li>`).join("")}</ul></article>`;
  }
  return `<article data-grant="${escape(value.grantId)}"><dl>${identity}<dt>Recorded role</dt><dd>${escape(value.role)}</dd><dt>Exact purpose</dt><dd>${escape(value.purpose)}</dd><dt>Created by</dt><dd>${escape(value.createdBy)}</dd><dt>Starts at (UTC)</dt><dd>${time(value.startsAt)}</dd><dt>Expires at (UTC)</dt><dd>${time(value.expiresAt)}</dd><dt>Created at (UTC)</dt><dd>${time(value.createdAt)}</dd>${value.revokedAt ? `<dt>Revoked at (UTC)</dt><dd>${time(value.revokedAt)}</dd>` : ""}</dl>${value.revokedAt ? "<p>This exact grant has already been revoked.</p>" : `<form method="post" action="${base}/revoke">${hidden(escape(csrf))}${scopeFields(scope)}${field("grantId", value.grantId)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I confirm revoking this exact grant only.</span></label><button type="submit">Revoke this grant</button></form>`}</article>`;
}
export function circleGrantHomePage(csrf: string, admin: CircleGrantAdmin) {
  return page(
    "Circle moderation grants",
    `<section class="reading">${notice}<h1>Circle moderation grants</h1><p>Your current administrator reference: <span data-circle-admin>${escape(admin.reference.staffId)}</span>. Credential expires at ${time(admin.reference.expiresAt)}.</p><p>Obtain the moderator's own reference directly. This page does not list staff, members or private circle content. A reference alone grants no access.</p>${admin.creationEnabled ? `<form method="post" action="${base}/check">${hidden(escape(csrf))}<label for="staffId">Exact staff reference</label><input id="staffId" name="staffId" type="text" maxlength="36" required>${circles()}<button type="submit">Check exact references</button></form><form method="post" action="${base}/check">${hidden(escape(csrf))}${field("staffId", "self")}${circles("selfCircleId")}<button type="submit">Check my own reference for this circle</button></form>` : "<p>Creating circle grants is paused. Protected inspection, history and exact revocation remain available.</p>"}<h2>Inspect an exact retained grant</h2><form method="post" action="${base}/inspect">${hidden(escape(csrf))}${scopeInputs("inspect")}<label for="lookupKind">Reference type</label><select id="lookupKind" name="lookupKind"><option value="key">My original submission key</option><option value="grant">Exact grant ID</option></select><label for="lookupValue">Exact reference to inspect</label><input id="lookupValue" name="lookupValue" maxlength="36" required><button type="submit">Inspect saved grant state</button></form><h2>Exact staff and circle history</h2><form method="post" action="${base}/history">${hidden(escape(csrf))}${scopeInputs("history")}<button type="submit">Inspect grant history</button></form>${navigation}</section>`,
  );
}
export function circleGrantReferencePage(reference: CircleGrantReference) {
  return page(
    "My moderation reference",
    `<section class="reading"><h1>My moderation reference</h1><p>Share this exact reference with your trusted local administrator. It is not a sign-in credential and does not itself grant access.</p><dl><dt>My staff reference</dt><dd data-circle-reference>${escape(reference.staffId)}</dd><dt>Current role</dt><dd>${escape(reference.role)}</dd><dt>Credential expires at (UTC)</dt><dd>${time(reference.expiresAt)}</dd></dl><p>Moderation still requires a current credential and a finite grant for the exact circle and purpose.</p>${navigation}</section>`,
  );
}
export function circleGrantConfirmPage(
  csrf: string,
  check: CircleGrantCheck,
  attempt: CircleGrantAttempt,
) {
  return page(
    "Confirm circle moderation grant",
    `<section class="reading">${notice}<h1>Confirm circle moderation grant</h1><p>Checked target role: ${escape(check.role)}. Maximum target credential expiry: ${time(check.expiresAt)}.</p>${check.creationEnabled ? creationForm(csrf, attempt, false) : "<p>Creating grants is paused. This check does not create access.</p>"}${navigation}</section>`,
  );
}
export function circleGrantReceiptPage(
  csrf: string,
  scope: CircleGrantScope,
  value: CircleGrantRecord | null,
  key?: string,
) {
  return page(
    "Circle grant receipt",
    `<section class="reading">${notice}<h1>Circle grant receipt</h1>${value ? record(csrf, scope, value) : "<p>No retained grant was found on this observation. The outcome may be unknown or its source may have been erased; this does not prove that an earlier submission did not commit.</p>"}${key === undefined ? "" : `<p>Your original submission key: ${escape(key)}</p>${inspectForm(csrf, scope, "key", key)}`}<p>Inspection does not create or restore access. Current roles, credentials and exact grants still govern moderation.</p>${historyForm(csrf, scope)}${navigation}</section>`,
  );
}
export function circleGrantHistoryPage(csrf: string, history: CircleGrantPage) {
  return page(
    "Circle grant history",
    `<section class="reading">${notice}<h1>Circle grant history</h1><p>Exact staff reference: ${escape(history.staffId)}. Exact circle: ${escape(history.circleId)}.</p><p>States observed at ${time(history.observedAt)}; they do not guarantee future access.</p>${history.items.length ? history.items.map((item) => record(csrf, history, item)).join("") : "<p>No retained grants or recorded audit events were found on this observation. An earlier unconfirmed submission may still have an unknown outcome.</p>"}<p>At most 20 grants per page. Revoking one preserves distinct overlapping grants. Expired or ineffective retained grants remain individually revocable. Reading history does not renew authority or restore deleted records.</p>${history.nextCursor === null ? "" : historyForm(csrf, history, history.nextCursor)}${navigation}</section>`,
  );
}
export function circleGrantNoticePage(
  csrf: string,
  message: string,
  attempt?: CircleGrantAttempt,
  scope?: CircleGrantScope,
  canRetry = false,
) {
  const recovery = attempt
    ? `<p>The grant may already have committed. Inspect its saved state before any further action. Missing state is an unknown outcome, not proof of noncommit. Nothing is retried automatically.</p>${inspectForm(csrf, attempt, "key", attempt.idempotencyKey)}${canRetry ? `<p>Any explicit retry preserves the original key and exact instruction. Changed instructions conflict with a retained submission.</p>${creationForm(csrf, attempt, true)}` : `<dl><dt>Exact staff reference</dt><dd>${escape(attempt.staffId)}</dd><dt>Exact circle</dt><dd>${escape(attempt.circleId)}</dd><dt>Original submission key</dt><dd>${escape(attempt.idempotencyKey)}</dd><dt>Original expiry</dt><dd>${escape(attempt.expiresAt)}</dd></dl>`}`
    : "";
  return page(
    "Circle grant unavailable",
    `<section class="reading"><h1>Circle grant unavailable</h1><p role="alert">${escape(message)}</p>${recovery}${scope ? historyForm(csrf, scope) : ""}${navigation}</section>`,
  );
}
