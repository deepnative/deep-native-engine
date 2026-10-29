import { randomUUID } from "node:crypto";
import { page, escape, hidden } from "./views.ts";
import {
  DISPLAY_PERMISSION,
  type PublicationInstruction,
  type PublicationReceipt,
  type PublicationSource,
} from "./proposal-publication.ts";
const input = (name: string, value: string | number) =>
  `<input type="hidden" name="${name}" value="${escape(String(value))}">`;
const ownerPath = (id: string) =>
  `/contribute/${encodeURIComponent(id)}/publication`;
function publishForm(
  csrf: string,
  instruction: Omit<PublicationInstruction, "confirmed">,
  repeat = false,
) {
  return `<form method="post" action="/contribute/${encodeURIComponent(instruction.proposalId)}/publish">${hidden(escape(csrf))}${input("operationId", instruction.operationId)}${input("revision", instruction.revision)}${input("permissionVersion", instruction.permissionVersion)}<label for="contribution-attribution">Display attribution</label><input id="contribution-attribution" name="attribution" maxlength="80" required value="${escape(instruction.attribution)}"><label for="contribution-audience">Sharing audience</label><select id="contribution-audience" name="audience" required><option value="">Choose an audience</option><option value="members"${repeat ? " selected" : ""}>Signed-in members only</option></select><label class="check"><input type="checkbox" name="confirmed" value="yes" required><span>I permit this platform to display this exact accepted revision and chosen attribution to signed-in members until I withdraw it. This does not grant external reuse rights.</span></label><p>Permission ${DISPLAY_PERMISSION}. Withdrawal stops future platform reads; it cannot recall copies already obtained. Sharing is optional and is not a qualification or response-time promise.</p><button>${repeat ? "Repeat this original publication request" : "Share this accepted revision"}</button></form>`;
}
export function publicationOwnerPage(
  csrf: string,
  source: PublicationSource,
  receipt: PublicationReceipt | null,
  enabled: boolean,
) {
  return page(
    "Your contribution sharing",
    `<section class="reading"><h1>Your contribution sharing</h1><h2>${escape(source.title ?? "Removed proposal")}</h2><p>Revision ${source.revision} · ${source.origin === "sample" ? "Originally submitted as a sample" : "Original member contribution"}. Saving, submitting and editorial acceptance remain private.</p>${source.body === null ? "<p>The source text has been removed.</p>" : `<pre class="content-text" data-publication-source>${escape(source.body).replace(/\r/g, "&#13;")}</pre><h3>Sources and rights notes</h3><p>${escape(source.sources!)}</p>`}${receipt ? `<p>Editorial acceptance for revision ${receipt.revision} recorded ${receipt.acceptedAt.toISOString()}. This is ordinary editorial review, not formal assessment.</p>${publicationReceiptContent(receipt)}` : "<p>Editorial acceptance is needed before sharing.</p>"}${receipt?.state === "accepted" && enabled && source.state === "submitted" ? publishForm(csrf, { operationId: randomUUID(), proposalId: source.id, revision: source.revision, attribution: "", audience: "members", permissionVersion: DISPLAY_PERMISSION }) : ""}${!enabled ? "<p>New contribution intake, acceptance and sharing are paused. Inspection and withdrawal remain available.</p>" : ""}${receipt && receipt.state !== "withdrawn" ? `<form method="post" action="/contribute/${encodeURIComponent(source.id)}/unshare">${hidden(escape(csrf))}${input("revision", receipt.revision)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Withdraw display permission for this revision. Keep my private proposal.</span></label><button>Withdraw sharing</button></form>` : ""}<p><a href="/contribute/${encodeURIComponent(source.id)}">Return to my private proposal</a> · <a href="/contributions">Read member contributions</a> · <a href="/contribution-requests/inspect">Inspect an earlier publication request</a></p></section>`,
  );
}
function publicationReceiptContent(r: PublicationReceipt) {
  return `<p data-publication-state="${r.state}">Status: ${r.state} · revision ${r.revision}</p>${r.operationId ? `<p>Original publication request reference: <code data-publication-request-reference>${escape(r.operationId)}</code></p>` : ""}${r.state === "published" ? `<p>Attribution: ${escape(r.attribution!)} · signed-in members only.</p><p><a href="/contributions/${encodeURIComponent(r.id)}">Open the shared contribution</a></p>` : r.state === "withdrawn" ? "<p>This acceptance or sharing permission was withdrawn. Its attribution is removed. Repeating an earlier request cannot publish it again; use a new proposal for a new contribution.</p>" : "<p>Accepted privately. Nothing is shared with other members.</p>"}`;
}
export function publicationReceiptPage(receipt: PublicationReceipt) {
  return page(
    "Contribution request result",
    `<section class="reading"><h1>Contribution request result</h1>${publicationReceiptContent(receipt)}<p><a href="${ownerPath(receipt.proposalId)}">Inspect my current contribution</a> · <a href="/moderate/proposals">Private moderation queue</a></p></section>`,
  );
}
export function publicationInspectionPage(csrf: string) {
  return page(
    "Inspect a publication request",
    `<section class="reading"><h1>Inspect a publication request</h1><p>Inspection reads only your own retained result. It does not share anything. Reopen this page after a restart for a fresh form.</p><form method="post" action="/contribution-requests/inspect">${hidden(escape(csrf))}<label for="publication-reference">Original publication request reference</label><input id="publication-reference" name="operationId" maxlength="36" required><button>Inspect publication request</button></form></section>`,
  );
}
export function publicationRecoveryPage(
  csrf: string,
  message: string,
  instruction?: PublicationInstruction,
) {
  return page(
    "Contribution needs attention",
    `<section class="reading"><h1>Contribution needs attention</h1><p role="alert">${escape(message)}</p>${instruction ? `<p>The write may have completed. Nothing is retried automatically. Inspect before deliberately repeating.</p><p>Original publication request reference: <code data-publication-request-reference>${escape(instruction.operationId)}</code></p><form method="post" action="/contribution-requests/inspect" target="_blank" rel="noopener">${hidden(escape(csrf))}${input("operationId", instruction.operationId)}<button>Inspect this publication request</button></form>${publishForm(csrf, instruction, true)}` : ""}<p><a href="/contribution-requests/inspect">Inspect an earlier publication request</a> · <a href="/contribute">My private proposals</a> · <a href="/moderate/proposals">Inspect current moderation state</a></p></section>`,
  );
}
export function contributionsPage(
  items: Array<{ source: PublicationSource; receipt: PublicationReceipt }>,
) {
  return page(
    "Member contributions",
    `<section class="reading"><h1>Member contributions</h1><p>Original contributions shared deliberately with signed-in members after ordinary editorial review. These are not formal instruction, credentials or an external reuse licence. Showing up to 50 currently shared contributions.</p><ul>${items.map(({ source, receipt }) => `<li><a href="/contributions/${encodeURIComponent(receipt.id)}">${escape(source.title!)}</a> · ${escape(receipt.attribution!)} · revision ${receipt.revision}${source.origin === "sample" ? " · originally submitted as a sample" : ""}</li>`).join("")}</ul>${items.length ? "" : "<p>No contributions are currently shared.</p>"}<p><a href="/contribute">Create or manage my private proposal</a> · <a href="/learn">My learning</a></p></section>`,
  );
}
export function contributionPage(
  source: PublicationSource,
  r: PublicationReceipt,
) {
  return page(
    source.title!,
    `<article class="reading"><h1>${escape(source.title!)}</h1><p>Member contribution · editorially reviewed · revision ${r.revision}</p><p>Attribution: ${escape(r.attribution!)} · signed-in members only${source.origin === "sample" ? " · originally submitted as a sample" : ""}</p><pre class="content-text" data-contribution-body>${escape(source.body!).replace(/\r/g, "&#13;")}</pre><h2>Sources and rights notes</h2><p>${escape(source.sources!)}</p><p>Platform display permission only; no external reuse rights or formal qualification is implied.</p><p><a href="/contributions">Member contributions</a></p></article>`,
  );
}
