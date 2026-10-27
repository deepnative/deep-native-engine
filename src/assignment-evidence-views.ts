import { randomUUID } from "node:crypto";
import { page, escape, hidden } from "./views.ts";
import type { AssignmentEvidenceReceipt } from "./assignment-evidence.ts";
import type {
  AssignmentEvidenceInstruction,
  AssignmentEvidenceSource,
} from "./assignment-evidence-values.ts";

export const ASSIGNMENT_INSPECT_PATH = "/assignment-feedback/inspect";
export const assignmentHandoffPath = (id: string) =>
  `/assignments/attempts/${encodeURIComponent(id)}/handoff`;
const input = (name: string, value: string | number) =>
  `<input type="hidden" name="${name}" value="${escape(String(value))}">`;

export function assignmentInspectionPage(csrf: string) {
  return page(
    "Inspect an earlier copy request",
    `<section class="reading"><h1>Inspect an earlier copy request</h1><p>Enter the original request reference shown when saving could not be confirmed. Inspection only reads a result belonging to your current learning account; it never creates a copy or grants review access.</p><form method="post" action="${ASSIGNMENT_INSPECT_PATH}">${hidden(csrf)}<label for="assignment-request-reference">Original copy request reference</label><input id="assignment-request-reference" name="operationId" maxlength="36" required autocomplete="off"><button>Inspect copy request</button></form><p>If the service restarted, reopen this page to use a fresh form.</p><p><a href="/evidence">Your private copies</a> · <a href="/assignments/attempts">Your assignments</a></p></section>`,
  );
}

function copyForm(
  csrf: string,
  instruction: Omit<AssignmentEvidenceInstruction, "privateReview">,
  repeat = false,
) {
  return `<form method="post" action="${assignmentHandoffPath(instruction.attemptId)}">${hidden(csrf)}${input("operationId", instruction.operationId)}${input("sequence", instruction.sequence)}${input("contentId", instruction.contentId)}${input("contentVersion", instruction.contentVersion)}${input("rubricVersion", instruction.rubricVersion)}${input("sourceSha256", instruction.sourceSha256)}<label class="check"><input type="checkbox" name="privateReview" value="yes" required><span>Create a private feedback copy of this submitted version. I will request review separately. Deleting the original attempt also deletes its copies and feedback.</span></label><button>${repeat ? "Repeat this original copy request" : "Create private feedback copy"}</button></form>`;
}

export function assignmentHandoffPage(
  csrf: string,
  source: AssignmentEvidenceSource,
) {
  return page(
    "Prepare assignment feedback",
    `<section class="reading"><p><a href="/assignments/attempts/${encodeURIComponent(source.attemptId)}#submission-${source.sequence}">Return to this submission</a></p><h1>Prepare assignment feedback</h1><h2>${escape(source.title)}</h2><p>Assignment version ${source.contentVersion} · submission ${source.sequence} · ${source.submittedAt.toISOString()}</p><p>This exact submitted version becomes your private copy. Your current draft stays separate. Creating a copy does not give anyone access; requesting review and assigning a reviewer are separate steps.</p><h2>Your submitted response</h2><pre class="content-text">${escape(source.response).replace(/\r/g, "&#13;")}</pre><h2>Original rubric · version ${source.rubricVersion}</h2><pre class="content-text">${escape(source.rubric)}</pre>${copyForm(csrf, { operationId: randomUUID(), attemptId: source.attemptId, sequence: source.sequence, contentId: source.contentId, contentVersion: source.contentVersion, rubricVersion: source.rubricVersion, sourceSha256: source.sourceSha256 })}<p>Later assignment revisions are never shared automatically. You can delete only the copy while keeping the original attempt.</p></section>`,
  );
}

export function assignmentReceiptPage(
  receipt: AssignmentEvidenceReceipt,
  message = "Your original feedback-copy result is retained.",
) {
  const origin = receipt.assignmentOrigin;
  return page(
    "Your assignment feedback copy",
    `<section class="reading"><h1>Your assignment feedback copy</h1><p role="status">${escape(message)}</p><p>Receipt ${escape(receipt.receiptId)} · ${receipt.createdAt.toISOString()} · ${receipt.state}</p>${origin ? `<p>Assignment ${escape(origin.contentId)} · version ${origin.contentVersion} · submission ${origin.sequence} · rubric ${origin.rubricVersion}</p>` : "<p>The copy or its original source has been removed. Repeating the original request cannot recreate it.</p>"}${receipt.evidenceId ? `<p data-assignment-evidence="${escape(receipt.evidenceId)}">Private copy ${escape(receipt.evidenceId)}</p>` : ""}<p>No reviewer was assigned and no feedback was requested automatically. Withdrawing review does not remove feedback you already received; deleting its source does.</p><p><a href="/evidence">Manage private copies and request feedback</a></p><p><a href="/assignments/attempts">Your assignments</a></p></section>`,
  );
}

export function assignmentRecoveryPage(
  csrf: string,
  message: string,
  instruction?: AssignmentEvidenceInstruction,
) {
  return page(
    "Assignment copy needs attention",
    `<section class="reading"><h1>Assignment copy needs attention</h1><p role="alert">${escape(message)}</p>${instruction ? `<p>The copy may already have been saved. Inspect this request before deliberately repeating it. Inspection opens another tab so this original request stays available.</p><p>Original copy request reference: <code data-assignment-request-reference>${escape(instruction.operationId)}</code>. Keep this reference if the service restarts.</p><form method="post" action="${ASSIGNMENT_INSPECT_PATH}" target="_blank" rel="noopener">${hidden(csrf)}${input("operationId", instruction.operationId)}<button>Inspect this copy request</button></form>${copyForm(csrf, instruction, true)}` : ""}<p><a href="${ASSIGNMENT_INSPECT_PATH}">Inspect an earlier copy request</a></p><p><a href="/assignments/attempts">Your assignments</a> · <a href="/evidence">Your private copies</a></p></section>`,
  );
}
