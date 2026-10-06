import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { ApplicationMode } from "./adapters.ts";
import type {
  AssignmentResult,
  SupportAssignmentStore,
} from "./support-assignment.ts";
import { assignmentId } from "./support-assignment-cursor.ts";
import { staffCookie, staffCredential } from "./staff-entry-selection.ts";
import {
  assignmentHomePage,
  assignmentReferencePage,
  assignmentConfirmPage,
  assignmentHistoryPage,
  assignmentReceiptPage,
  assignmentNoticePage,
  type AssignmentAttempt,
  type AssignmentRecovery,
} from "./support-assignment-views.ts";
const base = "/operator/support-assignment";
const fields = (
  value: unknown,
  allowed: string[],
  maximum = 200,
): value is Record<string, string> =>
  !!value &&
  typeof value === "object" &&
  Object.entries(value).every(
    ([key, item]) =>
      allowed.includes(key) &&
      typeof item === "string" &&
      item.length <= maximum,
  );
function utc(value: unknown): Date | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return null;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString() === value ? date : null;
}
const messages = {
  denied:
    "This exact assignment action is not available to the current staff session. Check your staff sign-in and the supplied references.",
  invalid:
    "The requested expiry exceeds the current operator credential expiry. Check the exact references again and confirm a valid UTC window; the submitted window was not shortened.",
  conflict:
    "This original submission key conflicts with its saved payload or a revoked grant. Inspect the saved state; it cannot restore a revoked assignment.",
  unavailable:
    "The result cannot be confirmed and a submitted change may already have committed. Inspect saved state before deciding whether to retry this exact submission. Nothing is retried automatically.",
};
/** Mounted after the application's selected-staff CSRF/Origin and Host checks.
 * This new surface additionally requires explicit staff selection, including
 * when legacy administrator cookies remain usable at older destinations. */
export function mountSupportAssignmentRoutes(
  app: Express,
  store: SupportAssignmentStore | undefined,
  options: {
    localSupportAssignment?: boolean;
    localStaffEntry?: boolean;
    mode?: ApplicationMode;
  },
) {
  function failure(
    res: Response,
    kind: keyof typeof messages,
    recovery?: AssignmentRecovery,
    attempt?: AssignmentAttempt,
  ) {
    return res
      .status(
        { denied: 403, invalid: 422, conflict: 409, unavailable: 503 }[kind],
      )
      .send(
        assignmentNoticePage(
          messages[kind],
          kind === "denied" ? undefined : recovery,
          kind === "unavailable" ? attempt : undefined,
          res.locals.csrf,
        ),
      );
  }
  app.use([base, "/operator/assignment-id"], (req, res, next) => {
    if (
      !options.localSupportAssignment ||
      !options.localStaffEntry ||
      options.mode === "live" ||
      !store
    )
      return res
        .status(404)
        .send(
          assignmentNoticePage(
            "Local support assignment administration is unavailable in this configuration.",
          ),
        );
    const selected = staffCookie(req.headers.cookie);
    if (selected.kind !== "value" || !staffCredential(selected.value))
      return failure(res, "denied");
    res.locals.assignmentCredential = selected.value;
    next();
  });
  function ready<T>(
    res: Response,
    result: AssignmentResult<T>,
    render: (value: T) => string,
    writing = false,
    recovery?: AssignmentRecovery,
    attempt?: AssignmentAttempt,
  ) {
    if (result.kind !== "ready")
      return failure(res, result.kind, recovery, attempt);
    const body = render(result.value);
    if (
      !Number.isFinite(result.deadline) ||
      performance.now() >= result.deadline
    )
      return failure(
        res,
        writing ? "unavailable" : "denied",
        recovery,
        attempt,
      );
    return res.send(body);
  }
  const route =
    (handler: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch {
        failure(res, "unavailable");
      }
    };
  const empty = (req: Request) => fields(req.query, []);
  app.get(
    base,
    route(async (req, res) => {
      if (!empty(req)) return failure(res, "denied");
      return ready(
        res,
        await store!.admin(res.locals.assignmentCredential),
        () => assignmentHomePage(res.locals.csrf),
      );
    }),
  );
  app.get(
    "/operator/assignment-id",
    route(async (req, res) => {
      if (!empty(req)) return failure(res, "denied");
      return ready(
        res,
        await store!.reference(res.locals.assignmentCredential),
        assignmentReferencePage,
      );
    }),
  );
  app.post(
    `${base}/check`,
    route(async (req, res) => {
      if (
        !empty(req) ||
        !fields(req.body, ["csrf", "requestId", "staffId"]) ||
        !assignmentId(req.body.requestId) ||
        !assignmentId(req.body.staffId)
      )
        return failure(res, "denied");
      return ready(
        res,
        await store!.check(
          res.locals.assignmentCredential,
          req.body.requestId,
          req.body.staffId,
        ),
        (value) =>
          assignmentConfirmPage(
            res.locals.csrf,
            {
              requestId: value.requestId,
              staffId: value.staffId,
              idempotencyKey: randomUUID(),
              startsAt: "",
              expiresAt: "",
            },
            value.expiresAt,
          ),
      );
    }),
  );
  app.get(
    `${base}/history`,
    route(async (req, res) => {
      if (
        !fields(req.query, ["requestId", "after", "key"]) ||
        !assignmentId(req.query.requestId)
      )
        return failure(res, "denied");
      const key = req.query.key === "" ? undefined : req.query.key;
      if (
        (key !== undefined && !assignmentId(key)) ||
        (key !== undefined && req.query.after !== undefined)
      )
        return failure(res, "denied");
      return ready(
        res,
        await store!.history(
          res.locals.assignmentCredential,
          req.query.requestId,
          req.query.after,
          key,
        ),
        (value) => assignmentHistoryPage(res.locals.csrf, value, key),
      );
    }),
  );
  app.post(
    `${base}/assign`,
    route(async (req, res) => {
      if (
        !empty(req) ||
        !fields(req.body, [
          "csrf",
          "requestId",
          "staffId",
          "idempotencyKey",
          "startsAt",
          "expiresAt",
          "confirm",
        ]) ||
        ![req.body.requestId, req.body.staffId, req.body.idempotencyKey].every(
          assignmentId,
        ) ||
        req.body.confirm !== "yes"
      )
        return failure(res, "denied");
      const startsAt = utc(req.body.startsAt),
        expiresAt = utc(req.body.expiresAt);
      if (!startsAt || !expiresAt || expiresAt <= startsAt)
        return failure(res, "denied");
      const attempt: AssignmentAttempt = {
          requestId: req.body.requestId!,
          staffId: req.body.staffId!,
          idempotencyKey: req.body.idempotencyKey!,
          startsAt: req.body.startsAt!,
          expiresAt: req.body.expiresAt!,
        },
        recovery = {
          requestId: attempt.requestId,
          key: attempt.idempotencyKey,
        };
      try {
        return ready(
          res,
          await store!.assign(res.locals.assignmentCredential, {
            ...attempt,
            startsAt,
            expiresAt,
          }),
          (value) =>
            assignmentReceiptPage(
              "Support assignment recorded",
              value,
              attempt.idempotencyKey,
            ),
          true,
          recovery,
          attempt,
        );
      } catch {
        return failure(res, "unavailable", recovery, attempt);
      }
    }),
  );
  app.post(
    `${base}/revoke`,
    route(async (req, res) => {
      if (
        !empty(req) ||
        !fields(req.body, ["csrf", "requestId", "grantId", "confirm"]) ||
        !assignmentId(req.body.requestId) ||
        !assignmentId(req.body.grantId) ||
        req.body.confirm !== "yes"
      )
        return failure(res, "denied");
      const recovery = { requestId: req.body.requestId };
      try {
        return ready(
          res,
          await store!.revoke(
            res.locals.assignmentCredential,
            req.body.requestId,
            req.body.grantId,
          ),
          (value) => assignmentReceiptPage("Support assignment revoked", value),
          true,
          recovery,
        );
      } catch {
        return failure(res, "unavailable", recovery);
      }
    }),
  );
}
