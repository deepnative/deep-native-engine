import type { Express, Response } from "express";
import type {
  ReviewerWorklistStore,
  ReviewerWorkState,
} from "./reviewer-worklist.ts";
import { escape, page } from "./views.ts";
const path = "/review/worklist";
const labels: Record<ReviewerWorkState, string> = {
  "not-started": "Not started",
  draft: "Your private draft",
  published: "Published",
  "clarification-needed": "Clarification needs your answer",
};
const navigation =
  '<nav aria-label="Feedback worklist"><a href="/review/worklist">Active feedback</a> · <a href="/review/worklist?view=completed">Completed feedback</a> · <a href="/editor/library">Content workflow</a></nav>';
export function mountReviewerWorklistRoutes(
  app: Express,
  store: ReviewerWorklistStore,
) {
  const failure = (res: Response, kind: string) =>
    res
      .status(kind === "denied" ? 403 : kind === "invalid" ? 422 : 503)
      .send(
        page(
          "Worklist unavailable",
          `<section class="reading reviewer-worklist"><h1>Worklist unavailable</h1><p role="alert">${kind === "denied" ? "Current reviewer access is required." : kind === "invalid" ? "This page link is invalid or expired. Open a fresh worklist." : "The worklist cannot be confirmed. Nothing is retried automatically."}</p>${navigation}</section>`,
        ),
      );
  app.get(path, async (req, res) => {
    const { view = "active", after } = req.query;
    if (
      Object.keys(req.query).some((k) => k !== "view" && k !== "after") ||
      (view !== "active" && view !== "completed") ||
      (after !== undefined && typeof after !== "string")
    ) {
      failure(res, "invalid");
      return;
    }
    try {
      const result = await store.list(res.locals.token as string, view, after);
      if (result.kind !== "ready") {
        failure(res, result.kind);
        return;
      }
      res.send(
        page(
          "Your sample feedback worklist",
          `<section class="reading reviewer-worklist"><p class="eyebrow">PRIVATE LOCAL REVIEW</p><h1>Your sample feedback worklist</h1><p>Only samples currently assigned and explicitly shared with you appear here. This is private sample feedback, not a qualified service or a promised response time. Opening this list does not begin a review.</p>${navigation}<h2>${view === "active" ? "Active" : "Completed"} feedback</h2>${result.items.length ? `<ul>${result.items.map((item) => `<li><h3><a href="/review/evidence/${encodeURIComponent(item.evidenceId)}/feedback">${escape(item.title)}</a></h3><p>Source version ${item.version} · ${labels[item.state]}</p><p>Submitted <time datetime="${escape(item.submittedAt)}">${escape(item.submittedAt)}</time> · ${item.ageMinutes} minutes since submission when this page was read.</p></li>`).join("")}</ul>` : `<p>No ${view} sample feedback is available to you.</p>`}${result.next ? `<p><a href="${path}?view=${view}&amp;after=${encodeURIComponent(result.next)}">Next feedback page</a></p>` : ""}<p>Access and work status are checked again on every page. The list can change as members withdraw samples or grants change.</p></section>`,
        ),
      );
    } catch {
      failure(res, "unavailable");
    }
  });
}
