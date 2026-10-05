import { escape, page } from "./views.ts";
import type { LocalAiHoldItem } from "./local-ai-hold-inspection.ts";
const base = "/operator/local-ai-holds";
const warning =
  "Invented local test requests only. This is read-only assigned metadata, not evidence of external provider execution, staffed coverage or an approved resolution. Nothing here charges, refunds, releases a unit or retries a request.";
function row(value: LocalAiHoldItem) {
  const state =
    value.state === "needs-reconciliation"
      ? "Started request: outcome unconfirmed"
      : value.state === "expired-claim"
        ? "Expired claim: outcome unconfirmed"
        : "No longer an unconfirmed started hold";
  return `<article><h2>${escape(state)}</h2><dl><dt>Local job reference</dt><dd>${escape(value.jobId)}</dd><dt>Stored status</dt><dd>${escape(value.status)}</dd><dt>Test request unit</dt><dd>${escape(value.unitState)}</dd><dt>Created</dt><dd>${escape(value.createdAt)}</dd><dt>Last recorded update</dt><dd>${escape(value.updatedAt)}</dd><dt>Recorded claim deadline</dt><dd>${value.leaseUntil === null ? "None retained" : escape(value.leaseUntil)}</dd><dt>Test policy</dt><dd>${escape(value.policy)}</dd><dt>Prompt contract</dt><dd>${escape(value.promptTemplateVersion)}</dd><dt>Model contract</dt><dd>${escape(value.modelContractVersion)}</dd></dl><p>Elapsed time does not establish execution, failure or permission to redispatch. <a href="${base}/${encodeURIComponent(value.jobId)}">Read a fresh assigned snapshot</a>.</p></article>`;
}
export function localAiHoldListPage(
  items: LocalAiHoldItem[],
  next: string | null,
) {
  return page(
    "Assigned local request holds",
    `<section class="reading"><nav class="breadcrumb"><a href="/operator/experts">Local operator registry</a></nav><p class="eyebrow">READ-ONLY · INVENTED LOCAL TESTS</p><h1>Assigned local request holds</h1><p>${warning}</p>${items.length ? items.map(row).join("") : '<p role="status">No currently assigned unconfirmed request is available in this snapshot.</p>'}${next === null ? "" : `<p><a href="${base}?after=${encodeURIComponent(next)}">Next assigned requests</a></p>`}<p><a href="${base}">Read a fresh worklist</a></p></section>`,
  );
}
export function localAiHoldDetailPage(value: LocalAiHoldItem) {
  return page(
    "Assigned local request snapshot",
    `<section class="reading"><nav class="breadcrumb"><a href="${base}">Assigned local request holds</a></nav><h1>Assigned local request snapshot</h1><p>${warning}</p>${row(value)}</section>`,
  );
}
export function localAiHoldUnavailablePage(
  kind: "live" | "denied" | "invalid" | "unavailable",
) {
  const messages = {
    live: "Local request inspection is unavailable in live mode.",
    denied:
      "No current exact assignment permits this read. The request reference does not grant access.",
    invalid:
      "The inspection address or continuation is invalid. Read a fresh worklist without extra parameters.",
    unavailable:
      "The assigned snapshot could not be confirmed. No private source or outcome is disclosed. Read a fresh worklist; do not retry or settle a job based on this response.",
  };
  return page(
    "Local request inspection unavailable",
    `<section class="reading"><h1>Local request inspection unavailable</h1><p role="status">${messages[kind]}</p><p>${warning}</p><p><a href="${base}">Read a fresh worklist</a></p></section>`,
  );
}
