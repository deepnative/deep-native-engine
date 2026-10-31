import { randomUUID } from "node:crypto";
import express, { type Express, type Response } from "express";
import { csrf, validCsrf } from "./session.ts";
import { escape } from "./views.ts";
import { LEARNING_WORKSPACE_ASSET_BASE } from "./learning-workspace-assets.ts";
import {
  learningInteger,
  learningObject,
  learningUuid,
  type LearningDecision,
} from "./learning-workspace-values.ts";
import type {
  LearningFailure,
  LearningRead,
  LearningWorkspaceStore,
  LearningWrite,
} from "./learning-workspace-store.ts";

const base = "/learn/notebooks";
const failures = {
  denied: [401, "Sign in again to open your private notebooks."],
  unavailable: [
    503,
    "Your saved records are temporarily unavailable. Try this page again.",
  ],
  invalid: [
    400,
    "This notebook request is not valid. Open your notebook list to continue.",
  ],
  conflict: [
    409,
    "The notebook changed. Open the saved notebook before making another decision.",
  ],
  deleted: [
    410,
    "This notebook has been removed. Its saved writing is no longer available.",
  ],
  "source-unavailable": [
    409,
    "The teaching source is unavailable. Your saved records remain separate.",
  ],
  "not-found": [
    404,
    "This notebook or operation is not available to your account.",
  ],
} satisfies Record<LearningFailure["kind"], [number, string]>;

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Deep Native</title><link rel="stylesheet" href="${LEARNING_WORKSPACE_ASSET_BASE}/style.css"></head><body><header class="account-navigation"><span>Private learning records</span><nav aria-label="Learning and account"><a href="/learn">Back to learning</a><a href="${base}">Saved notebooks</a><a href="/member/export">Download all my records</a></nav></header><main class="workspace-records"><div class="page-heading"><h1>${escape(title)}</h1></div>${body}</main></body></html>`;
}

function failure(res: Response, kind: LearningFailure["kind"]) {
  const [code, message] = failures[kind];
  return res
    .status(code)
    .send(
      page(
        "Saved notebooks",
        `<p role="status">${message}</p><p><a href="${base}">Open saved notebooks</a></p>`,
      ),
    );
}

// HTML cannot faithfully represent every accepted UTF-16 string. Downloads do.
function display(value: string) {
  return escape(
    Array.from(value, (character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 9 && code !== 10) ||
        (code >= 127 && code <= 159) ||
        (character.length === 1 && code >= 0xd800 && code <= 0xdfff)
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : character;
    }).join(""),
  );
}

function writing(title: string, text: string) {
  return `<section><h3>${escape(title)}</h3><pre>${display(text)}</pre>${text === "" ? '<p class="state-text">Nothing saved in this field.</p>' : ""}</section>`;
}

function notebookBody(value: LearningRead) {
  const state = value.state;
  return `<p>${escape(value.variant)} · ${escape(value.contentId)} version ${value.contentVersion} · Saved revision ${value.revision}</p>
    <p>This is your saved copy. It does not include unsaved changes from another tab.</p>
    ${value.availability === "source-unavailable" ? '<p role="status">The teaching source is unavailable. Your retained writing and feedback history remain readable and downloadable here.</p>' : '<p><a href="/learn">Continue learning</a></p>'}
    <p>Saved draft revision ${value.draftRevision}, based on feedback decision ${value.draftBasedOnDecisionSequence}. Current feedback head: decision ${value.decisionSequence}. These can differ after feedback was saved separately.</p>
    <p>Control characters and lone UTF-16 surrogates appear as explicit <code>\\uXXXX</code> notation for display only. JSON downloads preserve the exact saved strings.</p>
    <div class="notebook"><h2>Lesson writing</h2>${state.lessons.map((lesson, index) => writing(`Lesson ${index + 1}: practice`, lesson.transfer) + writing(`Lesson ${index + 1}: my work`, lesson.work)).join("")}
    <h2>Final practice</h2>${state.final.map((text, index) => writing(`Final practice ${index + 1}`, text)).join("")}
    <h2>Saved feedback draft</h2><p>Draft decision: ${escape(state.feedback.draft.decision || "Not chosen")}</p>${writing("Draft text", state.feedback.draft.text)}${writing("Draft reason", state.feedback.draft.reason)}${writing("Draft question", state.feedback.draft.question)}
    <h2>Current accepted feedback artifact</h2>${value.currentArtifact ? writing(`Artifact version ${value.currentArtifact.id}`, value.currentArtifact.text) : "<p>No accepted artifact is available in this retained record.</p>"}
    <h2>Private contribution worksheet</h2>${(["problem", "first", "revision", "reason", "rights", "attribution"] as const).map((key) => writing(key, state.contribution[key])).join("")}</div>`;
}

function decisionBody(item: LearningDecision & { acceptedAt: Date }) {
  return `<article class="notebook"><h2>Decision ${item.id}: ${escape(item.decision)}</h2><p>Comment version ${item.commentVersion} · Artifact ${item.fromVersion} → ${item.toVersion} · ${escape(item.acceptedAt.toISOString())}</p>${writing("Accepted artifact", item.text)}${writing("Proposed text", item.proposedText)}${writing("Reason", item.reason)}${writing("Question", item.question)}</article>`;
}

function deleteForm(
  id: string,
  input: LearningWrite,
  csrfToken: string,
  retry = false,
) {
  return `<form method="post" action="${base}/${id}/delete"><input type="hidden" name="csrf" value="${escape(csrfToken)}"><input type="hidden" name="operationId" value="${input.operationId}"><input type="hidden" name="expectedRevision" value="${input.expectedRevision}"><p><label><input type="checkbox" name="confirm" value="yes" required> I want to permanently remove this notebook and its saved feedback history.</label></p><button class="secondary" type="submit">${retry ? "Retry this same deletion" : "Remove this notebook"}</button></form>`;
}

function sequence(query: Record<string, unknown>) {
  const after = query.after;
  return Object.keys(query).some((key) => key !== "after") ||
    (after !== undefined &&
      (typeof after !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(after) ||
        !learningInteger(Number(after))))
    ? null
    : Number(after ?? 0);
}

/** Each continuation uses the original bearer, never a cached learner identity. */
export function mountLearningWorkspaceRecords(
  app: Express,
  workspace: LearningWorkspaceStore,
  options: { origin: string; secret: string },
) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    delete req.headers["if-none-match"];
    delete req.headers["if-modified-since"];
    next();
  });
  router.get("/", async (req, res) => {
    if (
      Object.keys(req.query).some((key) => key !== "after") ||
      (req.query.after !== undefined && !learningUuid(req.query.after))
    )
      return failure(res, "invalid");
    const result = await workspace.list(
      res.locals.token as string,
      req.query.after as string | undefined,
    );
    if (result.kind !== "ok") return failure(res, result.kind);
    const { items, nextCursor } = result.value;
    return res.send(
      page(
        "Saved notebooks",
        `<p>Your private saved writing, including notebooks whose teaching source is no longer available.</p><p>Up to 20 notebooks per page.</p>${items.length ? items.map((item) => `<article class="notebook"><h2><a href="${base}/${item.id}">${escape(item.variant)} notebook</a></h2><p>${escape(item.contentId)} version ${item.contentVersion} · Revision ${item.revision} · Saved ${escape(item.savedAt.toISOString())}</p></article>`).join("") : "<p>No saved notebooks on this page.</p>"}${nextCursor ? `<p><a rel="next" href="${base}?after=${nextCursor}">Next notebooks</a></p>` : ""}`,
      ),
    );
  });
  router.param("id", (req, res, next, id: string) => {
    if (!learningUuid(id)) return failure(res, "invalid");
    next();
  });
  router.get("/:id", async (req, res) => {
    const result = await workspace.read(
      res.locals.token as string,
      req.params.id,
    );
    if (result.kind !== "ok") return failure(res, result.kind);
    const link = `${base}/${req.params.id}`;
    return res.send(
      page(
        "Your saved notebook",
        `<p class="record-actions"><a class="secondary" href="${link}/download">Download saved draft and first history page</a> <a href="${link}/history">Read feedback history</a></p>${notebookBody(result.value)}<section class="notebook"><h2>Remove this notebook</h2><p>Download anything you want to keep first. Removal erases this notebook’s saved writing and feedback history.</p>${deleteForm(req.params.id, { operationId: randomUUID(), expectedRevision: result.value.revision }, csrf(res.locals.token as string, options.secret))}</section>`,
      ),
    );
  });
  router.get(["/:id/history", "/:id/download"], async (req, res) => {
    const after = sequence(req.query);
    if (after === null) return failure(res, "invalid");
    const bearer = res.locals.token as string;
    const id = req.params.id as string;
    // Read again for every continuation; no retained response/session snapshot.
    const record = await workspace.read(bearer, id);
    if (record.kind !== "ok") return failure(res, record.kind);
    const history = await workspace.history(bearer, id, after);
    if (history.kind !== "ok") return failure(res, history.kind);
    const { items, nextSequence } = history.value;
    const link = `${base}/${req.params.id}`;
    const label = `Feedback history after decision ${after} (up to 20 decisions)`;
    if (req.path.endsWith("/download")) {
      res.attachment(`learning-notebook-${req.params.id}-after-${after}.json`);
      return res.json({
        notebook: record.value,
        historyPage: {
          label,
          afterSequence: after,
          items,
          nextSequence,
          nextDownload:
            nextSequence === null
              ? null
              : `${link}/download?after=${nextSequence}`,
        },
        wholeAccountExport: "/member/export",
      });
    }
    return res.send(
      page(
        "Saved feedback history",
        `<p><a href="${link}">Back to saved draft</a> · <a href="${link}/download?after=${after}">Download draft and this history page</a></p><p>${label}. This page is a bounded part of your history.</p><p>Display-only escapes use <code>\\uXXXX</code>; download JSON for exact text.</p>${items.length ? items.map(decisionBody).join("") : "<p>No further saved feedback decisions.</p>"}${nextSequence === null ? "<p>End of saved history.</p>" : `<p><a rel="next" href="${link}/history?after=${nextSequence}">Next history page</a></p>`}`,
      ),
    );
  });
  router.post(
    "/:id/delete",
    express.urlencoded({ extended: false, limit: "8kb", inflate: false }),
    async (req, res) => {
      const bearer = res.locals.token as string;
      if (
        req.get("origin") !== options.origin ||
        !validCsrf(req.body?.csrf, bearer, options.secret)
      )
        return res
          .status(403)
          .send(
            page(
              "Removal not accepted",
              "<p>Open your notebook and confirm removal from this site.</p>",
            ),
          );
      if (
        !learningObject(req.body, [
          "csrf",
          "operationId",
          "expectedRevision",
          "confirm",
        ]) ||
        req.body.confirm !== "yes" ||
        !learningUuid(req.body.operationId) ||
        typeof req.body.expectedRevision !== "string" ||
        !/^[1-9][0-9]*$/.test(req.body.expectedRevision) ||
        !learningInteger(Number(req.body.expectedRevision))
      )
        return failure(res, "invalid");
      const input = {
        operationId: req.body.operationId,
        expectedRevision: Number(req.body.expectedRevision),
      };
      const result = await workspace
        .remove(bearer, req.params.id, input)
        .catch(() => ({ kind: "unavailable" as const }));
      if (!["saved", "replayed", "unavailable"].includes(result.kind))
        return failure(res, result.kind as LearningFailure["kind"]);
      return res.redirect(
        303,
        `${base}/${req.params.id}/status?operationId=${input.operationId}&expectedRevision=${input.expectedRevision}`,
      );
    },
  );
  router.get("/:id/status", async (req, res) => {
    if (
      !learningObject(req.query, ["operationId", "expectedRevision"]) ||
      !learningUuid(req.query.operationId) ||
      typeof req.query.expectedRevision !== "string" ||
      !/^[1-9][0-9]*$/.test(req.query.expectedRevision) ||
      !learningInteger(Number(req.query.expectedRevision))
    )
      return failure(res, "invalid");
    const input = {
      operationId: req.query.operationId,
      expectedRevision: Number(req.query.expectedRevision),
    };
    const bearer = res.locals.token as string;
    const receipt = await workspace.operation(bearer, input.operationId);
    if (!["saved", "replayed", "not-found"].includes(receipt.kind))
      return failure(res, receipt.kind as LearningFailure["kind"]);
    const record = await workspace.read(bearer, req.params.id);
    if (
      (receipt.kind === "saved" || receipt.kind === "replayed") &&
      receipt.notebookId === req.params.id &&
      record.kind === "deleted"
    )
      return res.send(
        page(
          "Notebook removed",
          '<p role="status">The operation receipt and saved record confirm that this notebook has been removed.</p>',
        ),
      );
    if (record.kind !== "ok") return failure(res, record.kind);
    if (
      receipt.kind !== "not-found" ||
      record.value.revision !== input.expectedRevision
    )
      return failure(res, "conflict");
    return res.send(
      page(
        "Removal not confirmed",
        `<p role="status">No receipt was found and the saved notebook is unchanged. Nothing was retried automatically. You can explicitly retry the same removal below.</p><p><a href="${base}/${req.params.id}">Keep and open this notebook</a></p>${deleteForm(req.params.id, input, csrf(bearer, options.secret), true)}`,
      ),
    );
  });
  router.use(
    (
      error: unknown,
      _req: express.Request,
      res: Response,
      _next: express.NextFunction,
    ) => {
      const type =
        error && typeof error === "object" && "type" in error
          ? error.type
          : null;
      return failure(
        res,
        type === "entity.too.large" ||
          type === "encoding.unsupported" ||
          type === "charset.unsupported"
          ? "invalid"
          : "unavailable",
      );
    },
  );
  app.use(base, router);
}
