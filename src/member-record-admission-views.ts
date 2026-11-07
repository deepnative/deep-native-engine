import { escape, hidden, notice, page } from "./views.ts";

// #42: a refused or unanswered new proposal keeps exactly what was typed, so
// the member can save it again after the wait without retyping.
export function proposalNotSavedPage(
  message: string,
  csrf: string,
  typed: Record<string, string>,
) {
  const value = (name: string) => escape(typed[name] ?? "");
  const kept = (name: string) =>
    typed[name] === undefined
      ? ""
      : `<input type="hidden" name="${name}" value="${value(name)}">`;
  return page(
    "Proposal not saved",
    `<section class="error-page"><h1>Proposal not saved</h1>${notice([message])}<form method="post" action="/contribute">${hidden(csrf)}${kept("workflow_id")}${kept("workflow_version")}${kept("sample_confirmed")}<label for="proposal-title">Title</label><input id="proposal-title" name="title" maxlength="160" required value="${value("title")}"><label for="proposal-body">Proposal</label><textarea id="proposal-body" name="body" maxlength="4000" required>${value("body")}</textarea><label for="proposal-sources">Sources and rights notes</label><textarea id="proposal-sources" name="sources" maxlength="1000" required>${value("sources")}</textarea><button type="submit">Save private draft</button></form><p><a href="/contribute">Your proposals</a> · <a href="/learn">Return to learning</a></p></section>`,
  );
}
