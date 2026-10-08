import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { ApplicationMode } from "./adapters.ts";
import type { EventCancellationResult } from "./event-cancellation-values.ts";
import type { EventAttendanceRuntimeStore } from "./event-attendance.ts";
import {
  attendanceChecked,
  attendanceId,
  attendanceObservationChecked,
  attendanceRemovalChecked,
  type AttendanceSavedReceipt,
} from "./event-attendance-values.ts";
import { staffCookie, staffCredential } from "./staff-entry-selection.ts";
import {
  attendanceMemberPage,
  attendanceHistoryPage,
  attendanceNotice,
  attendanceObservationConfirm,
  attendancePath,
  attendancePermissionConfirm,
  attendanceRemovalConfirm,
  attendanceSavedPage,
  attendanceStaffHome,
  attendanceStaffReceipt,
  type AttendanceAttempt,
} from "./event-attendance-views.ts";

const memberBase = "/events/registrations/:id/attendance",
  staffBase = "/operator/event-attendance";
const fields = (
  value: unknown,
  allowed: string[],
): value is Record<string, string> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.entries(value).every(
    ([key, item]) =>
      allowed.includes(key) && typeof item === "string" && item.length <= 4096,
  );
const messages = {
  denied:
    "This exact attendance scope is unavailable to your current access. No private observation is disclosed.",
  invalid:
    "Check the exact reference and explicitly confirm the checked scope. This form was not accepted.",
  conflict:
    "This reference conflicts with the original instruction or saved observation. It cannot replace or renew that outcome.",
  unavailable:
    "The attendance result cannot be confirmed. A write may already have committed; inspect saved state before repeating the original instruction.",
};
export function mountEventAttendanceRoutes(
  app: Express,
  store: EventAttendanceRuntimeStore | undefined,
  options: { mode?: ApplicationMode; localStaffEntry?: boolean },
) {
  const failure = (
    res: Response,
    kind: keyof typeof messages,
    attempt?: AttendanceAttempt,
  ) =>
    res
      .status(
        { denied: 403, invalid: 422, conflict: 409, unavailable: 503 }[kind],
      )
      .send(
        attendanceNotice(
          res.locals.csrf ?? "",
          messages[kind],
          kind === "unavailable" ? attempt : undefined,
        ),
      );
  const ready = <T>(
    res: Response,
    result: EventCancellationResult<T>,
    render: (value: T, observedAt: Date) => string,
    writing = false,
  ) => {
    if (result.kind !== "ready")
      return failure(res, result.kind, res.locals.attendanceAttempt);
    const expired = () =>
      !Number.isFinite(result.deadline) || performance.now() >= result.deadline;
    if (expired())
      return failure(
        res,
        writing ? "unavailable" : "denied",
        res.locals.attendanceAttempt,
      );
    const body = render(result.value, result.observedAt);
    if (expired())
      return failure(
        res,
        writing ? "unavailable" : "denied",
        res.locals.attendanceAttempt,
      );
    return res.send(body);
  };
  const route =
    (use: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await use(req, res);
      } catch {
        failure(res, "unavailable", res.locals.attendanceAttempt);
      }
    };
  app.use([memberBase, staffBase], (req, res, next) => {
    if (!store || options.mode === "live")
      return res
        .status(404)
        .send(
          attendanceNotice(
            "",
            "Local rehearsal attendance is unavailable in this configuration.",
          ),
        );
    if (!fields(req.query, [])) return failure(res, "invalid");
    next();
  });
  app.use(staffBase, (req, res, next) => {
    if (!options.localStaffEntry)
      return res
        .status(404)
        .send(
          attendanceNotice("", "Local attendance staff entry is unavailable."),
        );
    const selected = staffCookie(req.headers.cookie);
    if (selected.kind !== "value" || !staffCredential(selected.value))
      return failure(res, "denied");
    res.locals.attendanceStaffToken = selected.value;
    next();
  });
  const submitted = (req: Request, res: Response) => {
    if (
      !fields(req.body, ["csrf", "confirm", "checked", "key"]) ||
      req.body.confirm !== "yes" ||
      !attendanceId(req.body.key)
    ) {
      failure(res, "invalid");
      return null;
    }
    try {
      return {
        key: req.body.key,
        checked: JSON.parse(req.body.checked ?? "") as unknown,
      };
    } catch {
      failure(res, "invalid");
      return null;
    }
  };
  const saved = (
    res: Response,
    result: EventCancellationResult<AttendanceSavedReceipt>,
    key: string,
  ) => ready(res, result, (value) => attendanceSavedPage(value, key), true);
  const recover = (staff: boolean) =>
    route(async (req, res) => {
      if (
        !fields(req.body, ["csrf", "checked", "key", "kind"]) ||
        !attendanceId(req.body.key)
      )
        return failure(res, "invalid");
      const kind = req.body.kind;
      if (
        staff
          ? kind !== "observe"
          : !["permit", "withdraw", "remove"].includes(kind ?? "")
      )
        return failure(res, "invalid");
      let input: unknown;
      try {
        input = JSON.parse(req.body.checked ?? "");
      } catch {
        return failure(res, "invalid");
      }
      const checked =
        kind === "permit"
          ? attendanceChecked(input)
          : kind === "observe"
            ? attendanceObservationChecked(input)
            : kind === "remove"
              ? attendanceRemovalChecked(input)
              : fields(input, ["permissionId"]) &&
                  attendanceId(input.permissionId)
                ? input
                : null;
      if (!checked) return failure(res, "invalid");
      if (
        !staff &&
        "registrationId" in checked &&
        checked.registrationId !== String(req.params.id)
      )
        return failure(res, "invalid");
      const result = await store!.inspect(
        staff ? res.locals.attendanceStaffToken : res.locals.token,
        req.body.key,
        kind as "permit" | "withdraw" | "remove" | "observe",
        checked,
      );
      if (result.kind === "ready" && result.value && !staff) {
        const id =
          result.value.kind === "remove"
            ? result.value.registrationId
            : result.value.kind === "observe"
              ? result.value.observation.registrationId
              : result.value.permission.registrationId;
        if (id !== String(req.params.id)) return failure(res, "denied");
      }
      return ready(res, result, (value) =>
        value
          ? attendanceSavedPage(value, req.body.key!)
          : attendanceNotice(
              res.locals.csrf,
              "No saved original result is currently available. This does not prove that an uncertain write failed or cannot finish. No write was requested by this inspection.",
            ),
      );
    });
  app.post(`${memberBase}/recover`, recover(false));
  app.post(`${staffBase}/recover`, recover(true));
  app.get(
    "/events/attendance",
    route(async (req, res) => {
      if (!store || options.mode === "live")
        return res
          .status(404)
          .send(
            attendanceNotice(
              "",
              "Local rehearsal attendance is unavailable in this configuration.",
            ),
          );
      if (!fields(req.query, ["after"])) return failure(res, "invalid");
      return ready(
        res,
        await store.history(res.locals.token, req.query.after),
        attendanceHistoryPage,
      );
    }),
  );
  app.get(
    memberBase,
    route(async (req, res) =>
      ready(
        res,
        await store!.member(res.locals.token, String(req.params.id)),
        (value, observed) =>
          attendanceMemberPage(res.locals.csrf, value, observed, randomUUID()),
      ),
    ),
  );
  app.post(
    `${memberBase}/check`,
    route(async (req, res) => {
      if (!fields(req.body, ["csrf", "administratorId"]))
        return failure(res, "invalid");
      return ready(
        res,
        await store!.checkPermission(res.locals.token, {
          registrationId: String(req.params.id),
          administratorId: req.body.administratorId,
        }),
        (value) =>
          attendancePermissionConfirm(res.locals.csrf, value, randomUUID()),
      );
    }),
  );
  app.post(
    `${memberBase}/permit`,
    route(async (req, res) => {
      const input = submitted(req, res);
      if (!input) return;
      const checked = attendanceChecked(input.checked);
      if (!checked || checked.registrationId !== String(req.params.id))
        return failure(res, "invalid");
      res.locals.attendanceAttempt = {
        target: `${attendancePath(checked.registrationId)}/permit`,
        key: input.key,
        checked,
      };
      return saved(
        res,
        await store!.permit(res.locals.token, input.key, checked),
        input.key,
      );
    }),
  );
  app.post(
    `${memberBase}/withdraw`,
    route(async (req, res) => {
      const input = submitted(req, res);
      if (!input) return;
      if (
        !fields(input.checked, ["permissionId"]) ||
        !attendanceId(input.checked.permissionId)
      )
        return failure(res, "invalid");
      const scope = await store!.member(
        res.locals.token,
        String(req.params.id),
      );
      if (scope.kind !== "ready") return failure(res, scope.kind);
      if (
        scope.value.permission?.id !== input.checked.permissionId ||
        performance.now() >= scope.deadline
      )
        return failure(res, "denied");
      res.locals.attendanceAttempt = {
        target: `${attendancePath(String(req.params.id))}/withdraw`,
        key: input.key,
        checked: input.checked,
      };
      return saved(
        res,
        await store!.withdraw(
          res.locals.token,
          input.key,
          input.checked.permissionId,
        ),
        input.key,
      );
    }),
  );
  app.post(
    `${memberBase}/remove-check`,
    route(async (req, res) => {
      if (!fields(req.body, ["csrf", "observationId"]))
        return failure(res, "invalid");
      const result = await store!.checkRemoval(
        res.locals.token,
        req.body.observationId ?? "",
      );
      if (
        result.kind === "ready" &&
        result.value.registrationId !== String(req.params.id)
      )
        return failure(res, "denied");
      return ready(res, result, (value) =>
        attendanceRemovalConfirm(res.locals.csrf, value, randomUUID()),
      );
    }),
  );
  app.post(
    `${memberBase}/remove`,
    route(async (req, res) => {
      const input = submitted(req, res);
      if (!input) return;
      const checked = attendanceRemovalChecked(input.checked);
      if (!checked || checked.registrationId !== String(req.params.id))
        return failure(res, "invalid");
      res.locals.attendanceAttempt = {
        target: `${attendancePath(checked.registrationId)}/remove`,
        key: input.key,
        checked,
      };
      return saved(
        res,
        await store!.remove(res.locals.token, input.key, checked),
        input.key,
      );
    }),
  );
  app.get(
    staffBase,
    route(async (_req, res) =>
      ready(
        res,
        await store!.administrator(res.locals.attendanceStaffToken),
        (value) =>
          attendanceStaffHome(
            res.locals.csrf,
            value.reference,
            value.creationEnabled,
          ),
      ),
    ),
  );
  app.post(
    `${staffBase}/check`,
    route(async (req, res) => {
      if (!fields(req.body, ["csrf", "permissionId"]))
        return failure(res, "invalid");
      return ready(
        res,
        await store!.checkObservation(
          res.locals.attendanceStaffToken,
          req.body.permissionId ?? "",
        ),
        (value) =>
          attendanceObservationConfirm(res.locals.csrf, value, randomUUID()),
      );
    }),
  );
  app.post(
    `${staffBase}/inspect`,
    route(async (req, res) => {
      if (!fields(req.body, ["csrf", "permissionId"]))
        return failure(res, "invalid");
      return ready(
        res,
        await store!.permission(
          res.locals.attendanceStaffToken,
          req.body.permissionId ?? "",
        ),
        attendanceStaffReceipt,
      );
    }),
  );
  app.get(
    `${staffBase}/:id`,
    route(async (req, res) =>
      ready(
        res,
        await store!.permission(
          res.locals.attendanceStaffToken,
          String(req.params.id),
        ),
        attendanceStaffReceipt,
      ),
    ),
  );
  app.post(
    `${staffBase}/observe`,
    route(async (req, res) => {
      const input = submitted(req, res);
      if (!input) return;
      const checked = attendanceObservationChecked(input.checked);
      if (!checked) return failure(res, "invalid");
      res.locals.attendanceAttempt = {
        target: `${staffBase}/observe`,
        key: input.key,
        checked,
      };
      return saved(
        res,
        await store!.observe(
          res.locals.attendanceStaffToken,
          input.key,
          checked,
        ),
        input.key,
      );
    }),
  );
}
