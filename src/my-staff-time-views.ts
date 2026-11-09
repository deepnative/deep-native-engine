import { portalActions } from "./backend-portal-presentation.ts";
import { readableTime } from "./display-time.ts";
import { hostingText } from "./hosting-presentation.ts";
import type { MyRosterRecord, MyStaffTimeSnapshot } from "./my-staff-time.ts";
import { escape, page } from "./views.ts";

const path = "/review/my-time";
const minutes = (value: number) => `${value} min`;
const when = (value: Date) =>
  `<time datetime="${escape(value.toISOString())}">${readableTime(value)}</time>`;
function fields(rows: [string, string, string][]) {
  return `<dl>${rows.map(([key, label, value]) => `<dt>${label}</dt><dd data-field="${key}">${value}</dd>`).join("")}</dl>`;
}
const service = { coaching: "Coaching", "formal-review": "Formal review" };
// MYTIME-03: the first failing registry check, in plain words.
const notBookable = {
  unverified:
    "Not bookable: this record hasn't been verified, so it isn't qualified coverage.",
  inactive: "Not bookable: your staff access isn't current.",
  no_backup:
    "Not bookable: your named backup has no current verified record for this service.",
} as const;

function room(record: MyRosterRecord) {
  if (record.roomMinutes === null)
    return notBookable[record.standing as keyof typeof notBookable];
  return record.roomMinutes < 0
    ? `Over by ${minutes(-record.roomMinutes)}`
    : minutes(record.roomMinutes);
}
function recordSection(record: MyRosterRecord, index: number) {
  const key = (name: string) => `${index}.${name}`;
  const held = record.held.length
    ? `<ul data-held-slots="${index}">${record.held.map((slot) => `<li>${when(slot.startsAt)} to ${when(slot.endsAt)}</li>`).join("")}</ul>`
    : `<p data-held-slots="${index}">No slot is held.</p>`;
  return `<section class="portal-card" data-my-record="${index}" data-standing="${record.standing}"><h2>${service[record.service]} · ${escape(record.domain)}</h2>${
    record.standing === "covered"
      ? ""
      : `<p role="status">${notBookable[record.standing]}</p>`
  }${fields([
    [
      key("window"),
      "Accepted window",
      `${when(record.startsAt)} to ${when(record.endsAt)}`,
    ],
    [key("capacity"), "Declared capacity", minutes(record.capacityMinutes)],
    [
      key("committed"),
      "Recorded commitments",
      minutes(record.committedMinutes),
    ],
    [
      key("slots"),
      "Open future slots, held or not",
      minutes(record.slotMinutes),
    ],
    [key("held"), "Held sample slots", String(record.held.length)],
    [key("room"), "Room left after commitments and open slots", room(record)],
  ])}<h3>Held sample slots</h3>${held}</section>`;
}

export function myStaffTimePage(snapshot: MyStaffTimeSnapshot) {
  const records = snapshot.records.length
    ? snapshot.records.map(recordSection).join("")
    : `<p role="status" data-my-records="none">You have no current roster record, so nothing is bookable with you.</p>`;
  const lapsed = snapshot.notCurrent
    ? `<p data-not-current>${snapshot.notCurrent} of your records ${snapshot.notCurrent === 1 ? "is" : "are"} outside ${snapshot.notCurrent === 1 ? "its" : "their"} window or retired, so ${snapshot.notCurrent === 1 ? "it isn't" : "they aren't"} shown.</p>`
    : "";
  return page(
    "My booked time",
    `<article class="reading"><p class="eyebrow">STAFF · ${hostingText("PREVIEW RECORDS", "TEST DATA")} · ONLY YOUR RECORDS</p><h1>My booked time</h1><p>Your own roster records in the expert registry: the time members hold with you and the room left in each accepted window. Records where you are only the backup aren't shown.</p><p>As of <time datetime="${escape(snapshot.asOf.toISOString())}">${readableTime(snapshot.asOf)}</time>. A later read may differ.</p>${portalActions(
      [
        [path, "Read a fresh snapshot"],
        ["/staff", "Your staff tools"],
      ],
    )}${records}${lapsed}<h2>What this page cannot establish</h2><ul><li>Queued review or support requests are not available time and set no due date. Only held slots and recorded commitments are counted.</li><li>A held sample slot is a test hold, not a booking. No member, request or allowance is named.</li><li>Room left is declared capacity minus recorded commitments and open slots. It isn't a calendar and doesn't confirm you can deliver it.</li><li>Nothing here changes a record, a slot or a hold.</li></ul></article>`,
  );
}
export function myStaffTimeUnavailablePage(
  kind: "denied" | "unavailable" | "live" | "query",
) {
  const message = {
    denied: "This page is only for a signed-in staff member.",
    unavailable:
      "Your booked time could not be confirmed. No figures are shown. Nothing is retried automatically.",
    live: "This page is unavailable in live mode, so it shows no live figures.",
    query:
      "This page does not accept query fields or filters. Open it using its original link.",
  }[kind];
  return page(
    "Booked time unavailable",
    `<section class="error-page"><h1>Booked time unavailable</h1><p role="alert">${message}</p>${portalActions(
      [
        [path, "Open the page"],
        ["/staff", "Your staff tools"],
      ],
    )}</section>`,
  );
}
