import { course } from "./course.mjs";
import {
  newFeedbackState,
  validFeedbackState,
  renderFeedback,
  feedbackHistory,
  addFeedbackDecision,
  exportFeedback,
} from "./feedback.mjs";

import {
  newContribution,
  validContribution,
  renderContribution,
  bindContribution,
  exportContribution,
} from "./contribution.mjs";

const routes = { everyday: "Everyday", work: "Work", technical: "Technical" };
const stages = ["See an example", "Try it", "Fresh case", "Your work"];
const finalStages = [
  "Read the brief",
  "Write a first draft",
  "Read the update",
  "Revise and check",
];
const finalLabels = [
  "Task and check",
  "Your request",
  "Claim check and repair",
  "Use and sharing decision",
  "Repeatable workflow",
  "Feedback and revision",
];
const root = document.querySelector("#app");
const legacyKey = (route) => `dne-course-reader-1:${route}`;
const key = (route) => `${legacyKey(route)}:${course.contentHash}`;
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const sessions = new Map();
let route = new URLSearchParams(location.hash.slice(1)).get("route");
if (!Object.keys(routes).includes(route)) route = "everyday";

const lessonOutcomes = [
  "Choose a useful task and a way to check it.",
  "Give a clear request the context it needs.",
  "Separate supported claims from confident guesses.",
  "Decide what to use, change or keep private.",
  "Build a process you can check and repeat.",
  "Give useful feedback and explain your revision.",
];

function icon(name) {
  const paths = {
    learn:
      '<path d="M4 4.5h6a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H4z"/><path d="M20 4.5h-4a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h4z"/>',
    practice:
      '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17"/>',
    work: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3v18M12 8h4M12 12h4M12 16h3"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    case: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V4h8v3M3 12h18M10 12v3h4v-3"/>',
    source: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/>',
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.learn}</svg>`;
}

function sectionMarkup(html) {
  const headings = [...html.matchAll(/<h([1-6])(?:\s|>)/g)].map((m) =>
    Number(m[1]),
  );
  if (!headings.length) return html;
  const firstLevel = Math.min(...headings);
  return html.replace(
    /<(\/?)h([1-6])(?=[\s>])/g,
    (_, close, level) =>
      `<${close}h${Math.min(6, Number(level) - firstLevel + 2)}`,
  );
}

function emptyState(chosenRoute) {
  return {
    lesson: 0,
    step: 0,
    lessons: course.lessons.map(() => ({
      transfer: "",
      work: "",
      selfChecked: false,
      selections: [],
      checked: false,
      hint: false,
    })),
    final: finalLabels.map(() => ""),
    finalChecked: false,
    finalStep: 0,
    reviewCriterion: null,
    feedback: newFeedbackState(chosenRoute),
    contribution: newContribution(),
  };
}

function validState(value, chosenRoute) {
  const text = (v) => typeof v === "string" && v.length <= 30000;
  if (
    !value ||
    !Number.isInteger(value.lesson) ||
    value.lesson < 0 ||
    value.lesson > 6 ||
    !Number.isInteger(value.step) ||
    value.step < 0 ||
    value.step > 3
  )
    return false;
  if (
    !Array.isArray(value.lessons) ||
    value.lessons.length !== 6 ||
    !Array.isArray(value.final) ||
    value.final.length !== 6 ||
    !value.final.every(text) ||
    typeof value.finalChecked !== "boolean" ||
    (value.reviewCriterion !== undefined &&
      value.reviewCriterion !== null &&
      (!Number.isInteger(value.reviewCriterion) ||
        value.reviewCriterion < 0 ||
        value.reviewCriterion >=
          course.reviewGuidance.routes[chosenRoute].rows.length)) ||
    (value.finalStep !== undefined &&
      (!Number.isInteger(value.finalStep) ||
        value.finalStep < 0 ||
        value.finalStep > 3)) ||
    (value.contribution !== undefined &&
      !validContribution(value.contribution)) ||
    (value.feedback !== undefined &&
      !validFeedbackState(value.feedback, chosenRoute))
  )
    return false;
  return value.lessons.every((v, i) => {
    const questions = course.lessons[i].routes[chosenRoute].practice.questions;
    return (
      v &&
      text(v.transfer) &&
      text(v.work) &&
      typeof v.selfChecked === "boolean" &&
      typeof v.checked === "boolean" &&
      typeof v.hint === "boolean" &&
      Array.isArray(v.selections) &&
      v.selections.length <= questions.length &&
      v.selections.every(
        (choice, n) =>
          choice === null || questions[n].choices.some((c) => c.key === choice),
      )
    );
  });
}

function writingSnapshot(value) {
  return JSON.stringify({
    lessons: value.lessons.map(({ transfer, work, selfChecked }) => ({
      transfer,
      work,
      selfChecked,
    })),
    final: value.final,
    finalChecked: value.finalChecked,
    feedback: value.feedback,
    contribution: value.contribution,
  });
}

function getSession(chosenRoute) {
  if (sessions.has(chosenRoute)) return sessions.get(chosenRoute);
  const session = {
    state: emptyState(chosenRoute),
    view: "learn",
    dirty: false,
    saveFailed: false,
    blocked: false,
    raw: null,
    earlier: [],
    message:
      "Nothing saved yet. Your writing stays here while this page is open.",
  };
  let loadedKey;
  try {
    const currentRaw = localStorage.getItem(key(chosenRoute));
    loadedKey = currentRaw !== null ? key(chosenRoute) : legacyKey(chosenRoute);
    session.raw = currentRaw ?? localStorage.getItem(loadedKey);
    for (const storedKey of Object.keys(localStorage).sort()) {
      if (
        storedKey !== key(chosenRoute) &&
        (storedKey === legacyKey(chosenRoute) ||
          storedKey.startsWith(`${legacyKey(chosenRoute)}:`))
      ) {
        session.earlier.push({
          key: storedKey,
          raw: localStorage.getItem(storedKey),
        });
      }
    }
    if (session.raw !== null) {
      const stored = JSON.parse(session.raw);
      if (stored.version !== 1 || typeof stored.contentHash !== "string")
        throw new Error("different version");
      if (stored.route !== chosenRoute) throw new Error("unreadable");
      if (stored.contentHash !== course.contentHash) {
        if (loadedKey === key(chosenRoute))
          throw new Error("different version");
        session.raw = null;
      } else {
        if (!validState(stored.state, chosenRoute))
          throw new Error("unreadable");
        session.state = stored.state;
        session.view = "lesson";
        session.state.finalStep ??= 0;
        session.state.reviewCriterion ??= null;
        session.state.feedback ??= newFeedbackState(chosenRoute);
        session.state.contribution ??= newContribution();
        session.earlier = session.earlier.filter(
          (entry) => entry.key !== loadedKey,
        );
        session.message =
          "Restored your explicit browser save. This is not a member-account save.";
      }
    }
    if (session.raw === null && session.earlier.length)
      session.message =
        "An earlier content version is saved separately below. Start a current notebook here; earlier answers and self-checks have not been copied.";
  } catch (error) {
    session.blocked = session.raw !== null;
    session.earlier = session.earlier.filter(
      (entry) => entry.key !== loadedKey,
    );
    session.message = session.blocked
      ? `Saved work could not be restored${error.message === "different version" ? " because the lesson version differs" : " because the record is unreadable"}. The stored copy is unchanged. Download it before moving work to a new version.`
      : "Browser storage is unavailable. You can still practise and download your work.";
  }
  session.savedWriting = writingSnapshot(session.state);
  sessions.set(chosenRoute, session);
  return session;
}
const session = () => getSession(route);
const state = () => session().state;
const item = () => state().lessons[state().lesson];

function changed() {
  session().dirty = true;
  if (!session().blocked)
    session().message =
      "Unsaved changes. Choose Save in this browser or download your work.";
  updateStatus();
  renderOutline();
}

function updateStatus() {
  const node = document.querySelector("#save-status");
  if (node) node.textContent = session().message;
  for (const selector of ["#save", "#save-compact"]) {
    const button = document.querySelector(selector);
    if (button) button.disabled = session().blocked;
  }
  const compact = document.querySelector("#save-indicator");
  if (compact) {
    compact.textContent = session().blocked
      ? "Check your stored copy"
      : session().saveFailed
        ? "Save failed · try again"
        : session().dirty
          ? "Unsaved changes"
          : session().raw
            ? "Saved in this browser"
            : "Browser notebook";
    compact.classList.toggle("is-unsaved", session().dirty);
    compact.classList.toggle(
      "is-error",
      session().blocked || session().saveFailed,
    );
  }
}

function needsReview(index) {
  const lesson = state().lessons[index];
  return (
    lesson.checked &&
    course.lessons[index].routes[route].practice.questions.some(
      (question, n) => lesson.selections[n] !== question.answer,
    )
  );
}

function lessonStatus(index) {
  const lesson = state().lessons[index];
  if (needsReview(index)) return "Revisit the practice";
  if (lesson.selfChecked) return "Self-check recorded";
  if (lesson.work.trim() || lesson.transfer.trim()) return "Draft started";
  if (index === 5 && state().feedback.records.length)
    return "Decision recorded";
  if (lesson.checked) return "Practice checked";
  if (lesson.selections.some(Boolean)) return "Response chosen";
  return "Not tried yet";
}

function outline() {
  return [...course.lessons.map((l) => l.title), "Put it all together"]
    .map((title, i) => {
      const current = state().lesson === i;
      const written =
        i < 6
          ? state().lessons[i].work.trim()
          : state().final.some((v) => v.trim());
      const checked =
        i < 6 ? state().lessons[i].selfChecked : state().finalChecked;
      const caption = checked
        ? "Self-checked"
        : i === 5 && state().feedback.records.length
          ? "Decision recorded"
          : written
            ? "Notes written"
            : i === 6
              ? "One connected record"
              : "Example · practice · apply";
      return `<button class="lesson-link ${current ? "current" : ""}" data-lesson="${i}" aria-label="${i < 6 ? `Lesson ${i + 1}: ` : ""}${escape(title)}" ${current ? 'aria-current="step"' : ""}><span class="lesson-number">${i < 6 ? String(i + 1).padStart(2, "0") : icon("case")}</span><span><strong>${escape(title)}</strong><small>${i < 6 ? lessonStatus(i) : caption}</small></span></button>`;
    })
    .join("");
}

function renderOutline() {
  const node = document.querySelector("#course-path");
  if (!node) return;
  const signature = [
    state().lesson,
    ...state().lessons.map((_, i) => lessonStatus(i)),
    state().finalChecked,
    state().final.some((value) => value.trim()),
  ].join("|");
  if (node.dataset.signature === signature) return;
  node.innerHTML = outline();
  node.dataset.signature = signature;
}

function activitySummary() {
  return {
    checked: state().lessons.filter((lesson) => lesson.checked).length,
    written: state().lessons.filter(
      (lesson) => lesson.work.trim() || lesson.transfer.trim(),
    ).length,
    reflected: state().lessons.filter((lesson) => lesson.selfChecked).length,
  };
}

function learnContent() {
  const current = state();
  const activity = activitySummary();
  const title =
    current.lesson === 6
      ? "Put it all together"
      : course.lessons[current.lesson].title;
  const step =
    current.lesson === 6
      ? finalStages[current.finalStep]
      : stages[current.step];
  const rows = course.lessons
    .map(
      (lesson, index) =>
        `<li class="course-row ${current.lesson === index ? "current" : ""}"><span class="lesson-number">${String(index + 1).padStart(2, "0")}</span><div class="course-row-copy"><h3>${escape(lesson.title)}</h3><p>${lessonOutcomes[index]}</p><span class="state-tag ${needsReview(index) ? "needs-review" : ""}">${lessonStatus(index)}</span></div><button class="secondary" data-open-lesson="${index}" aria-label="Open lesson ${index + 1}">Open ${icon("arrow")}</button></li>`,
    )
    .join("");
  return {
    title: "Your learning path",
    intro:
      "Six practical skills. One useful piece of work. Learn with examples that fit your world.",
    body: `<div class="learning-home"><div class="learning-main"><section class="resume-panel" aria-labelledby="resume-heading"><div class="resume-copy"><h2 id="resume-heading">${escape(title)}</h2><span class="resume-meta">${current.lesson === 6 ? "Applied case" : `Lesson ${current.lesson + 1} of 6`} · ${escape(step)}</span><p>${current.lesson === 6 ? "Bring the skills together in a changing case. Keep your first draft and explain your revision." : lessonOutcomes[current.lesson]}</p><button class="primary" data-continue>Continue learning ${icon("arrow")}</button></div><div class="resume-visual" aria-hidden="true">${icon(current.lesson === 6 ? "case" : "learn")}<span>${current.lesson === 6 ? "Apply" : String(current.lesson + 1).padStart(2, "0")}</span></div></section><section class="course-outline" aria-labelledby="course-outline-heading"><div class="section-heading"><h2 id="course-outline-heading">Build your foundation</h2><span>Explore at your own pace</span></div><ol>${rows}</ol></section><section class="case-preview"><span class="case-icon">${icon("case")}</span><div><h2>Put it all together</h2><p>${escape(course.capstone[route].practiceFlow.title)}</p><p>Read a changing brief, make a first draft, then explain your revision.</p></div><button class="secondary" data-open-final>Open final practice ${icon("arrow")}</button></section></div><aside class="learning-aside"><section class="activity-panel"><h2>Your practice so far</h2><p>Activity from this ${routes[route].toLowerCase()} notebook.</p><dl class="activity-list"><div><dt>Practices checked</dt><dd>${activity.checked}<span> / 6</span></dd></div><div><dt>Lessons with writing</dt><dd>${activity.written}<span> / 6</span></dd></div><div><dt>Self-checks recorded</dt><dd>${activity.reflected}<span> / 6</span></dd></div></dl><p class="quiet">These describe your activity. They are not a skill score.</p></section><section class="learning-note"><span class="note-icon">${icon("source")}</span><h2>A useful habit</h2><p>Keep the source close. Ask what supports the answer, what is missing, and what you would change.</p><button class="text-button" data-view="practice" aria-label="Open practice">Find a skill to practise ${icon("arrow")}</button></section></aside></div>`,
  };
}

function practiceContent() {
  const review = state()
    .lessons.map((_, index) => index)
    .filter(needsReview);
  const reviewRows = review
    .map(
      (index) =>
        `<li class="review-row"><span class="review-icon">${icon("practice")}</span><div><h3>${escape(course.lessons[index].title)}</h3><p>Your last checked response needs another look at the source.</p></div><button class="primary" data-review-lesson="${index}" aria-label="Review lesson ${index + 1}">Review ${icon("arrow")}</button></li>`,
    )
    .join("");
  const skills = course.lessons
    .map(
      (lesson, index) =>
        `<li class="course-row"><span class="lesson-number">${String(index + 1).padStart(2, "0")}</span><div class="course-row-copy"><h3>${escape(lesson.title)}</h3><p>${lessonOutcomes[index]}</p><span class="state-tag">${lessonStatus(index)}</span></div><button class="secondary" data-review-lesson="${index}" aria-label="Practise lesson ${index + 1}">Practise ${icon("arrow")}</button></li>`,
    )
    .join("");
  return {
    title: "Make it stick",
    intro:
      "Revisit a response, check the evidence, and try again. A mistake is a useful place to start.",
    body: `<div class="practice-home"><section class="review-focus" aria-labelledby="review-heading"><h2 id="review-heading">Worth another look</h2>${review.length ? `<ul class="review-list">${reviewRows}</ul>` : `<div class="empty-state">${icon("check")}<div><h3>No checked answers need another try.</h3><p>Choose a skill below. When a checked response needs a revision, it will appear here.</p></div></div>`}</section><section class="course-outline" aria-labelledby="practice-skills-heading"><div class="section-heading"><h2 id="practice-skills-heading">Choose a skill</h2><span>Source-based questions and explanations</span></div><ol>${skills}</ol></section></div>`,
  };
}

function workContent() {
  const rows = state()
    .lessons.map((lesson, index) => ({ lesson, index }))
    .filter(
      ({ lesson, index }) =>
        lesson.work.trim() ||
        lesson.transfer.trim() ||
        (index === 5 &&
          (state().feedback.records.length ||
            state().feedback.draft.decision ||
            state().feedback.draft.reason.trim())),
    )
    .map(({ lesson, index }) => {
      const preview = lesson.work.trim() || lesson.transfer.trim();
      const step = lesson.work.trim() ? 3 : 2;
      return `<li class="work-row"><span class="work-icon">${icon("work")}</span><div><h2>${escape(course.lessons[index].title)}</h2><p class="work-meta">Lesson ${index + 1} · ${lessonStatus(index)}</p>${preview ? `<p class="work-preview">${escape(preview.length > 190 ? `${preview.slice(0, 190)}…` : preview)}</p>` : `<p>${state().feedback.records.length} feedback decision${state().feedback.records.length === 1 ? "" : "s"} recorded. Your response stays in this notebook.</p>`}</div><button class="secondary" data-write-lesson="${index}" data-write-step="${step}" aria-label="Continue writing lesson ${index + 1}">Continue writing ${icon("arrow")}</button></li>`;
    })
    .join("");
  const finalFields = state().final.filter((value) => value.trim()).length;
  const proposal = state().contribution;
  const hasProposal = ["problem", "first", "revision", "reason", "rights"].some(
    (field) => proposal[field].trim(),
  );
  return {
    title: "Your work, kept together",
    intro:
      "Your drafts, decisions and revisions. Save them in this browser or download a copy to keep.",
    body: `<div class="work-home">${rows ? `<ul class="work-list">${rows}</ul>` : `<section class="empty-state">${icon("work")}<div><h2>Make something you can come back to.</h2><p>Your lesson writing will appear here. Start with a task you can check, then keep your reasoning as you go.</p><button class="primary" data-open-lesson="0">Start your first lesson ${icon("arrow")}</button></div></section>`}<section class="case-preview"><span class="case-icon">${icon("case")}</span><div><h2>Your connected learning record</h2><p>${escape(course.capstone[route].practiceFlow.title)}</p><p>${finalFields ? `${finalFields} of 6 writing fields have notes. ${state().finalChecked ? "Your self-check is recorded." : "Your first draft and revision stay separate."}` : "Bring the six skills together in one changing case."}</p></div><button class="secondary" data-open-final>${finalFields ? "Continue final practice" : "Open final practice"} ${icon("arrow")}</button></section>${hasProposal ? `<section class="work-contribution"><h2>Your contribution draft</h2><p>A private proposal${proposal.revision.trim() ? " and revision" : ""} is kept with your final record. It has not been submitted or shared.</p><button class="text-button" data-open-contribution>Continue contribution draft ${icon("arrow")}</button></section>` : ""}</div>`,
  };
}

function textarea(label, value, kind, index = "", guidance = "") {
  const id = `writing-${kind}${index}`;
  return `<label class="writing-label" for="${id}">${escape(label)}</label>${guidance ? `<div class="writing-guidance" id="${id}-guide">${guidance}</div>` : ""}<textarea id="${id}" ${guidance ? `aria-describedby="${id}-guide"` : ""} data-writing="${kind}" data-index="${index}" maxlength="30000" rows="6" placeholder="Use the invented source. Write what you can explain.">${escape(value)}</textarea>`;
}

function selfCheck(checked, enabled, isFinal = false) {
  return `<label class="self-check"><input id="self-check" type="checkbox" ${checked ? "checked" : ""} ${enabled ? "" : "disabled"} data-final="${isFinal}">I compared this work with the criteria above</label><p class="quiet">Your self-check records your judgment. Free writing is not automatically graded.</p>`;
}

function practice(data) {
  const current = item();
  const responses = data.questions
    .map((q, n) => {
      const chosen = current.selections[n];
      const correct = chosen === q.answer;
      return `<fieldset><legend>${escape(q.prompt)}</legend>${q.choices.map((c) => `<label class="choice ${current.checked && chosen === c.key ? (correct ? "correct" : "reconsider") : ""}"><input type="radio" name="q-${n}" data-question="${n}" value="${escape(c.key)}" ${chosen === c.key ? "checked" : ""}><span>${c.key.length === 1 ? `<b>${c.key}</b> ` : ""}${escape(c.label)}</span></label>`).join("")}<div class="answer-feedback ${correct ? "positive" : ""}" tabindex="-1" ${current.checked ? "" : "hidden"}><strong>${icon(correct ? "check" : "practice")}${correct ? "This response matches the source." : "Try another choice after comparing with the source."}</strong><p>You chose ${escape(chosen ?? "no response")}.</p>${q.feedback}</div></fieldset>`;
    })
    .join("");
  return `${data.intro}<details id="hint" ${current.hint ? "open" : ""}><summary>Show a hint</summary><p>${escape(data.hint)}</p></details><form id="practice-form">${responses}<p id="practice-notice" role="status"></p><button class="primary" type="submit">Check answer${data.questions.length > 1 ? "s" : ""}</button></form><p class="quiet" id="practice-guidance">${practiceGuidance(data)}</p>`;
}

function practiceGuidance(data) {
  if (!item().checked)
    return "Choose your response, then compare the explanation with the source.";
  return data.questions.every((q, n) => item().selections[n] === q.answer)
    ? "Your response matches the source. Continue to the fresh case when you can explain why. This is practice, not a proficiency score."
    : "Use the explanation to revise your response, then check again. This is practice, not a proficiency score.";
}

function earlierNotebooks() {
  if (!session().earlier.length) return "";
  return `<details id="earlier-notebooks"><summary>Earlier notebooks (${session().earlier.length})</summary><p>These stored copies remain unchanged. Their answers and self-checks belong to their original content version; they are not copied into the current lessons. Downloads contain the stored record and version identifier, not a complete archive of the old lessons.</p><label for="earlier-record">Stored notebook</label><select id="earlier-record">${session()
    .earlier.map(
      (entry, i) =>
        `<option value="${i}">Notebook ${i + 1} · ${entry.key === legacyKey(route) ? "original save" : escape(entry.key.slice(-12))}</option>`,
    )
    .join(
      "",
    )}</select><button class="secondary" id="download-earlier">Download earlier notebook</button></details>`;
}

function notebookContent() {
  return state()
    .lessons.map((l, n) => {
      const decisions = n === 5 ? feedbackHistory(state().feedback) : "";
      if (!l.work.trim() && !l.transfer.trim() && !decisions) return "";
      return `<section><h3>${n + 1}. ${escape(course.lessons[n].title)}</h3>${l.transfer.trim() ? `<p class="record-label">Fresh-case attempt</p><pre>${escape(l.transfer)}</pre>` : ""}${l.work.trim() ? `<p class="record-label">Your work</p><pre>${escape(l.work)}</pre>` : ""}${decisions}</section>`;
    })
    .join("");
}

function earlierNotes() {
  return `<details class="notebook" id="notebook"><summary>Your earlier notes</summary><div id="notebook-content">${notebookContent() || "<p>Your notes will appear here as you write. You can revisit any lesson.</p>"}</div></details>`;
}

function refreshNotebook() {
  const notebook = document.querySelector("#notebook");
  if (notebook?.open)
    document.querySelector("#notebook-content").innerHTML =
      notebookContent() ||
      "<p>Your notes will appear here as you write. You can revisit any lesson.</p>";
}

function finalReview() {
  const guidance = course.reviewGuidance.routes[route];
  return `<section id="final-review" aria-labelledby="final-review-heading"><h2 id="final-review-heading">Review your record</h2><p>Point to the evidence in your own work. If one part needs another try, open its help and practise the related skill. Your final draft stays here.</p><div class="review-criteria">${guidance.rows.map((row, index) => `<section class="review-criterion" id="review-criterion-${index}" aria-label="${escape(row.criterion)}" tabindex="-1"><h3>${escape(row.criterion)}</h3><p>${escape(row.evidence)}</p><details><summary>Help me improve this part</summary><p>${escape(row.prompt)}</p><button class="secondary" data-review-criterion="${index}">Practise lesson ${row.lesson}: ${escape(course.lessons[row.lesson - 1].title)}</button></details></section>`).join("")}</div>${guidance.afterword}</section>`;
}

function practiceReturn() {
  if (state().reviewCriterion === null) return "";
  const row = course.reviewGuidance.routes[route].rows[state().reviewCriterion];
  return `<aside id="practice-return" class="practice-return" aria-label="Return to final practice"><h2>${escape(row.criterion)}</h2><p>${escape(row.prompt)}</p><p>Your first draft and revision remain in your final record. Practise here, then return when you are ready to improve your own work.</p><button class="secondary" id="return-final">Return to my final record</button></aside>`;
}

function lessonContent() {
  const lesson = course.lessons[state().lesson];
  const data = lesson.routes[route];
  const current = item();
  const startingWork =
    state().step === 3 && state().lesson > 0 && state().lessons[0].work.trim()
      ? state().lessons[0].work
      : null;
  let body;
  if (state().step === 0) body = sectionMarkup(data.example);
  if (state().step === 1) body = practice(data.practice);
  if (state().step === 2)
    body = `${sectionMarkup(data.transfer)}${state().lesson === 5 ? renderFeedback(route, state().feedback, session().feedbackNotice) : ""}${textarea("Your fresh-case attempt", current.transfer, "transfer")}${sectionMarkup(data.comparison)}<p class="quiet">Compare the reasoning, not the exact wording. The example is supplied teaching material.</p>`;
  if (state().step === 3)
    body = `${sectionMarkup(data.own)}${textarea("Your lesson work", current.work, "work")}${selfCheck(current.selfChecked, Boolean(current.work.trim()))}`;
  const next =
    state().step < 3
      ? stages[state().step + 1]
      : state().lesson < 5
        ? "Continue to the next lesson"
        : "Start the final practice";
  return {
    source:
      startingWork ?? (state().step === 2 ? data.freshSource : data.source),
    sourceNote: startingWork
      ? "These are your Lesson 1 notes. Check them against your original source; they have not been independently verified. Earlier drafts remain in your notebook below."
      : state().step === 3
        ? "Use this example if you need a source. Record your own source in your writing."
        : "Compare each claim with these notes. Keep unknown details open.",
    sourceLabel: startingWork
      ? "Your starting work"
      : state().step === 2
        ? "Fresh source"
        : state().step === 3
          ? "Example source"
          : "Your source",
    title: lesson.title,
    intro: lesson.intro,
    body: `${practiceReturn()}<nav class="stages" aria-label="Lesson stages">${stages.map((label, i) => `<button data-step="${i}" ${i === state().step ? 'aria-current="step"' : ""}><span>${i + 1}</span>${label}</button>`).join("")}</nav><section class="lesson-body" aria-label="${stages[state().step]}" tabindex="-1">${body}</section><div class="next-row"><button class="secondary" id="back" ${state().lesson === 0 && state().step === 0 ? "disabled" : ""}>Back</button><button class="primary" id="next">${next} ${icon("arrow")}</button></div>`,
  };
}

function finalContent() {
  const data = course.capstone[route];
  const flow = data.practiceFlow;
  const panel = (index, body) =>
    `<div class="final-panel" data-final-panel="${index}" aria-label="${finalStages[index]}" tabindex="-1" ${state().finalStep === index ? "" : "hidden"}>${body}</div>`;
  const draft = (id, label) =>
    `<details id="${id}"><summary>${label}</summary><pre>${escape(state().final[2] || "Your first draft will appear here after you write it in step 2.")}</pre></details>`;
  const teachingSample = `<div class="teaching-sample"><p class="record-label">Deliberately flawed teaching sample</p><p>${escape(data.sample)}</p><small>This was supplied for practice; it was not generated from your request.</small></div>`;
  const field = (n) =>
    textarea(
      `${n + 1}. ${finalLabels[n]}`,
      state().final[n],
      "final",
      n,
      flow.fieldGuides[n] + (n === 2 ? teachingSample : ""),
    );
  const panels = [
    panel(
      0,
      `<h2>${escape(flow.title)}</h2>${flow.introduction}${flow.sources}`,
    ),
    panel(
      1,
      `<h2>Make a useful first draft.</h2><p id="final-output"><strong>Your output:</strong> ${escape(data.output)}</p><p>Keep this first version so you can explain what changes later.</p>${[0, 1, 2, 3, 4].map(field).join("")}`,
    ),
    panel(
      2,
      `<h2>${escape(flow.updateTitle)}</h2>${flow.update}${draft("retained-draft-update", "Your retained first draft")}`,
    ),
    panel(
      3,
      `<h2>Explain what changed and why.</h2><p>Keep your first draft. Write the revision here, including what stays the same and any questions you still need to resolve.</p>${draft("retained-draft-revision", "Refer to your first draft")}${field(5)}<details id="final-comparison"><summary>Compare with a worked record</summary>${data.comparison}</details>${finalReview()}${selfCheck(
        state().finalChecked,
        state().final.every((v) => v.trim()),
        true,
      )}${renderContribution(state().contribution)}`,
    ),
  ];
  return {
    source: data.source,
    title: "Put it all together",
    intro: `<p>Make one useful piece of work you can explain from source to revision. Move between the steps whenever you need.</p>`,
    body: `<nav class="stages final-stages" aria-label="Final practice steps">${finalStages.map((label, i) => `<button data-final-step="${i}" aria-label="${label}" ${i === state().finalStep ? 'aria-current="step"' : ""}><span aria-hidden="true">${i + 1}</span>${label}</button>`).join("")}</nav><section class="lesson-body" tabindex="-1" aria-label="Final practice">${panels.join("")}</section><div class="next-row"><button class="secondary" id="back">${state().finalStep === 0 ? "Back to lesson 6" : "Back"}</button>${state().finalStep < 3 ? `<button class="primary" id="next">${finalStages[state().finalStep + 1]} ${icon("arrow")}</button>` : '<button class="primary" id="download-final">Download my learning record</button>'}</div>`,
  };
}

function routePicker() {
  return `<div class="route-picker" role="group" aria-label="Choose your example route"><span>Your examples</span>${Object.entries(
    routes,
  )
    .map(
      ([id, title]) =>
        `<button data-route="${id}" aria-pressed="${id === route}">${title}</button>`,
    )
    .join("")}</div>`;
}

function saveBar() {
  return `<footer class="save-bar"><div><strong>Your practice notebook</strong><p id="save-status" role="status">${escape(session().message)}</p><small>Saved only in this browser, at this address. Use invented information.</small></div><div class="save-actions"><button class="secondary" id="download">Download my work</button><button class="primary" id="save" ${session().blocked ? "disabled" : ""}>Save in this browser</button>${session().blocked ? '<button class="secondary" id="download-stored">Download stored copy</button>' : ""}</div></footer>${earlierNotebooks()}`;
}

function focusTarget(selector, scroll) {
  const target = document.querySelector(selector);
  if (!target) return;
  if (!target.matches("button, a, input, select, textarea, [tabindex]"))
    target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  if (scroll) target.scrollIntoView({ block: "start" });
}

function render(scroll = false, focus = null) {
  const current = state();
  const view = session().view;
  const isLesson = view === "lesson";
  const content = isLesson
    ? current.lesson === 6
      ? finalContent()
      : lessonContent()
    : view === "practice"
      ? practiceContent()
      : view === "work"
        ? workContent()
        : learnContent();
  const menuOpen =
    session().courseMenuOpen ?? !matchMedia("(max-width: 720px)").matches;
  const activeNav = isLesson ? "learn" : view;
  const navigation = [
    ["learn", "Learn"],
    ["practice", "Practice"],
    ["work", "My work"],
  ]
    .map(
      ([id, label]) =>
        `<button data-view="${id}" ${activeNav === id ? 'aria-current="page"' : ""}>${icon(id)}<span>${label}</span></button>`,
    )
    .join("");
  const step = current.lesson === 6 ? current.finalStep : current.step;
  const toolbar = isLesson
    ? `<div class="lesson-toolbar"><button class="text-button" data-view="learn" aria-label="Back to learning path">${icon("back")} Learning path</button><button class="text-button" data-source>${icon("source")} Check the source</button><div class="session-progress"><span>${current.lesson === 6 ? "Case" : `Lesson ${current.lesson + 1}`} · Step ${step + 1} of 4</span><progress value="${step + 1}" max="4" aria-label="Current lesson step"></progress></div></div>`
    : "";
  const intro = isLesson
    ? current.lesson === 6
      ? `<div class="case-banner">${icon("case")}<span>Applied case · ${routes[route]}</span></div><div class="lesson-intro">${content.intro}</div>`
      : `<p class="lesson-lead">${lessonOutcomes[current.lesson]}</p><details class="lesson-intro"><summary>About this lesson</summary>${content.intro}</details>`
    : `<p class="view-intro">${content.intro}</p>`;
  const workArea = isLesson
    ? `<div class="workspace ${current.lesson === 6 ? "final-workspace" : ""}"><article>${content.body}</article><aside class="reference">${current.lesson === 6 ? '<details id="final-source-reminder" class="source-card"><summary>Source reminder</summary>' : '<div class="source-card">'}<p class="source-label eyebrow">${icon("source")}${content.sourceLabel ?? "Your source"} · ${routes[route]}</p><p id="source-text">${escape(content.source)}</p><p class="source-note">${content.sourceNote ?? "Compare each claim with these notes. Keep unknown details open."}</p>${current.lesson === 6 ? "</details>" : "</div>"}<button class="text-button source-return" data-return-exercise>Back to exercise ${icon("back")}</button>${earlierNotes()}<a class="extra-link" href="../prototype/" target="_blank" rel="noopener">Open the request/check walkthrough ${icon("arrow")}</a></aside></div>`
    : content.body;
  root.innerHTML = `<div class="studio ${isLesson ? "is-lesson" : "is-overview"}"><aside class="sidebar"><a href="#learn" data-view="learn" class="brand" aria-label="Deep Native home"><span class="brand-icon">dn</span>Deep Native</a><nav class="main-nav" aria-label="Main navigation">${navigation}</nav><details class="course-nav" id="course-menu" ${menuOpen ? "open" : ""}><summary>Course contents</summary><nav id="course-path" aria-label="Course path">${outline()}</nav></details><div class="sidebar-foot"><strong>AI foundations</strong><p>Real decisions.<br>Useful practice.</p><span class="local-note">Save your work on this device.</span></div></aside><main><header class="topbar"><span>AI foundations</span><div class="topbar-save"><div class="topbar-save-copy"><span class="save-indicator" id="save-indicator">Browser notebook</span><span class="save-location" id="save-location">Only in this browser</span></div>${isLesson ? `<button class="primary compact-save" id="save-compact" type="button" aria-describedby="save-location save-indicator" ${session().blocked ? "disabled" : ""}>Save notebook</button>` : ""}</div></header>${routePicker()}${toolbar}<div class="page-heading"><h1 id="page-title" tabindex="-1">${escape(content.title)}</h1>${intro}</div>${workArea}${saveBar()}</main></div>`;
  bind();
  updateStatus();
  if (focus) focusTarget(focus, false);
  else if (scroll) focusTarget("#page-title", false);
  if (scroll) {
    if (isLesson)
      document
        .querySelector(".lesson-toolbar")
        .scrollIntoView({ block: "start" });
    else window.scrollTo({ top: 0, left: 0 });
  }
}

function navigate(lesson, step = 0) {
  session().view = "lesson";
  if (matchMedia("(max-width: 720px)").matches)
    session().courseMenuOpen = false;
  if (lesson === 6) state().reviewCriterion = null;
  state().lesson = lesson;
  state().step = step;
  changed();
  render(true, ".lesson-body");
}

function navigateFinal(step) {
  session().view = "lesson";
  state().finalStep = step;
  changed();
  render(true, ".final-panel:not([hidden])");
}

function showView(view) {
  session().view = view;
  if (matchMedia("(max-width: 720px)").matches)
    session().courseMenuOpen = false;
  render(true, "#page-title");
}

function bind() {
  document.querySelectorAll("[data-view]").forEach((button) =>
    button.addEventListener("click", (event) => {
      event.preventDefault();
      showView(button.dataset.view);
    }),
  );
  document.querySelector("[data-continue]")?.addEventListener("click", () => {
    session().view = "lesson";
    render(true, ".lesson-body");
  });
  document
    .querySelectorAll("[data-open-lesson]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        navigate(Number(button.dataset.openLesson)),
      ),
    );
  document
    .querySelectorAll("[data-review-lesson]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        navigate(Number(button.dataset.reviewLesson), 1),
      ),
    );
  document
    .querySelectorAll("[data-write-lesson]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        navigate(
          Number(button.dataset.writeLesson),
          Number(button.dataset.writeStep),
        ),
      ),
    );
  document
    .querySelectorAll("[data-open-final]")
    .forEach((button) => button.addEventListener("click", () => navigate(6)));
  document
    .querySelector("[data-open-contribution]")
    ?.addEventListener("click", () => {
      state().finalStep = 3;
      navigate(6);
      document.querySelector("#contribution-panel").open = true;
      focusTarget("#contribution-panel > summary", true);
    });
  document
    .querySelector("#course-menu")
    ?.addEventListener("toggle", (event) => {
      if (event.target.isConnected)
        session().courseMenuOpen = event.target.open;
    });
  document
    .querySelector("#notebook")
    ?.addEventListener("toggle", refreshNotebook);
  document.querySelector("[data-source]")?.addEventListener("click", () => {
    const reminder = document.querySelector("#final-source-reminder");
    if (reminder) reminder.open = true;
    focusTarget("#source-text", true);
  });
  document
    .querySelector("[data-return-exercise]")
    ?.addEventListener("click", () =>
      focusTarget(
        state().lesson === 6 ? ".final-panel:not([hidden])" : ".lesson-body",
        true,
      ),
    );
  document.querySelectorAll("[data-review-criterion]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.reviewCriterion);
      state().reviewCriterion = index;
      navigate(course.reviewGuidance.routes[route].rows[index].lesson - 1, 1);
    });
  });
  document.querySelector("#return-final")?.addEventListener("click", () => {
    const index = state().reviewCriterion;
    state().finalStep = 3;
    navigate(6);
    const criterion = document.querySelector(`#review-criterion-${index}`);
    criterion?.focus();
    criterion?.scrollIntoView({ block: "center" });
  });
  if (session().view === "lesson" && state().lesson === 6)
    bindContribution(state().contribution, changed);
  document
    .querySelector("#feedback-choice")
    ?.addEventListener("change", (event) => {
      state().feedback.draft.decision = event.target.value;
      state().lessons[5].selfChecked = false;
      session().feedbackNotice =
        "This response is still a draft. Add a reason before recording it.";
      changed();
      render(false, "#feedback-choice");
    });
  document.querySelectorAll("[data-feedback-field]").forEach((input) =>
    input.addEventListener("input", () => {
      state().feedback.draft[input.dataset.feedbackField] = input.value;
      state().lessons[5].selfChecked = false;
      const comparison = document.querySelector("#feedback-proposed");
      if (comparison) comparison.textContent = state().feedback.draft.text;
      changed();
    }),
  );
  document
    .querySelector("#feedback-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const error = addFeedbackDecision(route, state().feedback);
      if (error) {
        document.querySelector("#feedback-notice").textContent = error;
        return;
      }
      state().lessons[5].selfChecked = false;
      session().feedbackNotice =
        "Decision added to this notebook. Save in this browser to retain it after reload. No question was sent.";
      changed();
      render(false, "#feedback-notice");
    });
  document.querySelectorAll("[data-route]").forEach((button) =>
    button.addEventListener("click", () => {
      const view = session().view;
      route = button.dataset.route;
      session().view = view;
      history.replaceState(null, "", `#route=${route}`);
      render(false, `[data-route="${route}"]`);
    }),
  );
  document.querySelector("#course-path").addEventListener("click", (event) => {
    const button = event.target.closest("[data-lesson]");
    if (button) navigate(Number(button.dataset.lesson));
  });
  document.querySelectorAll("a[href^='#lesson=']").forEach((link) =>
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigate(Number(link.getAttribute("href").split("=")[1]) - 1);
    }),
  );
  document
    .querySelectorAll("[data-step]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        navigate(state().lesson, Number(button.dataset.step)),
      ),
    );
  document
    .querySelectorAll("[data-final-step]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        navigateFinal(Number(button.dataset.finalStep)),
      ),
    );
  document
    .querySelector("#next")
    ?.addEventListener("click", () =>
      state().lesson === 6
        ? navigateFinal(state().finalStep + 1)
        : state().step < 3
          ? navigate(state().lesson, state().step + 1)
          : navigate(state().lesson + 1),
    );
  document
    .querySelector("#back")
    ?.addEventListener("click", () =>
      state().lesson === 6
        ? state().finalStep > 0
          ? navigateFinal(state().finalStep - 1)
          : navigate(5, 3)
        : state().step > 0
          ? navigate(state().lesson, state().step - 1)
          : navigate(state().lesson - 1, 3),
    );
  document.querySelectorAll("[data-question]").forEach((input) =>
    input.addEventListener("change", () => {
      item().selections[Number(input.dataset.question)] = input.value;
      item().checked = false;
      document
        .querySelectorAll(".answer-feedback")
        .forEach((n) => (n.hidden = true));
      document
        .querySelectorAll(".choice")
        .forEach((n) => n.classList.remove("correct", "reconsider"));
      document.querySelector("#practice-guidance").textContent =
        practiceGuidance(course.lessons[state().lesson].routes[route].practice);
      changed();
    }),
  );
  document
    .querySelector("#practice-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const questions =
        course.lessons[state().lesson].routes[route].practice.questions;
      if (questions.some((_, n) => !item().selections[n])) {
        document.querySelector("#practice-notice").textContent =
          "Choose a response for each question first.";
        focusTarget("#practice-notice", true);
        return;
      }
      item().checked = true;
      changed();
      render(false, ".answer-feedback");
      document
        .querySelector(".answer-feedback")
        .scrollIntoView({ block: "nearest" });
    });
  document.querySelector("#hint")?.addEventListener("toggle", (event) => {
    if (!event.target.isConnected) return;
    if (item().hint !== event.target.open) {
      item().hint = event.target.open;
      changed();
    }
  });
  document.querySelectorAll("[data-writing]").forEach((input) =>
    input.addEventListener("input", () => {
      if (input.dataset.writing === "final") {
        state().final[Number(input.dataset.index)] = input.value;
        state().finalChecked = false;
      } else {
        item()[input.dataset.writing] = input.value;
        item().selfChecked = false;
      }
      const check = document.querySelector("#self-check");
      if (check) {
        check.checked = false;
        check.disabled =
          state().lesson === 6
            ? !state().final.every((v) => v.trim())
            : !item().work.trim();
      }
      changed();
      refreshNotebook();
    }),
  );
  document.querySelector("#self-check")?.addEventListener("change", (event) => {
    if (state().lesson === 6) state().finalChecked = event.target.checked;
    else item().selfChecked = event.target.checked;
    changed();
  });
  document.querySelector("#save").addEventListener("click", save);
  document.querySelector("#save-compact")?.addEventListener("click", save);
  document
    .querySelector("#download")
    .addEventListener("click", () =>
      download(exportText(), `foundation-${route}.txt`),
    );
  document
    .querySelector("#download-final")
    ?.addEventListener("click", () =>
      download(exportText(), `foundation-${route}.txt`),
    );
  document
    .querySelector("#download-stored")
    ?.addEventListener("click", () =>
      download(session().raw, `foundation-${route}-stored.txt`),
    );
  document.querySelector("#download-earlier")?.addEventListener("click", () => {
    const index = Number(document.querySelector("#earlier-record").value);
    download(
      session().earlier[index].raw,
      `foundation-${route}-earlier-${index + 1}.txt`,
    );
  });
}

function save() {
  if (session().blocked) return;
  try {
    const value = JSON.stringify({
      version: 1,
      contentHash: course.contentHash,
      route,
      state: state(),
      savedAt: new Date().toISOString(),
    });
    localStorage.setItem(key(route), value);
    session().raw = value;
    session().dirty = false;
    session().saveFailed = false;
    session().savedWriting = writingSnapshot(state());
    session().message =
      "Saved in this browser. Your position and writing will return here; no member account was updated.";
  } catch {
    session().saveFailed = true;
    session().message =
      "Saving failed. Your writing is still here. Download your work to keep a copy, or try saving again.";
  }
  updateStatus();
}

function exportText() {
  const lines = [
    `Deep Native foundation practice — ${routes[route]}`,
    `Content version: ${course.contentHash}`,
    "Local practice writing; no automatic grade or independent review.",
  ];
  course.lessons.forEach((lesson, i) => {
    const notes = state().lessons[i];
    const data = lesson.routes[route];
    lines.push(
      `\n${i + 1}. ${lesson.title}`,
      `Worked source: ${data.source}`,
      `Fresh-case source and task: ${plain(data.transfer)}`,
      `Fresh-case attempt: ${notes.transfer}`,
      `Your work: ${notes.work}`,
      `Self-checked by learner: ${notes.selfChecked ? "yes" : "no"}`,
    );
    data.practice.questions.forEach((q, n) =>
      lines.push(
        `Practice: ${q.prompt} — response: ${notes.selections[n] ?? "not answered"}; explanation checked: ${notes.checked ? "yes" : "no"}`,
      ),
    );
  });
  lines.push(exportFeedback(route, state().feedback));
  if (state().reviewCriterion !== null)
    lines.push(
      `Revisiting for final practice: ${course.reviewGuidance.routes[route].rows[state().reviewCriterion].criterion}. The first draft and revision remain below.`,
    );
  lines.push(
    "\nFinal practice",
    `Final practice step: ${finalStages[state().finalStep]}`,
    `Source: ${course.capstone[route].source}`,
  );
  if (course.capstone[route].sourcePacket)
    lines.push(
      `Complete source packet: ${plain(course.capstone[route].sourcePacket)}`,
    );
  finalLabels.forEach((label, i) =>
    lines.push(`${label}: ${state().final[i]}`),
  );
  lines.push(
    `Final record self-checked by learner: ${state().finalChecked ? "yes" : "no"}`,
  );
  lines.push(exportContribution(state().contribution, plain));
  return lines.join("\n\n");
}

function plain(html) {
  const node = document.createElement("div");
  node.innerHTML = html.replace(/<\/(?:p|td|th|tr|li|h\d)>/g, "\n$&");
  return node.textContent.trim();
}

function download(text, filename) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

window.addEventListener("beforeunload", (event) => {
  if (
    [...sessions.values()].some(
      (s) => writingSnapshot(s.state) !== s.savedWriting,
    )
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
});
render();
