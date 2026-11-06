import { randomUUID } from "node:crypto";
import { timeTag } from "./display-time.ts";
import { escape, hidden, page } from "./views.ts";
import {
  STUDY_ALLOWANCE_PATH,
  type StudyAllowanceClaim,
  type StudyAllowancePolicy,
  type StudyAllowanceView,
} from "./study-allowance-values.ts";

const HEADING = "Your monthly study allowance";
const links = `<p><a href="/member/test-units">Your test units</a> · <a href="/learn">Learning path</a></p>`;
function policyFacts(policy: StudyAllowancePolicy) {
  return `<h2>This month's rules</h2><dl><dt>Rules version</dt><dd>${escape(policy.version)}</dd><dt>How much</dt><dd>${policy.periodLimit} study requests, each calendar month (UTC)</dd><dt>Who can claim</dt><dd>Any current member who chooses to claim it</dd><dt>Where it comes from</dt><dd>Test setting on this site. It isn't bought, and it isn't a paid plan.</dd><dt>Cost estimate</dt><dd>None. These units never call a paid AI service.</dd></dl>`;
}
function claimFacts(claim: StudyAllowanceClaim) {
  return `<h2>This month's claim</h2><p role="status">Claimed under ${escape(claim.policyVersion)}.</p><dl><dt>Claimed</dt><dd>${claim.quantity} study requests on ${timeTag(claim.createdAt)}</dd><dt>Left to use</dt><dd><span data-field="available">${claim.available}</span> study requests</dd><dt>Held for a request in progress</dt><dd><span data-field="reserved">${claim.reserved}</span></dd><dt>Used</dt><dd><span data-field="consumed">${claim.consumed}</span></dd><dt>Ends</dt><dd>${timeTag(claim.periodEnd)}</dd></dl><p>Unused units end with the month and don't carry over. You can claim again when the next month starts.</p>`;
}
function claimForm(csrf: string, policy: StudyAllowancePolicy, start: Date) {
  return `<form method="post" action="${STUDY_ALLOWANCE_PATH}/claim">${hidden(csrf)}<input type="hidden" name="key" value="${randomUUID()}"><input type="hidden" name="policyVersion" value="${escape(policy.version)}"><input type="hidden" name="periodStart" value="${start.toISOString()}"><label class="check"><input type="checkbox" name="confirm" value="yes" required> I want this month's ${policy.periodLimit} study requests.</label><button>Claim this month's allowance</button></form>`;
}
export function studyAllowancePage(csrf: string, view: StudyAllowanceView) {
  const action = view.claim
    ? claimFacts(view.claim)
    : !view.policy
      ? `<p role="status">No study allowance is set up at the moment.</p>`
      : view.creationEnabled
        ? claimForm(csrf, view.policy, view.period.start)
        : `<p role="status">New claims are paused. Anything you've already claimed stays available.</p>`;
  return page(
    HEADING,
    `<article class="reading"><p class="eyebrow">PRIVATE · TEST ONLY</p><h1>${HEADING}</h1><p>Nothing is added until you claim it. Opening this page or changing your background or goals never adds units.</p>${view.policy ? policyFacts(view.policy) : ""}${action}${links}</article>`,
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
