import express, { type Express, type Response } from "express";
import { validCsrf } from "./session.ts";
import {
  LEARNING_VARIANTS,
  learningInteger,
  learningObject,
  type LearningVariant,
} from "./learning-workspace-values.ts";
import { LEARNING_WORKSPACE_CONTENT } from "./learning-workspace-pack.ts";
import type {
  LearningFailure,
  LearningWorkspaceStore,
} from "./learning-workspace-store.ts";

const prefix = "/api/learning-workspace";
const status = {
  denied: 401,
  unavailable: 503,
  invalid: 400,
  conflict: 409,
  deleted: 410,
  "source-unavailable": 409,
  "not-found": 404,
} satisfies Record<LearningFailure["kind"], number>;

function reply(res: Response, result: { kind: string }) {
  return res
    .status(status[result.kind as LearningFailure["kind"]] ?? 200)
    .json(result);
}

/** Mounted after session selection. Every store operation independently checks
 * the original bearer under its lifetime locks; locals are not authorization. */
export function mountLearningWorkspaceRoutes(
  app: Express,
  store: LearningWorkspaceStore,
  options: { origin: string; secret: string },
) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    delete req.headers["if-none-match"];
    delete req.headers["if-modified-since"];
    if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
      if (
        req.get("origin") !== options.origin ||
        !validCsrf(
          req.get("x-csrf-token"),
          res.locals.token as string,
          options.secret,
        )
      )
        return res.status(403).json({ kind: "denied" });
      if (!req.is("application/json"))
        return res.status(415).json({ kind: "invalid" });
    }
    next();
  });
  const small = express.json({ limit: "8kb", inflate: false });
  const decision = express.json({ limit: "1mb", inflate: false });
  // 27 separately validated 30k-UTF16 strings can require 4,860,000 JSON bytes.
  // This bound preserves all accepted writing without adding an aggregate cap.
  const draft = express.json({ limit: "8mb", inflate: false });
  router.get("/current", async (req, res) => {
    if (
      !learningObject(req.query, ["variant"]) ||
      !LEARNING_VARIANTS.includes(req.query.variant as LearningVariant)
    )
      return reply(res, { kind: "invalid" });
    const result = await store.find(res.locals.token as string, {
      contentId: LEARNING_WORKSPACE_CONTENT.id,
      contentVersion: LEARNING_WORKSPACE_CONTENT.version,
      contentHash: LEARNING_WORKSPACE_CONTENT.contentHash,
      variant: req.query.variant as LearningVariant,
    });
    return reply(res, result.kind === "not-found" ? { kind: "empty" } : result);
  });
  router.get("/notebooks", async (req, res) => {
    if (
      Object.keys(req.query).some((key) => key !== "after") ||
      (req.query.after !== undefined && typeof req.query.after !== "string")
    )
      return reply(res, { kind: "invalid" });
    return reply(
      res,
      await store.list(
        res.locals.token as string,
        req.query.after as string | undefined,
      ),
    );
  });
  router.post("/notebooks", small, async (req, res) => {
    if (
      !learningObject(req.body, [
        "contentId",
        "contentVersion",
        "contentHash",
        "variant",
        "operationId",
      ])
    )
      return reply(res, { kind: "invalid" });
    return reply(
      res,
      await store.create(
        res.locals.token as string,
        req.body as unknown as Parameters<LearningWorkspaceStore["create"]>[1],
      ),
    );
  });
  router.get("/notebooks/:id", async (req, res) =>
    reply(res, await store.read(res.locals.token as string, req.params.id)),
  );
  router.put("/notebooks/:id/draft", draft, async (req, res) => {
    if (
      !learningObject(req.body, [
        "operationId",
        "expectedRevision",
        "state",
        "basedOnDecisionSequence",
      ])
    )
      return reply(res, { kind: "invalid" });
    return reply(
      res,
      await store.save(
        res.locals.token as string,
        req.params.id,
        req.body as unknown as Parameters<LearningWorkspaceStore["save"]>[2],
      ),
    );
  });
  router.post(
    "/notebooks/:id/feedback-decisions",
    decision,
    async (req, res) => {
      if (
        !learningObject(req.body, [
          "operationId",
          "expectedRevision",
          "decision",
        ])
      )
        return reply(res, { kind: "invalid" });
      return reply(
        res,
        await store.append(
          res.locals.token as string,
          req.params.id,
          req.body as unknown as Parameters<
            LearningWorkspaceStore["append"]
          >[2],
        ),
      );
    },
  );
  router.get("/notebooks/:id/history", async (req, res) => {
    const value = req.query.after;
    if (
      Object.keys(req.query).some((key) => key !== "after") ||
      (value !== undefined &&
        (typeof value !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(value) ||
          !learningInteger(Number(value))))
    )
      return reply(res, { kind: "invalid" });
    return reply(
      res,
      await store.history(
        res.locals.token as string,
        req.params.id,
        value === undefined ? undefined : Number(value),
      ),
    );
  });
  router.delete("/notebooks/:id", small, async (req, res) => {
    if (!learningObject(req.body, ["operationId", "expectedRevision"]))
      return reply(res, { kind: "invalid" });
    return reply(
      res,
      await store.remove(
        res.locals.token as string,
        req.params.id,
        req.body as unknown as Parameters<LearningWorkspaceStore["remove"]>[2],
      ),
    );
  });
  router.get("/operations/:operationId", async (req, res) =>
    reply(
      res,
      await store.operation(res.locals.token as string, req.params.operationId),
    ),
  );
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
      if (type === "entity.too.large")
        return res.status(413).json({ kind: "invalid" });
      if (type === "entity.parse.failed")
        return res.status(400).json({ kind: "invalid" });
      if (type === "encoding.unsupported" || type === "charset.unsupported")
        return res.status(415).json({ kind: "invalid" });
      return reply(res, { kind: "unavailable" });
    },
  );
  app.use(prefix, router);
}
