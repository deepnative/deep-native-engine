import type { Express, Request, Response } from "express";
import { page, escape } from "./views.ts";
import { LEARNING_WORKSPACE_CONTENT } from "./learning-workspace-pack.ts";
import type { LearningWorkspaceStore } from "./learning-workspace-store.ts";
import type { LearningWorkspacePublicationStore } from "./learning-workspace-publication.ts";
import { learningWorkspacePage } from "./learning-workspace-views.ts";

function privatePage(req: Request, res: Response) {
  res.set("Cache-Control", "no-store");
  delete req.headers["if-none-match"];
  delete req.headers["if-modified-since"];
}

function unavailable(res: Response) {
  return res
    .status(503)
    .send(
      page(
        "Learning temporarily unavailable",
        `<h1>Learning temporarily unavailable</h1><p>Your saved work has not changed. Try opening learning again, or open your retained records.</p><p><a href="/learn">Try learning again</a> · <a href="/learn/notebooks">Saved notebooks</a> · <a href="/learn/records">Earlier lessons and assignments</a> · <a href="/member/export">Download my records</a></p>`,
      ),
    );
}

/** Mount after member session checks and before the existing learning/editor routes. */
export function mountLearningWorkspacePages(
  app: Express,
  store: LearningWorkspaceStore,
  publication: LearningWorkspacePublicationStore,
) {
  app.get("/learn/records", (req, res) => {
    privatePage(req, res);
    res.redirect(303, "/learn?view=records");
  });
  app.get("/learn", async (req, res, next) => {
    privatePage(req, res);
    if (req.query.view === "records") return next();
    const goal = res.locals.learner.goal as string;
    const variant =
      goal === "build" ? "technical" : goal === "work" ? "work" : "everyday";
    try {
      const source = await store.source(res.locals.token as string, {
        contentId: LEARNING_WORKSPACE_CONTENT.id,
        contentVersion: LEARNING_WORKSPACE_CONTENT.version,
        contentHash: LEARNING_WORKSPACE_CONTENT.contentHash,
        variant,
      });
      // Earlier learning remains available before publication or after retirement.
      if (source.kind === "source-unavailable") return next();
      if (source.kind === "denied") return res.redirect(303, "/");
      if (source.kind !== "ok") return unavailable(res);
      return res.send(
        learningWorkspacePage(variant, res.locals.csrf as string),
      );
    } catch {
      return unavailable(res);
    }
  });
  app.get("/editor/library/learning-workspace", async (req, res) => {
    privatePage(req, res);
    try {
      const result = await publication.preview(res.locals.token as string);
      if (result.kind === "denied")
        return res
          .status(403)
          .send(
            page(
              "Staff access required",
              '<h1>Staff access required</h1><p>Use a current editor or reviewer session to inspect the teaching bundle.</p><p><a href="/staff">Staff sign-in</a></p>',
            ),
          );
      if (result.kind === "conflict")
        return res
          .status(409)
          .send(
            page(
              "Teaching version differs",
              '<h1>Teaching version differs</h1><p>The registered bundle does not match the catalog version. Resolve the source version before importing or reviewing it.</p><p><a href="/editor/library">Open the editorial library</a></p>',
            ),
          );
      if (result.kind !== "ready") return unavailable(res);
      const item = result.pack.publication;
      return res.send(
        page(
          "Review the learning workspace",
          `<p><a href="/editor/library">Editorial library</a></p><h1>Review the learning workspace</h1><p>${escape(item.title)} · ${escape(item.id)} version ${item.version}</p><p>Catalog state: ${escape(result.state)}.</p><p>Inspect the complete six-lesson bundle, all three example routes, practice explanations, capstones and supplied feedback before making an editorial decision. The overview alone does not show the full instruction.</p><p><a href="/editor/library/learning-workspace/bundle">Inspect the complete teaching bundle (JSON)</a></p>${result.state === "not-imported" ? `<form method="post" action="/editor/library/learning-workspace/import"><input type="hidden" name="csrf" value="${escape(res.locals.csrf as string)}"><p>A current editor can import this exact version as a draft. Importing does not publish it.</p><button type="submit">Import teaching draft</button></form>` : `<p><a href="/editor/library/${encodeURIComponent(item.id)}/${item.version}">Open the version and editorial decisions</a></p>`}<p>Use the existing submission, separate reviewer, source and rights checks before publication. This lesson does not grant assessment credentials or change earlier assignment prerequisites.</p>`,
        ),
      );
    } catch {
      return unavailable(res);
    }
  });
}
