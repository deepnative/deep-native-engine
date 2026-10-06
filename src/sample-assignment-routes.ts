import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { ApplicationMode } from "./adapters.ts";
import { csrf, validCsrf } from "./session.ts";
import { staffCookie, staffCredential } from "./staff-entry-selection.ts";
import { sampleUuid } from "./sample-feedback-values.ts";
import {
  sampleAssignmentInput,
  sampleAssignmentReferences,
  sampleAssignmentSource,
} from "./sample-assignment-input.ts";
import {
  SAMPLE_ASSIGNMENT_PATH as base,
  SAMPLE_ASSIGNMENT_REFERENCE_PATH as reference,
  type SampleAssignmentInput,
  type SampleAssignmentStore,
} from "./sample-assignment-values.ts";
import {
  reviewerSampleReference,
  sampleAssignmentCheck,
  sampleAssignmentForm,
  sampleAssignmentHistory,
  sampleAssignmentReceipt,
  sampleAssignmentRecovery,
} from "./sample-assignment-views.ts";

function fields(
  value: unknown,
  names: string[],
): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every(
      (name) =>
        Object.hasOwn(value, name) &&
        typeof (value as Record<string, unknown>)[name] === "string",
    )
  );
}
export function mountSampleAssignmentRoutes(
  app: Express,
  store: SampleAssignmentStore | undefined,
  options: {
    origin: string;
    secret: string;
    mode?: ApplicationMode;
    enabled?: boolean;
    localStaffEntry?: boolean;
  },
) {
  function failure(
    res: Response,
    kind: string,
    attempt?: SampleAssignmentInput,
  ) {
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
          ? "Check the exact references, original operation key and finite UTC fields."
          : kind === "conflict"
            ? "This original operation key conflicts with a different confirmed payload."
            : kind === "disabled"
              ? "Private sample assignment tools are unavailable in this environment."
              : "The result cannot be confirmed. A write may have committed; inspect its saved state before any manual retry.";
    return res
      .status(status)
      .send(
        sampleAssignmentRecovery(
          message,
          (res.locals.sampleAssignmentCsrf as string) ?? "",
          kind === "unavailable" ? attempt : undefined,
        ),
      );
  }
  app.use([base, reference], (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (
      !store ||
      options.enabled !== true ||
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
    res.locals.sampleAssignmentToken = selected.value;
    res.locals.sampleAssignmentCsrf = csrf(selected.value, options.secret);
    if (
      req.method === "POST" &&
      (req.get("origin") !== options.origin ||
        !req.is("application/x-www-form-urlencoded") ||
        !validCsrf(req.body?.csrf, selected.value, options.secret))
    )
      return failure(res, "denied");
    next();
  });
  const token = (res: Response) => res.locals.sampleAssignmentToken as string;
  const nonce = (res: Response) => res.locals.sampleAssignmentCsrf as string;
  function send(
    res: Response,
    deadline: number,
    html: string,
    writing = false,
    attempt?: SampleAssignmentInput,
  ) {
    // Called only after HTML construction. Never accept a form-provided lifetime
    // or render privileged data after the runner's earliest authority deadline.
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      return failure(res, writing ? "unavailable" : "denied", attempt);
    return res.send(html);
  }
  const wrap =
    (
      handler: (req: Request, res: Response) => Promise<unknown>,
      write = false,
    ) =>
    async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch {
        const attempt =
          write &&
          fields(req.body, [
            "csrf",
            "evidenceId",
            "sourceRevision",
            "reviewerId",
            "operationId",
            "startsAt",
            "expiresAt",
            "confirm",
          ])
            ? sampleAssignmentInput({
                evidenceId: req.body.evidenceId,
                sourceRevision: req.body.sourceRevision,
                reviewerId: req.body.reviewerId,
                operationId: req.body.operationId,
                startsAt: req.body.startsAt,
                expiresAt: req.body.expiresAt,
              })
            : null;
        failure(res, "unavailable", attempt ?? undefined);
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
      return send(res, result.deadline, sampleAssignmentForm(nonce(res)));
    }),
  );
  app.post(
    base + "/check",
    wrap(async (req, res) => {
      if (
        !fields(req.query, []) ||
        !fields(req.body, [
          "csrf",
          "evidenceId",
          "sourceRevision",
          "reviewerId",
        ])
      )
        return failure(res, "invalid");
      const refs = sampleAssignmentReferences({
        evidenceId: req.body.evidenceId,
        sourceRevision: req.body.sourceRevision,
        reviewerId: req.body.reviewerId,
      });
      if (!refs) return failure(res, "invalid");
      const result = await store!.check(token(res), refs);
      if (result.kind !== "ready") return failure(res, result.kind);
      return send(
        res,
        result.deadline,
        sampleAssignmentCheck(result.check, nonce(res), randomUUID()),
      );
    }),
  );
  app.post(
    base + "/assign",
    wrap(async (req, res) => {
      if (
        !fields(req.query, []) ||
        !fields(req.body, [
          "csrf",
          "evidenceId",
          "sourceRevision",
          "reviewerId",
          "operationId",
          "startsAt",
          "expiresAt",
          "confirm",
        ]) ||
        req.body.confirm !== "yes"
      )
        return failure(res, "invalid");
      const input = sampleAssignmentInput({
        evidenceId: req.body.evidenceId,
        sourceRevision: req.body.sourceRevision,
        reviewerId: req.body.reviewerId,
        operationId: req.body.operationId,
        startsAt: req.body.startsAt,
        expiresAt: req.body.expiresAt,
      });
      if (!input) return failure(res, "invalid");
      const result = await store!.assign(token(res), input);
      if (result.kind !== "applied" && result.kind !== "replayed")
        return failure(res, result.kind, input);
      return send(
        res,
        result.deadline,
        sampleAssignmentReceipt(
          result.row,
          nonce(res),
          result.kind === "replayed"
            ? "This is the retained original operation. No new grant was created."
            : "The exact paired assignment was recorded.",
        ),
        true,
        input,
      );
    }, true),
  );
  app.get(
    base + "/history",
    wrap(async (req, res) => {
      if (
        !fields(
          req.query,
          Object.hasOwn(req.query, "after")
            ? ["evidenceId", "sourceRevision", "after"]
            : ["evidenceId", "sourceRevision"],
        )
      )
        return failure(res, "invalid");
      const source = sampleAssignmentSource({
        evidenceId: req.query.evidenceId,
        sourceRevision: req.query.sourceRevision,
      });
      if (
        !source ||
        (req.query.after !== undefined && req.query.after.length > 1024)
      )
        return failure(res, "invalid");
      const result = await store!.history(token(res), source, req.query.after);
      if (result.kind !== "ready") return failure(res, result.kind);
      return send(
        res,
        result.deadline,
        sampleAssignmentHistory(result.history, nonce(res)),
      );
    }),
  );
  app.post(
    base + "/recover",
    wrap(async (req, res) => {
      if (
        !fields(req.query, []) ||
        !fields(req.body, ["csrf", "operationId"]) ||
        !sampleUuid(req.body.operationId)
      )
        return failure(res, "invalid");
      const result = await store!.recover(token(res), req.body.operationId);
      if (result.kind !== "ready" && result.kind !== "absent")
        return failure(res, result.kind);
      return send(
        res,
        result.deadline,
        result.kind === "ready"
          ? sampleAssignmentReceipt(result.row, nonce(res))
          : sampleAssignmentRecovery(
              "No retained receipt was found; this does not establish that no write committed.",
              nonce(res),
            ),
      );
    }),
  );
  app.post(
    base + "/revoke",
    wrap(async (req, res) => {
      if (
        !fields(req.query, []) ||
        !fields(req.body, [
          "csrf",
          "evidenceId",
          "sourceRevision",
          "exactGrantId",
          "confirm",
        ]) ||
        req.body.confirm !== "yes" ||
        !sampleUuid(req.body.exactGrantId)
      )
        return failure(res, "invalid");
      const source = sampleAssignmentSource({
        evidenceId: req.body.evidenceId,
        sourceRevision: req.body.sourceRevision,
      });
      if (!source) return failure(res, "invalid");
      const result = await store!.revoke(
        token(res),
        source,
        req.body.exactGrantId,
      );
      if (result.kind !== "revoked" && result.kind !== "unchanged")
        return failure(res, result.kind);
      return send(
        res,
        result.deadline,
        sampleAssignmentReceipt(
          result.row,
          nonce(res),
          result.kind === "revoked"
            ? "Only this exact sample grant was revoked."
            : "No further exact-grant change was needed.",
        ),
        true,
      );
    }),
  );
}
