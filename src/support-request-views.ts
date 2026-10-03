import { randomUUID } from "node:crypto";
import type { SupportTimeReceipt } from "./support-time.ts";
import { escape, hidden, page } from "./views.ts";
import type {
  SupportRequestSummary,
  SupportMemberDetail,
  SupportOperatorSummary,
  SupportOperatorDetail,
} from "./support-requests.ts";

export interface SupportFormError {
  field: "subject" | "body" | "synthetic" | "support-form";
  message: string;
}
export interface SupportIntakeAttempt {
  subject: string;
  body: string;
  synthetic: boolean;
}
export interface SupportOperatorKeys {
  acknowledge: string;
  reply: string;
  note: string;
  resolve: string;
}
export interface SupportMessageAttempt {
  kind: "reply" | "note";
  body: string;
  message: string;
}
const disclosure =
  "Local sample support · coverage unverified · no response deadline. No staffed support, paid allowance or provider is connected.";
function time(value: Date) {
  return `<time datetime="${escape(value.toISOString())}">${escape(value.toISOString())}</time>`;
}
function lifecycle(value: SupportRequestSummary) {
  return `<dl><dt>Request receipt</dt><dd>${escape(value.requestId)}</dd><dt>Received</dt><dd>${time(value.receivedAt)}</dd><dt>Acknowledgement</dt><dd>${value.acknowledgedAt ? `Acknowledged locally ${time(value.acknowledgedAt)}` : "No separate acknowledgement recorded"}</dd><dt>Resolution</dt><dd>${value.resolvedAt ? `Resolved locally ${time(value.resolvedAt)}; this does not establish member satisfaction or completed paid work` : "Open; no resolution recorded"}</dd>${value.withdrawnAt ? `<dt>Withdrawal</dt><dd>${time(value.withdrawnAt)}</dd>` : ""}</dl>`;
}
function pages(base: string, next: string | null, joined = false) {
  return `<nav aria-label="Support pages"><a href="${escape(base)}">Return to newest</a>${next ? ` · <a href="${escape(base)}${joined ? "&amp;" : "?"}after=${encodeURIComponent(next)}">Next page</a>` : ""}</nav>`;
}
function summary(errors: SupportFormError[]) {
  return errors.length
    ? `<div class="notice" role="alert"><h2>Correct the request before sending</h2><p>No request was saved by this validation response.</p><ul>${errors.map((error) => `<li><a href="#${error.field}">${escape(error.message)}</a></li>`).join("")}</ul></div>`
    : "";
}
function errorField(
  field: SupportFormError["field"],
  errors: SupportFormError[],
) {
  const found = errors.find((error) => error.field === field);
  return {
    attributes: found
      ? ` aria-invalid="true" aria-describedby="${field}-error"`
      : "",
    message: found
      ? `<p id="${field}-error" class="field-error">${escape(found.message)}</p>`
      : "",
  };
}
export function supportIntakePage(
  csrf: string,
  key: string,
  attempted: SupportIntakeAttempt = { subject: "", body: "", synthetic: false },
  errors: SupportFormError[] = [],
) {
  const subject = errorField("subject", errors),
    body = errorField("body", errors),
    synthetic = errorField("synthetic", errors);
  return page(
    "New private sample support request",
    `<section class="reading"><p><a href="/support">Your private support requests</a></p><p class="eyebrow">PRIVATE LOCAL SAMPLE</p><h1>New private sample support request</h1><p>${disclosure}</p>${summary(errors)}<form id="support-form" tabindex="-1" method="post" action="/support">${hidden(csrf)}<input type="hidden" name="idempotencyKey" value="${escape(key)}"><label for="subject">Subject (up to 120 characters)</label><input id="subject" name="subject" maxlength="120" required value="${escape(attempted.subject)}"${subject.attributes}>${subject.message}<label for="body">Your sample request (up to 2,000 characters)</label><textarea id="body" name="body" maxlength="2000" rows="8" required${body.attributes}>${escape(attempted.body)}</textarea>${body.message}<label class="check"><input id="synthetic" type="checkbox" name="synthetic" value="yes" required${attempted.synthetic ? " checked" : ""}${synthetic.attributes}><span>I used only invented or sample information and want to send this private request.</span></label>${synthetic.message}<button type="submit">Send private sample request</button></form><p>Accepted text stays private until withdrawal or account deletion. Sending creates no charge, entitlement or service obligation.</p></section>`,
  );
}
export function supportOwnerHistoryPage(value: {
  items: SupportRequestSummary[];
  nextCursor: string | null;
}) {
  return page(
    "Your private support requests",
    `<section class="reading"><h1>Your private support requests</h1><p>${disclosure}</p><p><a href="/support/new">New private sample request</a> · <a href="/member/export">Download private preview records</a></p><p>Newest receipts first; at most 20 requests per page.</p>${value.items.length ? `<ul aria-label="Private support requests">${value.items.map((item) => `<li><a href="/support/${encodeURIComponent(item.requestId)}">${item.withdrawnAt ? "Withdrawn request" : escape(item.subject!)} · ${escape(item.requestId)}</a>${lifecycle(item)}</li>`).join("")}</ul>` : "<p>No private support requests on this page.</p>"}${pages("/support", value.nextCursor)}<p><a href="/learn">Return to your learning path</a></p></section>`,
  );
}
export function supportMemberDetailPage(
  value: SupportMemberDetail,
  csrf: string,
  timeReceipt?: SupportTimeReceipt | null,
  timeWrites = true,
) {
  const base = `/support/${encodeURIComponent(value.requestId)}`;
  const receipt = timeReceipt
    ? `<section aria-labelledby="support-time-heading"><h2 id="support-time-heading">Private support test minutes</h2><p role="status">${timeReceipt.held} support test minutes held</p><p>Confirmed ceiling: ${timeReceipt.ceiling}. Consumed: ${timeReceipt.consumed}. Released: ${timeReceipt.released}. State: ${escape(timeReceipt.state)}.</p><p>Recorded support: ${timeReceipt.supportMinutes} minutes; preparation: ${timeReceipt.preparationMinutes} minutes. These are private invented test records, not paid staff time or a service promise.</p></section>`
    : "";
  const allocationForm =
    timeWrites &&
    timeReceipt !== undefined &&
    (!timeReceipt ||
      timeReceipt.state === "completed" ||
      timeReceipt.state === "cancelled") &&
    !value.withdrawnAt &&
    !value.resolvedAt
      ? `<section aria-labelledby="support-time-allocation-heading"><h2 id="support-time-allocation-heading">Allocate private support test minutes</h2><p>Use one existing support test allowance. No minutes are purchased or created. Replies and acknowledgements remain unmetered. Withdrawal before work begins releases the hold; after begin, unresolved work stays held for reconciliation.</p><form method="post" action="${base}/time/allocate">${hidden(csrf)}<input type="hidden" name="idempotencyKey" value="${escape(randomUUID())}"><label for="support-time-ceiling">Maximum support and preparation minutes</label><input id="support-time-ceiling" name="ceiling" type="number" min="1" max="120" step="1" required><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Hold this ceiling from my existing private support test minutes for this invented request.</span></label><button type="submit">Hold support test minutes</button></form></section>`
      : "";
  const cancel =
    timeWrites && timeReceipt?.state === "allocated" && !value.withdrawnAt
      ? `<form method="post" action="${base}/time/${encodeURIComponent(timeReceipt.allocationId)}/cancel">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Cancel this unstarted allocation, release its held test minutes and keep the request text and receipt.</span></label><button class="secondary" type="submit">Cancel unstarted support allocation</button></form>`
      : "";
  const minutes =
    receipt +
    cancel +
    allocationForm +
    (timeReceipt !== undefined && !timeWrites
      ? "<p>Support-time writes are paused. Retained receipts remain available; no holds are automatically refunded or retried.</p>"
      : "");

  return page(
    "Private sample support receipt",
    `<section class="reading"><p><a href="/support">Your private support requests</a></p><h1>Private sample support receipt</h1><p>${disclosure}</p>${lifecycle(value)}${minutes}${value.withdrawnAt ? '<p role="status">Request withdrawn. Request text and all associated messages were removed. The content-free receipt remains.</p>' : `<h2>${escape(value.subject!)}</h2><pre class="content-text" data-support-body>${escape(value.body!)}</pre><h2>Replies visible to you</h2><p>Newest replies first; at most 20 replies per page.</p>${value.replies.items.length ? `<ul aria-label="Replies visible to you">${value.replies.items.map((reply) => `<li id="reply-${escape(reply.id)}"><p>${escape(reply.attribution)} · ${time(reply.createdAt)}</p><pre class="content-text" data-support-reply>${escape(reply.body)}</pre></li>`).join("")}</ul>` : "<p>No member-visible reply on this page.</p>"}${pages(base, value.replies.nextCursor)}<form method="post" action="${base}/withdraw">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Withdraw this request and remove its subject, body and all associated messages. Keep a content-free receipt.</span></label><button class="secondary" type="submit">Withdraw request text</button></form>`}<p><a href="/member/export">Download private preview records</a></p><p>Withdrawal cannot recall downloaded copies or establish erasure from hosted backups.</p></section>`,
  );
}
export function supportOperatorWorklistPage(value: {
  items: SupportOperatorSummary[];
  nextCursor: string | null;
}) {
  return page(
    "Granted local support requests",
    `<section class="reading"><p class="eyebrow">EXACT-GRANTED LOCAL OPERATOR</p><h1>Granted local support requests</h1><p>${disclosure}</p><p>Only requests with a current exact grant appear. Newest receipts first; at most 20 per page. Opening a request does not acknowledge it.</p>${value.items.length ? `<ul aria-label="Granted support requests">${value.items.map((item) => `<li><a href="/operator/support/${encodeURIComponent(item.requestId)}?grant=${encodeURIComponent(item.grantId)}">${escape(item.subject!)} · ${escape(item.requestId)}</a>${lifecycle(item)}</li>`).join("")}</ul>` : "<p>No currently granted requests on this page.</p>"}${pages("/operator/support", value.nextCursor)}</section>`,
  );
}
export function supportOperatorDetailPage(
  value: SupportOperatorDetail,
  csrf: string,
  keys: SupportOperatorKeys,
  attempted?: SupportMessageAttempt,
) {
  const base = `/operator/support/${encodeURIComponent(value.requestId)}`;
  const common = (key: string) =>
    `${hidden(csrf)}<input type="hidden" name="grantId" value="${escape(value.grantId)}"><input type="hidden" name="idempotencyKey" value="${escape(key)}">`;
  const transition = (
    action: "acknowledge" | "resolve",
    label: string,
    explanation: string,
  ) =>
    `<form method="post" action="${base}/${action}">${common(keys[action])}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>${explanation}</span></label><button type="submit">${label}</button></form>`;
  const message = (kind: "reply" | "note") => {
    const reply = kind === "reply",
      failed = attempted?.kind === kind;
    return `<section aria-labelledby="${kind}-heading"><h2 id="${kind}-heading">${reply ? "Reply visible to member" : "Internal note—staff only"}</h2><p>${reply ? "This separate action deliberately sends a sample reply to the member." : "This note is internal. It must not appear in member pages or their downloads."}</p>${failed ? `<div class="notice" role="alert"><a href="#${kind}-body">${escape(attempted.message)}</a></div>` : ""}<form method="post" action="${base}/${reply ? "replies" : "notes"}">${common(keys[kind])}<label for="${kind}-body">${reply ? "Member-visible reply" : "Internal note"} (up to 2,000 characters)</label><textarea id="${kind}-body" name="body" maxlength="2000" rows="5" required${failed ? ` aria-invalid="true" aria-describedby="${kind}-error"` : ""}>${failed ? escape(attempted.body) : ""}</textarea>${failed ? `<p id="${kind}-error" class="field-error">${escape(attempted.message)}</p>` : ""}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>${reply ? "Send this invented reply to the member." : "Save this invented information as an internal staff-only note."}</span></label><button type="submit">${reply ? "Send member-visible reply" : "Save internal note"}</button></form></section>`;
  };
  return page(
    "Granted sample support request",
    `<section class="reading"><p><a href="/operator/support">Granted local support requests</a></p><h1>Granted sample support request</h1><p>${disclosure}</p>${lifecycle(value)}<h2>${escape(value.subject!)}</h2><pre class="content-text">${escape(value.body)}</pre><h2>Operator message history</h2><p>Newest entries first; at most 20 notes and replies per page.</p>${value.messages.items.length ? `<ul aria-label="Operator message history">${value.messages.items.map((item) => `<li id="message-${escape(item.id)}"><h3>${item.kind === "reply" ? "Reply visible to member" : "Internal note—staff only"}</h3><p>${escape(item.attribution)} · ${time(item.createdAt)}</p><pre class="content-text" data-support-message="${item.kind}">${escape(item.body)}</pre></li>`).join("")}</ul>` : "<p>No operator messages on this page.</p>"}${pages(`${base}?grant=${encodeURIComponent(value.grantId)}`, value.messages.nextCursor, true)}${value.resolvedAt ? '<p role="status">Resolved locally. No further acknowledgement, note or reply is accepted. This request cannot be reopened.</p>' : `${value.acknowledgedAt ? "" : transition("acknowledge", "Acknowledge request locally", "Record a separate local acknowledgement of this request.")}${message("note")}${message("reply")}${transition("resolve", "Resolve request locally", "Resolve this local request and stop further messages; this does not record member satisfaction or a separate acknowledgement.")}`}</section>`,
  );
}
export function supportNoticePage(
  title: string,
  message: string,
  href: string,
  label: string,
) {
  return page(
    title,
    `<section class="reading"><h1>${escape(title)}</h1><div class="notice" role="alert"><p>${escape(message)}</p></div><p><a href="${escape(href)}">${escape(label)}</a></p></section>`,
  );
}
export function supportIntakeRecoveryPage(
  key: string,
  attempted: SupportIntakeAttempt,
  message: string,
) {
  return page(
    "Support receipt not confirmed",
    `<section class="reading"><h1>Support receipt not confirmed</h1><div class="notice" role="alert"><p>${escape(message)}</p></div><p>Copy your attempted text before leaving. Nothing is submitted automatically.</p><label for="copy-subject">Attempted subject to copy</label><textarea id="copy-subject" readonly>${escape(attempted.subject)}</textarea><label for="copy-body">Attempted request to copy</label><textarea id="copy-body" rows="8" readonly>${escape(attempted.body)}</textarea><p><a href="/support/receipts/${encodeURIComponent(key)}">Inspect the original request receipt</a> · <a href="/support">Inspect private request history</a></p></section>`,
  );
}
