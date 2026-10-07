import { randomUUID } from "node:crypto";
import type { Express, Response } from "express";
import type { WorkflowReviewStore } from "./workflow-review.ts";
import {
  workflowReviewHistoryPage,
  workflowReviewPreviewPage,
  workflowReviewReceiptPage,
  workflowReviewRecoveryPage,
  reviewMemberBase as base,
} from "./workflow-review-views.ts";

function fields(
  value: unknown,
  names: string[],
): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every(
      (key) =>
        Object.hasOwn(value, key) &&
        typeof (value as Record<string, unknown>)[key] === "string",
    )
  );
}
export function mountWorkflowReviewRoutes(
  app: Express,
  store: WorkflowReviewStore | undefined,
) {
  const failure = (
    res: Response,
    kind: string,
    original?: { operationId: string; checked?: string; requestId?: string },
  ) =>
    res
      .status(
        kind === "invalid"
          ? 422
          : kind === "denied"
            ? 403
            : kind === "conflict"
              ? 409
              : 503,
      )
      .send(
        workflowReviewRecoveryPage(
          kind === "denied"
            ? "Current owning member authority and the exact source are required."
            : kind === "invalid"
              ? "Check the original fields and deliberate confirmation."
              : kind === "conflict"
                ? "This key or exact source conflicts with an earlier confirmed instruction."
                : "The result cannot be confirmed; inspect its saved state.",
          res.locals.csrf as string,
          original,
        ),
      );
  function deliver(
    res: Response,
    deadline: number,
    render: () => string,
    original?: { operationId: string; checked?: string; requestId?: string },
  ) {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      return failure(res, original ? "unavailable" : "denied", original);
    const html = render();
    if (performance.now() >= deadline)
      return failure(res, original ? "unavailable" : "denied", original);
    return res.send(html);
  }
  app.get(`${base}/receipts/:id`, async (req, res) => {
    if (!store) return failure(res, "unavailable");
    const result = await store.receipt(
      res.locals.token as string,
      req.params.id as string,
    );
    if (result.kind !== "ready") return failure(res, result.kind);
    return deliver(res, result.deadline, () =>
      workflowReviewReceiptPage(
        result.receipt,
        res.locals.csrf as string,
        randomUUID(),
      ),
    );
  });
  app.get(`${base}/history`, async (req, res) => {
    if (!store) return failure(res, "unavailable");
    if (
      Object.keys(req.query).some((k) => k !== "cursor") ||
      (req.query.cursor !== undefined && typeof req.query.cursor !== "string")
    )
      return failure(res, "invalid");
    const result = await store.history(
      res.locals.token as string,
      req.query.cursor as string | undefined,
    );
    if (result.kind !== "ready") return failure(res, result.kind);
    return deliver(res, result.deadline, () =>
      workflowReviewHistoryPage(result.receipts, result.next),
    );
  });
  app.get("/workflow-feedback/:id/review", async (req, res) => {
    if (!store) return failure(res, "unavailable");
    const result = await store.preview(
      res.locals.token as string,
      req.params.id as string,
    );
    if (result.kind !== "ready") return failure(res, result.kind);
    return deliver(res, result.deadline, () =>
      workflowReviewPreviewPage(
        result.preview,
        res.locals.csrf as string,
        randomUUID(),
      ),
    );
  });
  app.post(`${base}/request`, async (req, res) => {
    if (!store) return failure(res, "unavailable");
    if (!fields(req.body, ["csrf", "checked", "operationId", "confirm"]))
      return failure(res, "invalid");
    const original = {
      checked: req.body.checked!,
      operationId: req.body.operationId!,
    };
    const result = await store.request(res.locals.token as string, {
      ...original,
      confirm: req.body.confirm,
    });
    if (result.kind !== "applied" && result.kind !== "replayed")
      return failure(res, result.kind, original);
    return deliver(
      res,
      result.deadline,
      () =>
        workflowReviewReceiptPage(
          result.receipt,
          res.locals.csrf as string,
          randomUUID(),
        ),
      original,
    );
  });
  app.post(`${base}/inspect`, async (req, res) => {
    if (!store) return failure(res, "unavailable");
    if (!fields(req.body, ["csrf", "operationId"]))
      return failure(res, "invalid");
    const result = await store.inspect(
      res.locals.token as string,
      req.body.operationId!,
    );
    if (result.kind !== "ready") return failure(res, result.kind);
    return deliver(res, result.deadline, () =>
      result.receipt
        ? workflowReviewReceiptPage(
            result.receipt,
            res.locals.csrf as string,
            randomUUID(),
          )
        : workflowReviewRecoveryPage(
            "No saved receipt was found; this does not prove an earlier write did not commit.",
            res.locals.csrf as string,
          ),
    );
  });
  app.post(`${base}/withdraw`, async (req, res) => {
    if (!store) return failure(res, "unavailable");
    if (!fields(req.body, ["csrf", "requestId", "operationId", "confirm"]))
      return failure(res, "invalid");
    const original = {
      requestId: req.body.requestId!,
      operationId: req.body.operationId!,
    };
    const result = await store.withdraw(
      res.locals.token as string,
      original.requestId,
      original.operationId,
      req.body.confirm!,
    );
    if (result.kind !== "applied" && result.kind !== "replayed")
      return failure(res, result.kind, original);
    return deliver(
      res,
      result.deadline,
      () =>
        workflowReviewReceiptPage(
          result.receipt,
          res.locals.csrf as string,
          randomUUID(),
        ),
      original,
    );
  });
}
