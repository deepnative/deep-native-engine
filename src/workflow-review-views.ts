import { escape, hidden, page } from "./views.ts";
import type {
  WorkflowReviewPreview,
  WorkflowReviewReceipt,
} from "./workflow-review.ts";

export const reviewMemberBase = "/workflow-feedback/review";
const field = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${escape(value)}">`;
const notice = `<p class="eyebrow">PRIVATE LOCAL REVIEW REQUEST</p><p>This offers one invented-text note to an individually assigned moderator. It is not qualified assessment or public publication. No moderator availability or response time is promised.</p>`;
export function workflowReviewPreviewPage(
  value: WorkflowReviewPreview,
  csrf: string,
  operationId: string,
) {
  return page(
    "Request private review",
    `${notice}<section class="reading"><h1>Request private review</h1><h2>${escape(value.title)}</h2><p>Workflow ${escape(value.workflowId)} · version ${value.workflowVersion} · exact note revision ${value.revision}</p><pre class="content-text">${escape(value.note)}</pre><p>Permission ends <time datetime="${escape(value.expiresAt)}">${escape(value.expiresAt)}</time>. Checking or submitting again does not extend this deadline.</p><form method="post" action="${reviewMemberBase}/request">${hidden(csrf)}${field("checked", value.checked)}${field("operationId", operationId)}<label><input type="checkbox" name="confirm" value="yes" required> Allow an individually assigned local moderator to read only this exact note until the shown deadline</label><button type="submit">Request private review</button></form><p><a href="/workflow-feedback/${escape(value.workflowId)}">Back to my private note</a></p></section>`,
  );
}
export function workflowReviewReceiptPage(
  value: WorkflowReviewReceipt,
  csrf: string,
  operationId: string,
) {
  return page(
    "Private review request receipt",
    `${notice}<section class="reading"><h1>Private review request receipt</h1><p data-request-id="${escape(value.requestId)}">Request ${escape(value.requestId)}</p><dl><dt>Workflow</dt><dd>${escape(value.workflowId)} · version ${value.workflowVersion} · note revision ${value.revision}</dd><dt>Permission status</dt><dd>${escape(value.state)}</dd><dt>Permission ends</dt><dd>${escape(value.expiresAt)}</dd></dl><p>Pending means permission is waiting for an exact assignment. Assigned means an unrevoked finite assignment is recorded; current staff authority is checked separately before every read. Neither state means the note has been read.</p>${value.withdrawnAt ? "<p>Your permission is withdrawn; your own original note remains available.</p>" : `<form method="post" action="${reviewMemberBase}/withdraw">${hidden(csrf)}${field("requestId", value.requestId)}${field("operationId", operationId)}<label><input type="checkbox" name="confirm" value="yes" required> Withdraw this review permission while keeping my own note</label><button class="secondary" type="submit">Withdraw review permission</button></form>`}<p><a href="${reviewMemberBase}/receipts/${escape(value.requestId)}">Reload this request receipt</a> · <a href="${reviewMemberBase}/history">My private review history</a> · <a href="/workflow-feedback/${escape(value.workflowId)}">My private note</a> · <a href="/member/export">Export my private records</a></p></section>`,
  );
}
export function workflowReviewRecoveryPage(
  message: string,
  csrf: string,
  original?: { checked?: string; operationId: string; requestId?: string },
) {
  const inspect = original
    ? `<form method="post" action="${reviewMemberBase}/inspect" target="_blank" rel="noopener">${hidden(csrf)}${field("operationId", original.operationId)}<button type="submit">Inspect the original operation</button></form><p>Inspection opens a separate tab so this original recovery form stays available.</p>`
    : "";
  const repeat = original?.checked
    ? `<form method="post" action="${reviewMemberBase}/request">${hidden(csrf)}${field("checked", original.checked)}${field("operationId", original.operationId)}<label><input type="checkbox" name="confirm" value="yes" required> Deliberately repeat the exact original request without extending its deadline</label><button type="submit">Repeat exact request</button></form>`
    : original?.requestId
      ? `<form method="post" action="${reviewMemberBase}/withdraw">${hidden(csrf)}${field("requestId", original.requestId)}${field("operationId", original.operationId)}<label><input type="checkbox" name="confirm" value="yes" required> Deliberately repeat the exact permission withdrawal</label><button type="submit">Repeat exact withdrawal</button></form>`
      : "";
  return page(
    "Private review request unavailable",
    `${notice}<section class="reading"><h1>Private review request unavailable</h1><p role="alert">${escape(message)}</p><p>A failed write response may follow a committed change. Inspect the original operation before deciding on any manual repeat. Inspection does not create permission; no automatic retry or replacement key is used.</p>${inspect}${repeat}<p><a href="/workflows">Workflow demonstrations</a></p></section>`,
  );
}

export function workflowReviewHistoryPage(
  receipts: WorkflowReviewReceipt[],
  next: string | null,
) {
  return page(
    "My private workflow review history",
    `${notice}<section class="reading"><h1>My private workflow review history</h1><p>Request and permission metadata only. Your notes stay in their original private records.</p>${receipts.length ? `<ul>${receipts.map((r) => `<li><a href="${reviewMemberBase}/receipts/${escape(r.requestId)}">${escape(r.workflowId)} · version ${r.workflowVersion} · note revision ${r.revision}</a> · ${escape(r.state)} · permission ends ${escape(r.expiresAt)}</li>`).join("")}</ul>` : "<p>No private review requests on this page.</p>"}${next ? `<a href="${reviewMemberBase}/history?cursor=${encodeURIComponent(next)}">Next private review requests</a>` : ""}<p><a href="/workflows">Workflow demonstrations</a> · <a href="/member/export">Export my private records</a></p></section>`,
  );
}
