import { escape, hidden, page } from "./views.ts";
import {
  REHEARSAL_TEMPLATE,
  type RehearsalSnapshot,
  type RehearsalReceipt,
} from "./event-rehearsal-values.ts";
export interface RehearsalAttempt {
  key: string;
  snapshot: RehearsalSnapshot;
}
const base = "/operator/event-rehearsals";
const integrity = (csrf: string) => hidden(escape(csrf));
const notice = `<p class="eyebrow">INVENTED PRIVATE REHEARSAL</p><p>Schedule a local learning rehearsal using the trusted sample template. This is not a real clinic, expert service, recording, attendance record or paid booking. No member directory is shown.</p>`;
const nav = `<p><a href="${base}">Rehearsal scheduling</a> · <a href="/operator/event-cancellations">Event cancellation</a> · <a href="/staff">Your staff tools</a></p>`;
const instruction = (startsAt = "") =>
  `<label>Trusted template<input name="templateId" readonly required value="${escape(REHEARSAL_TEMPLATE.id)}"></label><label>Template version<input name="templateVersion" readonly required value="${REHEARSAL_TEMPLATE.version}"></label><label>Start in UTC<input name="startsAt" required maxlength="24" placeholder="2026-10-07T15:30:00.000Z" value="${escape(startsAt)}"></label><p>Use the full UTC format shown. Starts must be two minutes to thirty days ahead of the database clock. The template sets duration and sample capacity.</p>`;
function checkedFields(attempt: RehearsalAttempt) {
  return `${Object.entries(attempt.snapshot)
    .map(
      ([name, value]) =>
        `<label>${escape(name)}<input name="${escape(name)}" readonly required value="${escape(String(value))}"></label>`,
    )
    .join(
      "",
    )}<label>Original submission key<input name="key" readonly required value="${escape(attempt.key)}"></label>`;
}
const inspect = (csrf: string, attempt: RehearsalAttempt) =>
  `<form method="post" action="${base}/inspect" target="_blank">${integrity(csrf)}${checkedFields(attempt)}<button type="submit">Inspect saved result in a new tab</button></form>`;
export function eventRehearsalHome(csrf: string, enabled: boolean) {
  return page(
    "Schedule a private rehearsal",
    `<section class="reading">${notice}<h1>Schedule a private rehearsal</h1><p>${enabled ? "Check a proposed schedule before deliberately confirming it." : "New scheduling is paused. Saved rehearsals and protected inspection remain available."}</p>${enabled ? `<form method="post" action="${base}/check">${integrity(csrf)}${instruction()}<button type="submit">Check proposed schedule</button></form>` : ""}<h2>Inspect an original instruction</h2><p>Use the original template, UTC start and key. Inspection creates nothing and never retries a schedule.</p><form method="post" action="${base}/inspect">${integrity(csrf)}${instruction()}<label>Original submission key<input name="key" required maxlength="36" autocomplete="off"></label><button type="submit">Inspect original instruction</button></form>${nav}</section>`,
  );
}
export function eventRehearsalConfirm(
  csrf: string,
  attempt: RehearsalAttempt,
  enabled: boolean,
) {
  return page(
    "Confirm private rehearsal",
    `<section class="reading">${notice}<h1>Confirm private rehearsal</h1><p>These are the exact trusted content, dates and sample capacity you checked. A different schedule creates a separate event; it never changes or transfers an existing registration.</p>${enabled ? `<form method="post" action="${base}/schedule">${integrity(csrf)}${checkedFields(attempt)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I deliberately confirm this exact invented rehearsal schedule.</span></label><button type="submit">Schedule private rehearsal</button></form>` : `<p role="status">New scheduling is unavailable. Nothing was created.</p>`}${inspect(csrf, attempt)}${nav}</section>`,
  );
}
export function eventRehearsalReceipt(receipt: RehearsalReceipt | null) {
  return page(
    "Private rehearsal receipt",
    `<section class="reading">${notice}<h1>Private rehearsal receipt</h1>${receipt ? `<dl><dt>Canonical receipt</dt><dd>${escape(receipt.id)}</dd><dt>Exact event/version</dt><dd>${escape(receipt.eventId)} / ${receipt.eventVersion}</dd><dt>Title</dt><dd>${escape(receipt.title)}</dd><dt>Schedule (UTC)</dt><dd>${receipt.startsAt.toISOString()} to ${receipt.endsAt.toISOString()}</dd><dt>Scheduled (UTC)</dt><dd>${receipt.scheduledAt.toISOString()}</dd></dl><p role="status">This invented rehearsal is saved. Current cancellation state and registration availability are checked separately.</p><p><a href="/events/${escape(receipt.eventId)}/${receipt.eventVersion}">Open member event detail with your learner access</a></p>` : `<p role="status">No saved rehearsal is confirmed by this inspection. An earlier uncertain instruction could still complete; do not substitute a new key.</p>`}${nav}</section>`,
  );
}
export function eventRehearsalNotice(
  csrf: string,
  message: string,
  attempt?: RehearsalAttempt,
) {
  return page(
    "Rehearsal scheduling needs attention",
    `<section class="reading">${notice}<h1>Rehearsal scheduling needs attention</h1><p role="alert">${escape(message)}</p>${attempt ? `${inspect(csrf, attempt)}<details><summary>Repeat the exact original instruction manually</summary><p>Inspect saved state first. No automatic retry, replacement key or compensation occurs.</p><form method="post" action="${base}/schedule">${integrity(csrf)}${checkedFields(attempt)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I confirm repeating the exact original instruction.</span></label><button type="submit">Repeat original schedule</button></form></details>` : ""}${nav}</section>`,
  );
}
