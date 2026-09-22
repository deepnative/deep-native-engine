import { BACKGROUNDS, GOALS, LESSON, exercise } from "./content.ts";
import type { Learner, Exercise } from "./store.ts";
import type { AdapterReadiness, ApplicationMode } from "./adapters.ts";
export function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Deep Native Engine</title><link rel="stylesheet" href="/assets/style.css"></head><body><a class="skip" href="#main">Skip to content</a><header class="site-header"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">d/n</span> deep native<span class="brand-light">engine</span></a><span class="preview-tag">LOCAL LEARNING PREVIEW</span></header><main id="main">${body}</main><footer><strong>Learn something. Make something. Share what works.</strong><span>Local preview · Use sample information only. No AI provider, payment or formal assessment is connected. <a href="/readiness">Integration readiness</a>.</span></footer></body></html>`;
}
export function notice(errors: string[]) {
  return errors.length
    ? `<div class="notice" role="alert"><h2>Let's fix that</h2><ul>${errors.map((e) => `<li>${escape(e)}</li>`).join("")}</ul></div>`
    : "";
}
export function hidden(csrf: string) {
  return `<input type="hidden" name="csrf" value="${csrf}">`;
}
export function readinessPage(
  mode: ApplicationMode,
  adapters: AdapterReadiness[],
) {
  return page(
    "Integration readiness",
    `<section class="error-page"><p class="eyebrow">${escape(mode.toUpperCase())} ENVIRONMENT</p><h1>Integration readiness</h1><p class="lead">This page reports integration boundaries. Simulated results never mean a message, payment, upload or provider request happened.</p><ul>${adapters
      .map(
        (adapter) =>
          `<li><strong>${escape(adapter.kind)}</strong> · ${escape(adapter.state)}<br><span>${escape(adapter.message)}</span></li>`,
      )
      .join(
        "",
      )}</ul><a class="button" href="/">Return to the learning preview</a></section>`,
  );
}
export function welcome(csrf: string, error: string[] = []) {
  return page(
    "A practical start with AI",
    `<section class="hero"><div><p class="eyebrow">YOUR NEXT CHAPTER STARTS HERE</p><h1>Find your place<br>in the future of <em>AI.</em></h1><p class="lead">A little curiosity. A useful skill. Something you can put into practice today.</p><div class="pill-row"><span>No coding required</span><span>Learn at your pace</span><span>Built for different starting points</span></div></div><aside class="path-card"><span class="eyebrow">YOUR FIRST SMALL WIN</span><h2>A clearer instruction.<br>A more useful result.</h2><p>Learn how to give AI context, set a useful task and check its answer.</p><div class="path-step"><b>01</b><span>Choose your direction</span></div><div class="path-step"><b>02</b><span>Learn one practical idea</span></div><div class="path-step"><b>03</b><span>Try it. Check it. Keep it.</span></div><p class="small">12 minutes · One guided exercise</p></aside></section><section class="onboard"><div><p class="eyebrow">MAKE THIS YOUR STARTING POINT</p><h2>What brings you here?</h2><p>Choose an example that feels useful to you, whether you are exploring AI, applying it at work or building something new.</p><p class="small">Your work stays on this computer. This browser can access it for up to 30 days; clearing its cookie loses access. Use Delete this preview to remove your saved work.</p></div><form method="post" action="/start">${hidden(csrf)}${notice(error)}<label for="background">Your starting point</label><select id="background" name="background" required><option value="">Choose a starting point</option>${Object.entries(
      BACKGROUNDS,
    )
      .map(([k, v]) => `<option value="${k}">${v}</option>`)
      .join(
        "",
      )}</select><label for="goal">What would you like to do?</label><select id="goal" name="goal" required><option value="">Choose a learning goal</option>${Object.entries(
      GOALS,
    )
      .map(([k, v]) => `<option value="${k}">${v}</option>`)
      .join(
        "",
      )}</select><label class="check"><input type="checkbox" name="synthetic" value="yes" required><span>I'll use invented or sample information in this preview.</span></label><button type="submit">Start my learning path <span aria-hidden="true">↗</span></button></form></section>`,
  );
}
export function dashboard(
  learner: Learner,
  progress: Exercise | undefined,
  csrf: string,
) {
  const done = Boolean(progress?.completed_at);
  const status = done
    ? "Completed · self-assessed"
    : progress
      ? "Draft saved"
      : "Ready when you are";
  return page(
    "Your learning path",
    `<section class="dashboard-head"><div><p class="eyebrow">YOUR LEARNING SPACE</p><h1>Small steps.<br><em>Useful skills.</em></h1><p class="lead">${GOALS[learner.goal]}</p><span class="subtle-tag">${BACKGROUNDS[learner.background]}</span></div><aside class="progress-card"><p class="eyebrow">YOUR PROGRESS</p><strong>${done ? "1" : "0"}<small> / 1</small></strong><p>exercise completed</p><progress aria-label="Exercises completed" value="${done ? 1 : 0}" max="1"></progress><span class="small">Completion records your own practice, not a formal assessment.</span></aside></section><section class="learning-grid"><article class="lesson-card"><p class="eyebrow">FOUNDATION · LESSON 01</p><span class="status">${status}</span><h2>${LESSON.title}</h2><p>Context. A clear task. A way to check the answer. Three things that make a better starting point.</p><p class="small">${LESSON.minutes} minutes · No coding · Version ${LESSON.version}</p><a class="button" href="/lesson">${done ? "Review your work" : progress ? "Continue exercise" : "Open lesson"} <span aria-hidden="true">↗</span></a></article><aside class="next-card"><p class="eyebrow">WHERE THIS CAN GO</p><h2>Learn together.<br>Contribute something useful.</h2><p>Learning circles, peer contributions and more paths are on the roadmap. This preview begins with your first practical exercise.</p><p class="small">Community and coaching features are not yet available.</p></aside></section><form class="delete-form" method="post" action="/delete">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Delete my local preview and all its saved work.</span></label><button class="secondary" type="submit">Delete this preview</button></form>`,
  );
}
export function lesson(
  learner: Learner,
  progress: Exercise | undefined,
  csrf: string,
  errors: string[] = [],
) {
  const prompt = exercise(learner.goal);
  const done = Boolean(progress?.completed_at);
  return page(
    LESSON.title,
    `<nav class="breadcrumb"><a href="/learn">← Your learning path</a><span>FOUNDATION / 01</span></nav><section class="lesson-heading"><p class="eyebrow">${LESSON.minutes} MINUTES · VERSION ${LESSON.version}</p><h1>${LESSON.title}</h1><p class="lead">AI can produce a confident answer to an unclear question. Give it something concrete to work with—and decide how you'll check the result.</p></section><div class="lesson-layout"><article class="reading"><section><span class="number">01</span><h2>Give it context</h2><p>Explain the situation using information you have permission to share. Use sample details when practising. Leave out names, secrets and private client information.</p></section><section><span class="number">02</span><h2>Ask for a useful outcome</h2><p>Name the task, audience and format. Set limits such as length, time or available resources. Ask it to identify missing information instead of guessing.</p></section><section><span class="number">03</span><h2>Decide how you'll check</h2><p>Compare facts against your original material or a reliable source. Check whether the answer fits the task. An AI suggestion is a starting point; you remain responsible for how you use it.</p></section><aside class="example"><p class="eyebrow">A CHECK FOR YOUR EXERCISE</p><p>${prompt.check}</p></aside></article><section class="exercise-card" aria-labelledby="exercise-title"><p class="eyebrow">PUT IT INTO PRACTICE</p><h2 id="exercise-title">${prompt.title}</h2><p>${prompt.brief}</p>${notice(errors)}${done ? `<div class="success" role="status"><strong>Exercise completed</strong><p>Self-assessed practice saved. No AI or qualified reviewer has assessed it.</p></div><h3>Your instruction</h3><p class="saved-answer">${escape(progress!.instruction)}</p><h3>Your way to check</h3><p class="saved-answer">${escape(progress!.verification)}</p><a class="button" href="/learn">See your progress</a>` : `<form method="post" action="/exercise">${hidden(csrf)}<label for="instruction">Your instruction to AI</label><textarea id="instruction" name="instruction" maxlength="2000" rows="5" aria-describedby="answer-help">${escape(progress?.instruction ?? "")}</textarea><p id="answer-help" class="small">Use at least 20 characters to complete. You can save an unfinished draft.</p><label for="verification">How will you check the result?</label><textarea id="verification" name="verification" maxlength="1000" rows="3">${escape(progress?.verification ?? "")}</textarea><label class="check"><input type="checkbox" name="checked" value="yes"><span>I checked the context, task and verification plan, and used only sample information.</span></label><div class="actions"><button type="submit" name="intent" value="complete">Complete exercise</button><button type="submit" name="intent" value="draft" class="secondary">Save draft</button></div>${progress && !errors.length ? '<p class="saved-note" role="status">Your draft is saved. You can return in this browser.</p>' : ""}</form>`}</section></div>`,
  );
}
export function errorPage(title: string, message: string) {
  return page(
    title,
    `<section class="error-page"><p class="eyebrow">A SMALL PAUSE</p><h1>${escape(title)}</h1><p class="lead">${escape(message)}</p><a class="button" href="/learn">Return to your learning path</a></section>`,
  );
}
