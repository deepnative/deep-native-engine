import { timeTag, rangeTag } from "./display-time.ts";
import { escape, hidden, page } from "./views.ts";
import {
  eventText,
  hostingText,
  privateRecordsLabel,
} from "./hosting-presentation.ts";
import { localSlotTime } from "./availability.ts";
import type {
  EventEnrollmentPreview,
  EventEnrollmentReceipt,
} from "./event-enrollments.ts";
export const eventReceiptPath = (id: string) =>
  `/events/registrations/${encodeURIComponent(id)}`;
const notice = () =>
  `<p class="eyebrow">${hostingText("PRIVATE LOCAL REHEARSAL", "PRIVATE PRACTICE REGISTRATION")} · INVENTED DATA ONLY</p><p>This saves a sample registration, not a real appointment. No expert, paid service, notification, recording or live clinic is provided.</p>`;
function schedule(startsAt: Date, endsAt: Date, timezone?: string | null) {
  const start = timezone ? localSlotTime(startsAt, timezone) : null,
    end = timezone ? localSlotTime(endsAt, timezone) : null;
  return `<p>${rangeTag(startsAt, endsAt)}.</p>${start && end ? `<p>In your saved time zone, ${escape(timezone!)}: ${escape(start)} to ${escape(end)}.</p>` : '<p><a href="/learn#timezone">Set your time zone</a> to see local times.</p>'}`;
}
export function eventEnrollmentPage(
  preview: EventEnrollmentPreview,
  csrf: string,
  operationId: string,
  timezone?: string | null,
) {
  const { event } = preview;
  const cancellation = preview.cancelledAt
    ? `<p role="status">Event cancelled · ${timeTag(preview.cancelledAt)}. New registrations are closed; any saved receipt remains available.</p>`
    : "";
  const action = preview.activeReceiptId
    ? `<p role="status">You already have a sample registration for this version.</p><p><a href="${eventReceiptPath(preview.activeReceiptId)}">Open your registration receipt</a></p>`
    : !preview.cancelledAt &&
        preview.canEnroll &&
        preview.remaining !== null &&
        preview.remaining > 0
      ? `<form method="post" action="/events/${encodeURIComponent(event.id)}/${event.version}/enroll">${hidden(escape(csrf))}<input type="hidden" name="operation_id" value="${escape(operationId)}"><label class="check"><input type="checkbox" name="synthetic" value="yes" required><span>I want to save an invented-data registration; this is not a real appointment.</span></label><button type="submit">${hostingText("Enroll in local rehearsal", "Save practice registration")}</button></form>`
      : `<p role="status">${preview.canEnroll ? `${hostingText("This local rehearsal", "This practice registration")} is full. Choose another event from Sample events below, or check back later.` : hostingText("New local registrations are unavailable.", "New practice registrations are unavailable.")}</p>`;
  return page(
    hostingText("Local event rehearsal", "Practice event registration"),
    `<section class="reading">${notice()}<h1>${escape(eventText(event.title))}</h1><p>${hostingText("Exact version", "Version")} ${event.version}</p>${schedule(new Date(event.startsAt), new Date(event.endsAt), timezone)}${preview.remaining !== null ? `<p>${hostingText("Observed rehearsal seats", "Practice seats")} remaining: ${preview.remaining} of ${event.fixtureCapacity}. Availability can change before you enroll.</p>` : ""}${cancellation}${action}<p><a href="/events/registrations">Your registration history</a> · <a href="/events">Sample events</a></p></section>`,
  );
}
export function eventEnrollmentReceiptPage(
  receipt: EventEnrollmentReceipt,
  csrf: string,
  timezone?: string | null,
  attendanceAvailable = false,
) {
  const receiptPage = page(
    "Private registration receipt",
    `<section class="reading">${notice()}<h1>Private registration receipt</h1><h2>${escape(eventText(receipt.title))}</h2><p>${hostingText("Exact version", "Version")} ${receipt.eventVersion}</p>${schedule(receipt.startsAt, receipt.endsAt, timezone)}<p role="status">${receipt.withdrawnAt ? "Registration withdrawn. This attempt cannot be reactivated." : receipt.cancelledAt ? "The saved registration is retained for the cancelled event." : hostingText("Registered for the local rehearsal.", "Saved as a practice registration.")}</p>${receipt.cancelledAt ? `<p role="status">Event cancelled · ${timeTag(receipt.cancelledAt)}. This does not withdraw your saved registration.</p>` : ""}<p>Saved ${timeTag(receipt.createdAt)}${receipt.withdrawnAt ? ` · Withdrawn ${timeTag(receipt.withdrawnAt)}` : ""}</p>${receipt.withdrawnAt ? "" : `<form method="post" action="${eventReceiptPath(receipt.id)}/withdraw">${hidden(escape(csrf))}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Withdraw this exact sample registration and release its seat.</span></label><button type="submit">Withdraw registration</button></form>`}${receipt.cancelledAt ? "" : `<p><a href="/events/${encodeURIComponent(receipt.eventId)}/${receipt.eventVersion}/rehearsal">Check this version for a new registration</a></p>`}<p><a href="/events/registrations">Your registration history</a> · <a href="/member/export">${privateRecordsLabel()}</a> · <a href="/events">Sample events</a></p></section>`,
  );
  return attendanceAvailable
    ? receiptPage.replace(
        "</section>",
        `<p><a href="${eventReceiptPath(receipt.id)}/attendance">My private attendance receipt</a></p></section>`,
      )
    : receiptPage;
}
export function eventEnrollmentHistoryPage(history: {
  items: EventEnrollmentReceipt[];
  nextCursor: string | null;
}) {
  return page(
    "Your registration history",
    `<section class="reading">${notice()}<h1>Your registration history</h1>${history.items.length ? `<ul>${history.items.map((item) => `<li><a href="${eventReceiptPath(item.id)}">${escape(eventText(item.title))} · version ${item.eventVersion} · ${item.withdrawnAt ? "withdrawn" : "registered"}${item.cancelledAt ? ` · event cancelled ${timeTag(item.cancelledAt)}` : ""} · ${timeTag(item.createdAt)}</a></li>`).join("")}</ul>` : "<p>No sample registrations are saved.</p>"}${history.nextCursor ? `<p><a href="/events/registrations?after=${encodeURIComponent(history.nextCursor)}">More registrations</a></p>` : ""}<p><a href="/events">Sample events</a></p></section>`,
  );
}
export function eventEnrollmentRecovery(message: string, receiptId?: string) {
  return page(
    "Registration needs attention",
    `<section class="reading"><h1>Registration needs attention</h1><p role="alert">${escape(message)}</p>${receiptId ? `<p><a href="${eventReceiptPath(receiptId)}">Check this registration attempt</a></p>` : ""}<p><a href="/events/registrations">Inspect your saved registrations</a> before starting a new attempt. No automatic retry occurs.</p><p><a href="/events">Sample events</a></p></section>`,
  );
}
