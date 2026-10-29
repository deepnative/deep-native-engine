import { routes, labels, contentVersion } from "./content.mjs";

const steps = [
  "See an example",
  "Write a request",
  "Check claims",
  "Repair",
  "Review",
];
const headings = [
  "Write a useful request",
  "Now try a fresh case",
  "Check one claim at a time",
  "Make the answer useful",
  "See what changed",
];
const descriptions = [
  "Give a clear task, keep the source facts, and say how you will check the result.",
  "Use new facts to practise the same skill. There is more than one good way to write this.",
  "Keep what the source supports, correct what it contradicts, and leave missing facts open.",
  "Keep the accurate facts. Correct the mistake. Explain the change in your own words.",
  "Your request, the teaching sample and your revision form one small piece of learning work.",
];
const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const key = (route) => `dne-content-storyboard-${contentVersion}:${route}`;
const fresh = () => ({
  step: 0,
  request: "",
  usedExample: false,
  answers: ["", "", ""],
  checked: false,
  hint: false,
  repair: "",
  reason: "",
  criteria: [false, false, false],
  sawRepair: false,
});
const states = {};
const notices = {};
let route = Object.hasOwn(routes, location.hash.slice(1))
  ? location.hash.slice(1)
  : "everyday";
let message =
  "Use invented text. Choose Save when you want to keep your practice in this browser.";
let error = "";

function valid(record, name) {
  if (
    !record ||
    record.schema !== 1 ||
    record.contentVersion !== contentVersion ||
    record.route !== name ||
    !record.state
  )
    return false;
  const state = record.state;
  return (
    Number.isInteger(state.step) &&
    state.step >= 0 &&
    state.step < steps.length &&
    ["request", "repair", "reason"].every(
      (field) => typeof state[field] === "string",
    ) &&
    ["usedExample", "checked", "hint", "sawRepair"].every(
      (field) => typeof state[field] === "boolean",
    ) &&
    Array.isArray(state.answers) &&
    state.answers.length === 3 &&
    state.answers.every((answer) => answer === "" || labels.includes(answer)) &&
    Array.isArray(state.criteria) &&
    state.criteria.length === 3 &&
    state.criteria.every((criterion) => typeof criterion === "boolean")
  );
}

for (const name of Object.keys(routes)) {
  states[name] = fresh();
  try {
    const saved = localStorage.getItem(key(name));
    if (saved !== null) {
      const record = JSON.parse(saved);
      if (!valid(record, name)) throw new Error("Incompatible saved draft");
      states[name] = { ...fresh(), ...record.state };
      notices[name] =
        "Restored from this browser. This practice is not linked to a learning account.";
    }
  } catch {
    notices[name] =
      "Saved practice could not be restored. It remains unchanged; you can work on a new unsaved draft here.";
  }
}
message = notices[route] || message;

function state() {
  return states[route];
}
function allCorrect() {
  return state().answers.every(
    (answer, index) => answer === routes[route].claims[index].answer,
  );
}
function status(text) {
  message = text;
  $("save-status").textContent = text;
}
function dirty() {
  status("Changes not saved yet. Save here to resume in this browser.");
}
function button(text, action, primary = false) {
  return `<button type="button" data-action="${action}" class="${primary ? "primary" : "secondary"}">${text}</button>`;
}
function footer(primary, action, additional = "") {
  return `<div class="actions">${state().step ? button("Back", "back") : ""}${button(primary, action, true)}</div>${additional}`;
}
function saveActions() {
  return `<div class="draft-actions">${button("Save in this browser", "save")}${button("Download my work", "download")}</div>`;
}
function reviewPrompt() {
  return `<details class="request-reference"><summary>Your request</summary><p>${escape(state().request)}</p></details>`;
}
function teachingSample() {
  return `<div class="sample"><p class="eyebrow">Teaching sample</p><p>${escape(routes[route].sample)}</p><p class="small">Written for this exercise; it was not generated from your request.</p></div>`;
}

function render() {
  const current = state();
  const content = routes[route];
  $("routes").innerHTML = Object.entries(routes)
    .map(
      ([id, item]) =>
        `<button type="button" data-route="${id}" aria-pressed="${route === id}">${item.label}</button>`,
    )
    .join("");
  $("steps").innerHTML = steps
    .map(
      (name, index) =>
        `<li ${index === current.step ? 'aria-current="step"' : ""}><span>${index + 1}</span>${name}</li>`,
    )
    .join("");
  $("step-label").textContent =
    `STEP ${current.step + 1} OF 5 · ${content.label.toUpperCase()}`;
  $("heading").textContent = headings[current.step];
  $("lede").textContent = descriptions[current.step];
  $("source-label").textContent =
    current.step === 0 ? "WORKED EXAMPLE" : "FRESH CASE";
  $("source-title").textContent =
    current.step === 0 ? content.topic : content.freshTopic;
  $("source-text").textContent =
    current.step === 0 ? content.source : content.freshSource;
  const errorHtml = error
    ? `<p role="alert" class="validation">${escape(error)}</p>`
    : "";
  let html = "";
  if (current.step === 0) {
    html = `<p class="eyebrow">A request you can inspect</p><blockquote>${escape(content.example)}</blockquote><dl class="ingredients">${["Context", "Task & shape", "Limits", "Check"].map((name, index) => `<div><dt>${name}</dt><dd>${escape(content.parts[index])}</dd></div>`).join("")}</dl><p class="small">You will try a new source next. Keep the four ingredients; change the facts.</p>${footer("Try a fresh case", "next")}`;
  } else if (current.step === 1) {
    html = `<p>${escape(content.task)}</p><label for="request">Your request</label><textarea id="request" data-field="request" rows="6" placeholder="Using these notes, draft… Keep… I will check…">${escape(current.request)}</textarea><p class="small">Name the output, keep unknowns visible, and say what you will compare with the source.</p>${button("Use the worked request", "example")}${current.usedExample ? '<p class="notice">Worked request loaded. Adapt it or keep it as an example; this is not an unaided attempt.</p>' : ""}${errorHtml}<details class="rubric"><summary>What makes a useful request?</summary><ul><li>Each fact is traceable to the notes.</li><li>The output has a usable shape.</li><li>Missing facts stay missing.</li><li>Your check could reveal a specific mistake.</li></ul></details>${footer("Check a sample answer", "to-claims", saveActions())}`;
  } else if (current.step === 2) {
    html = `${reviewPrompt()}${teachingSample()}<dl class="definitions"><div><dt>Supported</dt><dd>The source establishes it.</dd></div><div><dt>Contradicted</dt><dd>The source gives an incompatible fact.</dd></div><div><dt>Not given</dt><dd>The source does not establish it.</dd></div></dl>${content.claims.map((claim, index) => `<fieldset><legend>Claim ${index + 1}: ${escape(claim.text)}</legend><div class="choices">${labels.map((label, position) => `<label for="claim-${index}-${position}"><input type="radio" name="claim-${index}" id="claim-${index}-${position}" data-claim="${index}" value="${label}" ${current.answers[index] === label ? "checked" : ""}><span>${label}</span></label>`).join("")}</div>${current.checked ? `<p class="claim-feedback ${current.answers[index] === claim.answer ? "correct" : "reconsider"}"><strong>${current.answers[index] === claim.answer ? "That fits." : "Try this check."}</strong> ${escape(claim.evidence)} <span>The classification is <strong>${claim.answer}</strong>.</span></p>` : ""}</fieldset>`).join("")}${button(current.hint ? "Hide hint" : "Show a hint", "hint")}${current.hint ? '<p class="hint">A contradiction needs an incompatible fact. If the source gives no answer, choose Not given.</p>' : ""}${errorHtml}${current.checked ? `<p class="check-summary">${allCorrect() ? "These classifications fit the source. Now put the useful facts back together." : "Keep checking: compare each claim with the source."}</p>` : ""}${footer(current.checked && allCorrect() ? "Repair the sample" : "Check these claims", current.checked && allCorrect() ? "to-repair" : "check", saveActions())}`;
  } else if (current.step === 3) {
    html = `${teachingSample()}<label for="repair">Your corrected answer</label><textarea id="repair" data-field="repair" rows="4" placeholder="Keep the supported fact, correct the conflict, and leave the missing detail open.">${escape(current.repair)}</textarea><label for="reason">What did you change, and why?</label><textarea id="reason" data-field="reason" rows="3" placeholder="I changed… because the source…">${escape(current.reason)}</textarea>${errorHtml}<details class="rubric" id="worked-repair"><summary>Compare with a worked correction</summary><p>${escape(content.repair)}</p><p class="small">${escape(content.reason)}</p><p class="small">This is one valid answer, not required wording.</p></details>${footer("Review my revision", "to-review", saveActions())}`;
  } else {
    html = `<section class="review-request"><h2>Your request</h2><p id="review-request">${escape(current.request)}</p>${current.usedExample ? '<p class="small">Request began with the worked example.</p>' : ""}</section><div class="comparison"><section><p class="eyebrow">BEFORE · TEACHING SAMPLE</p><p>${escape(content.sample)}</p></section><section><p class="eyebrow">AFTER · YOUR REVISION</p><p id="review-repair">${escape(current.repair)}</p></section></div><h2>Your reason</h2><p>${escape(current.reason)}</p>${current.sawRepair ? '<p class="small">You opened the worked correction while practising.</p>' : ""}<div class="self-check"><h2>Check your work</h2>${["I kept the facts the source supports.", "I corrected the conflicting fact and left missing details open.", "My reason points to evidence in the source."].map((text, index) => `<label><input type="checkbox" data-criterion="${index}" ${current.criteria[index] ? "checked" : ""}><span>${text}</span></label>`).join("")}<p class="small">Self-check, not an automatic grade.</p></div><div class="actions">${button("Edit my revision", "edit")}${button("Save in this browser", "save", true)}</div><div class="draft-actions">${button("Download my work", "download")}</div>`;
  }
  $("lesson").innerHTML = html;
  $("save-status").textContent = message;
}

function move(step) {
  state().step = step;
  error = "";
  dirty();
  render();
  $("heading").scrollIntoView({ block: "start", behavior: "instant" });
}

function save() {
  try {
    const record = JSON.stringify({
      schema: 1,
      contentVersion,
      route,
      state: state(),
    });
    localStorage.setItem(key(route), record);
    if (localStorage.getItem(key(route)) !== record)
      throw new Error("Save unconfirmed");
    status(
      "Saved in this browser. No account record was changed. Other example routes have their own saves.",
    );
  } catch {
    status(
      "Not saved: this browser could not store the draft. Your text is still here; download it or try saving again.",
    );
  }
}

function download() {
  const current = state();
  const content = routes[route];
  const text = [
    `Deep Native local practice — ${content.label}`,
    `Content draft ${contentVersion}; browser-only practice, not an assessment.`,
    "",
    "SOURCE",
    content.freshSource,
    "",
    "REQUEST",
    current.request || "Not written",
    current.usedExample ? "Began with a worked request." : "",
    "",
    "TEACHING SAMPLE",
    content.sample,
    "",
    "MY CLASSIFICATIONS",
    ...content.claims.map(
      (claim, index) =>
        `${claim.text} — ${current.answers[index] || "Not attempted"}`,
    ),
    "",
    "MY REVISION",
    current.repair || "Not written",
    "",
    "MY REASON",
    current.reason || "Not written",
    "",
    `Self-check criteria: ${current.criteria.map((value) => (value ? "shown" : "not marked")).join(", ")}.`,
    current.sawRepair ? "Worked correction opened during practice." : "",
  ].join("\n");
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `deep-native-${route}-practice.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.addEventListener("input", (event) => {
  if (
    event.target instanceof HTMLTextAreaElement &&
    Object.hasOwn(state(), event.target.dataset.field)
  ) {
    state()[event.target.dataset.field] = event.target.value;
    state().criteria = [false, false, false];
    dirty();
  }
});
document.addEventListener("change", (event) => {
  if (!(event.target instanceof HTMLInputElement)) return;
  if (event.target.dataset.claim !== undefined) {
    const targetId = event.target.id;
    state().answers[Number(event.target.dataset.claim)] = event.target.value;
    state().checked = false;
    error = "";
    dirty();
    render();
    $(targetId).focus({ preventScroll: true });
  }
  if (event.target.dataset.criterion !== undefined) {
    state().criteria[Number(event.target.dataset.criterion)] =
      event.target.checked;
    dirty();
  }
});
document.addEventListener(
  "toggle",
  (event) => {
    if (event.target.id === "worked-repair" && event.target.open) {
      state().sawRepair = true;
      dirty();
    }
  },
  true,
);
document.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.route) {
    if (route !== target.dataset.route) {
      route = target.dataset.route;
      history.replaceState(null, "", `#${route}`);
      error = "";
      status(
        "This example has its own draft. Switching examples does not save or erase your writing.",
      );
      render();
    }
    return;
  }
  const action = target.dataset.action;
  if (action === "save") return save();
  if (action === "download") return download();
  if (action === "back") return move(Math.max(0, state().step - 1));
  if (action === "next") return move(1);
  if (action === "edit") return move(3);
  if (action === "example") {
    state().request = routes[route].freshRequest;
    state().usedExample = true;
    state().criteria = [false, false, false];
    error = "";
    dirty();
  }
  if (action === "to-claims") {
    if (state().request.trim()) return move(2);
    error =
      "Write a request, or use the worked request to practise with an example.";
  }
  if (action === "hint") {
    state().hint = !state().hint;
    dirty();
  }
  if (action === "check") {
    error = state().answers.includes("")
      ? "Choose a classification for each claim, then check again."
      : "";
    state().checked = !error;
    dirty();
  }
  if (action === "to-repair" && state().checked && allCorrect()) return move(3);
  if (action === "to-review") {
    if (state().repair.trim() && state().reason.trim()) return move(4);
    error =
      "Write a correction and one reason so you can compare what changed.";
  }
  render();
});
render();
