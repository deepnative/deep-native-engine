import { portalActions } from "./backend-portal-presentation.ts";
import { readableTime } from "./display-time.ts";
import { hostingText } from "./hosting-presentation.ts";
import type {
  CapacityGroup,
  ReviewTimeCommitments,
  StaffCapacitySnapshot,
  SupportTimeCommitments,
} from "./staff-capacity.ts";
import { escape, page } from "./views.ts";

const minutes = (value: number) => `${value} min`;
function fields(rows: [string, string, string][]) {
  return `<dl>${rows.map(([key, label, value]) => `<dt>${label}</dt><dd data-field="${key}">${value}</dd>`).join("")}</dl>`;
}
const heading = { coaching: "Coaching", "formal-review": "Formal review" };
function groupSection(row: CapacityGroup) {
  const statusText = {
    empty:
      "No current roster records. Available capacity is not recorded, which is not the same as none.",
    consistent:
      "Verified records leave room after their commitments and open slots. This does not confirm anyone can deliver it.",
    discrepancies:
      "Some verified records are committed past their capacity. They stay visible below. This report corrects nothing.",
  }[row.status];
  const key = (name: string) => `${row.service}.${name}`;
  return `<section class="portal-card" data-capacity-group="${row.service}"><h2>${heading[row.service]}</h2><p role="status" data-capacity-status="${row.status}">${statusText}</p><h3>Verified roster records</h3><p>Records that pass the registry's own checks: a verifier, qualification, agreement and conflict references, active staff access and a verified backup. This report repeats those checks. It doesn't confirm anyone's qualifications.</p>${fields(
    [
      [key("covered"), "Verified records", String(row.covered)],
      [key("capacity"), "Declared capacity", minutes(row.capacityMinutes)],
      [
        key("committed"),
        "Declared committed, typed into the registry",
        minutes(row.committedMinutes),
      ],
      [key("slots"), "Open future slots", minutes(row.slotMinutes)],
      [key("held"), "Slots held by a member", String(row.heldSlots)],
      [
        key("available"),
        "Available, per record, after commitments and open slots",
        row.availableMinutes === null
          ? "Not recorded"
          : minutes(row.availableMinutes),
      ],
      [
        key("overcommitted"),
        `Committed past capacity (${row.overcommitted})`,
        minutes(row.overcommitMinutes),
      ],
    ],
  )}<h3>Not counted as available coverage</h3>${fields([
    [
      key("unverified"),
      `Unverified records, not qualified coverage (${row.unverified})`,
      `${minutes(row.unverifiedCapacityMinutes)} declared, ${minutes(row.unverifiedCommittedMinutes)} committed`,
    ],
    [
      key("noBackup"),
      `Verified, with no verified backup (${row.noBackup})`,
      `${minutes(row.noBackupCapacityMinutes)} declared`,
    ],
    [
      key("inactive"),
      `Verified, staff access ended (${row.inactive})`,
      `${minutes(row.inactiveCapacityMinutes)} declared`,
    ],
    [
      key("notCurrent"),
      "Expired, retired or not yet started",
      String(row.notCurrent),
    ],
  ])}</section>`;
}
function reviewTimeSection(row: ReviewTimeCommitments) {
  const statusText = {
    empty: "No review time to compare.",
    consistent:
      "All granted review time sits with reviewers who have a verified roster record.",
    discrepancies:
      "Some review time is granted to reviewers with no current verified roster record. It stays visible here. This report corrects nothing.",
  }[row.status];
  return `<section class="portal-card" data-review-time><h2>Review time · Test data</h2><p>Invented review time from the review-time test records. It is shown beside the roster's declared commitments and never added to them.</p><p role="status" data-capacity-status="${row.status}">${statusText}</p>${fields(
    [
      [
        "review.open",
        `Open review time (${row.open})`,
        minutes(row.openMinutes),
      ],
      [
        "review.granted",
        `Granted to a reviewer (${row.granted})`,
        minutes(row.grantedMinutes),
      ],
      ["review.reviewers", "Reviewers holding grants", String(row.reviewers)],
      [
        "review.unrostered",
        `Granted to reviewers with no verified roster record (${row.unrostered})`,
        minutes(row.unrosteredMinutes),
      ],
      [
        "review.unrosteredReviewers",
        "Reviewers with no verified roster record",
        String(row.unrosteredReviewers),
      ],
      [
        "review.waiting",
        `Waiting for a reviewer (${row.waiting})`,
        minutes(row.waitingMinutes),
      ],
      ["review.completed", "Completed reviews", String(row.completed)],
      ["review.used", "Review minutes used", minutes(row.reviewMinutes)],
      [
        "review.preparation",
        "Preparation minutes used, counted once",
        minutes(row.preparationMinutes),
      ],
    ],
  )}</section>`;
}
// SUPCAP-01/03: support time members allocated, beside the roster and never added to it.
function supportTimeSection(row: SupportTimeCommitments) {
  const statusText = {
    empty: "No support time to show.",
    recorded:
      "Open support time stays held from the member's support test minutes until an operator settles it or the member cancels.",
  }[row.status];
  return `<section class="portal-card" data-support-time><h2>Support time · Test data</h2><p>Invented support time from the support-time test records. Each open allocation is counted once at the minutes the member held for it. It is shown beside the roster and never added to coaching or review.</p><p role="status" data-capacity-status="${row.status}">${statusText}</p>${fields(
    [
      [
        "support.open",
        `Open support time (${row.open})`,
        minutes(row.openMinutes),
      ],
      [
        "support.granted",
        `Granted to an operator (${row.granted})`,
        minutes(row.grantedMinutes),
      ],
      ["support.operators", "Operators holding grants", String(row.operators)],
      [
        "support.waiting",
        `Waiting for an operator (${row.waiting})`,
        minutes(row.waitingMinutes),
      ],
      ["support.completed", "Completed support", String(row.completed)],
      ["support.used", "Support minutes used", minutes(row.supportMinutes)],
      [
        "support.preparation",
        "Preparation minutes used, counted once",
        minutes(row.preparationMinutes),
      ],
    ],
  )}</section>`;
}
export function staffCapacityPage(snapshot: StaffCapacitySnapshot) {
  return page(
    "Staff capacity",
    `<article class="reading"><p class="eyebrow">STAFF · ${hostingText("PREVIEW RECORDS", "TEST DATA")} · NOT A LIVE FIGURE</p><h1>Staff capacity</h1><p>One read-only snapshot comparing the expert registry's declared capacity with its open slots and recorded review time, with support time shown beside them. Coaching, formal review and support are shown apart and are never added together.</p><p>As of <time datetime="${escape(snapshot.asOf.toISOString())}">${readableTime(snapshot.asOf)}</time>. A later read may differ.</p>${portalActions(
      [
        ["/operator/experts", "Expert coverage registry"],
        ["/operator", "Administration console"],
      ],
    )}${snapshot.groups.map(groupSection).join("")}${reviewTimeSection(snapshot.reviewTime)}${supportTimeSection(snapshot.supportTime)}<h2>What this report cannot establish</h2><ul><li>Support has no roster: nobody declares support capacity, so open support time is shown on its own and is compared with nothing.</li><li>A roster record is not proof of qualification. Unverified records are never counted as available coverage.</li><li>Declared capacity and commitments are what staff typed into the registry. No timesheet, calendar or contract is compared.</li><li>Coach assignments to members use a member sign-in, not the staff identity the roster uses, so they can't be matched to roster records and aren't shown.</li><li>No staff cost, forecast, booked service or revenue is shown.</li><li>No staff names, identifiers or qualification, agreement or conflict references are shown. Nothing is corrected or stored.</li></ul><p><a href="/operator/staff-capacity">Read a fresh snapshot</a> · <a href="/operator/delivery-cost">Delivery cost</a></p></article>`,
  );
}
export function staffCapacityUnavailablePage(
  kind: "denied" | "unavailable" | "live" | "query",
) {
  const message = {
    denied: "This report is not available to this session.",
    unavailable:
      "The snapshot could not be confirmed. No figures are shown. Nothing is retried automatically.",
    live: "This report is unavailable in live mode, so it shows no live figures.",
    query:
      "This report does not accept query fields or filters. Open the report using its original link.",
  }[kind];
  return page(
    "Capacity report unavailable",
    `<section class="error-page"><h1>Capacity report unavailable</h1><p role="alert">${message}</p>${portalActions(
      [
        ["/operator/staff-capacity", "Open the report"],
        ["/operator", "Administration console"],
      ],
    )}</section>`,
  );
}

/**
 * COST-01..03 (#94, F-ROADMAP-09-C): what delivery has used so far, from
 * existing records only. Staff time is in minutes, with preparation counted
 * once per completed review or support booking. AI is in simulated cost
 * points and every figure is labelled as an estimate. No money is shown.
 */
export function deliveryCostPage(snapshot: StaffCapacitySnapshot) {
  const review = snapshot.reviewTime,
    support = snapshot.supportTime,
    ai = snapshot.aiUsage;
  const staffMinutes =
    review.reviewMinutes +
    review.preparationMinutes +
    support.supportMinutes +
    support.preparationMinutes;
  const points = (value: number) =>
    `${value} simulated cost point${value === 1 ? "" : "s"} · estimate`;
  return page(
    "Delivery cost",
    `<article class="reading"><p class="eyebrow">STAFF · ${hostingText("PREVIEW RECORDS", "TEST DATA")} · NOT A LIVE FIGURE</p><h1>Delivery cost</h1><p>One read-only snapshot of what delivery has used: recorded staff minutes and estimated AI use. No money is shown, because no staff pay rate or AI price has been set.</p><p>As of <time datetime="${escape(snapshot.asOf.toISOString())}">${readableTime(snapshot.asOf)}</time>. A later read may differ.</p>${portalActions(
      [
        ["/operator/staff-capacity", "Staff capacity"],
        ["/operator/invoice-reconciliation", "Invoice reconciliation"],
        ["/staff", "Staff tools"],
      ],
    )}<section class="portal-card" data-delivery-staff><h2>Staff time used · Test data</h2><p>Minutes staff recorded on completed reviews and completed support bookings. Each completed review or booking has one record, so its preparation is counted once, however many staff held a grant on it. Open and cancelled work is not counted.</p>${fields(
      [
        ["cost.reviews", "Completed reviews", String(review.completed)],
        ["cost.review", "Review minutes", minutes(review.reviewMinutes)],
        [
          "cost.reviewPreparation",
          "Review preparation minutes, counted once",
          minutes(review.preparationMinutes),
        ],
        [
          "cost.supports",
          "Completed support bookings",
          String(support.completed),
        ],
        ["cost.support", "Support minutes", minutes(support.supportMinutes)],
        [
          "cost.supportPreparation",
          "Support preparation minutes, counted once",
          minutes(support.preparationMinutes),
        ],
        ["cost.staffMinutes", "All staff minutes used", minutes(staffMinutes)],
      ],
    )}</section><section class="portal-card" data-delivery-ai><h2>AI use · Estimate</h2><p><strong>ESTIMATE · SIMULATED · NO MONEY CHARGED.</strong> AI figures are simulated cost points at test rates. They are estimates, not a provider's bill, and no AI provider is connected.</p>${fields(
      [
        [
          "cost.aiRequests",
          "AI requests with an estimate",
          String(ai.estimated),
        ],
        [
          "cost.aiEstimated",
          "Estimated before the requests ran",
          points(ai.estimatedPoints),
        ],
        [
          "cost.aiSettled",
          "Requests with recorded simulated use",
          String(ai.settled),
        ],
        [
          "cost.aiSettledPoints",
          "Recorded simulated use of those requests",
          points(ai.settledPoints),
        ],
        [
          "cost.aiSettledEstimate",
          "What those requests were estimated at",
          points(ai.settledEstimatePoints),
        ],
      ],
    )}</section><h2>What this report cannot establish</h2><ul><li>No cost in money. Staff pay rates and AI prices aren't set, so minutes and points are not converted.</li><li>Minutes are what staff typed when they recorded a review or support booking. No timesheet or calendar is compared.</li><li>Coaching sessions aren't recorded as minutes, so they aren't here.</li><li>Invoices and payments are on <a href="/operator/invoice-reconciliation">Invoice reconciliation</a>, where sample and test entries stay apart from real ones.</li><li>No member, staff member or request is named. Nothing is corrected or stored.</li></ul><p><a href="/operator/delivery-cost">Read a fresh snapshot</a></p></article>`,
  );
}
