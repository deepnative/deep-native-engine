import type { Express, Request, Response } from "express";
import type {
  SampleFeedbackStore,
  SampleFeedbackResult,
} from "./sample-feedback.ts";
import {
  sampleFeedbackPage,
  sampleFeedbackPath,
  sampleFeedbackRecovery,
} from "./sample-feedback-views.ts";
function fields(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((x) => typeof x === "string")
  );
}
const number = (value: string | undefined) =>
  value !== undefined && /^(0|[1-9][0-9]{0,9})$/.test(value)
    ? Number(value)
    : NaN;
export function mountSampleFeedbackRoutes(
  app: Express,
  store: SampleFeedbackStore,
) {
  function failure(
    res: Response,
    kind: string,
    path: string,
    attempt?: Record<string, string>,
    recoverPublication = false,
  ) {
    const status =
      kind === "denied"
        ? 403
        : kind === "invalid"
          ? 422
          : kind === "conflict"
            ? 409
            : 503;
    const message =
      kind === "denied"
        ? "This session cannot use this sample feedback."
        : kind === "invalid"
          ? "Check the fields and exact source references."
          : kind === "conflict"
            ? "The saved feedback changed or this action conflicts with an earlier request."
            : "The result cannot be confirmed. A write may have committed; inspect its saved state.";
    return res
      .status(status)
      .send(
        sampleFeedbackRecovery(
          "Feedback needs attention",
          message,
          path,
          attempt,
          kind === "unavailable" &&
            recoverPublication &&
            attempt?.allocationId !== undefined
            ? { csrf: res.locals.csrf as string }
            : undefined,
        ),
      );
  }
  const wrap =
    (handler: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch {
        failure(
          res,
          "unavailable",
          sampleFeedbackPath(
            String(req.params.id),
            req.path.startsWith("/review/"),
          ),
          fields(req.body) ? req.body : undefined,
          req.path.endsWith("/publish"),
        );
      }
    };
  app.post(
    "/review/evidence/:id/feedback/begin",
    wrap(async (req, res) => {
      const id = String(req.params.id),
        path = sampleFeedbackPath(id, true);
      if (!fields(req.body)) return failure(res, "invalid", path);
      const b = req.body;
      if (
        Object.keys(b).some(
          (key) =>
            !["csrf", "allocationId", "grantId", "operationId"].includes(key),
        )
      )
        return failure(res, "invalid", path);
      const result = await store.beginReview(
        res.locals.token as string,
        id,
        b.allocationId ?? "",
        b.grantId ?? "",
        b.operationId ?? "",
      );
      if (result.kind !== "applied" && result.kind !== "replayed")
        return failure(res, result.kind, path);
      res.redirect(303, path);
    }),
  );
  for (const reviewer of [false, true]) {
    const base = `${reviewer ? "/review" : ""}/evidence/:id/feedback`;
    app.get(
      base,
      wrap(async (req, res) => {
        const id = String(req.params.id),
          path = sampleFeedbackPath(id, reviewer);
        if (
          !fields(req.query) ||
          Object.keys(req.query).some((key) => key !== "after") ||
          (reviewer && Object.keys(req.query).length)
        )
          return failure(res, "denied", path);
        const result = reviewer
          ? await store.reviewer(res.locals.token as string, id)
          : await store.owner(res.locals.token as string, id, req.query.after);
        if (result.kind !== "ready") return failure(res, result.kind, path);
        res.send(
          sampleFeedbackPage(result, res.locals.csrf as string, reviewer),
        );
      }),
    );
    for (const action of reviewer
      ? ["draft", "publish", "answer"]
      : ["clarify"])
      app.post(
        `${base}/${action}`,
        wrap(async (req, res) => {
          const id = String(req.params.id),
            path = sampleFeedbackPath(id, reviewer),
            token = res.locals.token as string;
          if (!fields(req.body)) return failure(res, "invalid", path);
          const b = req.body;
          const allowed =
            action === "draft"
              ? [
                  "csrf",
                  "operationId",
                  "revision",
                  "preparationMinutes",
                  "reviewMinutes",
                  ...Array.from({ length: 5 }, (_, i) =>
                    ["label", "comment", "quote", "occurrence"].map(
                      (k) => k + i,
                    ),
                  ).flat(),
                ]
              : action === "publish"
                ? [
                    "csrf",
                    "operationId",
                    "revision",
                    "confirm",
                    "allocationId",
                    "grantId",
                    "reviewStart",
                    "reviewEnd",
                    "preparationStart",
                    "preparationEnd",
                  ]
                : ["csrf", "operationId", "feedbackId", "message"];
          if (Object.keys(b).some((key) => !allowed.includes(key)))
            return failure(res, "invalid", path, b);
          let result: SampleFeedbackResult;
          if (action === "draft") {
            const current = await store.reviewer(token, id);
            if (current.kind !== "ready")
              return failure(res, current.kind, path, b);
            const criteria = [];
            for (let i = 0; i < 5; i++) {
              const label = b["label" + i] ?? "",
                comment = b["comment" + i] ?? "",
                quote = b["quote" + i] ?? "";
              if (!label && !comment && !quote) continue;
              const occurrence = number(b["occurrence" + i]);
              let start = -1;
              if (
                quote &&
                Number.isInteger(occurrence) &&
                occurrence >= 1 &&
                occurrence <= current.source.length
              ) {
                for (let n = 0; n < occurrence; n++) {
                  start = current.source.indexOf(quote, start + 1);
                  if (start < 0) break;
                }
              }
              criteria.push({
                label,
                comment,
                quote,
                start,
                end: start + quote.length,
              });
            }
            result = await store.save(token, id, {
              revision: number(b.revision),
              operationId: b.operationId,
              criteria,
              preparationMinutes:
                b.preparationMinutes === ""
                  ? null
                  : number(b.preparationMinutes),
              reviewMinutes:
                b.reviewMinutes === "" ? null : number(b.reviewMinutes),
            });
          } else if (action === "publish") {
            if (b.confirm !== "yes") return failure(res, "invalid", path, b);
            result = await store.publish(
              token,
              id,
              number(b.revision),
              b.operationId ?? "",
              b.allocationId !== undefined
                ? {
                    allocationId: b.allocationId,
                    grantId: b.grantId ?? "",
                    intervals: {
                      reviewStart: new Date(b.reviewStart ?? ""),
                      reviewEnd: new Date(b.reviewEnd ?? ""),
                      preparationStart: b.preparationStart
                        ? new Date(b.preparationStart)
                        : null,
                      preparationEnd: b.preparationEnd
                        ? new Date(b.preparationEnd)
                        : null,
                    },
                  }
                : undefined,
            );
          } else
            result = await store[action === "answer" ? "answer" : "clarify"](
              token,
              id,
              b.feedbackId ?? "",
              b.message ?? "",
              b.operationId ?? "",
            );
          if (result.kind !== "saved")
            return failure(res, result.kind, path, b, action === "publish");
          res.redirect(303, path);
        }),
      );
  }
}
