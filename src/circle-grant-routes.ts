import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { ApplicationMode } from "./adapters.ts";
import { staffCookie, staffCredential } from "./staff-entry-selection.ts";
import {
  circleGrantId,
  circleGrantCircle,
  circleGrantUtc,
  type CircleGrantAdminStore,
  type CircleGrantAttempt,
  type CircleGrantResult,
  type CircleGrantScope,
} from "./circle-grant-values.ts";
import {
  circleGrantHomePage,
  circleGrantReferencePage,
  circleGrantConfirmPage,
  circleGrantReceiptPage,
  circleGrantHistoryPage,
  circleGrantNoticePage,
} from "./circle-grant-views.ts";
const base = "/operator/circle-grants",
  reference = "/moderate/circle-reference";
const fields = (
  value: unknown,
  allowed: string[],
): value is Record<string, string> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.entries(value).every(
    ([name, item]) =>
      allowed.includes(name) && typeof item === "string" && item.length <= 200,
  );
const messages = {
  denied:
    "This circle grant action is unavailable to the current selected staff credential. Check your staff sign-in and exact references.",
  invalid:
    "Check the exact references and canonical finite UTC expiry. A new grant must end in the future and no later than the target credential; submitted dates are never shortened.",
  conflict:
    "This submission key belongs to a different retained instruction or creator. It cannot be replaced or used to change that original grant.",
  unavailable:
    "The result cannot be confirmed. A submitted change may already have committed. Inspect saved state before deciding whether to repeat the exact instruction.",
};
/** Mounted after normal Host/Origin/selected-staff CSRF. Unlike legacy staff
 * destinations, all of these operations require an explicitly selected cookie. */
export function mountCircleGrantRoutes(
  app: Express,
  store: CircleGrantAdminStore | undefined,
  options: {
    localStaffEntry?: boolean;
    localCircleAdmin?: boolean;
    circleDiscussionEnabled?: boolean;
    mode?: ApplicationMode;
  },
) {
  const canCreate =
    options.localCircleAdmin === true &&
    options.circleDiscussionEnabled === true;
  function failure(
    res: Response,
    kind: keyof typeof messages,
    attempt?: CircleGrantAttempt,
    scope?: CircleGrantScope,
  ) {
    return res
      .status(
        { denied: 403, invalid: 422, conflict: 409, unavailable: 503 }[kind],
      )
      .send(
        circleGrantNoticePage(
          res.locals.csrf,
          messages[kind],
          kind === "unavailable" ? attempt : undefined,
          kind === "denied" ? undefined : scope,
          canCreate,
        ),
      );
  }
  app.use([base, reference], (req, res, next) => {
    if (!options.localStaffEntry || options.mode === "live" || !store)
      return res
        .status(404)
        .send(
          circleGrantNoticePage(
            "",
            "Local circle grant administration is unavailable in this configuration.",
          ),
        );
    const selected = staffCookie(req.headers.cookie);
    if (selected.kind !== "value" || !staffCredential(selected.value))
      return failure(res, "denied");
    res.locals.circleGrantCredential = selected.value;
    next();
  });
  function ready<T>(
    res: Response,
    result: CircleGrantResult<T>,
    render: (value: T) => string,
    writing = false,
    attempt?: CircleGrantAttempt,
    scope?: CircleGrantScope,
  ) {
    if (result.kind !== "ready")
      return failure(res, result.kind, attempt, scope);
    const expired = () =>
      !Number.isFinite(result.deadline) || performance.now() >= result.deadline;
    if (expired())
      return failure(res, writing ? "unavailable" : "denied", attempt, scope);
    const body = render(result.value);
    if (expired())
      return failure(res, writing ? "unavailable" : "denied", attempt, scope);
    return res.send(body);
  }
  const route =
    (handler: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch {
        failure(
          res,
          "unavailable",
          res.locals.circleGrantAttempt,
          res.locals.circleGrantScope,
        );
      }
    };
  const empty = (req: Request) => fields(req.query, []);
  function scope(req: Request, res: Response): CircleGrantScope | null {
    if (
      !circleGrantId(req.body.staffId) ||
      !circleGrantCircle(req.body.circleId)
    )
      return null;
    return (res.locals.circleGrantScope = {
      staffId: req.body.staffId,
      circleId: req.body.circleId,
    });
  }
  app.get(
    base,
    route(async (req, res) => {
      if (!empty(req)) return failure(res, "invalid");
      return ready(
        res,
        await store!.admin(res.locals.circleGrantCredential),
        (value) =>
          circleGrantHomePage(res.locals.csrf, {
            ...value,
            creationEnabled: value.creationEnabled && canCreate,
          }),
      );
    }),
  );
  app.get(
    reference,
    route(async (req, res) => {
      if (!empty(req)) return failure(res, "invalid");
      return ready(
        res,
        await store!.reference(res.locals.circleGrantCredential),
        circleGrantReferencePage,
      );
    }),
  );
  app.post(
    `${base}/check`,
    route(async (req, res) => {
      if (
        !empty(req) ||
        !fields(req.body, ["csrf", "staffId", "circleId"]) ||
        (req.body.staffId !== "self" && !circleGrantId(req.body.staffId)) ||
        !circleGrantCircle(req.body.circleId)
      )
        return failure(res, "invalid");
      return ready(
        res,
        await store!.check(
          res.locals.circleGrantCredential,
          req.body.staffId,
          req.body.circleId,
        ),
        (value) =>
          circleGrantConfirmPage(
            res.locals.csrf,
            { ...value, creationEnabled: value.creationEnabled && canCreate },
            {
              staffId: value.staffId,
              circleId: value.circleId,
              idempotencyKey: randomUUID(),
              expiresAt: "",
            },
          ),
      );
    }),
  );
  app.post(
    `${base}/create`,
    route(async (req, res) => {
      if (
        !empty(req) ||
        !fields(req.body, [
          "csrf",
          "staffId",
          "circleId",
          "idempotencyKey",
          "expiresAt",
          "confirm",
        ]) ||
        !circleGrantId(req.body.idempotencyKey)
      )
        return failure(res, "invalid");
      const exact = scope(req, res),
        expiresAt = circleGrantUtc(req.body.expiresAt);
      if (!exact || !expiresAt) return failure(res, "invalid");
      if (req.body.confirm !== "yes" || !canCreate)
        return failure(res, "denied");
      const attempt: CircleGrantAttempt = {
        ...exact,
        idempotencyKey: req.body.idempotencyKey,
        expiresAt: expiresAt.toISOString(),
      };
      res.locals.circleGrantAttempt = attempt;
      return ready(
        res,
        await store!.create(res.locals.circleGrantCredential, {
          ...exact,
          idempotencyKey: attempt.idempotencyKey,
          expiresAt,
        }),
        (value) =>
          circleGrantReceiptPage(
            res.locals.csrf,
            exact,
            value,
            attempt.idempotencyKey,
          ),
        true,
        attempt,
        exact,
      );
    }),
  );
  app.post(
    `${base}/inspect`,
    route(async (req, res) => {
      if (
        !empty(req) ||
        !fields(req.body, [
          "csrf",
          "staffId",
          "circleId",
          "lookupKind",
          "lookupValue",
        ]) ||
        !circleGrantId(req.body.lookupValue) ||
        !["key", "grant"].includes(req.body.lookupKind!)
      )
        return failure(res, "invalid");
      const exact = scope(req, res);
      if (!exact) return failure(res, "invalid");
      const kind = req.body.lookupKind as "key" | "grant",
        value = req.body.lookupValue;
      return ready(
        res,
        await store!.inspect(res.locals.circleGrantCredential, exact, {
          kind,
          value,
        }),
        (record) =>
          circleGrantReceiptPage(
            res.locals.csrf,
            exact,
            record,
            kind === "key" ? value : undefined,
          ),
        false,
        undefined,
        exact,
      );
    }),
  );
  app.post(
    `${base}/history`,
    route(async (req, res) => {
      if (
        !empty(req) ||
        !fields(req.body, ["csrf", "staffId", "circleId", "after"])
      )
        return failure(res, "invalid");
      const exact = scope(req, res);
      if (!exact) return failure(res, "invalid");
      return ready(
        res,
        await store!.history(
          res.locals.circleGrantCredential,
          exact,
          req.body.after,
        ),
        (value) => circleGrantHistoryPage(res.locals.csrf, value),
        false,
        undefined,
        exact,
      );
    }),
  );
  app.post(
    `${base}/revoke`,
    route(async (req, res) => {
      if (
        !empty(req) ||
        !fields(req.body, [
          "csrf",
          "staffId",
          "circleId",
          "grantId",
          "confirm",
        ]) ||
        !circleGrantId(req.body.grantId)
      )
        return failure(res, "invalid");
      const exact = scope(req, res);
      if (!exact) return failure(res, "invalid");
      if (req.body.confirm !== "yes") return failure(res, "denied");
      return ready(
        res,
        await store!.revoke(
          res.locals.circleGrantCredential,
          exact,
          req.body.grantId,
        ),
        (value) => circleGrantReceiptPage(res.locals.csrf, exact, value),
        true,
        undefined,
        exact,
      );
    }),
  );
}
