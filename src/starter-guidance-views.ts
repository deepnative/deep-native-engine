import { GOALS, type Goal } from "./content.ts";
import { escape } from "./views.ts";
import {
  STARTER_GUIDANCE_VERSION,
  STARTER_GUIDES,
  type GuidanceChoice,
  type GuidanceStep,
} from "./starter-guidance.ts";

function frame(title: string, active: "example" | "practise", body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Deep Native Engine</title><link rel="stylesheet" href="/assets/style.css"></head><body><header class="site-header guidance-header"><a class="brand" href="/learn"><span class="brand-mark" aria-hidden="true">d/n</span>deep native</a><nav aria-label="Learning account"><a href="/learn">Learning</a><a href="/account">My account</a></nav></header><main class="guidance" id="main"><ol class="guidance-steps" aria-label="Lesson steps"><li${active === "example" ? ' aria-current="step"' : ""}><span>1</span> Example</li><li${active === "practise" ? ' aria-current="step"' : ""}><span>2</span> Practise</li><li><span>3</span> Apply</li></ol>${body}<p class="guidance-exit"><a href="/lesson#exercise-title">Go to your writing exercise</a> · <a href="/learn">Return to learning</a></p></main><footer class="guidance-footer"><p>Use these examples to practise. Your writing exercise is saved separately when you choose to save it.</p></footer></body></html>`;
}

export function starterGuidanceExample(goal: Goal) {
  const guide = STARTER_GUIDES[goal];
  return frame(
    "Turn a vague request into a useful one",
    "example",
    `<p class="eyebrow">YOUR FIRST LESSON · ABOUT 5 MINUTES</p><h1>Turn a vague request into a useful one</h1><p class="lead">${escape(guide.outcome)}</p><p class="guidance-goal">${escape(GOALS[goal])}</p><section class="guidance-source"><h2>Start with what you know</h2><p>${escape(guide.source)}</p></section><section class="guidance-comparison"><div><p class="eyebrow">A VAGUE REQUEST</p><blockquote>${escape(guide.vague)}</blockquote><p>This leaves the task, limits and checks for the answer to guess.</p></div><div><p class="eyebrow">A MORE USEFUL REQUEST</p><blockquote>${escape(guide.improved)}</blockquote></div></section><section class="guidance-reasons"><h2>Why this works</h2><ol><li><strong>Carry over the context.</strong> ${escape(guide.context)}</li><li><strong>Give the answer a job.</strong> ${escape(guide.task)}</li><li><strong>Make it checkable.</strong> ${escape(guide.check)}</li></ol></section><div class="guidance-action"><p>Now check a short answer against its source.</p><a class="button" href="/lesson/guide/practise">Try a quick check <span aria-hidden="true">→</span></a></div>`,
  );
}

export function starterGuidanceQuestion(
  goal: Goal,
  step: GuidanceStep,
  csrf: string,
  answer?: GuidanceChoice,
) {
  const question = STARTER_GUIDES[goal][step];
  const correct = answer?.correct === true;
  const title = step === "practise" ? "Check the facts" : "Try a new situation";
  const feedback = answer
    ? `<section class="guidance-feedback ${correct ? "is-correct" : "try-again"}" role="status"><h2>${correct ? "That's the right check" : "Look at the source again"}</h2><p>${escape(answer.explanation)}</p></section>`
    : "";
  const choices = correct
    ? `<p class="guidance-answer"><strong>Your answer:</strong> ${escape(answer.text)}</p>`
    : `<form method="post" action="/lesson/guide/check"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="version" value="${STARTER_GUIDANCE_VERSION}"><input type="hidden" name="goal" value="${goal}"><input type="hidden" name="step" value="${step}"><fieldset class="guidance-choices"><legend>${escape(question.question)}</legend>${question.choices.map((choice) => `<label class="guidance-choice"><input type="radio" name="choice" value="${choice.id}" required${answer?.id === choice.id ? " checked" : ""}><span>${escape(choice.text)}</span></label>`).join("")}</fieldset><details class="guidance-hint"><summary>Give me a hint</summary><p>${escape(question.hint)}</p></details><button type="submit">${answer ? "Check again" : "Check answer"}</button></form>`;
  const next = correct
    ? step === "practise"
      ? '<div class="guidance-action"><p>Use the same idea with a different situation.</p><a class="button" href="/lesson/guide/transfer">Try a new situation <span aria-hidden="true">→</span></a></div>'
      : '<div class="guidance-action"><h2>Make it your own</h2><p>Write your own instruction and a way to check the answer. Keep facts grounded in the brief and leave missing details open.</p><a class="button" href="/lesson#exercise-title">Write your own request <span aria-hidden="true">→</span></a><p class="small">These checks do not complete or change your saved exercise.</p></div>'
    : "";
  return frame(
    title,
    "practise",
    `<p class="eyebrow">QUICK CHECK ${step === "practise" ? "1" : "2"} OF 2</p><h1>${title}</h1><section class="guidance-source"><h2>What you know</h2><p>${escape(question.source)}</p></section>${feedback}${choices}${next}<p class="small guidance-credit">Explanations refer to this example. Guided practice v${STARTER_GUIDANCE_VERSION}.</p>`,
  );
}

export function starterGuidanceRecovery(title: string, explanation: string) {
  return frame(
    title,
    "practise",
    `<h1>${escape(title)}</h1><p class="lead">${escape(explanation)}</p><a class="button" href="/lesson/guide">Open your current lesson guide</a>`,
  );
}
