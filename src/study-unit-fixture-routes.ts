import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { ApplicationMode } from "./adapters.ts";
import type { EventCancellationResult } from "./event-cancellation-values.ts";
import type { StudyUnitFixtureStore } from "./study-unit-fixtures.ts";
import { staffCookie, staffCredential } from "./staff-entry-selection.ts";
import {
  studyFixtureId,
  studyFixtureFields,
  studyRequestInstruction,
  studyIssueInstruction,
} from "./study-unit-fixture-values.ts";
import {
  STUDY_MEMBER_PATH,
  STUDY_STAFF_PATH,
  studyFixtureMemberPage,
  studyFixtureStaffPage,
  studyFixtureConfirmation,
  studyFixtureReceiptPage,
  studyFixtureNotice,
  studyFixtureUncommitted,
  type StudyFixtureAttempt,
} from "./study-unit-fixture-views.ts";

const messages = {
  denied:
    "This exact test fixture is unavailable to your current access. No other member's request or balance is disclosed.",
  invalid:
    "Check the exact reference and explicitly confirm the fixed test scope. This form was not accepted.",
  conflict:
    "This instruction conflicts with the original request or the one-time policy slot. It cannot reset or renew that fixture.",
  unavailable:
    "The fixture result cannot be confirmed. A write may already have committed; inspect the original operation before repeating the same instruction.",
};
function submitted(input: unknown, confirmed: boolean) {
  const keys = [
    "csrf",
    "kind",
    "key",
    "checked",
    ...(confirmed ? ["confirm"] : []),
  ];
  if (
    !studyFixtureFields(input, keys) ||
    !studyFixtureId(input.key) ||
    typeof input.checked !== "string" ||
    input.checked.length > 4096 ||
    (confirmed && input.confirm !== "yes") ||
    !["request", "issue", "withdraw"].includes(String(input.kind))
  )
    return null;
  try {
    const value: unknown = JSON.parse(input.checked);
    const checked =
      input.kind === "request"
        ? studyRequestInstruction(value)
        : input.kind === "issue"
          ? studyIssueInstruction(value)
          : studyFixtureFields(value, ["requestId"]) &&
              studyFixtureId(value.requestId)
            ? { requestId: value.requestId }
            : null;
    return checked
      ? {
          kind: input.kind as StudyFixtureAttempt["kind"],
          key: input.key,
          checked,
        }
      : null;
  } catch {
    return null;
  }
}
export function mountStudyUnitFixtureRoutes(
  app: Express,
  store: StudyUnitFixtureStore | undefined,
  options: { mode?: ApplicationMode; localStaffEntry?: boolean },
) {
  const failure = (res: Response, kind: keyof typeof messages) =>
    res
      .status(
        { denied: 403, invalid: 422, conflict: 409, unavailable: 503 }[kind],
      )
      .send(
        studyFixtureNotice(
          res.locals.csrf ?? "",
          messages[kind],
          kind === "unavailable" ? res.locals.studyFixtureAttempt : undefined,
        ),
      );
  const ready = <T>(
    res: Response,
    result: EventCancellationResult<T>,
    render: (value: T, observed: Date) => string,
    writing = false,
  ) => {
    if (result.kind !== "ready") return failure(res, result.kind);
    const expired = () =>
      !Number.isFinite(result.deadline) || performance.now() >= result.deadline;
    if (expired()) return failure(res, writing ? "unavailable" : "denied");
    const body = render(result.value, result.observedAt);
    if (expired()) return failure(res, writing ? "unavailable" : "denied");
    return res.send(body);
  };
  const route =
    (use: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await use(req, res);
      } catch {
        failure(res, "unavailable");
      }
    };
  app.use([STUDY_MEMBER_PATH, STUDY_STAFF_PATH], (req, res, next) => {
    if (!store || options.mode === "live")
      return res
        .status(404)
        .send(
          studyFixtureNotice(
            "",
            "Local test-unit issuance is unavailable in this configuration.",
          ),
        );
    if (!studyFixtureFields(req.query, [])) return failure(res, "invalid");
    next();
  });
  app.use(STUDY_STAFF_PATH, (req, res, next) => {
    if (!options.localStaffEntry)
      return res
        .status(404)
        .send(studyFixtureNotice("", "Local staff entry is unavailable."));
    const cookie = staffCookie(req.headers.cookie);
    if (cookie.kind !== "value" || !staffCredential(cookie.value))
      return failure(res, "denied");
    res.locals.studyFixtureStaffToken = cookie.value;
    next();
  });
  app.get(
    STUDY_MEMBER_PATH,
    route(async (_req, res) =>
      ready(res, await store!.member(res.locals.token), (value, observed) =>
        studyFixtureMemberPage(
          res.locals.csrf,
          value.receipt,
          value.creationEnabled,
          observed,
        ),
      ),
    ),
  );
  app.get(
    STUDY_STAFF_PATH,
    route(async (_req, res) =>
      ready(
        res,
        await store!.administrator(res.locals.studyFixtureStaffToken),
        (value) =>
          studyFixtureStaffPage(
            res.locals.csrf,
            value.reference,
            value.creationEnabled,
          ),
      ),
    ),
  );
  app.post(
    `${STUDY_MEMBER_PATH}/check`,
    route(async (req, res) => {
      if (
        !studyFixtureFields(req.body, ["csrf", "administratorId"]) ||
        !studyFixtureId(req.body.administratorId)
      )
        return failure(res, "invalid");
      return ready(
        res,
        await store!.checkRequest(res.locals.token, req.body.administratorId),
        (checked) =>
          studyFixtureConfirmation(res.locals.csrf, {
            kind: "request",
            key: randomUUID(),
            checked,
          }),
      );
    }),
  );
  app.post(
    `${STUDY_STAFF_PATH}/check`,
    route(async (req, res) => {
      if (
        !studyFixtureFields(req.body, ["csrf", "requestId"]) ||
        !studyFixtureId(req.body.requestId)
      )
        return failure(res, "invalid");
      return ready(
        res,
        await store!.checkIssue(
          res.locals.studyFixtureStaffToken,
          req.body.requestId,
        ),
        (checked) =>
          studyFixtureConfirmation(res.locals.csrf, {
            kind: "issue",
            key: randomUUID(),
            checked,
          }),
      );
    }),
  );
  app.post(
    `${STUDY_MEMBER_PATH}/withdraw/check`,
    route(async (req, res) => {
      if (
        !studyFixtureFields(req.body, ["csrf", "requestId"]) ||
        !studyFixtureId(req.body.requestId)
      )
        return failure(res, "invalid");
      const result = await store!.member(res.locals.token);
      if (
        result.kind === "ready" &&
        (!result.value.receipt ||
          result.value.receipt.id !== req.body.requestId ||
          result.value.receipt.withdrawnAt)
      )
        return failure(res, "denied");
      return ready(res, result, (value) => {
        return studyFixtureConfirmation(res.locals.csrf, {
          kind: "withdraw",
          key: randomUUID(),
          checked: { requestId: value.receipt!.id },
        });
      });
    }),
  );
  for (const kind of ["request", "issue", "withdraw"] as const) {
    const staff = kind === "issue",
      base = staff ? STUDY_STAFF_PATH : STUDY_MEMBER_PATH;
    app.post(
      `${base}/${kind}`,
      route(async (req, res) => {
        const attempt = submitted(req.body, true);
        if (!attempt || attempt.kind !== kind) return failure(res, "invalid");
        res.locals.studyFixtureAttempt = attempt;
        const token = staff
          ? res.locals.studyFixtureStaffToken
          : res.locals.token;
        const result =
          kind === "request"
            ? await store!.request(token, attempt.key, attempt.checked)
            : kind === "issue"
              ? await store!.issue(token, attempt.key, attempt.checked)
              : await store!.withdraw(
                  token,
                  attempt.key,
                  (attempt.checked as { requestId: string }).requestId,
                );
        return ready(
          res,
          result,
          (receipt, observed) =>
            studyFixtureReceiptPage(receipt, observed, staff),
          true,
        );
      }),
    );
  }
  for (const staff of [false, true]) {
    const base = staff ? STUDY_STAFF_PATH : STUDY_MEMBER_PATH;
    app.post(
      `${base}/inspect`,
      route(async (req, res) => {
        const attempt = submitted(req.body, false);
        if (
          !attempt ||
          (staff ? attempt.kind !== "issue" : attempt.kind === "issue")
        )
          return failure(res, "invalid");
        res.locals.studyFixtureAttempt = attempt;
        const input =
          attempt.kind === "withdraw"
            ? (attempt.checked as { requestId: string }).requestId
            : attempt.checked;
        return ready(
          res,
          await store!.inspect(
            staff ? res.locals.studyFixtureStaffToken : res.locals.token,
            attempt.key,
            attempt.kind,
            input,
          ),
          (receipt, observed) =>
            receipt
              ? studyFixtureReceiptPage(receipt, observed, staff)
              : studyFixtureUncommitted(res.locals.csrf, attempt),
        );
      }),
    );
  }
}
