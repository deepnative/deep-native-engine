import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import {
  supportTextValid,
  type SupportRequestStore,
} from "./support-requests.ts";
import {
  supportIntakePage,
  supportIntakeRecoveryPage,
  supportMemberDetailPage,
  supportNoticePage,
  supportOperatorDetailPage,
  supportOperatorWorklistPage,
  supportOwnerHistoryPage,
  type SupportFormError,
  type SupportOperatorKeys,
} from "./support-request-views.ts";

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const fields = (
  value: unknown,
  allowed: string[],
): value is Record<string, string> =>
  !!value &&
  typeof value === "object" &&
  Object.entries(value).every(
    ([key, item]) => allowed.includes(key) && typeof item === "string",
  );
const operatorKeys = (): SupportOperatorKeys => ({
  acknowledge: randomUUID(),
  reply: randomUUID(),
  note: randomUUID(),
  resolve: randomUUID(),
});
const attempt = (req: Request) => ({
  subject: typeof req.body?.subject === "string" ? req.body.subject : "",
  body: typeof req.body?.body === "string" ? req.body.body : "",
  synthetic: req.body?.synthetic === "yes",
});
const unavailable =
  "The support result cannot be confirmed. Inspect the saved state before deciding what to do next. Nothing is retried automatically.";
function notice(
  res: Response,
  status: number,
  message: string,
  href = "/support",
) {
  return res
    .status(status)
    .send(
      supportNoticePage(
        "Support request unavailable",
        message,
        href,
        "Inspect saved support state",
      ),
    );
}
function resultFailure(
  res: Response,
  kind: "denied" | "unavailable" | "withdrawn" | "conflict",
  href: string,
) {
  const status = {
    denied: 403,
    unavailable: 503,
    withdrawn: 410,
    conflict: 409,
  }[kind];
  const message = {
    denied: "This support action is not available to this session.",
    unavailable,
    withdrawn:
      "This request was withdrawn. Its text and messages are no longer available.",
    conflict:
      "This action conflicts with the saved request state or its original submission. Inspect that state; do not automatically resubmit.",
  }[kind];
  return notice(res, status, message, href);
}
function queryValid(req: Request, allowed: string[]) {
  return fields(req.query, allowed);
}

/** The host applies session/CSRF middleware and the support-only body parser before mounting. */
export function mountSupportRequestRoutes(
  app: Express,
  store: SupportRequestStore,
) {
  const route =
    (handler: (req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch {
        notice(
          res,
          503,
          unavailable,
          req.path.startsWith("/operator/") ? "/operator/support" : "/support",
        );
      }
    };
  app.get(
    "/support/new",
    route((req, res) => {
      if (!queryValid(req, []))
        return notice(res, 400, "Unexpected support query fields.");
      return res.send(supportIntakePage(res.locals.csrf, randomUUID()));
    }),
  );
  app.get(
    "/support",
    route(async (req, res) => {
      if (!queryValid(req, ["after"]))
        return notice(res, 400, "Unexpected support query fields.");
      const result = await store.ownerHistory(
        res.locals.token,
        req.query.after as string | undefined,
      );
      return result.kind === "ready"
        ? res.send(supportOwnerHistoryPage(result.value))
        : resultFailure(res, result.kind, "/support");
    }),
  );
  app.post(
    "/support",
    route(async (req, res) => {
      const attempted = attempt(req);
      const key = uuid(req.body?.idempotencyKey)
        ? req.body.idempotencyKey
        : randomUUID();
      const errors: SupportFormError[] = [];
      if (
        !queryValid(req, []) ||
        !fields(req.body, [
          "csrf",
          "idempotencyKey",
          "subject",
          "body",
          "synthetic",
        ]) ||
        typeof req.body.csrf !== "string" ||
        !uuid(req.body.idempotencyKey)
      )
        errors.push({
          field: "support-form",
          message:
            "Use the request form with its original valid receipt key and expected fields.",
        });
      if (!supportTextValid(attempted.subject, 120))
        errors.push({
          field: "subject",
          message:
            "Enter a nonblank subject of at most 120 characters without invalid text characters.",
        });
      if (!supportTextValid(attempted.body, 2000))
        errors.push({
          field: "body",
          message:
            "Enter a nonblank sample request of at most 2,000 characters without invalid text characters.",
        });
      if (!attempted.synthetic)
        errors.push({
          field: "synthetic",
          message: "Confirm that you used only invented or sample information.",
        });
      if (errors.length)
        return res
          .status(422)
          .send(supportIntakePage(res.locals.csrf, key, attempted, errors));
      let result: Awaited<ReturnType<SupportRequestStore["create"]>>;
      try {
        result = await store.create(res.locals.token, {
          idempotencyKey: key,
          subject: attempted.subject,
          body: attempted.body,
        });
      } catch {
        return res
          .status(503)
          .send(supportIntakeRecoveryPage(key, attempted, unavailable));
      }
      if ("receipt" in result)
        return res.redirect(303, `/support/${result.receipt.requestId}`);
      if (result.kind === "invalid")
        return res.status(422).send(
          supportIntakePage(res.locals.csrf, key, attempted, [
            {
              field:
                result.field === "idempotencyKey"
                  ? "support-form"
                  : result.field,
              message: "Check this field before sending the request.",
            },
          ]),
        );
      if (result.kind === "denied")
        return resultFailure(res, result.kind, "/support");
      return res
        .status(result.kind === "unavailable" ? 503 : 409)
        .send(
          supportIntakeRecoveryPage(
            key,
            attempted,
            result.kind === "unavailable"
              ? unavailable
              : "The original submission cannot be changed or repeated in the current saved state. Inspect its receipt.",
          ),
        );
    }),
  );
  app.get(
    "/support/receipts/:intakeKey",
    route(async (req, res) => {
      if (!queryValid(req, []) || !uuid(req.params.intakeKey))
        return notice(res, 400, "Use the original request receipt link.");
      const result = await store.receipt(
        res.locals.token,
        req.params.intakeKey,
      );
      if (result.kind === "found")
        return res.redirect(303, `/support/${result.receipt.requestId}`);
      if (result.kind === "missing")
        return notice(
          res,
          404,
          "No saved receipt was found for this original submission key. Nothing was submitted by this lookup.",
        );
      return resultFailure(res, result.kind, "/support");
    }),
  );
  app.get(
    "/support/:id",
    route(async (req, res) => {
      if (!queryValid(req, ["after"]) || !uuid(req.params.id))
        return notice(res, 400, "Use a valid support receipt link.");
      const result = await store.memberDetail(
        res.locals.token,
        req.params.id,
        req.query.after as string | undefined,
      );
      return result.kind === "ready"
        ? res.send(supportMemberDetailPage(result.value, res.locals.csrf))
        : resultFailure(res, result.kind, "/support");
    }),
  );
  app.post(
    "/support/:id/withdraw",
    route(async (req, res) => {
      if (
        !queryValid(req, []) ||
        !uuid(req.params.id) ||
        !fields(req.body, ["csrf", "confirm"]) ||
        typeof req.body.csrf !== "string" ||
        req.body.confirm !== "yes"
      )
        return notice(
          res,
          422,
          "Use the withdrawal form and confirm removal of this request's text.",
        );
      const result = await store.withdraw(res.locals.token, req.params.id);
      return result.kind === "withdrawn" || result.kind === "already-withdrawn"
        ? res.redirect(303, `/support/${req.params.id}`)
        : resultFailure(res, result.kind, "/support");
    }),
  );
  app.get(
    "/operator/support",
    route(async (req, res) => {
      if (!queryValid(req, ["after"]))
        return notice(
          res,
          400,
          "Unexpected support query fields.",
          "/operator/support",
        );
      const result = await store.operatorWorklist(
        res.locals.token,
        req.query.after as string | undefined,
      );
      return result.kind === "ready"
        ? res.send(supportOperatorWorklistPage(result.value))
        : resultFailure(res, result.kind, "/operator/support");
    }),
  );
  app.get(
    "/operator/support/:id",
    route(async (req, res) => {
      if (
        !queryValid(req, ["grant", "after"]) ||
        !uuid(req.params.id) ||
        !uuid(req.query.grant)
      )
        return notice(
          res,
          400,
          "Use a current exact-granted request link.",
          "/operator/support",
        );
      const result = await store.operatorDetail(
        res.locals.token,
        { requestId: req.params.id, grantId: req.query.grant },
        req.query.after as string | undefined,
      );
      return result.kind === "ready"
        ? res.send(
            supportOperatorDetailPage(
              result.value,
              res.locals.csrf,
              operatorKeys(),
            ),
          )
        : resultFailure(res, result.kind, "/operator/support");
    }),
  );
  for (const action of ["acknowledge", "reply", "note", "resolve"] as const) {
    const path =
      action === "reply" ? "replies" : action === "note" ? "notes" : action;
    const messageAction = action === "reply" || action === "note";
    app.post(
      `/operator/support/:id/${path}`,
      route(async (req, res) => {
        if (
          !queryValid(req, []) ||
          !uuid(req.params.id) ||
          !fields(
            req.body,
            messageAction
              ? ["csrf", "grantId", "idempotencyKey", "confirm", "body"]
              : ["csrf", "grantId", "idempotencyKey", "confirm"],
          ) ||
          typeof req.body.csrf !== "string" ||
          !uuid(req.body.grantId) ||
          !uuid(req.body.idempotencyKey) ||
          req.body.confirm !== "yes" ||
          (messageAction && typeof req.body.body !== "string")
        )
          return notice(
            res,
            422,
            "Use the current exact-granted action form and confirm its intended visibility.",
            "/operator/support",
          );
        const scope = { requestId: req.params.id, grantId: req.body.grantId };
        const href = `/operator/support/${scope.requestId}?grant=${scope.grantId}`;
        const result = messageAction
          ? await store[action](
              res.locals.token,
              scope,
              req.body.idempotencyKey,
              req.body.body!,
            )
          : await store[action](
              res.locals.token,
              scope,
              req.body.idempotencyKey,
            );
        if ("receipt" in result) return res.redirect(303, href);
        if (result.kind !== "invalid")
          return resultFailure(res, result.kind, href);
        const current = await store.operatorDetail(res.locals.token, scope);
        if (current.kind !== "ready")
          return resultFailure(res, current.kind, "/operator/support");
        if (current.value.resolvedAt)
          return resultFailure(res, "conflict", href);
        const keys = operatorKeys();
        keys[action] = req.body.idempotencyKey;
        return res.status(422).send(
          supportOperatorDetailPage(current.value, res.locals.csrf, keys, {
            kind: action as "reply" | "note",
            body: req.body.body!,
            message:
              "Enter a nonblank message of at most 2,000 characters without invalid text characters.",
          }),
        );
      }),
    );
  }
}
