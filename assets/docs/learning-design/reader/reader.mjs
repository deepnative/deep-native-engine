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
    dirty: false,
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
        session.state.finalStep ??= 0;
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
  const save = document.querySelector("#save");
  if (save) save.disabled = session().blocked;
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
      return `<button class="lesson-link ${current ? "current" : ""}" data-lesson="${i}" aria-label="${i < 6 ? `Lesson ${i + 1}: ` : ""}${escape(title)}" ${current ? 'aria-current="step"' : ""}><span class="lesson-number">${i < 6 ? String(i + 1).padStart(2, "0") : "↗"}</span><span><strong>${escape(title)}</strong><small>${caption}</small></span></button>`;
    })
    .join("");
}

function renderOutline() {
  const node = document.querySelector("#course-path");
  if (node) node.innerHTML = outline();
}

function textarea(label, value, kind, index = "") {
  const id = `writing-${kind}${index}`;
  return `<label class="writing-label" for="${id}">${escape(label)}</label><textarea id="${id}" data-writing="${kind}" data-index="${index}" maxlength="30000" rows="6" placeholder="Use the invented source. Write what you can explain.">${escape(value)}</textarea>`;
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
      return `<fieldset><legend>${escape(q.prompt)}</legend>${q.choices.map((c) => `<label class="choice ${current.checked && chosen === c.key ? (correct ? "correct" : "reconsider") : ""}"><input type="radio" name="q-${n}" data-question="${n}" value="${escape(c.key)}" ${chosen === c.key ? "checked" : ""}><span>${c.key.length === 1 ? `<b>${c.key}</b> ` : ""}${escape(c.label)}</span></label>`).join("")}<div class="answer-feedback ${correct ? "positive" : ""}" ${current.checked ? "" : "hidden"}><strong>${correct ? "This response matches the source." : "Try another choice after comparing with the source."}</strong><p>You chose ${escape(chosen ?? "no response")}.</p>${q.feedback}</div></fieldset>`;
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

function earlierNotes() {
  const notes = state()
    .lessons.map((l, n) => {
      const decisions = n === 5 ? feedbackHistory(state().feedback) : "";
      if (!l.work.trim() && !l.transfer.trim() && !decisions) return "";
      return `<section><h3>${n + 1}. ${escape(course.lessons[n].title)}</h3>${l.transfer.trim() ? `<p class="eyebrow">Fresh-case attempt</p><pre>${escape(l.transfer)}</pre>` : ""}${l.work.trim() ? `<p class="eyebrow">Your work</p><pre>${escape(l.work)}</pre>` : ""}${decisions}</section>`;
    })
    .join("");
  return `<details class="notebook" id="notebook"><summary>Your earlier notes</summary>${notes || "<p>Your notes will appear here as you write. You can revisit any lesson.</p>"}</details>`;
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
  if (state().step === 0) body = data.example;
  if (state().step === 1) body = practice(data.practice);
  if (state().step === 2)
    body = `${data.transfer}${state().lesson === 5 ? renderFeedback(route, state().feedback, session().feedbackNotice) : ""}${textarea("Your fresh-case attempt", current.transfer, "transfer")}${data.comparison}<p class="quiet">Compare the reasoning, not the exact wording. The example is supplied teaching material.</p>`;
  if (state().step === 3)
    body = `${data.own}${textarea("Your lesson work", current.work, "work")}${selfCheck(current.selfChecked, Boolean(current.work.trim()))}`;
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
    body: `<nav class="stages" aria-label="Lesson stages">${stages.map((label, i) => `<button data-step="${i}" ${i === state().step ? 'aria-current="step"' : ""}><span>${i + 1}</span>${label}</button>`).join("")}</nav><section class="lesson-body" aria-label="${stages[state().step]}">${body}</section><div class="next-row"><button class="secondary" id="back" ${state().lesson === 0 && state().step === 0 ? "disabled" : ""}>Back</button><button class="primary" id="next">${next} <span aria-hidden="true">→</span></button></div>`,
  };
}

function finalContent() {
  const data = course.capstone[route];
  const flow = data.practiceFlow;
  const panel = (index, body) =>
    `<div class="final-panel" data-final-panel="${index}" ${state().finalStep === index ? "" : "hidden"}>${body}</div>`;
  const draft = (id, label) =>
    `<details id="${id}"><summary>${label}</summary><pre>${escape(state().final[2] || "Your first draft will appear here after you write it in step 2.")}</pre></details>`;
  const field = (n) =>
    textarea(`${n + 1}. ${finalLabels[n]}`, state().final[n], "final", n);
  const panels = [
    panel(
      0,
      `<h2>${escape(flow.title)}</h2>${flow.introduction}${flow.sources}`,
    ),
    panel(
      1,
      `<h2>Make a useful first draft.</h2><p>Write your plan from the brief. Keep the first version so you can explain what changes later.</p><details><summary>What to include in your first pass</summary>${flow.task}</details>${field(0)}${field(1)}<div class="teaching-sample"><p class="eyebrow">Deliberately flawed teaching sample</p><p>${escape(data.sample)}</p><small>This was supplied for practice; it was not generated from your request.</small></div>${[2, 3, 4].map(field).join("")}`,
    ),
    panel(
      2,
      `<h2>${escape(flow.updateTitle)}</h2>${flow.update}${draft("retained-draft-update", "Your retained first draft")}`,
    ),
    panel(
      3,
      `<h2>Explain what changed and why.</h2><p>Keep your first draft. Write the revision here, including what stays the same and any questions you still need to resolve.</p>${draft("retained-draft-revision", "Refer to your first draft")}${field(5)}<details id="final-comparison"><summary>Compare with a worked record</summary>${data.comparison}</details>${data.criteria}${selfCheck(
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
    body: `<nav class="stages" aria-label="Final practice steps">${finalStages.map((label, i) => `<button data-final-step="${i}" aria-label="${label}" ${i === state().finalStep ? 'aria-current="step"' : ""}><span aria-hidden="true">${i + 1}</span>${label}</button>`).join("")}</nav><section class="lesson-body">${panels.join("")}</section><div class="next-row"><button class="secondary" id="back">${state().finalStep === 0 ? "Back to lesson 6" : "Back"}</button>${state().finalStep < 3 ? `<button class="primary" id="next">${finalStages[state().finalStep + 1]} <span aria-hidden="true">→</span></button>` : '<button class="primary" id="download-final">Download my learning record</button>'}</div>`,
  };
}

function render(scroll = false) {
  const current = state();
  const content = current.lesson === 6 ? finalContent() : lessonContent();
  root.innerHTML = `<div class="studio"><aside class="sidebar"><a href="#lesson=1" class="brand"><span class="brand-icon">dn</span>Deep Native</a><div class="course-heading"><p class="eyebrow">Foundations</p><h2>AI, put to<br>practice.</h2><p>Build something useful.<br>Learn how to check it.</p></div><nav id="course-path" aria-label="Course path">${outline()}</nav><div class="sidebar-foot"><span class="dot"></span>Local learning studio<p>Original invented examples.<br>No AI account needed.</p></div></aside><main><header class="topbar"><span>LEARN / FOUNDATIONS</span><span class="draft-badge">Practice edition</span></header><div class="page-heading"><p class="eyebrow">${current.lesson < 6 ? `Lesson ${String(current.lesson + 1).padStart(2, "0")} of 06` : "Final practice"}</p><h1>${escape(content.title)}</h1><div class="lesson-intro">${content.intro}</div></div><div class="route-picker" role="group" aria-label="Choose your example route"><span>Your examples</span>${Object.entries(
    routes,
  )
    .map(
      ([id, title]) =>
        `<button data-route="${id}" aria-pressed="${id === route}">${title}</button>`,
    )
    .join(
      "",
    )}</div><div class="workspace ${current.lesson === 6 ? "final-workspace" : ""}"><article>${content.body}</article><aside class="reference">${current.lesson === 6 ? '<details id="final-source-reminder" class="source-card"><summary>Source reminder</summary>' : '<div class="source-card">'}<p class="eyebrow">${content.sourceLabel ?? "Your source"} · ${routes[route]}</p><h2>Keep the facts close.</h2><p id="source-text">${escape(content.source)}</p><p class="source-note">${content.sourceNote ?? "Compare each claim with these notes. Keep unknown details open."}</p>${current.lesson === 6 ? "</details>" : "</div>"}${earlierNotes()}<a class="extra-link" href="../prototype/" target="_blank" rel="noopener">Open the request/check walkthrough <span aria-hidden="true">↗</span></a></aside></div><footer class="save-bar"><div><strong>Your practice notebook</strong><p id="save-status" role="status">${escape(session().message)}</p><small>Saved only in this browser, at this address. Use invented information.</small></div><div class="save-actions"><button class="secondary" id="download">Download my work</button><button class="primary" id="save" ${session().blocked ? "disabled" : ""}>Save in this browser</button>${session().blocked ? '<button class="secondary" id="download-stored">Download stored copy</button>' : ""}</div></footer>${earlierNotebooks()}</main></div>`;
  bind();
  if (scroll) document.querySelector("h1").scrollIntoView({ block: "start" });
}

function navigate(lesson, step = 0) {
  state().lesson = lesson;
  state().step = step;
  changed();
  render(true);
}

function navigateFinal(step) {
  state().finalStep = step;
  changed();
  render(true);
}

function bind() {
  if (state().lesson === 6) bindContribution(state().contribution, changed);
  document
    .querySelector("#feedback-choice")
    ?.addEventListener("change", (event) => {
      state().feedback.draft.decision = event.target.value;
      state().lessons[5].selfChecked = false;
      session().feedbackNotice =
        "This response is still a draft. Add a reason before recording it.";
      changed();
      render();
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
      render();
    });
  document.querySelectorAll("[data-route]").forEach((button) =>
    button.addEventListener("click", () => {
      route = button.dataset.route;
      history.replaceState(null, "", `#route=${route}`);
      render();
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
        return;
      }
      item().checked = true;
      changed();
      render();
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
      const notebook = document.querySelector("#notebook");
      const open = notebook.open;
      notebook.outerHTML = earlierNotes();
      document.querySelector("#notebook").open = open;
    }),
  );
  document.querySelector("#self-check")?.addEventListener("change", (event) => {
    if (state().lesson === 6) state().finalChecked = event.target.checked;
    else item().selfChecked = event.target.checked;
    changed();
  });
  document.querySelector("#save").addEventListener("click", save);
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
    session().savedWriting = writingSnapshot(state());
    session().message =
      "Saved in this browser. Your position and writing will return here; no member account was updated.";
  } catch {
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
