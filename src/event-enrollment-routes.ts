import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { EventEnrollmentStore } from "./event-enrollments.ts";
import {
  eventEnrollmentPage,
  eventEnrollmentReceiptPage,
  eventEnrollmentHistoryPage,
  eventEnrollmentRecovery,
  eventReceiptPath,
} from "./event-enrollment-views.ts";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const version = (value: unknown) =>
  typeof value === "string" && /^[1-9][0-9]{0,6}$/.test(value)
    ? Number(value)
    : NaN;
function fields(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}
export function mountEventEnrollmentRoutes(
  app: Express,
  store: EventEnrollmentStore,
) {
  const wrap =
    (handler: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch {
        const attempted = fields(req.body) ? req.body.operation_id : undefined;
        const id =
          typeof req.params.id === "string" ? req.params.id : undefined;
        const receipt =
          attempted && uuid.test(attempted)
            ? attempted
            : id && uuid.test(id)
              ? id
              : undefined;
        res
          .status(503)
          .send(
            eventEnrollmentRecovery(
              "The result cannot be confirmed. A write may have committed; inspect its saved state.",
              receipt,
            ),
          );
      }
    };
  app.get(
    "/events/registrations",
    wrap(async (req, res) => {
      if (
        !fields(req.query) ||
        Object.keys(req.query).some((key) => key !== "after")
      )
        return res
          .status(404)
          .send(eventEnrollmentRecovery("Registration history unavailable."));
      const result = await store.history(
        res.locals.token as string,
        req.query.after,
      );
      if (!result)
        return res
          .status(404)
          .send(eventEnrollmentRecovery("Registration history unavailable."));
      res.send(eventEnrollmentHistoryPage(result));
    }),
  );
  app.get(
    "/events/registrations/:id",
    wrap(async (req, res) => {
      const result = await store.receipt(
        res.locals.token as string,
        String(req.params.id),
      );
      if (!result)
        return res
          .status(404)
          .send(
            eventEnrollmentRecovery(
              "This registration is unavailable to the current session.",
            ),
          );
      res.send(
        eventEnrollmentReceiptPage(
          result,
          res.locals.csrf as string,
          res.locals.learner.timezone,
        ),
      );
    }),
  );
  app.get(
    "/events/:eventId/:version/rehearsal",
    wrap(async (req, res) => {
      const result = await store.preview(
        res.locals.token as string,
        String(req.params.eventId),
        version(req.params.version),
      );
      if (!result)
        return res
          .status(404)
          .send(
            eventEnrollmentRecovery("This event rehearsal is unavailable."),
          );
      res.send(
        eventEnrollmentPage(
          result,
          res.locals.csrf as string,
          randomUUID(),
          res.locals.learner.timezone,
        ),
      );
    }),
  );
  app.post(
    "/events/:eventId/:version/enroll",
    wrap(async (req, res) => {
      const token = res.locals.token as string,
        id = String(req.params.eventId),
        v = version(req.params.version);
      const preview = await store.preview(token, id, v);
      // Preserve refusal for discovery-only fixtures; a posted form never grants opt-in.
      if (!preview?.event.localRegistration)
        return res
          .status(404)
          .send(
            eventEnrollmentRecovery("This event rehearsal is unavailable."),
          );
      if (
        !fields(req.body) ||
        req.body.synthetic !== "yes" ||
        !uuid.test(req.body.operation_id ?? "") ||
        Object.keys(req.body).some(
          (key) => !["csrf", "synthetic", "operation_id"].includes(key),
        )
      )
        return res
          .status(422)
          .send(
            eventEnrollmentRecovery(
              "Confirm the local rehearsal and refresh its enrollment form.",
            ),
          );
      const result = await store.enroll(token, id, v, req.body.operation_id!);
      if ("receiptId" in result)
        return res.redirect(303, eventReceiptPath(result.receiptId));
      res
        .status(
          result.kind === "full" || result.kind === "conflict" ? 409 : 404,
        )
        .send(
          eventEnrollmentRecovery(
            result.kind === "full"
              ? "This local rehearsal is full. No seat was reserved."
              : result.kind === "conflict"
                ? "This attempt belongs to a different event version."
                : "New registration is unavailable.",
          ),
        );
    }),
  );
  app.post(
    "/events/registrations/:id/withdraw",
    wrap(async (req, res) => {
      if (
        !fields(req.body) ||
        req.body.confirm !== "yes" ||
        Object.keys(req.body).some((key) => !["csrf", "confirm"].includes(key))
      )
        return res
          .status(422)
          .send(
            eventEnrollmentRecovery(
              "Confirm withdrawal of this exact registration.",
            ),
          );
      const id = String(req.params.id),
        result = await store.withdraw(res.locals.token as string, id);
      if (result === "unavailable")
        return res
          .status(404)
          .send(
            eventEnrollmentRecovery(
              "This registration is unavailable to the current session.",
            ),
          );
      res.redirect(303, eventReceiptPath(id));
    }),
  );
}
