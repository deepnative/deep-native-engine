import { randomUUID } from "node:crypto";
import { timeTag } from "./display-time.ts";
import { escape, hidden, page } from "./views.ts";
import {
  EARLIER_ALLOWANCE_MONTHS,
  STUDY_ALLOWANCE_PATH,
  type EarlierAllowanceMonth,
  type StudyAllowanceClaim,
  type StudyAllowancePolicy,
  type StudyAllowanceView,
} from "./study-allowance-values.ts";

const HEADING = "Your monthly study allowance";
const links = `<p><a href="/member/test-units">Your test units</a> · <a href="/learn">Learning path</a></p>`;
function policyFacts(policy: StudyAllowancePolicy) {
  return `<h3>This month's rules</h3><dl><dt>Rules version</dt><dd>${escape(policy.version)}</dd><dt>How much</dt><dd>${policy.periodLimit} study requests, each calendar month (UTC)</dd><dt>Who can claim</dt><dd>Any current member who chooses to claim it</dd><dt>Where it comes from</dt><dd>Test setting on this site. It isn't bought, and it isn't a paid plan.</dd><dt>Cost estimate</dt><dd>None. These units never call a paid AI service.</dd></dl>`;
}
function claimFacts(claim: StudyAllowanceClaim) {
  return `<h3>This month's claim</h3><p role="status">Claimed under ${escape(claim.policyVersion)}.</p><dl><dt>Claimed</dt><dd>${claim.quantity} study requests on ${timeTag(claim.createdAt)}</dd><dt>Left to use</dt><dd><span data-field="available">${claim.available}</span> study requests</dd><dt>Held for a request in progress</dt><dd><span data-field="reserved">${claim.reserved}</span></dd><dt>Used</dt><dd><span data-field="consumed">${claim.consumed}</span></dd><dt>Ends</dt><dd>${timeTag(claim.periodEnd)}</dd></dl><p>Unused units end with the month and don't carry over. Nothing renews automatically. The next month opens ${timeTag(claim.periodEnd)}, and you can claim again then.</p>`;
}
function claimForm(
  csrf: string,
  policy: StudyAllowancePolicy,
  start: Date,
  noun = "study requests",
  button = "Claim this month's allowance",
) {
  return `<form method="post" action="${STUDY_ALLOWANCE_PATH}/claim">${hidden(csrf)}<input type="hidden" name="key" value="${randomUUID()}"><input type="hidden" name="policyVersion" value="${escape(policy.version)}"><input type="hidden" name="periodStart" value="${start.toISOString()}"><label class="check"><input type="checkbox" name="confirm" value="yes" required> I want this month's ${policy.periodLimit} ${noun}.</label><button>${button}</button></form>`;
}
function practiceSection(csrf: string, view: StudyAllowanceView) {
  const { policy, claim } = view.practice!;
  const facts = policy
    ? `<dl><dt>Rules version</dt><dd>${escape(policy.version)}</dd><dt>How much</dt><dd>${policy.periodLimit} practice sessions, each calendar month (UTC)</dd><dt>What uses one</dt><dd>Starting a new practice session. Returning to it and saving up to 15 pairs (30 visible turns) uses nothing more.</dd></dl>`
    : "";
  const action = claim
    ? `<p role="status">Claimed under ${escape(claim.policyVersion)}.</p><dl><dt>Left to use</dt><dd><span data-field="practice-available">${claim.available}</span> practice sessions</dd><dt>Used</dt><dd><span data-field="practice-consumed">${claim.consumed}</span></dd><dt>Ends</dt><dd>${timeTag(claim.periodEnd)}</dd></dl><p>Unused sessions end with the month. Withdrawing a session doesn't give its unit back.</p>`
    : !policy
      ? `<p role="status">No practice session allowance is set up at the moment.</p>`
      : view.creationEnabled
        ? claimForm(
            csrf,
            policy,
            view.period.start,
            "practice sessions",
            "Claim this month's practice sessions",
          )
        : `<p role="status">New practice session claims are paused. Sessions you've already started stay open.</p>`;
  // Not <section>: `.reading section` indents numbered lesson steps.
  return `<div data-allowance="mock_sessions"><h2>Practice sessions</h2>${facts}${action}</div>`;
}
const categoryName = {
  study_requests: "Study requests",
  mock_sessions: "Practice sessions",
} as const;
const monthName = (start: Date) =>
  start.toLocaleString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
function earlierRow(row: EarlierAllowanceMonth) {
  const held = row.held
    ? `<p>A request that was in progress when this month ended can still finish and uses that month's unit. If it's cancelled instead, the unit ends with that month and doesn't move to the current month.</p>`
    : "";
  return `<div data-earlier-month="${row.periodStart.toISOString().slice(0, 7)}" data-earlier-category="${row.category}"><h3>${monthName(row.periodStart)} · ${categoryName[row.category]}</h3><dl><dt>Rules version</dt><dd>${escape(row.policyVersion)}</dd><dt>Claimed</dt><dd><span data-field="earlier-claimed">${row.quantity}</span></dd><dt>Used</dt><dd><span data-field="earlier-used">${row.used}</span></dd><dt>Still held for a request in progress</dt><dd><span data-field="earlier-held">${row.held}</span></dd><dt>Ended unused</dt><dd><span data-field="earlier-ended">${row.endedUnused}</span></dd></dl>${held}</div>`;
}
function earlierMonths(view: StudyAllowanceView) {
  const rows = view.earlier ?? [];
  const older = view.olderOmitted
    ? `<p>This shows the last ${EARLIER_ALLOWANCE_MONTHS} months. Older claims are in your <a href="/member/export">private records download</a>.</p>`
    : "";
  return `<div data-allowance-history><h2>Earlier months</h2>${rows.length ? rows.map(earlierRow).join("") : "<p>No earlier months yet.</p>"}${older}</div>`;
}
export function studyAllowancePage(csrf: string, view: StudyAllowanceView) {
  const action = view.claim
    ? claimFacts(view.claim)
    : !view.policy
      ? `<p role="status">No study allowance is set up at the moment.</p>`
      : view.creationEnabled
        ? claimForm(csrf, view.policy, view.period.start)
        : `<p role="status">New claims are paused. Anything you've already claimed stays available.</p>`;
  const renewal = view.claim
    ? ""
    : `<p>Nothing renews automatically. Any unused units from earlier months ended with their month and weren't carried over.</p>`;
  return page(
    HEADING,
    `<article class="reading"><p class="eyebrow">PRIVATE · TEST ONLY</p><h1>${HEADING}</h1><p>Nothing is added until you claim it. Opening this page or changing your background or goals never adds units.</p><div data-allowance="study_requests"><h2>Study requests</h2>${view.policy ? policyFacts(view.policy) : ""}${renewal}${action}</div>${view.practice ? practiceSection(csrf, view) : ""}${earlierMonths(view)}${links}</article>`,
  );
}
const notices = {
  unavailableRoute: "Study allowances aren't available on this site.",
  denied: "This study allowance isn't available to your current session.",
  invalid: "Tick the confirmation and try again. Nothing was added.",
  conflict:
    "This month's rules or dates have changed since you opened the page. Nothing was added. Check the current rules and try again.",
  unavailable:
    "We couldn't confirm the result. Your claim may already have been saved, so check this page. Trying again never adds a second allowance for the same month.",
};
export function studyAllowanceNotice(kind: keyof typeof notices) {
  return page(
    HEADING,
    `<article class="reading"><h1>${HEADING}</h1><p role="status">${notices[kind]}</p><p><a href="${STUDY_ALLOWANCE_PATH}">Back to your allowance</a> · <a href="/member/test-units">Your test units</a></p></article>`,
  );
}
