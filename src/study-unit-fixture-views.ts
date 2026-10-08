import { escape, hidden, page } from "./views.ts";
import {
  studyFixtureState,
  type StudyFixtureReceipt,
} from "./study-unit-fixture-values.ts";

export const STUDY_MEMBER_PATH = "/member/test-unit-request";
export const STUDY_STAFF_PATH = "/operator/study-test-units";
export interface StudyFixtureAttempt {
  kind: "request" | "issue" | "withdraw";
  key: string;
  checked: unknown;
}
const explanation = `<p class="eyebrow">PRIVATE · LOCAL TEST PREVIEW</p><p>This one-time test fixture contains exactly three study requests. It is not money, a purchased plan, live AI access or a qualified service. There is no automatic allowance or renewal.</p>`;
const back = `<p><a href="${STUDY_MEMBER_PATH}">Your test fixture</a> · <a href="/member/test-units">Current local balances</a> · <a href="/learn">Learning path</a></p>`;
function receiptText(receipt: StudyFixtureReceipt, observed: Date) {
  const state = studyFixtureState(receipt, observed);
  return `<dl><dt>Request reference</dt><dd>${escape(receipt.id)}</dd><dt>Fixed test quantity</dt><dd>3 study requests</dd><dt>State</dt><dd>${escape(state)}</dd><dt>Original request deadline</dt><dd>${escape(receipt.expiresAt.toISOString())}</dd>${receipt.grantExpiresAt ? `<dt>Original unit deadline</dt><dd>${escape(receipt.grantExpiresAt.toISOString())}</dd>` : ""}${receipt.withdrawnAt ? `<dt>Owner withdrawal</dt><dd>${escape(receipt.withdrawnAt.toISOString())}</dd>` : ""}</dl>`;
}
export function studyFixtureMemberPage(
  csrf: string,
  receipt: StudyFixtureReceipt | null,
  creationEnabled: boolean,
  observed: Date,
) {
  return page(
    "Request three local study units",
    `<article class="reading">${explanation}<h1>Request three local study units</h1>${receipt ? `${receiptText(receipt, observed)}<p>This policy slot cannot be reset by another request, expiry, cancellation or withdrawal.</p>${receipt.withdrawnAt ? "" : `<form method="post" action="${STUDY_MEMBER_PATH}/withdraw/check">${hidden(csrf)}<input type="hidden" name="requestId" value="${escape(receipt.id)}"><button class="secondary">Review fixture withdrawal</button></form>`}` : creationEnabled ? `<p>Select one current local platform administrator using the reference they have deliberately given you. This page provides no administrator directory.</p><p>The request lasts at most 30 minutes, bounded by both original access deadlines. Issued units last at most 15 minutes and never beyond the original request deadline.</p><form method="post" action="${STUDY_MEMBER_PATH}/check">${hidden(csrf)}<label>Administrator reference<input name="administratorId" required maxlength="36" autocomplete="off"></label><button>Review request</button></form>` : `<p role="status">New fixture requests and issuance are paused. Your retained receipt, balances, export, withdrawal and account erasure remain available.</p>`}${back}</article>`,
  );
}
export function studyFixtureStaffPage(
  csrf: string,
  reference: string,
  creationEnabled: boolean,
) {
  return page(
    "Local study-unit issuance",
    `<article class="reading">${explanation}<h1>Local study-unit issuance</h1><p>Your noncredential administrator reference: <code>${escape(reference)}</code></p><p>Share this reference deliberately with the invented member. It does not sign anyone in or grant access.</p>${creationEnabled ? "" : '<p role="status">New requests and issuance are paused. Finite original receipt inspection remains available.</p>'}<form method="post" action="${STUDY_STAFF_PATH}/check">${hidden(csrf)}<label>Member-supplied request reference<input name="requestId" required maxlength="36" autocomplete="off"></label><button>Review exact request</button></form><p><a href="/staff">Staff work</a></p></article>`,
  );
}
function confirmationForm(csrf: string, attempt: StudyFixtureAttempt) {
  const base = attempt.kind === "issue" ? STUDY_STAFF_PATH : STUDY_MEMBER_PATH;
  return `<form method="post" action="${base}/${attempt.kind}">${hidden(csrf)}<input type="hidden" name="kind" value="${escape(attempt.kind)}"><input type="hidden" name="key" value="${escape(attempt.key)}"><input type="hidden" name="checked" value="${escape(JSON.stringify(attempt.checked))}"><label class="check"><input type="checkbox" name="confirm" value="yes" required> I explicitly confirm this exact ${escape(attempt.kind)} instruction.</label><button>Confirm ${escape(attempt.kind)}</button></form>`;
}
export function studyFixtureConfirmation(
  csrf: string,
  attempt: StudyFixtureAttempt,
) {
  const staff = attempt.kind === "issue";
  const base = staff ? STUDY_STAFF_PATH : STUDY_MEMBER_PATH;
  const title =
    attempt.kind === "request"
      ? "Confirm your fixed test-unit request"
      : staff
        ? "Confirm three local study units"
        : "Confirm fixture withdrawal";
  const facts = attempt.checked as Record<string, unknown>;
  const labels: Record<string, string> = {
    administratorId: "Selected administrator reference",
    requestId: "Exact request reference",
    memberExpiresAt: "Original member access deadline",
    administratorExpiresAt: "Original administrator access deadline",
    checkedAt: "Scope checked at",
    expiresAt: "Latest permitted deadline",
    requestExpiresAt: "Original request deadline",
  };
  return page(
    title,
    `<article class="reading">${explanation}<h1>${title}</h1><dl>${Object.entries(
      facts,
    )
      .filter(([name]) => name !== "policy")
      .map(
        ([name, value]) =>
          `<dt>${escape(labels[name] ?? "Exact reference")}</dt><dd>${escape(String(value))}</dd>`,
      )
      .join(
        "",
      )}</dl><p>${attempt.kind === "withdraw" ? "This cancels a pending request or makes only remaining usable units unavailable. Held and consumed history stays intact. No job is refunded or retried, and this policy cannot be issued again." : "Exactly three study requests, one lifetime test fixture under this policy. This grants no permission to use private source material; that remains a separate explicit choice."}</p>${confirmationForm(csrf, attempt)}<p><a href="${base}">Cancel this form</a></p></article>`,
  );
}
export function studyFixtureReceiptPage(
  receipt: StudyFixtureReceipt,
  observed: Date,
  staff: boolean,
) {
  return page(
    "Saved local test fixture",
    `<article class="reading">${explanation}<h1>Saved local test fixture</h1>${receiptText(receipt, observed)}<p>Reload before taking another action. Current balances and request-source permission are separate.</p>${staff ? `<p><a href="${STUDY_STAFF_PATH}">Local issuance work</a> · <a href="/staff">Staff work</a></p>` : `${back}<p><a href="/member/export">Export your retained records</a></p>`}</article>`,
  );
}
export function studyFixtureNotice(
  csrf: string,
  message: string,
  attempt?: StudyFixtureAttempt,
) {
  const base = attempt?.kind === "issue" ? STUDY_STAFF_PATH : STUDY_MEMBER_PATH;
  return page(
    "Local test fixture unavailable",
    `<article class="reading"><h1>Local test fixture unavailable</h1><p role="status">${escape(message)}</p>${attempt ? `<p>A write may already have committed. Inspect the original operation before deliberately repeating that same instruction; this form does not dispatch anything.</p><form method="post" action="${base}/inspect">${hidden(csrf)}<input type="hidden" name="kind" value="${escape(attempt.kind)}"><input type="hidden" name="key" value="${escape(attempt.key)}"><input type="hidden" name="checked" value="${escape(JSON.stringify(attempt.checked))}"><button>Inspect original operation</button></form>` : ""}<p><a href="${base}">Read current fixture state</a></p></article>`,
  );
}
export function studyFixtureUncommitted(
  csrf: string,
  attempt: StudyFixtureAttempt,
) {
  return page(
    "Original operation has no saved receipt",
    `<article class="reading"><h1>Original operation has no saved receipt</h1><p>No owned receipt was found for this exact instruction. This does not authorize a new key, renewed window or automatic dispatch. Repeating the original instruction still checks current authority and its original finite deadline.</p>${confirmationForm(csrf, attempt)}</article>`,
  );
}
