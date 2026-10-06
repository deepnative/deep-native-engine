import { escape, hidden, page } from "./views.ts";
import type {
  EventCancellationAttempt,
  EventCancellationPreview,
  EventCancellationReceipt,
  EventCancellationScope,
} from "./event-cancellation-values.ts";
const base = "/operator/event-cancellations";
const notice = `<p class="eyebrow">PRIVATE LOCAL EVENT REHEARSAL</p><p>Cancel one exact invented event version. This does not cancel a real appointment, notify attendees, issue refunds or record attendance. No attendee directory or private member work is shown.</p>`;
const navigation = `<p><a href="${base}">Event cancellation</a> · <a href="/staff">Your staff tools</a></p>`;
const scopeFields = (scope: EventCancellationScope) =>
  `<label>Exact event ID<input name="eventId" value="${escape(scope.eventId)}" readonly required></label><label>Exact version<input name="eventVersion" value="${scope.eventVersion}" readonly required></label>`;
const referenceInputs = `<label for="eventId">Exact event ID</label><input id="eventId" name="eventId" maxlength="80" required><label for="eventVersion">Exact version</label><input id="eventVersion" name="eventVersion" inputmode="numeric" maxlength="7" required>`;
export function eventCancellationHome(csrf: string, enabled: boolean) {
  return page(
    "Event cancellation",
    `<section class="reading">${notice}<h1>Event cancellation</h1><p>${enabled ? "Check an exact future opted-in event before confirming cancellation." : "New cancellations are paused. Existing cancelled events remain closed; protected inspection is still available."}</p><form method="post" action="${base}/check">${hidden(escape(csrf))}${referenceInputs}<button type="submit">Check exact event</button></form><h2>Inspect retained cancellation</h2><form method="post" action="${base}/inspect">${hidden(escape(csrf))}${referenceInputs}<label for="key">Original submission key (optional)</label><input id="key" name="key" maxlength="36" autocomplete="off"><button type="submit">Inspect saved cancellation</button></form>${navigation}</section>`,
  );
}
function attemptFields(attempt: EventCancellationAttempt) {
  return `${scopeFields(attempt)}<label>Checked title<input name="title" value="${escape(attempt.title)}" maxlength="200" readonly required></label><label>Checked start (UTC)<input name="startsAt" value="${escape(attempt.startsAt)}" readonly required></label><label>Checked end (UTC)<input name="endsAt" value="${escape(attempt.endsAt)}" readonly required></label><label>Checked sample capacity<input name="capacity" value="${attempt.capacity}" readonly required></label><label>Original submission key<input name="key" value="${escape(attempt.key)}" readonly required></label>`;
}
function inspectForm(csrf: string, scope: EventCancellationScope, key = "") {
  return `<form method="post" action="${base}/inspect" target="_blank">${hidden(escape(csrf))}${scopeFields(scope)}<input type="hidden" name="key" value="${escape(key)}"><button type="submit">Inspect saved cancellation in a new tab</button></form>`;
}
export function eventCancellationConfirm(
  csrf: string,
  preview: EventCancellationPreview,
  attempt: EventCancellationAttempt,
) {
  if (preview.receipt)
    return eventCancellationReceipt(csrf, attempt, preview.receipt);
  return page(
    "Confirm event cancellation",
    `<section class="reading">${notice}<h1>Confirm event cancellation</h1><p>Check the exact version and schedule. Cancellation is permanent for this version; saved registrations are retained separately from voluntary withdrawal.</p>${preview.creationEnabled ? `<form method="post" action="${base}/cancel">${hidden(escape(csrf))}${attemptFields(attempt)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I confirm cancelling this exact invented event version.</span></label><button type="submit">Cancel this event version</button></form>` : `<p role="status">New cancellation is unavailable for this version or configuration.</p>`}${inspectForm(csrf, attempt)}${navigation}</section>`,
  );
}
export function eventCancellationReceipt(
  csrf: string,
  scope: EventCancellationScope,
  receipt: EventCancellationReceipt | null,
  key = "",
) {
  return page(
    "Event cancellation receipt",
    `<section class="reading">${notice}<h1>Event cancellation receipt</h1>${receipt ? `<h2>${escape(receipt.title)}</h2><dl><dt>Exact event/version</dt><dd>${escape(receipt.eventId)} / ${receipt.eventVersion}</dd><dt>Cancellation ID</dt><dd>${escape(receipt.id)}</dd><dt>Event cancelled (UTC)</dt><dd>${receipt.cancelledAt.toISOString()}</dd><dt>Original schedule (UTC)</dt><dd>${receipt.startsAt.toISOString()} to ${receipt.endsAt.toISOString()}</dd></dl><p role="status">New registrations are closed. Members retain their owned registration receipts and may separately withdraw them.</p>` : `<p role="status">No retained cancellation is confirmed by this inspection. This is not a guarantee that an earlier uncertain request cannot still complete. Nothing was created or reversed.</p>`}${key ? `<p>Original submission key: ${escape(key)}</p>` : ""}${inspectForm(csrf, scope, key)}${navigation}</section>`,
  );
}
export function eventCancellationNotice(
  csrf: string,
  message: string,
  attempt?: EventCancellationAttempt,
) {
  return page(
    "Event cancellation needs attention",
    `<section class="reading">${notice}<h1>Event cancellation needs attention</h1><p role="alert">${escape(message)}</p>${attempt ? `${inspectForm(csrf, attempt, attempt.key)}<details><summary>Repeat the exact original instruction manually</summary><p>Inspect saved state first. This keeps the original key and checked event snapshot; no automatic retry, replacement key or compensation occurs.</p><form method="post" action="${base}/cancel">${hidden(escape(csrf))}${attemptFields(attempt)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I confirm repeating this exact original instruction.</span></label><button type="submit">Repeat original cancellation</button></form></details>` : ""}${navigation}</section>`,
  );
}
