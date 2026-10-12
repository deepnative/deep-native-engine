import { randomUUID } from "node:crypto";
import { page, escape, hidden } from "./views.ts";
import {
  PREPARED_SAMPLES,
  PROVIDED_SAMPLE_LABEL,
  type PreparedInstruction,
} from "./prepared-sample-values.ts";
import type { PreparedReceipt } from "./prepared-samples.ts";
export const PREPARED_PATH = "/evidence/prepared";
function input(name: string, value: string) {
  return `<input type="hidden" name="${name}" value="${escape(value)}">`;
}
export function preparedCopyForm(
  csrf: string,
  instruction: Pick<
    PreparedInstruction,
    "operationId" | "templateId" | "templateVersion" | "templateDigest"
  >,
  retry = false,
) {
  return `<form method="post" action="${PREPARED_PATH}">${hidden(csrf)}${input("operationId", instruction.operationId)}${input("templateId", instruction.templateId)}${input("templateVersion", String(instruction.templateVersion))}${input("templateDigest", instruction.templateDigest)}<label class="check"><input type="checkbox" name="providedExample" value="yes" required><span>I understand this is a provided invented example, not my authored work.</span></label><label class="check"><input type="checkbox" name="privateReview" value="yes" required><span>I separately permit private review of my copy. I can withdraw this permission.</span></label><button>${retry ? "Repeat this original copy instruction" : "Create my private provided copy"}</button></form>`;
}
export function preparedSamplesPage(csrf: string, goal: string) {
  return page(
    "Choose a prepared invented sample",
    `<nav class="breadcrumb"><a href="/evidence">Your private evidence</a></nav><section class="reading"><p class="eyebrow">${PROVIDED_SAMPLE_LABEL}</p><h1>Choose a prepared invented sample</h1><p>Choose one exact provided example to practise the private feedback journey. These fixed examples are unreviewed. Copying does not submit it, assign staff, complete learning or create test units. Your arbitrary uploads and edits still need their own safety check.</p>${PREPARED_SAMPLES.map((sample) => `<article data-prepared-template="${sample.id}"><h2>${escape(sample.name)}</h2>${goal === sample.goal ? "<p>Suggested for your current direction; choose any example.</p>" : ""}<p>Template ${sample.id} · version ${sample.version} · ${PROVIDED_SAMPLE_LABEL}</p><details open><summary>Exact provided text</summary><pre class="content-text">${escape(sample.text)}</pre></details><details><summary>Exact source digest</summary><code>${sample.digest}</code></details>${preparedCopyForm(csrf, { operationId: randomUUID(), templateId: sample.id, templateVersion: sample.version, templateDigest: sample.digest })}</article>`).join("")}</section>`,
  );
}
export function preparedReceiptPage(
  receipt: PreparedReceipt,
  message = "The original provided-copy outcome is retained.",
) {
  return page(
    "Your provided-copy receipt",
    `<section class="reading"><h1>Your provided-copy receipt</h1><p role="status">${escape(message)}</p><p>Receipt ${escape(receipt.receiptId)} · ${receipt.createdAt.toISOString()} · ${receipt.state}</p>${receipt.origin ? `<p>${PROVIDED_SAMPLE_LABEL}. Template ${escape(receipt.origin.templateId)} · version ${receipt.origin.templateVersion} · digest <code>${receipt.origin.templateDigest}</code></p>` : "<p>The private source has been removed. Repeating the original instruction cannot recreate it.</p>"}${receipt.evidenceId ? `<p data-prepared-evidence="${escape(receipt.evidenceId)}">Private source ${escape(receipt.evidenceId)} · version 1</p>` : ""}<p>Nothing was automatically queued, assigned, assessed or allocated. Withdrawal does not recreate permission.</p><p><a href="/evidence">Manage my private samples and separately queue for review</a></p></section>`,
  );
}
export function preparedRecoveryPage(
  csrf: string,
  message: string,
  attempt?: PreparedInstruction,
) {
  return page(
    "Provided copy needs attention",
    `<section class="reading"><h1>Provided copy needs attention</h1><p role="alert">${escape(message)}</p><p>A missing receipt does not prove that no write committed. Nothing is automatically retried. Inspect your original instruction before any deliberate repetition.</p>${attempt ? `<p>Inspection opens a separate tab so this original instruction stays available. Return here only if you deliberately choose to repeat it.</p><form method="post" action="${PREPARED_PATH}/inspect" target="_blank" rel="noopener">${hidden(csrf)}${input("operationId", attempt.operationId)}<button>Inspect my original copy instruction</button></form>${preparedCopyForm(csrf, attempt, true)}` : ""}<p><a href="/evidence">Inspect my private samples</a></p></section>`,
  );
}
