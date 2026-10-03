import { randomUUID } from "node:crypto";
import { escape, hidden, page } from "./views.ts";
import type {
  OperatorSupportTimeReceipt,
  SupportTimeScope,
} from "./support-time.ts";
export function supportTimeLink(value: SupportTimeScope): string {
  return `/operator/support-time/${encodeURIComponent(value.requestId)}?allocation=${encodeURIComponent(value.allocationId)}&grant=${encodeURIComponent(value.grantId)}`;
}
export function supportTimeWorklistPage(value: {
  items: OperatorSupportTimeReceipt[];
  nextCursor: string | null;
}) {
  return page(
    "Private support test effort",
    `<section class="reading"><h1>Private support test effort</h1><p>Only your current exact-purpose grants appear. These invented records promise no staff coverage, paid service or real-world hours. At most 20 grants per page. Opening a receipt does not begin work or consume minutes.</p>${value.items.length ? `<ul>${value.items.map((item) => `<li><a href="${escape(supportTimeLink(item))}">Support test allocation · ${escape(item.requestId)}</a> · ${item.held} held, ${item.consumed} consumed, ${item.released} released · ${escape(item.state)}</li>`).join("")}</ul>` : "<p>No current support-time grants on this page.</p>"}${value.nextCursor ? `<p><a href="/operator/support-time?after=${encodeURIComponent(value.nextCursor)}">Older support-time grants</a></p>` : ""}</section>`,
  );
}
export function supportTimeOperatorPage(
  value: OperatorSupportTimeReceipt,
  csrf: string,
) {
  const base = `/operator/support-time/${encodeURIComponent(value.requestId)}`;
  const common = () =>
    `${hidden(escape(csrf))}<input type="hidden" name="allocationId" value="${escape(value.allocationId)}"><input type="hidden" name="grantId" value="${escape(value.grantId)}"><input type="hidden" name="idempotencyKey" value="${escape(randomUUID())}">`;
  const begin = value.canBegin
    ? `<form method="post" action="${base}/begin">${common()}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Begin this private invented support effort under my separate exact time grant. Unresolved begun work remains held; it is not automatically refunded.</span></label><button type="submit">Begin support test effort</button></form>`
    : "";
  const field = (name: string, label: string, required: boolean) =>
    `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="text" placeholder="2026-10-03T01:00:00.000Z" ${required ? "required" : ""}>`;
  const record = value.canRecord
    ? `<form method="post" action="${base}/record">${common()}<p>Enter actual invented UTC intervals from the previous 24 hours, ending in Z. Each duration must be a positive whole number of minutes. Support is mandatory; preparation is optional. Use both preparation fields or leave both blank. Segments cannot overlap each other or your other recorded support work; adjacent intervals are allowed. Total effort cannot exceed the confirmed ${value.ceiling}-minute ceiling.</p>${field("supportStart", "Support start (UTC)", true)}${field("supportEnd", "Support end (UTC)", true)}${field("preparationStart", "Preparation start (UTC, optional)", false)}${field("preparationEnd", "Preparation end (UTC, optional)", false)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Record these invented intervals once, consume their total minutes and release the unused hold. This does not resolve or acknowledge the support request.</span></label><button type="submit">Record and settle test effort</button></form>`
    : "";
  return page(
    "Support test effort receipt",
    `<section class="reading"><p><a href="/operator/support-time">Granted support test effort</a></p><h1>Support test effort receipt</h1><p>Private invented test records. No paid staffing, live service, real costs or qualified approval.</p><p role="status">State: ${escape(value.state)}. ${value.held} support test minutes held.</p><p>Confirmed ceiling: ${value.ceiling}. Consumed: ${value.consumed}. Released: ${value.released}.</p><p>Support recorded: ${value.supportMinutes} minutes; preparation: ${value.preparationMinutes} minutes. Attribution: Synthetic operator.</p>${value.state === "needs_reconciliation" ? "<p>Work was begun but is unresolved. Keep the hold for reconciliation. Do not invent a completion or automatically retry/refund.</p>" : ""}${begin}${record}<p>This exact time grant does not expose private request text or grant permission to reply or write internal notes.</p></section>`,
  );
}
