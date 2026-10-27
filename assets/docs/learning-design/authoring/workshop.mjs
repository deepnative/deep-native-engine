import { cases, fixtureVersion } from "./cases.mjs";

const app = document.querySelector("#app");
const drafts = new Map();
const prefix = "dne-content-workshop-1:";
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let active = Object.hasOwn(cases, location.hash.slice(1))
  ? location.hash.slice(1)
  : "budget";
const current = () => drafts.get(active);
const seed = () => cases[active];
const emptyRecord = (id) => ({
  version: 1,
  fixtureVersion,
  caseId: id,
  revisions: [],
});

function validFields(id, fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    return false;
  const definitions = cases[id].fields;
  return (
    Object.keys(fields).length === definitions.length &&
    definitions.every(
      (f) =>
        typeof fields[f.key] === "string" &&
        fields[f.key].length <= 20000 &&
        (!f.options || f.options.includes(fields[f.key])),
    )
  );
}
function parseRecord(id, raw) {
  if (raw === null) return emptyRecord(id);
  const record = JSON.parse(raw);
  if (
    record.version !== 1 ||
    record.fixtureVersion !== fixtureVersion ||
    record.caseId !== id ||
    !Array.isArray(record.revisions)
  )
    throw new Error("Unsupported record");
  record.revisions.forEach((r, i) => {
    if (
      r.id !== i + 2 ||
      !validFields(id, r.fields) ||
      typeof r.reason !== "string" ||
      r.reason.length > 20000 ||
      r.reviewedBy !== "Author self-check" ||
      typeof r.savedAt !== "string" ||
      !Number.isFinite(Date.parse(r.savedAt))
    )
      throw new Error("Unreadable revision");
  });
  return record;
}
function latest(state, id = active) {
  return (
    state.record.revisions.at(-1) ?? {
      id: 1,
      fields: cases[id].original,
      reason: "",
      reviewedBy: null,
    }
  );
}
function dirty(state, id) {
  const base = latest(state, id);
  return !same(state.fields, base.fields) || state.reason !== base.reason;
}
function load(id) {
  if (drafts.has(id)) return;
  const state = {
    record: emptyRecord(id),
    raw: null,
    blocked: false,
    incoming: null,
    preview: null,
    checked: false,
    selfChecked: false,
    reason: "",
    message:
      "Working from the original practice draft. Nothing has been saved.",
    checkMessage:
      "Preview your changes, inspect the source and explain your revision.",
  };
  try {
    state.raw = localStorage.getItem(prefix + id);
    state.record = parseRecord(id, state.raw);
    const last = latest(state, id);
    state.fields = structuredClone(last.fields);
    state.reason = last.reason;
    state.selfChecked = Boolean(last.reviewedBy);
    if (last.id > 1)
      state.message = `Restored local revision ${last.id}. No course or member account was changed.`;
  } catch {
    state.blocked = true;
    state.message =
      "Stored copy is protected because it could not be read or belongs to another exercise version. Download it and your separate draft; this workshop will not overwrite it.";
  }
  state.fields ??= structuredClone(cases[id].original);
  drafts.set(id, state);
}
function fieldList(fields) {
  return seed()
    .fields.map(
      (f) =>
        `<div class="field-value"><dt>${escape(f.label)}</dt><dd>${escape(fields[f.key])}</dd></div>`,
    )
    .join("");
}
function editorField(f) {
  const value = current().fields[f.key];
  const input = f.options
    ? `<select id="edit-${f.key}" data-field="${f.key}">${f.options.map((option) => `<option${value === option ? " selected" : ""}>${escape(option)}</option>`).join("")}</select>`
    : `<textarea id="edit-${f.key}" data-field="${f.key}" rows="4" maxlength="20000">${escape(value)}</textarea>`;
  return `<div class="editor-field"><label for="edit-${f.key}">${escape(f.label)}</label>${input}</div>`;
}
function render() {
  load(active);
  const data = seed(),
    state = current();
  app.innerHTML = `<header><a class="brand" href="../reader/"><span>dn</span> Deep Native</a><a href="../reader/">Open the learning reader ↗</a></header>
    <main><div class="intro"><p class="eyebrow">CONTENT WORKSHOP · LOCAL PRACTICE</p><h1>Make the next draft better.</h1><p class="lead">Find the teaching problem. Make a concrete correction. Try what the learner will see.</p></div>
    <nav aria-label="Editorial cases">${Object.entries(cases)
      .map(
        ([id, c]) =>
          `<button type="button" data-case="${id}" aria-pressed="${id === active}">${escape(c.title)}</button>`,
      )
      .join("")}</nav>
    <p class="scope">These are deliberately flawed practice versions of original invented material. The current lessons already contain the corrections. Your workshop revisions stay in this browser; they do not publish or edit the course.</p>
    <div class="context-grid"><section class="source-card"><p class="eyebrow">01 · READ THE SOURCE</p><h2>${escape(data.title)}</h2><p class="reference">${escape(data.lesson)}</p><blockquote id="source">${escape(data.source)}</blockquote><h3>Question to refine</h3><p>${escape(data.question)}</p><h3>Fresh source</h3><p id="fresh-source">${escape(data.freshSource)}</p>${data.freshQuestion ? `<h3>Fresh question</h3><p>${escape(data.freshQuestion)}</p>` : ""}</section>
    <section class="critique-card"><p class="eyebrow">THE CHANGE TO MAKE</p><h2>${escape(data.focus)}</h2><p id="critique">${escape(data.critique)}</p><p class="note">Supplied practice critique · author self-review, not an independent review.</p><details><summary>Original practice draft · v1</summary><dl id="original">${fieldList(data.original)}</dl></details></section></div>
    <div class="editing-grid"><section class="panel"><p class="eyebrow">02 · REVISE THE DRAFT</p><h2>Make the change explainable.</h2><p id="base-label">Based on revision ${latest(state).id}. The original source stays fixed for this exercise.</p><form id="editor">${data.fields.map(editorField).join("")}<label for="reason">Why this revision?</label><textarea id="reason" rows="3" maxlength="20000">${escape(state.reason)}</textarea><p class="note">Name the affected question and connect your change to the critique or source.</p></form><button class="primary" id="preview-button">Preview this draft</button></section>
    <section class="panel preview-panel"><p class="eyebrow">03 · TRY IT AS A LEARNER</p><h2>Does the correction help?</h2><div id="preview"></div></section></div>
    <section class="panel"><p class="eyebrow">COMPARE THE WORDING</p><h2>Before and after.</h2><div id="comparison"></div></section>
    <section class="save-panel"><div><p class="eyebrow">04 · KEEP THE REVISION</p><h2>Save the change and its reason.</h2><p>${escape(data.review)}</p><label class="check-label"><input id="self-check" type="checkbox"${state.selfChecked ? " checked" : ""}/>I checked this draft against the source and critique</label><div class="actions"><button id="check-button">Check this draft</button><button class="primary" id="save-button" disabled>Save local revision</button><button id="download-button">Download draft and history</button></div><p id="check-status" role="status"></p><p id="save-status" role="status"></p><div id="recovery"></div><div id="incoming"></div></div></section>
    <section class="panel"><h2>Revision history</h2><p class="note">Saved revisions retain their wording, reason and author self-check. Previewing or correcting a draft does not create a new independent review.</p><div id="history"></div></section>
    <footer>Original invented examples · Browser-local workshop · No AI provider or member data</footer></main>`;
  renderComparison();
  renderPreview();
  renderHistory();
  status();
}
function renderComparison() {
  const data = seed(),
    state = current();
  document.querySelector("#comparison").innerHTML =
    `<div class="comparison-head"><span>Original practice v1</span><span>Working draft</span></div>${data.fields.map((f) => `<div class="comparison-row"><h3>${escape(f.label)}</h3><p>${escape(data.original[f.key])}</p><p class="${data.original[f.key] !== state.fields[f.key] ? "changed" : ""}">${escape(state.fields[f.key])}</p></div>`).join("")}`;
}
function previewQuestion(name, question, options, kind) {
  return `<fieldset><legend>${name}</legend><p>${escape(question)}</p>${options.map(({ value, label }) => `<label class="choice"><input type="radio" name="${kind}" value="${escape(value)}"/>${escape(label)}</label>`).join("")}<button type="button" data-answer="${kind}">Check ${kind} answer</button><p id="${kind}-feedback" class="feedback" role="status"></p></fieldset>`;
}
function renderPreview() {
  const state = current(),
    data = seed(),
    target = document.querySelector("#preview");
  if (!state.preview) {
    target.innerHTML =
      '<p class="placeholder">Use Preview this draft to try your wording and answer feedback.</p>';
    return;
  }
  const p = state.preview,
    f = p.fields;
  if (p.signature !== signature()) {
    target.innerHTML =
      '<p class="notice">Preview out of date. Preview the edited draft before checking it again.</p>';
    return;
  }
  const options =
    active === "budget"
      ? ["Supported", "Contradicted", "Not given"].map((x) => ({
          value: x,
          label: x,
        }))
      : [
          {
            value: "A",
            label:
              "A. Use the library as the venue because it sounds suitable.",
          },
          {
            value: "B",
            label: "B. Make the plan enthusiastic and hide uncertainty.",
          },
          { value: "C", label: `C. ${f.choice}` },
        ];
  target.innerHTML = `<p class="note">Working-draft preview · feedback follows this draft's key. It is not an independent assessment of the wording.</p>${f.request ? `<h3>Worked request</h3><p class="preview-text">${escape(f.request)}</p>` : ""}${previewQuestion("Try the question", data.question, options, "main")}<details><summary>Inspect the answer explanation</summary><p>${escape(f.feedback)}</p></details><h3>Fresh-case preview</h3><p>${escape(data.freshSource)}</p>${active === "budget" ? previewQuestion("Try the fresh question", data.freshQuestion, options, "fresh") + `<details><summary>Inspect the fresh explanation</summary><p>${escape(f.freshFeedback)}</p></details>` : `<p class="preview-text">${escape(f.freshRequest)}</p><p class="note">This worked request is supplied guidance. Different wording can meet the same criteria.</p>`}`;
}
function renderHistory() {
  document.querySelector("#history").innerHTML = current().record.revisions
    .length
    ? current()
        .record.revisions.map(
          (r) =>
            `<details><summary>Revision ${r.id} · ${escape(r.savedAt)}</summary><p><strong>Reason:</strong> ${escape(r.reason)}</p><p class="note">${escape(r.reviewedBy)} · no independent review claimed</p><dl>${fieldList(r.fields)}</dl></details>`,
        )
        .join("")
    : "<p>No saved revisions yet. The original practice draft is retained above.</p>";
}
function status() {
  const s = current();
  document.querySelector("#check-status").textContent = s.checkMessage;
  document.querySelector("#save-status").textContent = s.message;
  document.querySelector("#save-button").disabled = !s.checked || s.blocked;
  document.querySelector("#self-check").checked = s.selfChecked;
  document.querySelector("#recovery").innerHTML =
    `${s.blocked && s.raw !== null ? '<button id="download-stored">Download stored copy</button>' : ""}${s.conflict ? '<button id="compare-latest">Compare latest saved</button>' : ""}`;
}
function signature() {
  return JSON.stringify({ fields: current().fields, reason: current().reason });
}
function invalidate() {
  const s = current();
  s.checked = false;
  s.selfChecked = false;
  s.checkMessage = "Edited draft: preview and check this wording again.";
  s.message = s.blocked
    ? s.message
    : "Unsaved changes. Keep a local revision or download your draft.";
  renderComparison();
  renderPreview();
  status();
}
function problems() {
  const s = current(),
    errors = [];
  if (seed().fields.some((f) => !s.fields[f.key].trim()))
    errors.push("Complete the draft fields.");
  if (
    active === "budget" &&
    (s.fields.answer !== "Not given" || s.fields.freshAnswer !== "Not given")
  )
    errors.push(
      "Both claims need Not given: the source supplies neither an amount nor a room.",
    );
  if (!s.reason.trim())
    errors.push("Explain why this revision addresses the critique.");
  if (!s.preview || s.preview.signature !== signature())
    errors.push("Preview the current draft.");
  if (!s.selfChecked)
    errors.push("Record your source and critique self-check.");
  if (!dirty(s, active))
    errors.push(
      "No new revision to save; the current wording and reason are already retained.",
    );
  if (s.blocked)
    errors.push("The stored copy is protected; download this separate draft.");
  if (s.conflict)
    errors.push(
      "Compare the latest saved revision and deliberately keep your draft on that base before checking again.",
    );
  return errors;
}
function checkDraft() {
  const s = current(),
    errors = problems();
  s.checked = errors.length === 0;
  s.checkMessage = errors.length
    ? errors.join(" ")
    : `Ready to save a local revision. ${active === "budget" ? "Both keys match this fixed source. " : ""}Wording was checked by you; no automatic semantic grade or independent review is claimed.`;
  status();
}
function save() {
  const s = current();
  checkDraft();
  if (!s.checked) return;
  try {
    const latestRaw = localStorage.getItem(prefix + active);
    if (latestRaw !== s.raw) {
      s.conflict = true;
      s.checked = false;
      s.message =
        "A newer local revision exists, or the stored copy changed. Your draft is retained. Compare it before saving.";
      status();
      return;
    }
    const revision = {
      id: latest(s).id + 1,
      fields: structuredClone(s.fields),
      reason: s.reason,
      reviewedBy: "Author self-check",
      savedAt: new Date().toISOString(),
    };
    const next = { ...s.record, revisions: [...s.record.revisions, revision] };
    const raw = JSON.stringify(next);
    localStorage.setItem(prefix + active, raw);
    if (localStorage.getItem(prefix + active) !== raw)
      throw new Error("Save unconfirmed");
    s.record = next;
    s.raw = raw;
    s.checked = false;
    s.conflict = false;
    s.message = `Saved local revision ${revision.id}. Original and earlier revisions are retained; no course or member account was changed.`;
    s.checkMessage =
      "This revision has been saved with your author self-check.";
    document.querySelector("#base-label").textContent =
      `Based on revision ${revision.id}. The original source stays fixed for this exercise.`;
    renderHistory();
    status();
  } catch {
    s.message =
      "Could not confirm a save. Your draft remains editable and downloadable. Retry when storage is available; a changed stored copy will be compared first.";
    status();
  }
}
function compareLatest() {
  const s = current();
  try {
    const raw = localStorage.getItem(prefix + active),
      record = parseRecord(active, raw);
    s.incoming = { raw, record };
    const last = record.revisions.at(-1) ?? {
      id: 1,
      fields: seed().original,
      reason: "Original practice draft",
    };
    document.querySelector("#incoming").innerHTML =
      `<h3>Latest saved · revision ${last.id}</h3><p>${escape(last.reason)}</p><dl>${fieldList(last.fields)}</dl><p>Your working fields above are unchanged. Using this as the base retains both drafts and requires a fresh preview and self-check.</p><button id="rebase">Keep my draft on latest base</button>`;
  } catch {
    s.message =
      "The changed stored copy cannot be read safely. Your working draft is retained; download it before resolving the stored copy.";
    status();
  }
}
function rebase() {
  const s = current();
  if (!s.incoming) return;
  s.raw = s.incoming.raw;
  s.record = s.incoming.record;
  s.incoming = null;
  s.conflict = false;
  s.checked = false;
  s.selfChecked = false;
  s.preview = null;
  s.message =
    "Your draft is retained on the latest saved base. Compare, preview and check it before adding a revision.";
  s.checkMessage = "A new base requires a fresh preview and author self-check.";
  render();
}
function download(name, value) {
  const blob = new Blob([value], { type: "application/json;charset=utf-8" }),
    href = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
function exportDraft() {
  const s = current(),
    data = seed();
  return JSON.stringify(
    {
      version: 1,
      fixtureVersion,
      caseId: active,
      source: data.source,
      freshSource: data.freshSource,
      critique: data.critique,
      original: { id: 1, fields: data.original },
      saved: s.record,
      draft: {
        fields: s.fields,
        reason: s.reason,
        authorSelfChecked: s.selfChecked,
        checkedForSave: s.checked,
      },
      notice:
        "Local workshop export; not a published lesson or independent review.",
    },
    null,
    2,
  );
}

app.addEventListener("submit", (event) => event.preventDefault());
app.addEventListener("input", (event) => {
  const field = event.target.dataset.field;
  if (field) {
    current().fields[field] = event.target.value;
    invalidate();
  } else if (event.target.id === "reason") {
    current().reason = event.target.value;
    invalidate();
  }
});
app.addEventListener("change", (event) => {
  if (event.target.id === "self-check") {
    current().selfChecked = event.target.checked;
    current().checked = false;
    status();
  }
});
app.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const selected = button.dataset.case;
  if (selected && Object.hasOwn(cases, selected)) {
    active = selected;
    history.replaceState(null, "", `#${active}`);
    render();
    return;
  }
  const action = button.dataset.answer;
  if (action) {
    const s = current();
    if (!s.preview || s.preview.signature !== signature()) return;
    const chosen = app.querySelector(`input[name="${action}"]:checked`);
    const target = document.querySelector(`#${action}-feedback`);
    if (!chosen) {
      target.textContent = "Choose a response first.";
      return;
    }
    const f = s.preview.fields,
      key = action === "fresh" ? f.freshAnswer : (f.answer ?? "C"),
      feedback = action === "fresh" ? f.freshFeedback : f.feedback;
    target.textContent = `${chosen.value === key ? "Matches this draft's key." : "This draft marks another response as correct."} ${feedback}`;
    return;
  }
  switch (button.id) {
    case "preview-button":
      current().preview = {
        fields: structuredClone(current().fields),
        signature: signature(),
      };
      current().checked = false;
      renderPreview();
      status();
      break;
    case "check-button":
      checkDraft();
      break;
    case "save-button":
      save();
      break;
    case "download-button":
      download(`content-${active}-draft.json`, exportDraft());
      break;
    case "download-stored":
      download(`content-${active}-stored.json`, current().raw);
      break;
    case "compare-latest":
      compareLatest();
      break;
    case "rebase":
      rebase();
      break;
  }
});
window.addEventListener("beforeunload", (event) => {
  if ([...drafts].some(([id, state]) => dirty(state, id))) {
    event.preventDefault();
    event.returnValue = "";
  }
});
render();
