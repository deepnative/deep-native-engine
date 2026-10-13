import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { ApplicationMode } from "./adapters.ts";
import { csrf, validCsrf } from "./session.ts";
import { staffCookie, staffCredential } from "./staff-entry-selection.ts";
import { sampleUuid } from "./sample-feedback-values.ts";
import type { supportTimeGrantAdminStore } from "./support-time-grant-admin.ts";
import {
  SUPPORT_GRANT_PATH as base,
  supportMinuteFields as fields,
  supportMinuteInput,
  supportMinuteReferences,
  supportMinuteRevokeInput,
  type SupportGrantAdministration,
  type SupportMinuteRevocation,
} from "./support-time-grant-values.ts";
import {
  supportMinuteForm,
  supportMinuteCheck,
  supportMinuteHistory,
  supportMinuteReceipt,
  supportMinuteRecovery,
  type SupportMinuteAttempt,
} from "./support-time-grant-views.ts";
const grantInput = (req: Request) =>
  supportMinuteInput({
    requestId: req.body?.requestId,
    allocationId: req.body?.allocationId,
    operatorId: req.body?.operatorId,
    operationId: req.body?.operationId,
    startsAt: req.body?.startsAt,
    expiresAt: req.body?.expiresAt,
  });
const revokeInput = (req: Request) =>
  supportMinuteRevokeInput({
    grantId: req.body?.grantId,
    operationId: req.body?.operationId,
  });
export function mountSupportTimeGrantRoutes(
  app: Express,
  store: ReturnType<typeof supportTimeGrantAdminStore> | undefined,
  options: {
    origin: string;
    secret: string;
    mode?: ApplicationMode;
    administration?: SupportGrantAdministration;
    localStaffEntry?: boolean;
  },
) {
  const token = (res: Response) => res.locals.supportMinuteToken as string,
    nonce = (res: Response) => (res.locals.supportMinuteCsrf as string) ?? "";
  function failure(
    res: Response,
    kind: string,
    attempt?: SupportMinuteAttempt,
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
          ? "Check the exact references, original operation and finite UTC fields."
          : kind === "conflict"
            ? "This original operation conflicts with a different confirmed payload."
            : kind === "disabled"
              ? "Private support-minute permission tools are unavailable in this environment."
              : "The result cannot be confirmed. A write may have committed; inspect its saved original operation before any manual retry.";
    return res
      .status(status)
      .send(
        supportMinuteRecovery(
          message,
          nonce(res),
          kind === "unavailable" ? attempt : undefined,
        ),
      );
  }
  app.use(base, (req, res, next) => {
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
    res.locals.supportMinuteToken = selected.value;
    res.locals.supportMinuteCsrf = csrf(selected.value, options.secret);
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
    attempt?: SupportMinuteAttempt,
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
          res.locals.supportMinuteAttempt as SupportMinuteAttempt | undefined,
        );
      }
    };
  app.get(
    base,
    wrap(async (req, res) => {
      if (!fields(req.query, [])) return failure(res, "invalid");
      const result = await store!.open(token(res));
      if (result.kind !== "ready") return failure(res, result.kind);
      return send(
        res,
        result.deadline,
        supportMinuteForm(
          nonce(res),
          result.creationEnabled,
          result.writesEnabled,
        ),
      );
    }),
  );
  app.post(
    base + "/check",
    wrap(async (req, res) => {
      if (
        !fields(req.query, []) ||
        !fields(req.body, ["csrf", "requestId", "allocationId", "operatorId"])
      )
        return failure(res, "invalid");
      const refs = supportMinuteReferences({
        requestId: req.body.requestId,
        allocationId: req.body.allocationId,
        operatorId: req.body.operatorId,
      });
      if (!refs) return failure(res, "invalid");
      const result = await store!.check(token(res), refs);
      if (result.kind !== "ready") return failure(res, result.kind);
      return send(
        res,
        result.deadline,
        supportMinuteCheck(result.check, nonce(res), randomUUID()),
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
          "requestId",
          "allocationId",
          "operatorId",
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
      const attempt: SupportMinuteAttempt = { kind: "grant", input };
      res.locals.supportMinuteAttempt = attempt;
      const result = await store!.grant(token(res), input);
      if (result.kind !== "applied" && result.kind !== "replayed")
        return failure(res, result.kind, attempt);
      return send(
        res,
        result.deadline,
        supportMinuteReceipt(
          result.row,
          nonce(res),
          randomUUID(),
          result.kind === "replayed"
            ? "The retained original permission was inspected. No new grant was created."
            : "The exact support-minute permission was recorded.",
          undefined,
          result.writesEnabled,
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
      return send(res, result.deadline, supportMinuteHistory(result));
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
          ? await store!.recoverRevocation(token(res), req.body.operationId)
          : await store!.recover(token(res), req.body.operationId);
        if (result.kind !== "ready" && result.kind !== "absent")
          return failure(res, result.kind);
        return send(
          res,
          result.deadline,
          result.kind === "absent"
            ? supportMinuteRecovery(
                "No retained original operation was found; this does not establish that no write committed.",
                nonce(res),
              )
            : supportMinuteReceipt(
                result.row,
                nonce(res),
                randomUUID(),
                undefined,
                "revocation" in result
                  ? (result.revocation as SupportMinuteRevocation)
                  : undefined,
                result.writesEnabled,
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
      const attempt: SupportMinuteAttempt = { kind: "revoke", input };
      res.locals.supportMinuteAttempt = attempt;
      const result = await store!.revoke(token(res), input);
      if (result.kind !== "applied" && result.kind !== "replayed")
        return failure(res, result.kind, attempt);
      return send(
        res,
        result.deadline,
        supportMinuteReceipt(
          result.row,
          nonce(res),
          randomUUID(),
          result.kind === "applied" && result.revocation.outcome === "revoked"
            ? "Only this exact permission was revoked."
            : "The retained revocation was inspected; no additional grant audit was created.",
          result.revocation,
          result.writesEnabled,
        ),
        attempt,
      );
    }),
  );
  app.get(
    base + "/:grantId",
    wrap(async (req, res) => {
      if (!fields(req.query, [])) return failure(res, "invalid");
      const result = await store!.exact(token(res), String(req.params.grantId));
      if (result.kind !== "ready")
        return failure(res, result.kind === "absent" ? "denied" : result.kind);
      return send(
        res,
        result.deadline,
        supportMinuteReceipt(
          result.row,
          nonce(res),
          randomUUID(),
          undefined,
          undefined,
          result.writesEnabled,
        ),
      );
    }),
  );
}
