import type { Express, Response } from "express";
import type { ApplicationMode } from "./adapters.ts";
import {
  preparedSamplesEnabled,
  type PreparedSampleStore,
} from "./prepared-samples.ts";
import { preparedInstruction } from "./prepared-sample-values.ts";
import {
  PREPARED_PATH as base,
  preparedSamplesPage,
  preparedReceiptPage,
  preparedRecoveryPage,
} from "./prepared-sample-views.ts";
const exact = (
  value: unknown,
  names: string[],
): value is Record<string, string> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === names.length &&
  names.every(
    (name) =>
      Object.hasOwn(value, name) &&
      typeof (value as Record<string, unknown>)[name] === "string",
  );
export function mountPreparedSampleRoutes(
  app: Express,
  store: PreparedSampleStore | undefined,
  options: {
    preparedReviewSamples?: boolean;
    mode?: ApplicationMode;
    origin: string;
  },
) {
  const failure = (
    res: Response,
    kind: string,
    attempt?: ReturnType<typeof preparedInstruction>,
  ) =>
    res
      .status(
        kind === "invalid"
          ? 422
          : kind === "conflict"
            ? 409
            : kind === "disabled"
              ? 404
              : kind === "denied"
                ? 403
                : 503,
      )
      .send(
        preparedRecoveryPage(
          res.locals.csrf as string,
          kind === "unavailable"
            ? "The result cannot be confirmed; a copy may have committed. Inspect its saved state."
            : kind === "conflict"
              ? "The original instruction conflicts with a different provided example."
              : kind === "disabled"
                ? "New provided copies are disabled in this environment."
                : kind === "invalid"
                  ? "Choose an exact supplied example and separately confirm both permissions."
                  : "Current member authority is required.",
          kind === "unavailable" ? (attempt ?? undefined) : undefined,
        ),
      );
  const enabled = () =>
    store &&
    preparedSamplesEnabled({
      enabled: options.preparedReviewSamples,
      mode: options.mode,
      origin: options.origin,
    });
  function send(
    res: Response,
    deadline: number,
    html: string,
    writing = false,
    attempt?: ReturnType<typeof preparedInstruction>,
  ) {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      return failure(res, writing ? "unavailable" : "denied", attempt);
    return res.send(html);
  }
  app.get(base, async (req, res) => {
    if (!enabled()) return failure(res, "disabled");
    if (!exact(req.query, [])) return failure(res, "invalid");
    try {
      const result = await store!.open(res.locals.token as string);
      if (result.kind !== "ready") return failure(res, result.kind);
      return send(
        res,
        result.deadline,
        preparedSamplesPage(res.locals.csrf as string, result.goal),
      );
    } catch {
      return failure(res, "unavailable");
    }
  });
  app.post(base, async (req, res) => {
    if (!enabled()) return failure(res, "disabled");
    if (
      !exact(req.query, []) ||
      !exact(req.body, [
        "csrf",
        "operationId",
        "templateId",
        "templateVersion",
        "templateDigest",
        "providedExample",
        "privateReview",
      ])
    )
      return failure(res, "invalid");
    const b = req.body;
    const attempt = preparedInstruction({
      operationId: b.operationId,
      templateId: b.templateId,
      templateVersion: b.templateVersion === "1" ? 1 : NaN,
      templateDigest: b.templateDigest,
      providedExample: b.providedExample === "yes",
      privateReview: b.privateReview === "yes",
    });
    if (!attempt) return failure(res, "invalid");
    try {
      const result = await store!.create(res.locals.token as string, attempt);
      if (result.kind !== "created" && result.kind !== "replayed")
        return failure(res, result.kind, attempt);
      return send(
        res,
        result.deadline,
        preparedReceiptPage(
          result.receipt,
          result.kind === "created"
            ? "Your exact private provided copy was saved."
            : "Your original copy instruction was replayed; no new copy or permission was created.",
        ),
        true,
        attempt,
      );
    } catch {
      return failure(res, "unavailable", attempt);
    }
  });
  app.post(base + "/inspect", async (req, res) => {
    // Creation-off rollback must retain current-owner saved-state inspection.
    if (!store || options.mode === "live") return failure(res, "disabled");
    if (!exact(req.query, []) || !exact(req.body, ["csrf", "operationId"]))
      return failure(res, "invalid");
    try {
      const result = await store.inspect(
        res.locals.token as string,
        req.body.operationId!,
      );
      if (result.kind !== "ready" && result.kind !== "absent")
        return failure(res, result.kind);
      return send(
        res,
        result.deadline,
        result.kind === "ready"
          ? preparedReceiptPage(result.receipt)
          : preparedRecoveryPage(
              res.locals.csrf as string,
              "No owned retained receipt was found. This does not establish that the write failed or permit a new automatic instruction.",
            ),
      );
    } catch {
      return failure(res, "unavailable");
    }
  });
}
