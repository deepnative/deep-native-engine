import { rangeTag, timeTag } from "./display-time.ts";
import { hostingText } from "./hosting-presentation.ts";
import type {
  CancelReason,
  StaffCancellation,
  StaffCancelResult,
  StaffHeldSample,
} from "./sample-hold-cancellations.ts";
import { escape, hidden, page } from "./views.ts";

export const sampleHoldCancellationBase = "/operator/sample-holds";
export const cancelPath = (holdId: string) =>
  `${sampleHoldCancellationBase}/${encodeURIComponent(holdId)}/cancel`;
/** Staff wording, and the member's wording on their receipt. */
export const CANCEL_REASON_LABELS: Record<CancelReason, string> = {
  "coach-unavailable": "The coach is unavailable",
  "scheduling-error": "The window was listed in error",
  "member-request": "The member asked staff to cancel",
};
const title = "Staff sample holds";
// STAFFCANCEL: every page says what a cancellation does and does not do.
const notice = () =>
  `${hostingText("Local sample holds", "Sample holds")} with test minutes only, never bookings. Cancelling one frees its window and adds one replacement credit of the same test minutes, valid for the same dates as the credit it replaces. Nothing is paid, refunded or sent, and the member's earlier history is kept.`;
function shell(body: string) {
  return page(
    title,
    `<section class="reading"><p class="eyebrow">STAFF · SAMPLE HOLDS — NOT BOOKINGS</p><h1>${title}</h1><p>${notice()}</p>${body}</section>`,
  );
}
function cancellation(value: StaffCancellation) {
  return `<dl><dt>Hold</dt><dd>${escape(value.holdId)}</dd><dt>Slot</dt><dd>${escape(value.slotId)}</dd><dt>Window</dt><dd>${rangeTag(value.startsAt, value.endsAt, "UTC")}</dd><dt>Reason</dt><dd>${escape(CANCEL_REASON_LABELS[value.reason])}</dd><dt>Cancelled</dt><dd>${timeTag(value.cancelledAt, "UTC")} · ${value.cancelledByReader ? "by you" : "by another staff member"}</dd><dt>Replacement credit</dt><dd>${value.replacementMinutes} test minutes</dd><dt>Valid from</dt><dd>${timeTag(value.replacementStartsAt, "UTC")}</dd><dt>Valid until</dt><dd>${timeTag(value.replacementExpiresAt, "UTC")}</dd></dl>`;
}
function heldItem(hold: StaffHeldSample, csrf: string, requestId: string) {
  const id = escape(hold.holdId);
  return `<li><p><strong>Slot ${escape(hold.slotId)}</strong> · ${escape(hold.domain)} · ${escape(hold.serviceType)}</p><p>${rangeTag(hold.startsAt, hold.endsAt, "UTC")} · held until ${timeTag(hold.expiresAt, "UTC")}</p><form method="post" action="${cancelPath(hold.holdId)}">${hidden(csrf)}<input type="hidden" name="requestId" value="${escape(requestId)}"><label for="reason-${id}">Reason</label><select id="reason-${id}" name="reason" required><option value="">Choose a reason</option>${Object.entries(
    CANCEL_REASON_LABELS,
  )
    .map(
      ([value, label]) => `<option value="${value}">${escape(label)}</option>`,
    )
    .join(
      "",
    )}</select><button type="submit">Cancel sample hold as staff</button></form></li>`;
}
export function staffSampleHoldsPage(view: {
  held: StaffHeldSample[];
  recent: StaffCancellation[];
  csrf: string;
  requestIds: Record<string, string>;
}) {
  const held = view.held.length
    ? `<ul>${view.held.map((hold) => heldItem(hold, view.csrf, view.requestIds[hold.holdId]!)).join("")}</ul>`
    : `<p role="status">No sample hold is currently held.</p>`;
  const recent = view.recent.length
    ? `<ul>${view.recent.map((item) => `<li>${cancellation(item)}</li>`).join("")}</ul>`
    : "<p>No sample hold has been cancelled by staff.</p>";
  return shell(
    `<p>Members are not named here. A member sees the cancellation, its reason and the replacement credit on their own receipt.</p><h2>Currently held</h2>${held}<h2>Recent staff cancellations</h2>${recent}<p><a href="${sampleHoldCancellationBase}">Read a fresh list</a></p>`,
  );
}
export function staffCancelResultPage(
  kind: "applied" | "replayed",
  value: StaffCancellation,
) {
  return shell(
    `<p role="status">${kind === "applied" ? "Sample hold cancelled. One replacement credit was added." : "This cancellation was already recorded. No second credit was added."}</p>${cancellation(value)}<p><a href="${sampleHoldCancellationBase}">Back to staff sample holds</a></p>`,
  );
}
type Failure = Exclude<StaffCancelResult["kind"], "applied" | "replayed">;
const failureText: Record<Failure, string> = {
  stale:
    "This hold changed since the page was opened. Nothing was cancelled or credited. Read a fresh list before trying again.",
  ended:
    "The credit this hold reserved has reached the end of its dates, so it cannot be replaced. Nothing was cancelled or credited; the hold ends at its own deadline.",
  conflict:
    "This form was already used for a different cancellation. Nothing more was changed. Read a fresh list.",
  denied:
    "Staff sample holds need current operator access. Nothing is disclosed and nothing was changed.",
  invalid:
    "That was not accepted. Choose one of the listed reasons on a current form. Nothing was changed.",
  unavailable:
    "The cancellation could not be confirmed. Do not assume it succeeded or failed; read a fresh list before trying again.",
};
export function staffCancelFailurePage(kind: Failure) {
  const back =
    kind === "denied"
      ? ""
      : `<p><a href="${sampleHoldCancellationBase}">Read a fresh list</a></p>`;
  return shell(`<p role="status">${failureText[kind]}</p>${back}`);
}
export function staffSampleHoldsUnavailablePage() {
  return page(
    title,
    `<section class="error-page"><h1>${title}</h1><p role="status">Sample holds are test records, so staff cancellation is not available on this site.</p></section>`,
  );
}
