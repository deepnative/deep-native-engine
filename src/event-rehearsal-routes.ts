import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { ApplicationMode } from "./adapters.ts";
import { staffCookie, staffCredential } from "./staff-entry-selection.ts";
import {
  eventCancellationId,
  type EventCancellationResult,
} from "./event-cancellation-values.ts";
import {
  rehearsalSnapshot,
  checkedRehearsalSnapshot,
  type EventRehearsalStore,
} from "./event-rehearsal-values.ts";
import {
  eventRehearsalHome,
  eventRehearsalConfirm,
  eventRehearsalReceipt,
  eventRehearsalNotice,
  type RehearsalAttempt,
} from "./event-rehearsal-views.ts";
const base = "/operator/event-rehearsals";
const fields = (
  value: unknown,
  allowed: string[],
): value is Record<string, string> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.entries(value).every(
    ([key, v]) =>
      allowed.includes(key) && typeof v === "string" && v.length <= 200,
  );
const core = ["templateId", "templateVersion", "startsAt"],
  full = [...core, "title", "endsAt", "capacity", "templateDigest"];
const messages = {
  denied:
    "Current selected platform-administrator access is required. No new schedule is confirmed.",
  invalid:
    "Check the exact trusted template, canonical UTC start and checked instruction. Nothing was accepted from this invalid form.",
  conflict:
    "The original key belongs to a different creator or instruction. It cannot replace a saved event.",
  unavailable:
    "The result cannot be confirmed. Scheduling may already have committed. Inspect saved state before manually repeating the exact original instruction.",
};
export function mountEventRehearsalRoutes(
  app: Express,
  store: EventRehearsalStore | undefined,
  options: { mode?: ApplicationMode; localStaffEntry?: boolean },
) {
  const failure = (
    res: Response,
    kind: keyof typeof messages,
    attempt?: RehearsalAttempt,
  ) =>
    res
      .status(
        { denied: 403, invalid: 422, conflict: 409, unavailable: 503 }[kind],
      )
      .send(
        eventRehearsalNotice(
          res.locals.csrf ?? "",
          messages[kind],
          kind === "unavailable" ? attempt : undefined,
        ),
      );
  app.use(base, (req, res, next) => {
    if (!store || !options.localStaffEntry || options.mode === "live")
      return res
        .status(404)
        .send(
          eventRehearsalNotice(
            "",
            "Local rehearsal scheduling is unavailable in this configuration.",
          ),
        );
    const selected = staffCookie(req.headers.cookie);
    if (selected.kind !== "value" || !staffCredential(selected.value))
      return failure(res, "denied");
    res.locals.rehearsalCredential = selected.value;
    next();
  });
  const empty = (req: Request) => fields(req.query, []);
  const instruction = (body: Record<string, string>) => ({
    templateId: body.templateId,
    templateVersion: /^[1-9][0-9]{0,6}$/.test(body.templateVersion ?? "")
      ? Number(body.templateVersion)
      : NaN,
    startsAt: body.startsAt,
  });
  function parse(
    req: Pick<Request, "query" | "body">,
    checked: boolean,
  ): RehearsalAttempt | null {
    if (
      !fields(req.query, []) ||
      !fields(req.body, ["csrf", "key", ...(checked ? full : core)]) ||
      !eventCancellationId(req.body.key)
    )
      return null;
    const snapshot = checked
      ? checkedRehearsalSnapshot({
          ...instruction(req.body),
          title: req.body.title,
          endsAt: req.body.endsAt,
          capacity: /^[1-9][0-9]{0,2}$/.test(req.body.capacity ?? "")
            ? Number(req.body.capacity)
            : NaN,
          templateDigest: req.body.templateDigest,
        })
      : rehearsalSnapshot(instruction(req.body));
    return snapshot ? { key: req.body.key, snapshot } : null;
  }
  const ready = <T>(
    res: Response,
    result: EventCancellationResult<T>,
    render: (value: T) => string,
    writing = false,
    attempt?: RehearsalAttempt,
  ) => {
    if (result.kind !== "ready") return failure(res, result.kind, attempt);
    const expired = () =>
      !Number.isFinite(result.deadline) || performance.now() >= result.deadline;
    if (expired())
      return failure(res, writing ? "unavailable" : "denied", attempt);
    const html = render(result.value);
    if (expired())
      return failure(res, writing ? "unavailable" : "denied", attempt);
    return res.send(html);
  };
  const route =
    (handler: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch {
        failure(res, "unavailable", res.locals.rehearsalAttempt);
      }
    };
  app.get(
    base,
    route(async (req, res) => {
      if (!empty(req)) return failure(res, "invalid");
      return ready(
        res,
        await store!.admin(res.locals.rehearsalCredential),
        (value) => eventRehearsalHome(res.locals.csrf, value.creationEnabled),
      );
    }),
  );
  app.post(
    `${base}/check`,
    route(async (req, res) => {
      if (!empty(req) || !fields(req.body, ["csrf", ...core]))
        return failure(res, "invalid");
      return ready(
        res,
        await store!.preview(
          res.locals.rehearsalCredential,
          instruction(req.body),
        ),
        (value) =>
          eventRehearsalConfirm(
            res.locals.csrf,
            { key: randomUUID(), snapshot: value.snapshot },
            value.creationEnabled,
          ),
      );
    }),
  );
  app.post(
    `${base}/schedule`,
    route(async (req, res) => {
      if (
        !empty(req) ||
        !fields(req.body, ["csrf", "key", ...full, "confirm"]) ||
        req.body.confirm !== "yes"
      )
        return failure(res, "invalid");
      const body = { ...req.body };
      delete body.confirm;
      const attempt = parse({ query: req.query, body }, true);
      if (!attempt) return failure(res, "invalid");
      res.locals.rehearsalAttempt = attempt;
      return ready(
        res,
        await store!.schedule(
          res.locals.rehearsalCredential,
          attempt.key,
          attempt.snapshot,
        ),
        (value) => eventRehearsalReceipt(value.receipt),
        true,
        attempt,
      );
    }),
  );
  app.post(
    `${base}/inspect`,
    route(async (req, res) => {
      const attempt = parse(
        req,
        Object.hasOwn(req.body ?? {}, "templateDigest"),
      );
      if (!attempt) return failure(res, "invalid");
      res.locals.rehearsalAttempt = attempt;
      return ready(
        res,
        await store!.inspectOperation(
          res.locals.rehearsalCredential,
          attempt.key,
          attempt.snapshot,
        ),
        (value) => eventRehearsalReceipt(value),
        false,
        attempt,
      );
    }),
  );
  app.get(
    `${base}/receipts/:id`,
    route(async (req, res) => {
      if (!empty(req) || !eventCancellationId(req.params.id))
        return failure(res, "invalid");
      return ready(
        res,
        await store!.receipt(res.locals.rehearsalCredential, req.params.id),
        (value) => eventRehearsalReceipt(value),
      );
    }),
  );
}
