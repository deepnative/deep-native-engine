import type { ContentVersion } from "./catalog.ts";
import { hostingText } from "./hosting-presentation.ts";
import { STUDY_QUESTION_MAX, type StudyAnswer } from "./study-answer.ts";
import { escape, hidden, notice, page } from "./views.ts";

export type StudyQuestionState =
  { question: string; answer: StudyAnswer } | { error: string } | null;

function answerSection(
  item: ContentVersion,
  question: string,
  answer: StudyAnswer,
) {
  const cited = `${escape(item.id)} · version ${answer.version}`;
  const body =
    answer.status === "cited"
      ? `${answer.excerpts.map((text) => `<blockquote>${escape(text)}</blockquote>`).join("")}<p>Cited: ${cited}. These are the lesson's own words, not an explanation. Read them in the full lesson before relying on them.</p>`
      : `<p>This lesson version doesn't say enough to answer that, so nothing was guessed. Try other words from the lesson, or read the full lesson.</p>`;
  return `<section aria-labelledby="study-answer-title"><h2 id="study-answer-title">From this lesson</h2><p>You asked: ${escape(question)}</p>${body}<p>This is a word match against the lesson text, not AI. It does not assess you. Your question was not saved or sent to an AI provider; opening this page again will clear it.</p></section>`;
}

export function studyQuestionPage(
  item: ContentVersion,
  csrf: string,
  state: StudyQuestionState = null,
) {
  const path = `/library/${encodeURIComponent(item.id)}`;
  return page(
    `Ask about this lesson · ${item.title}`,
    `<nav class="breadcrumb"><a href="${path}">← Current lesson</a></nav><section class="reading"><p class="eyebrow">STUDY QUESTION · SIMULATED</p><h1>Ask about this lesson</h1><p>Answers quote only ${escape(item.title)} (${escape(item.id)} · version ${item.version}). No AI provider, paid allowance or reviewer is connected.${hostingText(" Use invented information only.", "")}</p>${state && "error" in state ? notice([state.error]) : ""}${state && "answer" in state ? answerSection(item, state.question, state.answer) : ""}<form method="post" action="${path}/study/question">${hidden(csrf)}<input type="hidden" name="content_version" value="${item.version}"><label for="question">Your question (up to ${STUDY_QUESTION_MAX} characters)</label><textarea id="question" name="question" maxlength="${STUDY_QUESTION_MAX}" required></textarea><button type="submit">Find it in this lesson</button></form><p><a href="${path}/study">Write a study reflection instead</a> · <a href="/library">Return to the learning library</a></p></section>`,
  );
}
