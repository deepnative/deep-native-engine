import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { ApplicationMode } from "./adapters.ts";
import { staffCookie, staffCredential } from "./staff-entry-selection.ts";
import {
  eventCancellationId,
  eventCancellationScope,
  type EventCancellationAttempt,
  type EventCancellationResult,
  type EventCancellationScope,
  type EventCancellationStore,
} from "./event-cancellation-values.ts";
import {
  eventCancellationConfirm,
  eventCancellationHome,
  eventCancellationNotice,
  eventCancellationReceipt,
} from "./event-cancellation-views.ts";
const base = "/operator/event-cancellations";
const fields = (
  value: unknown,
  allowed: string[],
): value is Record<string, string> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.entries(value).every(
    ([k, v]) => allowed.includes(k) && typeof v === "string" && v.length <= 200,
  );
const messages = {
  denied:
    "Current selected platform-administrator access is required. No new cancellation is confirmed.",
  invalid:
    "Check the exact event reference, checked snapshot and original key. Nothing was accepted from this invalid form.",
  conflict:
    "This key or checked event snapshot conflicts with the retained instruction. It cannot replace the original event or outcome.",
  unavailable:
    "The result cannot be confirmed. Cancellation may already have committed. Inspect saved state before manually repeating the exact original instruction.",
};
export function mountEventCancellationRoutes(
  app: Express,
  store: EventCancellationStore | undefined,
  options: { mode?: ApplicationMode; localStaffEntry?: boolean },
) {
  const failure = (
    res: Response,
    kind: keyof typeof messages,
    attempt?: EventCancellationAttempt,
  ) =>
    res
      .status(
        { denied: 403, invalid: 422, conflict: 409, unavailable: 503 }[kind],
      )
      .send(
        eventCancellationNotice(
          res.locals.csrf,
          messages[kind],
          kind === "unavailable" ? attempt : undefined,
        ),
      );
  app.use(base, (req, res, next) => {
    if (!store || !options.localStaffEntry || options.mode === "live")
      return res
        .status(404)
        .send(
          eventCancellationNotice(
            "",
            "Local event cancellation is unavailable in this configuration.",
          ),
        );
    const selected = staffCookie(req.headers.cookie);
    if (selected.kind !== "value" || !staffCredential(selected.value))
      return failure(res, "denied");
    res.locals.eventCancellationCredential = selected.value;
    next();
  });
  const empty = (req: Request) => fields(req.query, []);
  const scope = (
    body: Record<string, string>,
  ): EventCancellationScope | null => {
    if (!/^[1-9][0-9]{0,6}$/.test(body.eventVersion ?? "")) return null;
    const value = {
      eventId: body.eventId!,
      eventVersion: Number(body.eventVersion),
    };
    return eventCancellationScope(value) ? value : null;
  };
  const ready = <T>(
    res: Response,
    result: EventCancellationResult<T>,
    render: (v: T) => string,
    writing = false,
    attempt?: EventCancellationAttempt,
  ) => {
    if (result.kind !== "ready") return failure(res, result.kind, attempt);
    const expired = () =>
      !Number.isFinite(result.deadline) || performance.now() >= result.deadline;
    if (expired())
      return failure(res, writing ? "unavailable" : "denied", attempt);
    const body = render(result.value);
    if (expired())
      return failure(res, writing ? "unavailable" : "denied", attempt);
    return res.send(body);
  };
  const route =
    (handler: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch {
        failure(res, "unavailable", res.locals.eventCancellationAttempt);
      }
    };
  app.get(
    base,
    route(async (req, res) => {
      if (!empty(req)) return failure(res, "invalid");
      return ready(
        res,
        await store!.admin(res.locals.eventCancellationCredential),
        (value) =>
          eventCancellationHome(res.locals.csrf, value.creationEnabled),
      );
    }),
  );
  app.post(
    `${base}/check`,
    route(async (req, res) => {
      if (!empty(req) || !fields(req.body, ["csrf", "eventId", "eventVersion"]))
        return failure(res, "invalid");
      const exact = scope(req.body);
      if (!exact) return failure(res, "invalid");
      return ready(
        res,
        await store!.preview(res.locals.eventCancellationCredential, exact),
        (value) =>
          eventCancellationConfirm(res.locals.csrf, value, {
            ...exact,
            key: randomUUID(),
            title: value.event.title,
            startsAt: value.event.startsAt,
            endsAt: value.event.endsAt,
            capacity: value.event.fixtureCapacity,
          }),
      );
    }),
  );
  app.post(
    `${base}/cancel`,
    route(async (req, res) => {
      if (
        !empty(req) ||
        !fields(req.body, [
          "csrf",
          "eventId",
          "eventVersion",
          "key",
          "title",
          "startsAt",
          "endsAt",
          "capacity",
          "confirm",
        ])
      )
        return failure(res, "invalid");
      const exact = scope(req.body),
        validUtc = (v: unknown) =>
          typeof v === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
          Number.isFinite(Date.parse(v)) &&
          new Date(v).toISOString() === v;
      if (
        !exact ||
        !eventCancellationId(req.body.key) ||
        !req.body.title ||
        !validUtc(req.body.startsAt) ||
        !validUtc(req.body.endsAt) ||
        !/^[1-9][0-9]{0,2}$/.test(req.body.capacity ?? "") ||
        Number(req.body.capacity) > 100
      )
        return failure(res, "invalid");
      if (req.body.confirm !== "yes") return failure(res, "denied");
      const attempt: EventCancellationAttempt = {
        ...exact,
        key: req.body.key,
        title: req.body.title,
        startsAt: req.body.startsAt!,
        endsAt: req.body.endsAt!,
        capacity: Number(req.body.capacity),
      };
      res.locals.eventCancellationAttempt = attempt;
      return ready(
        res,
        await store!.cancel(
          res.locals.eventCancellationCredential,
          exact,
          attempt.key,
          attempt,
        ),
        (value) =>
          eventCancellationReceipt(
            res.locals.csrf,
            exact,
            value.receipt,
            attempt.key,
          ),
        true,
        attempt,
      );
    }),
  );
  app.post(
    `${base}/inspect`,
    route(async (req, res) => {
      if (
        !empty(req) ||
        !fields(req.body, ["csrf", "eventId", "eventVersion", "key"])
      )
        return failure(res, "invalid");
      const exact = scope(req.body),
        key = req.body.key ?? "";
      if (!exact || (key !== "" && !eventCancellationId(key)))
        return failure(res, "invalid");
      const result = key
        ? await store!.inspectOperation(
            res.locals.eventCancellationCredential,
            exact,
            key,
          )
        : await store!.inspect(res.locals.eventCancellationCredential, exact);
      return ready(res, result, (value) =>
        eventCancellationReceipt(res.locals.csrf, exact, value, key),
      );
    }),
  );
}
