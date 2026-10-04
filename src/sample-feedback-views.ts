import { randomUUID } from "node:crypto";
import { escape, hidden, page } from "./views.ts";
import type {
  SampleFeedbackView,
  SampleFeedbackRecord,
} from "./sample-feedback.ts";
export const sampleFeedbackPath = (id: string, reviewer = false) =>
  `${reviewer ? "/review" : ""}/evidence/${encodeURIComponent(id)}/feedback`;
const label =
  '<p class="eyebrow">HUMAN-AUTHORED · PRIVATE SAMPLE · NOT FORMAL ASSESSMENT</p><p>This local feedback is not a qualification, score, paid review or promise of an outcome. Any time shown is self-reported and unbilled.</p>';
function published(row: SampleFeedbackRecord) {
  return `<article><h2>Published sample feedback</h2><p>Reviewer reference ${escape(row.authorId)} · source version ${row.sourceRevision} · published ${escape(row.publishedAt!.toISOString())}</p>${row.criteria.map((c) => `<section><h3>${escape(c.label)}</h3><blockquote>${escape(c.quote)}</blockquote><p>${escape(c.comment)}</p></section>`).join("")}<p>Self-reported preparation: ${row.preparationMinutes ?? "not supplied"} minutes; review: ${row.reviewMinutes ?? "not supplied"} minutes.</p>${row.clarification ? `<h3>Your clarification</h3><p>${escape(row.clarification)}</p>` : ""}${row.answer ? `<h3>Reviewer answer</h3><p>${escape(row.answer)}</p>` : ""}</article>`;
}
export function sampleFeedbackRecovery(
  title: string,
  message: string,
  href: string,
  attempt?: Record<string, string>,
) {
  return page(
    title,
    `<section class="reading"><h1>${escape(title)}</h1><p role="alert">${escape(message)}</p><p>Nothing is retried automatically. Inspect saved feedback before deciding what to do next.</p>${
      attempt
        ? `<h2>Your attempted text</h2><p>Copy any text you want to keep before reopening the form.</p>${Object.entries(
            attempt,
          )
            .filter(
              ([key]) =>
                !["csrf", "operationId", "revision", "confirm"].includes(key),
            )
            .map(
              ([key, value]) =>
                `<label>${escape(key)}<textarea readonly>${escape(value)}</textarea></label>`,
            )
            .join("")}`
        : ""
    }<p><a href="${escape(href)}">Inspect saved feedback</a></p><p><a href="/evidence">Your private evidence</a></p></section>`,
  );
}
function exchangeForm(path: string, csrf: string, id: string, answer: boolean) {
  return `<form method="post" action="${escape(path)}/${answer ? "answer" : "clarify"}">${hidden(csrf)}<input type="hidden" name="feedbackId" value="${escape(id)}"><input type="hidden" name="operationId" value="${randomUUID()}"><label for="message-${escape(id)}">${answer ? "One reviewer answer" : "One clarification"}</label><textarea id="message-${escape(id)}" name="message" maxlength="2000" required></textarea><p>One clarification and one answer are available while consent and reviewer authority remain active. This is not an appeal service.</p><button type="submit">${answer ? "Send answer" : "Send clarification"}</button></form>`;
}
export function sampleFeedbackPage(
  view: SampleFeedbackView,
  csrf: string,
  reviewer: boolean,
) {
  const path = sampleFeedbackPath(view.evidenceId, reviewer),
    draft = view.records[0];
  let content: string;
  if (reviewer && !draft?.publishedAt) {
    content = `<h2>Your private feedback draft</h2><p>The learner cannot see this draft until you explicitly publish it. Use one to five criteria of your own; no approved rubric is implied.</p><form method="post" action="${path}/draft">${hidden(csrf)}<input type="hidden" name="operationId" value="${randomUUID()}"><input type="hidden" name="revision" value="${draft?.revision ?? 0}">${Array.from(
      { length: 5 },
      (_, index) => {
        const c = draft?.criteria[index];
        let occurrence = 1;
        if (c) {
          let offset = view.source.indexOf(c.quote);
          while (offset >= 0 && offset < c.start) {
            occurrence++;
            offset = view.source.indexOf(c.quote, offset + 1);
          }
        }
        return `<fieldset><legend>Criterion ${index + 1}${index ? " (optional)" : ""}</legend><label for="label-${index}">Criterion ${index + 1} label</label><input id="label-${index}" name="label${index}" maxlength="100" ${index ? "" : "required"} value="${escape(c?.label ?? "")}"><label for="comment-${index}">Criterion ${index + 1} comment</label><textarea id="comment-${index}" name="comment${index}" maxlength="1000" ${index ? "" : "required"}>${escape(c?.comment ?? "")}</textarea><label for="quote-${index}">Criterion ${index + 1} exact source quote</label><textarea id="quote-${index}" name="quote${index}" maxlength="1000" ${index ? "" : "required"}>${escape(c?.quote ?? "")}</textarea><label for="occurrence-${index}">Criterion ${index + 1} quote occurrence (1 for first match)</label><input id="occurrence-${index}" name="occurrence${index}" type="number" min="1" max="1048576" value="${occurrence}"></fieldset>`;
      },
    ).join(
      "",
    )}<label for="preparation">Self-reported preparation minutes (optional, unbilled)</label><input id="preparation" name="preparationMinutes" type="number" min="0" max="480" value="${draft?.preparationMinutes ?? ""}"><label for="review">Self-reported review minutes (optional, unbilled)</label><input id="review" name="reviewMinutes" type="number" min="0" max="480" value="${draft?.reviewMinutes ?? ""}"><button type="submit">Save private feedback draft</button></form>${draft ? `<form method="post" action="${path}/publish">${hidden(csrf)}<input type="hidden" name="operationId" value="${randomUUID()}"><input type="hidden" name="revision" value="${draft.revision}"><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Publish saved draft version ${draft.revision}. Published feedback cannot be edited; unsaved form changes are not included.</span></label><button type="submit">Publish saved feedback</button></form>` : ""}`;
  } else {
    content = view.records.length
      ? view.records
          .map(
            (row) =>
              published(row) +
              (view.consent &&
              ((!reviewer && !row.clarification) ||
                (reviewer && row.clarification && !row.answer))
                ? exchangeForm(path, csrf, row.id, reviewer)
                : ""),
          )
          .join("")
      : "<p>No published feedback is available for this sample.</p>";
  }
  return page(
    reviewer ? "Review private sample" : "Your private sample feedback",
    `<nav class="breadcrumb"><a href="/evidence">Your private evidence</a></nav><section class="reading">${label}<h1>${reviewer ? "Review private sample" : "Your private sample feedback"}</h1><h2>${escape(view.title)}</h2><p>Source version ${view.sourceRevision} · ${view.consent ? "Private-review consent active" : "Consent withdrawn: published feedback remains private to its owner; no new clarification exchange is available."}</p><details open><summary>Exact source sample</summary><pre>${escape(view.source)}</pre></details>${content}${view.next ? `<p><a href="${path}?after=${encodeURIComponent(view.next)}">Next feedback page</a></p>` : ""}${reviewer ? "<p>The source owner controls consent, revisions and deletion.</p>" : '<p><a href="/evidence">Manage source revisions, consent and deletion</a></p>'}</section>`,
  );
}
