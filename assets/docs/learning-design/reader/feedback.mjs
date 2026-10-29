import { course } from "./course.mjs";

const cases = course.feedbackCases;
const labels = {
  revise: "Revise the current draft",
  decline: "Keep text and decline this suggestion",
  addressed: "Already addressed in a newer version",
};
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
const text = (value) => typeof value === "string" && value.length <= 30000;
const initial = (route) => cases[route].versions.at(-1);

function emptyDraft(value) {
  return { decision: "", text: value, reason: "", question: "" };
}
export function newFeedbackState(route) {
  return {
    caseId: cases[route].id,
    records: [],
    draft: emptyDraft(initial(route).text),
  };
}
export function currentFeedbackArtifact(route, state) {
  const last = state.records.at(-1);
  return last ? { id: last.toVersion, text: last.text } : initial(route);
}
function artifactVersions(route, state) {
  return [
    ...cases[route].versions,
    ...state.records
      .filter((r) => r.decision === "revise")
      .map((r) => ({ id: r.toVersion, text: r.text })),
  ];
}
export function validFeedbackState(state, route) {
  if (
    !state ||
    state.caseId !== cases[route].id ||
    !Array.isArray(state.records) ||
    !state.draft
  )
    return false;
  const draft = state.draft;
  if (
    !["", ...Object.keys(labels)].includes(draft.decision) ||
    ![draft.text, draft.reason, draft.question].every(text)
  )
    return false;
  let current = initial(route);
  for (const [index, r] of state.records.entries()) {
    if (
      !r ||
      r.id !== index + 1 ||
      !Object.hasOwn(labels, r.decision) ||
      ![r.text, r.reason, r.question, r.proposedText].every(text) ||
      !r.reason.trim() ||
      r.commentVersion !== cases[route].commentVersion ||
      r.fromVersion !== current.id
    )
      return false;
    if (r.decision === "revise") {
      if (
        !r.text.trim() ||
        r.text === current.text ||
        r.toVersion !== current.id + 1 ||
        r.proposedText !== r.text
      )
        return false;
    } else if (
      r.toVersion !== current.id ||
      r.text !== current.text ||
      (r.decision === "addressed" && current.id <= r.commentVersion)
    )
      return false;
    current = { id: r.toVersion, text: r.text };
  }
  return true;
}
export function addFeedbackDecision(route, state) {
  const { draft } = state;
  const current = currentFeedbackArtifact(route, state);
  if (!Object.hasOwn(labels, draft.decision))
    return "Choose what to do with this feedback.";
  if (!draft.reason.trim())
    return "Give a reason linked to the source or version.";
  if (
    draft.decision === "revise" &&
    (!draft.text.trim() || draft.text === current.text)
  )
    return "Write different, nonempty text for a new revision.";
  if (
    draft.decision === "addressed" &&
    current.id <= cases[route].commentVersion
  )
    return "There is no newer draft to point to. Revise or explain why you decline.";
  state.records.push({
    id: state.records.length + 1,
    commentVersion: cases[route].commentVersion,
    fromVersion: current.id,
    toVersion: current.id + (draft.decision === "revise" ? 1 : 0),
    decision: draft.decision,
    text: draft.decision === "revise" ? draft.text : current.text,
    proposedText: draft.text,
    reason: draft.reason,
    question: draft.question,
  });
  state.draft = emptyDraft(currentFeedbackArtifact(route, state).text);
  return null;
}
export function feedbackHistory(state) {
  return state.records
    .map(
      (r) =>
        `<section class="decision-record"><h4>Decision ${r.id} · ${escape(labels[r.decision])}</h4><p class="quiet">Comment on v${r.commentVersion} · ${r.decision === "revise" ? `new draft v${r.toVersion} from v${r.fromVersion}` : `retained draft v${r.toVersion}`} · learner decision, no new review</p><p><strong>Reason:</strong> ${escape(r.reason)}</p><pre>${escape(r.text)}</pre>${r.question ? `<p><strong>Clarification kept in this notebook:</strong> ${escape(r.question)}</p>` : ""}${r.decision !== "revise" && r.proposedText !== r.text ? `<details><summary>Unapplied proposal retained</summary><pre>${escape(r.proposedText)}</pre></details>` : ""}</section>`,
    )
    .join("");
}
export function renderFeedback(route, state, notice = "") {
  const data = cases[route],
    current = currentFeedbackArtifact(route, state),
    draft = state.draft;
  return `<section class="feedback-workflow" id="feedback-workflow" aria-label="Feedback decision workspace">
    <p class="eyebrow">TRY A REASONED RESPONSE · ${escape(data.id)}</p><h2>Decide what to do with the feedback</h2>
    <p>Use this invented case to practise. Keep a correction or a reason for retaining the wording. No question is sent to a reviewer.</p>
    <div class="feedback-context"><div><h3>Source</h3><p id="feedback-source">${escape(data.source)}</p></div><div id="feedback-comment"><h3>Comment on v${data.commentVersion}</h3><p>${escape(data.comment)}</p><p class="quiet">Supplied practice feedback · its version stays fixed. It is not a review of later writing.</p></div></div>
    <div id="feedback-current"><h3>Current draft · v${current.id}</h3><pre>${escape(current.text)}</pre></div>
    <details id="feedback-versions"><summary>All artifact versions (${artifactVersions(route, state).length})</summary>${artifactVersions(
      route,
      state,
    )
      .map(
        (v) =>
          `<h4>Draft v${v.id}${v.id <= initial(route).id ? " · supplied practice" : " · your revision"}</h4><pre>${escape(v.text)}</pre>`,
      )
      .join("")}</details>
    <form id="feedback-form"><label class="writing-label" for="feedback-choice">My decision</label><select id="feedback-choice"><option value="">Choose a response</option>${Object.entries(
      labels,
    )
      .map(
        ([value, label]) =>
          `<option value="${value}"${draft.decision === value ? " selected" : ""}>${label}</option>`,
      )
      .join("")}</select>
    <div ${draft.decision === "revise" ? "" : "hidden"}><label class="writing-label" for="feedback-text">Revised text</label><textarea id="feedback-text" data-feedback-field="text" maxlength="30000" rows="5">${escape(draft.text)}</textarea><div class="feedback-comparison"><div><h4>Before · v${current.id}</h4><pre>${escape(current.text)}</pre></div><div><h4>Proposed revision</h4><pre id="feedback-proposed">${escape(draft.text)}</pre></div></div></div>
    ${draft.decision && draft.decision !== "revise" ? `<p class="feedback-retained">This decision retains draft v${current.id} exactly. Any unapplied proposal remains in its decision record.</p>` : ""}
    <label class="writing-label" for="feedback-reason">My reason</label><textarea id="feedback-reason" data-feedback-field="reason" maxlength="30000" rows="3" placeholder="Point to the source or the change already made.">${escape(draft.reason)}</textarea>
    <label class="writing-label" for="feedback-question">Clarification to keep (optional)</label><textarea id="feedback-question" data-feedback-field="question" maxlength="30000" rows="2" placeholder="Which source would settle the uncertainty? This stays in your notebook.">${escape(draft.question)}</textarea>
    <details><summary>Compare with source-based guidance</summary><p>${escape(data.guidance)}</p><p class="quiet">This is supplied guidance. Your reasoning is not automatically graded.</p></details>
    <button class="primary" type="submit">Add decision to my notebook</button><p id="feedback-notice" role="status">${escape(notice || "A decision needs your reason. Adding it keeps an in-page record; use Save in this browser to retain it after reload.")}</p></form>
    <div id="feedback-decisions"><h3>Your decision record</h3>${feedbackHistory(state) || "<p>No decision recorded yet.</p>"}</div><p class="quiet">A recorded decision is not a mastery result or an independent review. Additional fresh-case notes remain available below.</p></section>`;
}
export function exportFeedback(route, state) {
  const data = cases[route];
  const lines = [
    "\nLesson 6 feedback decision workspace",
    `Case: ${data.id}`,
    `Source: ${data.source}`,
    `Comment on v${data.commentVersion}: ${data.comment}`,
    "Supplied practice feedback. No question was sent; no independent review is claimed.",
  ];
  for (const v of artifactVersions(route, state))
    lines.push(`Draft v${v.id}: ${v.text}`);
  for (const r of state.records) {
    lines.push(
      `Decision ${r.id}: ${labels[r.decision]}; comment v${r.commentVersion}; artifact v${r.fromVersion} → v${r.toVersion}`,
      `Reason: ${r.reason}`,
      `Resulting text: ${r.text}`,
      `Clarification kept locally: ${r.question}`,
    );
    if (r.proposedText !== r.text)
      lines.push(`Unapplied proposal retained: ${r.proposedText}`);
  }
  const draft = state.draft;
  if (
    draft.decision ||
    draft.reason ||
    draft.question ||
    draft.text !== currentFeedbackArtifact(route, state).text
  )
    lines.push(
      "Unfinished response (not a recorded decision)",
      `Decision: ${labels[draft.decision] ?? "not chosen"}`,
      `Proposed text: ${draft.text}`,
      `Reason: ${draft.reason}`,
      `Clarification: ${draft.question}`,
    );
  return lines.join("\n\n");
}
