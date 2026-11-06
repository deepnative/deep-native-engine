import { hostingText } from "./hosting-presentation.ts";
import { timeTag } from "./display-time.ts";
import { escape, page } from "./views.ts";
import type { LocalAiHoldItem } from "./local-ai-hold-inspection.ts";
const base = "/operator/local-ai-holds";
const warning = () =>
  `${hostingText("Invented local test requests", "Invented test requests")} only. This is read-only assigned metadata, not evidence of external provider execution, staffed coverage or an approved resolution. Nothing here charges, refunds, releases a unit or retries a request.`;
const holdsTitle = () =>
  hostingText("Assigned local request holds", "Assigned test request holds");
const snapshotTitle = () =>
  hostingText(
    "Assigned local request snapshot",
    "Assigned test request snapshot",
  );
function row(value: LocalAiHoldItem) {
  const state =
    value.state === "needs-reconciliation"
      ? "Started request: outcome unconfirmed"
      : value.state === "expired-claim"
        ? "Expired claim: outcome unconfirmed"
        : "No longer an unconfirmed started hold";
  return `<article><h2>${escape(state)}</h2><dl><dt>${hostingText("Local job reference", "Job reference")}</dt><dd>${escape(value.jobId)}</dd><dt>Stored status</dt><dd>${escape(value.status)}</dd><dt>Test request unit</dt><dd>${escape(value.unitState)}</dd><dt>Created</dt><dd>${timeTag(value.createdAt)}</dd><dt>Last recorded update</dt><dd>${timeTag(value.updatedAt)}</dd><dt>Recorded claim deadline</dt><dd>${value.leaseUntil === null ? "None retained" : escape(value.leaseUntil)}</dd><dt>Test policy</dt><dd>${escape(value.policy)}</dd><dt>Prompt contract</dt><dd>${escape(value.promptTemplateVersion)}</dd><dt>Model contract</dt><dd>${escape(value.modelContractVersion)}</dd></dl><p>Elapsed time does not establish execution, failure or permission to redispatch. <a href="${base}/${encodeURIComponent(value.jobId)}">Read a fresh assigned snapshot</a>.</p></article>`;
}
export function localAiHoldListPage(
  items: LocalAiHoldItem[],
  next: string | null,
) {
  return page(
    holdsTitle(),
    `<section class="reading"><nav class="breadcrumb"><a href="/operator/experts">${hostingText("Local operator registry", "Expert coverage registry")}</a></nav><p class="eyebrow">READ-ONLY · ${hostingText("INVENTED LOCAL TESTS", "INVENTED TESTS")}</p><h1>${holdsTitle()}</h1><p>${warning()}</p>${items.length ? items.map(row).join("") : '<p role="status">No currently assigned unconfirmed request is available in this snapshot.</p>'}${next === null ? "" : `<p><a href="${base}?after=${encodeURIComponent(next)}">Next assigned requests</a></p>`}<p><a href="${base}">Read a fresh worklist</a></p></section>`,
  );
}
export function localAiHoldDetailPage(value: LocalAiHoldItem) {
  return page(
    snapshotTitle(),
    `<section class="reading"><nav class="breadcrumb"><a href="${base}">${holdsTitle()}</a></nav><h1>${snapshotTitle()}</h1><p>${warning()}</p>${row(value)}</section>`,
  );
}
export function localAiHoldUnavailablePage(
  kind: "live" | "denied" | "invalid" | "unavailable",
) {
  const messages = {
    live: hostingText(
      "Local request inspection is unavailable in live mode.",
      "Test request inspection is unavailable in live mode.",
    ),
    denied:
      "No current exact assignment permits this read. The request reference does not grant access.",
    invalid:
      "The inspection address or continuation is invalid. Read a fresh worklist without extra parameters.",
    unavailable:
      "The assigned snapshot could not be confirmed. No private source or outcome is disclosed. Read a fresh worklist; do not retry or settle a job based on this response.",
  };
  const heading = hostingText(
    "Local request inspection unavailable",
    "Test request inspection unavailable",
  );
  return page(
    heading,
    `<section class="reading"><h1>${heading}</h1><p role="status">${messages[kind]}</p><p>${warning()}</p><p><a href="${base}">Read a fresh worklist</a></p></section>`,
  );
}
