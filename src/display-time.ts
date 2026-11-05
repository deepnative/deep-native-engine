// Every date a reader sees goes through here, so it reads the same everywhere
// and always says which zone it is in. Exports and datetime attributes keep the
// exact machine value; this module only decides what is displayed.

const TIME_UNAVAILABLE = "Time unavailable";
const DATE_UNAVAILABLE = "Date unavailable";

type Moment = Date | string;

function parsed(value: Moment) {
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isFinite(date.getTime()) ? date : null;
}

function validZone(timezone?: string | null) {
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return timezone;
  } catch {
    return null;
  }
}

function fields(date: Date, timezone: string | null) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone ?? "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)!.value;
  return {
    day: `${part("month")} ${part("day")}, ${part("year")}`,
    time: `${part("hour")}:${part("minute")} ${part("dayPeriod")}`,
    zone: timezone ? `${part("timeZoneName")} (${timezone})` : "UTC",
  };
}

/** "November 3, 2030, 5:30 a.m. UTC", or in a saved zone when one is given. */
export function readableTime(value: Moment, timezone?: string | null) {
  const date = parsed(value);
  if (!date) return TIME_UNAVAILABLE;
  const { day, time, zone } = fields(date, validZone(timezone));
  return `${day}, ${time} ${zone}`;
}

/** "October 27, 2026". A day-only value stays on its own calendar date. */
export function readableDay(value: Moment) {
  const date = parsed(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}T00:00:00.000Z`
      : value,
  );
  return date ? fields(date, null).day : DATE_UNAVAILABLE;
}

/**
 * "November 3, 2030, 5:30 a.m. to 6:30 a.m. UTC". The date and zone are only
 * shared when both ends agree, so a daylight-saving change stays visible.
 */
export function readableRange(
  start: Moment,
  end: Moment,
  timezone?: string | null,
) {
  const ends = rangeEnds(start, end, timezone);
  return ends ? `${ends.first} to ${ends.last}` : TIME_UNAVAILABLE;
}

function rangeEnds(start: Moment, end: Moment, timezone?: string | null) {
  const from = parsed(start),
    to = parsed(end);
  if (!from || !to) return null;
  const zone = validZone(timezone);
  const first = fields(from, zone),
    last = fields(to, zone);
  const shared = first.day === last.day && first.zone === last.zone;
  return {
    from,
    to,
    first: `${first.day}, ${first.time}${shared ? "" : ` ${first.zone}`}`,
    last: shared
      ? `${last.time} ${last.zone}`
      : `${last.day}, ${last.time} ${last.zone}`,
  };
}

/** A readable time whose exact value stays available to machines. */
export function timeTag(value: Moment, timezone?: string | null) {
  const date = parsed(value);
  return date
    ? `<time datetime="${date.toISOString()}">${readableTime(date, timezone)}</time>`
    : TIME_UNAVAILABLE;
}

/** readableRange with each end's exact value kept for machines. */
export function rangeTag(start: Moment, end: Moment, timezone?: string | null) {
  const ends = rangeEnds(start, end, timezone);
  return ends
    ? `<time datetime="${ends.from.toISOString()}">${ends.first}</time> to <time datetime="${ends.to.toISOString()}">${ends.last}</time>`
    : TIME_UNAVAILABLE;
}

/** Wraps already-escaped text, such as FND-003, so it stays on one line. */
export function noBreak(html: string) {
  return `<span class="no-break">${html}</span>`;
}

/** Applies noBreak to short codes and dates inside already-escaped free text. */
export function keepCodesTogether(html: string) {
  return html.replace(
    /(?<![\w/.-])(?:[A-Z]{2,5}-\d{2,4}|\d{4}-\d{2}-\d{2})(?![\w/-])/g,
    noBreak,
  );
}
