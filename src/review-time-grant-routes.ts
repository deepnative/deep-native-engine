import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { ApplicationMode } from "./adapters.ts";
import { csrf, validCsrf } from "./session.ts";
import { staffCookie, staffCredential } from "./staff-entry-selection.ts";
import { sampleUuid } from "./sample-feedback-values.ts";
import { reviewerSampleReference } from "./sample-assignment-views.ts";
import type { reviewTimeGrantAdminStore } from "./review-time-grant-admin.ts";
import {
  REVIEW_GRANT_PATH as base,
  REVIEW_GRANT_REFERENCE_PATH as reference,
  reviewGrantFields as fields,
  reviewGrantInput,
  reviewGrantReferences,
  reviewGrantRevokeInput,
  type ReviewGrantAdministration,
  type ReviewGrantRevocation,
} from "./review-time-grant-values.ts";
import {
  reviewGrantForm,
  reviewGrantCheck,
  reviewGrantHistory,
  reviewGrantReceipt,
  reviewGrantRecovery,
  type ReviewGrantAttempt,
} from "./review-time-grant-views.ts";
const grantInput = (req: Request) =>
  reviewGrantInput({
    allocationId: req.body?.allocationId,
    reviewerId: req.body?.reviewerId,
    operationId: req.body?.operationId,
    startsAt: req.body?.startsAt,
    expiresAt: req.body?.expiresAt,
  });
const revokeInput = (req: Request) =>
  reviewGrantRevokeInput({
    grantId: req.body?.grantId,
    operationId: req.body?.operationId,
  });
export function mountReviewTimeGrantRoutes(
  app: Express,
  store: ReturnType<typeof reviewTimeGrantAdminStore> | undefined,
  options: {
    origin: string;
    secret: string;
    mode?: ApplicationMode;
    administration?: ReviewGrantAdministration;
    localStaffEntry?: boolean;
  },
) {
  const token = (res: Response) => res.locals.reviewGrantToken as string,
    nonce = (res: Response) => (res.locals.reviewGrantCsrf as string) ?? "";
  function failure(res: Response, kind: string, attempt?: ReviewGrantAttempt) {
    const status =
      kind === "denied"
        ? 403
        : kind === "invalid"
          ? 422
          : kind === "conflict"
            ? 409
            : kind === "disabled"
              ? 404
              : 503;
    const message =
      kind === "denied"
        ? "Current selected staff authority is required for this exact private task."
        : kind === "invalid"
          ? "Check the exact references, original operation and finite UTC fields."
          : kind === "conflict"
            ? "This original operation conflicts with a different confirmed payload."
            : kind === "disabled"
              ? "Private review-minute permission tools are unavailable in this environment."
              : "The result cannot be confirmed. A write may have committed; inspect its saved original operation before any manual retry.";
    return res
      .status(status)
      .send(
        reviewGrantRecovery(
          message,
          nonce(res),
          kind === "unavailable" ? attempt : undefined,
        ),
      );
  }
  app.use([base, reference], (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (
      !store ||
      !options.administration ||
      options.administration === "disabled" ||
      options.localStaffEntry !== true ||
      options.mode === "live"
    )
      return failure(res, "disabled");
    const selected = staffCookie(req.headers.cookie);
    if (
      selected.kind !== "value" ||
      !staffCredential(selected.value) ||
      req.get("host") !== new URL(options.origin).host
    )
      return failure(res, "denied");
    res.locals.reviewGrantToken = selected.value;
    res.locals.reviewGrantCsrf = csrf(selected.value, options.secret);
    if (
      req.method === "POST" &&
      (req.get("origin") !== options.origin ||
        !req.is("application/x-www-form-urlencoded") ||
        !validCsrf(req.body?.csrf, selected.value, options.secret))
    )
      return failure(res, "denied");
    next();
  });
  function send(
    res: Response,
    deadline: number,
    html: string,
    attempt?: ReviewGrantAttempt,
  ) {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      return failure(res, attempt ? "unavailable" : "denied", attempt);
    return res.send(html);
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
          res.locals.reviewGrantAttempt as ReviewGrantAttempt | undefined,
        );
      }
    };
  app.get(
    reference,
    wrap(async (req, res) => {
      if (!fields(req.query, [])) return failure(res, "invalid");
      const result = await store!.selfReference(token(res));
      if (result.kind !== "ready") return failure(res, result.kind);
      return send(
        res,
        result.deadline,
        reviewerSampleReference(result.reference),
      );
    }),
  );
  app.get(
    base,
    wrap(async (req, res) => {
      if (!fields(req.query, [])) return failure(res, "invalid");
      const result = await store!.open(token(res));
      if (result.kind !== "ready") return failure(res, result.kind);
      return send(
        res,
        result.deadline,
        reviewGrantForm(nonce(res), result.creationEnabled),
      );
    }),
  );
  app.post(
    base + "/check",
    wrap(async (req, res) => {
      if (
        !fields(req.query, []) ||
        !fields(req.body, ["csrf", "allocationId", "reviewerId"])
      )
        return failure(res, "invalid");
      const refs = reviewGrantReferences({
        allocationId: req.body.allocationId,
        reviewerId: req.body.reviewerId,
      });
      if (!refs) return failure(res, "invalid");
      const result = await store!.check(token(res), refs);
      if (result.kind !== "ready") return failure(res, result.kind);
      return send(
        res,
        result.deadline,
        reviewGrantCheck(result.check, nonce(res), randomUUID()),
      );
    }),
  );
  app.post(
    base + "/grant",
    wrap(async (req, res) => {
      if (
        !fields(req.query, []) ||
        !fields(req.body, [
          "csrf",
          "allocationId",
          "reviewerId",
          "operationId",
          "startsAt",
          "expiresAt",
          "confirm",
        ]) ||
        req.body.confirm !== "yes"
      )
        return failure(res, "invalid");
      const input = grantInput(req);
      if (!input) return failure(res, "invalid");
      const attempt: ReviewGrantAttempt = { kind: "grant", input };
      res.locals.reviewGrantAttempt = attempt;
      const result = await store!.grant(token(res), input);
      if (result.kind !== "applied" && result.kind !== "replayed")
        return failure(res, result.kind, attempt);
      return send(
        res,
        result.deadline,
        reviewGrantReceipt(
          result.row,
          nonce(res),
          randomUUID(),
          result.kind === "replayed"
            ? "The retained original permission was inspected. No new grant was created."
            : "The exact review-minute permission was recorded.",
        ),
        attempt,
      );
    }),
  );
  app.get(
    base + "/history",
    wrap(async (req, res) => {
      if (
        !fields(
          req.query,
          Object.hasOwn(req.query, "after") ? ["after"] : [],
        ) ||
        (req.query.after !== undefined && req.query.after.length > 1024)
      )
        return failure(res, "invalid");
      const result = await store!.history(token(res), req.query.after);
      if (result.kind !== "ready") return failure(res, result.kind);
      return send(res, result.deadline, reviewGrantHistory(result.history));
    }),
  );
  for (const revoke of [false, true])
    app.post(
      base + (revoke ? "/recover-revoke" : "/recover"),
      wrap(async (req, res) => {
        if (
          !fields(req.query, []) ||
          !fields(req.body, ["csrf", "operationId"]) ||
          !sampleUuid(req.body.operationId)
        )
          return failure(res, "invalid");
        const result = revoke
          ? await store!.recoverRevoke(token(res), req.body.operationId)
          : await store!.recover(token(res), req.body.operationId);
        if (result.kind !== "ready" && result.kind !== "absent")
          return failure(res, result.kind);
        return send(
          res,
          result.deadline,
          result.kind === "absent"
            ? reviewGrantRecovery(
                "No retained original operation was found; this does not establish that no write committed.",
                nonce(res),
              )
            : reviewGrantReceipt(
                result.row,
                nonce(res),
                randomUUID(),
                undefined,
                "revocationReceiptId" in result
                  ? {
                      revocationReceiptId: (
                        result as typeof result & ReviewGrantRevocation
                      ).revocationReceiptId,
                      outcome: (result as typeof result & ReviewGrantRevocation)
                        .outcome,
                    }
                  : undefined,
              ),
        );
      }),
    );
  app.post(
    base + "/revoke",
    wrap(async (req, res) => {
      if (
        !fields(req.query, []) ||
        !fields(req.body, ["csrf", "grantId", "operationId", "confirm"]) ||
        req.body.confirm !== "yes"
      )
        return failure(res, "invalid");
      const input = revokeInput(req);
      if (!input) return failure(res, "invalid");
      const attempt: ReviewGrantAttempt = { kind: "revoke", input };
      res.locals.reviewGrantAttempt = attempt;
      const result = await store!.revoke(token(res), input);
      if (
        result.kind !== "revoked" &&
        result.kind !== "unchanged" &&
        result.kind !== "replayed"
      )
        return failure(res, result.kind, attempt);
      return send(
        res,
        result.deadline,
        reviewGrantReceipt(
          result.row,
          nonce(res),
          randomUUID(),
          result.kind === "revoked"
            ? "Only this exact permission was revoked."
            : "The retained revocation was inspected; no additional grant audit was created.",
          result,
        ),
        attempt,
      );
    }),
  );
  app.get(
    base + "/:grantId",
    wrap(async (req, res) => {
      if (!fields(req.query, [])) return failure(res, "invalid");
      const result = await store!.receipt(
        token(res),
        String(req.params.grantId),
      );
      if (result.kind !== "ready")
        return failure(res, result.kind === "absent" ? "denied" : result.kind);
      return send(
        res,
        result.deadline,
        reviewGrantReceipt(result.row, nonce(res), randomUUID()),
      );
    }),
  );
}
