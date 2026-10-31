import { readFile } from "node:fs/promises";
import type { Express, Request, Response } from "express";
import { validCsrf } from "./session.ts";
import { LEARNING_WORKSPACE_CONTENT } from "./learning-workspace-pack.ts";
import type { LearningWorkspaceStore } from "./learning-workspace-store.ts";
import type { LearningWorkspacePublicationStore } from "./learning-workspace-publication.ts";
import { learningObject } from "./learning-workspace-values.ts";
import { page } from "./views.ts";

export const LEARNING_WORKSPACE_ASSET_BASE = `/learn/workspace/content/${LEARNING_WORKSPACE_CONTENT.id}/${LEARNING_WORKSPACE_CONTENT.version}/${LEARNING_WORKSPACE_CONTENT.contentHash}`;
const teaching = "/editor/library/learning-workspace";
const generic = new Set([
  "reader.mjs",
  "feedback.mjs",
  "contribution.mjs",
  "browser-notebook.mjs",
  "style.css",
]);

function privateResponse(req: Request, res: Response) {
  res.set("Cache-Control", "no-store");
  delete req.headers["if-none-match"];
  delete req.headers["if-modified-since"];
}
function failure(res: Response, kind: string) {
  const code = kind === "denied" ? 403 : kind === "unavailable" ? 503 : 409;
  return res.status(code).json({ kind });
}
function importFailure(res: Response, kind: string, html: boolean) {
  if (!html)
    return kind === "invalid"
      ? res.status(400).json({ kind })
      : failure(res, kind);
  const code =
    kind === "denied"
      ? 403
      : kind === "invalid"
        ? 400
        : kind === "unavailable"
          ? 503
          : 409;
  return res
    .status(code)
    .send(
      page(
        "Teaching import unconfirmed",
        `<h1>Teaching import unconfirmed</h1><p>${kind === "unavailable" ? "The response did not confirm the import. The draft may already exist; inspect its current state before trying again." : "This request was not accepted. Open the teaching workspace to check your access and the registered version before trying again."}</p><p><a href="${teaching}">Inspect the teaching workspace</a> · <a href="/editor/library">Open the editorial library</a></p><p>Importing a draft does not publish it.</p>`,
      ),
    );
}

/** Only generic renderer files use the filesystem. course.mjs is always
 * generated from the exact registered bundle after current source eligibility. */
export function mountLearningWorkspaceAssets(
  app: Express,
  store: LearningWorkspaceStore,
  publication: LearningWorkspacePublicationStore,
  options: { origin: string; secret: string },
) {
  app.get(
    `${LEARNING_WORKSPACE_ASSET_BASE}/fonts/InterVariable.woff2`,
    async (req, res) => {
      privateResponse(req, res);
      try {
        const bytes = await readFile(
          new URL(
            "../assets/docs/learning-design/reader/fonts/InterVariable.woff2",
            import.meta.url,
          ),
        );
        return res.type("font/woff2").send(bytes);
      } catch {
        return failure(res, "unavailable");
      }
    },
  );
  app.get(`${LEARNING_WORKSPACE_ASSET_BASE}/:asset`, async (req, res) => {
    privateResponse(req, res);
    try {
      if (req.params.asset === "course.mjs") {
        const source = await store.source(res.locals.token as string, {
          contentId: LEARNING_WORKSPACE_CONTENT.id,
          contentVersion: LEARNING_WORKSPACE_CONTENT.version,
          contentHash: LEARNING_WORKSPACE_CONTENT.contentHash,
          variant: "everyday",
        });
        if (source.kind !== "ok") return failure(res, source.kind);
        if (
          !("module" in source.value) ||
          typeof source.value.module !== "string"
        )
          return failure(res, "unavailable");
        return res.type("application/javascript").send(source.value.module);
      }
      if (!generic.has(req.params.asset)) return res.sendStatus(404);
      const bytes = await readFile(
        new URL(
          `../assets/docs/learning-design/reader/${req.params.asset}`,
          import.meta.url,
        ),
      );
      return res
        .type(
          req.params.asset.endsWith(".css")
            ? "text/css"
            : "application/javascript",
        )
        .send(bytes);
    } catch {
      return failure(res, "unavailable");
    }
  });
  app.get(`${teaching}/bundle`, async (req, res) => {
    privateResponse(req, res);
    try {
      const result = await publication.preview(res.locals.token as string);
      if (result.kind !== "ready") return failure(res, result.kind);
      // The full instructional bundle is visible for editorial review, including
      // every source, question, answer explanation, capstone and feedback case.
      return res.json({
        kind: "ready",
        state: result.state,
        publication: result.pack.publication,
        contentHash: result.pack.contentHash,
        fileHash: LEARNING_WORKSPACE_CONTENT.fileHash,
        course: result.pack.course,
      });
    } catch {
      return failure(res, "unavailable");
    }
  });
  app.post(`${teaching}/import`, async (req, res) => {
    privateResponse(req, res);
    const html = req.get("accept")?.includes("text/html") === true;
    if (
      req.get("origin") !== options.origin ||
      !validCsrf(req.body?.csrf, res.locals.token as string, options.secret)
    )
      return importFailure(res, "denied", html);
    if (!learningObject(req.body, ["csrf"]))
      return importFailure(res, "invalid", html);
    try {
      const result = await publication.import(res.locals.token as string);
      if ((result.kind === "imported" || result.kind === "existing") && html)
        return res.redirect(
          303,
          `/editor/library/${LEARNING_WORKSPACE_CONTENT.id}/${LEARNING_WORKSPACE_CONTENT.version}`,
        );
      return result.kind === "imported" || result.kind === "existing"
        ? res.json(result)
        : importFailure(res, result.kind, html);
    } catch {
      return importFailure(res, "unavailable", html);
    }
  });
}
