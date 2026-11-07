import { hostingText } from "./hosting-presentation.ts";
import { timeTag } from "./display-time.ts";
import { escape, page } from "./views.ts";
import type {
  HoldTestDecision,
  HoldTestOutcome,
  HoldTestReason,
} from "./local-ai-hold-decisions.ts";

const base = "/operator/local-ai-holds";
export const holdDecisionPath = (jobId: string) =>
  `${base}/${encodeURIComponent(jobId)}/test-outcome`;
const title = () =>
  hostingText("Local request test outcome", "Test request outcome");
const outcomes: Record<HoldTestOutcome, string> = {
  "test-executed": "Test outcome: the request ran",
  "test-not-executed": "Test outcome: the request did not run",
};
const reasons: Record<HoldTestReason, string> = {
  "matching-test-record": "An invented test record matches this request",
  "operator-test-exercise": "Recorded as part of an operator test exercise",
};
// HOLDDEC-12: every page says this is a test label, not a provider's answer.
const notice = () =>
  `${hostingText("Invented local test requests", "Invented test requests")} only. A test outcome is a label you record from an invented test record. No AI provider confirmed it. Recording one does not charge, refund, release a unit or retry the request, and it cannot be changed afterwards.`;
function shell(body: string) {
  return page(
    title(),
    `<section class="reading"><nav class="breadcrumb"><a href="${base}">${hostingText("Assigned local request holds", "Assigned test request holds")}</a></nav><p class="eyebrow">TEST OUTCOME · NOT PROVIDER-CONFIRMED</p><h1>${title()}</h1><p>${notice()}</p>${body}</section>`,
  );
}
function recorded(jobId: string, value: HoldTestDecision) {
  return `<article><h2>${escape(outcomes[value.outcome])}</h2><dl><dt>Job reference</dt><dd>${escape(jobId)}</dd><dt>Reason</dt><dd>${escape(reasons[value.reason])}</dd><dt>Source</dt><dd>Invented test record ${escape(value.sourceReference)}</dd><dt>Held because</dt><dd>${value.priorStatus === "expired-claim" ? "Its claim expired without a result" : "Its outcome was unknown"}</dd><dt>Recorded</dt><dd>${timeTag(value.decidedAt)}</dd><dt>Recorded by</dt><dd>${value.decidedByReader ? "You" : "Another assigned operator"}</dd></dl><p>The request stays held. Its test unit, if any, is unchanged.</p></article>`;
}
export function holdDecisionPage(view: {
  jobId: string;
  open: boolean;
  metered: boolean;
  decision: HoldTestDecision | null;
  csrf: string;
  key: string;
}) {
  if (view.decision) return shell(recorded(view.jobId, view.decision));
  if (!view.open)
    return shell(
      `<p role="status">This request is not held, so it cannot take a test outcome now. <a href="${base}/${encodeURIComponent(view.jobId)}">Read its current snapshot</a>.</p>`,
    );
  const radios = <T extends string>(name: string, labels: Record<T, string>) =>
    Object.entries(labels)
      .map(
        ([value, label], i) =>
          `<label><input type="radio" name="${name}" value="${value}" required${i === 0 ? " checked" : ""}> ${escape(label as string)}</label>`,
      )
      .join("");
  return shell(
    `<p>Job reference ${escape(view.jobId)}${view.metered ? ", with a reserved test unit" : ", not metered"}.</p><form method="post" action="${holdDecisionPath(view.jobId)}"><input type="hidden" name="csrf" value="${escape(view.csrf)}"><input type="hidden" name="key" value="${escape(view.key)}"><fieldset><legend>Test outcome</legend>${radios("outcome", outcomes)}</fieldset><fieldset><legend>Reason</legend>${radios("reason", reasons)}</fieldset><label for="hold-source">Invented test record reference</label><p id="hold-source-hint">Starts with test-, then lower-case letters, digits or hyphens. Never paste source text, prompts or provider messages.</p><input id="hold-source" name="sourceReference" required pattern="test-[a-z0-9\\-]{1,60}" maxlength="65" aria-describedby="hold-source-hint" autocomplete="off"><button type="submit">Record test outcome</button></form>`,
  );
}
export function holdDecisionResultPage(
  jobId: string,
  kind: "applied" | "replayed",
  value: HoldTestDecision,
) {
  return shell(
    `<p role="status">${kind === "applied" ? "Test outcome recorded." : "This test outcome was already recorded."}</p>${recorded(jobId, value)}`,
  );
}
export function holdDecisionFailurePage(
  kind: "conflict" | "closed" | "denied" | "invalid" | "unavailable",
  jobId?: string,
) {
  const messages = {
    conflict:
      "A different test outcome is already recorded for this request. It was not changed.",
    closed: "This request is not held, so it cannot take a test outcome now.",
    denied:
      "No current exact assignment permits this. The request reference does not grant access.",
    invalid:
      "That was not accepted. Choose an outcome and reason, and use a reference that starts with test-.",
    unavailable:
      "The test outcome could not be confirmed. Nothing is disclosed. Read it again before trying anything else.",
  };
  const back =
    jobId && kind !== "denied"
      ? `<p><a href="${holdDecisionPath(jobId)}">Read the current test outcome</a></p>`
      : "";
  return shell(`<p role="status">${messages[kind]}</p>${back}`);
}
