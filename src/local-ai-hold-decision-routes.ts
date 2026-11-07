import { randomUUID } from "node:crypto";
import type { Express, Response } from "express";
import type { ApplicationMode } from "./adapters.ts";
import type { LocalAiHoldDecisionStore } from "./local-ai-hold-decisions.ts";
import {
  holdDecisionFailurePage,
  holdDecisionPage,
  holdDecisionResultPage,
} from "./local-ai-hold-decision-views.ts";
import { localAiHoldUnavailablePage } from "./local-ai-hold-inspection-views.ts";

const path = "/operator/local-ai-holds/:jobId/test-outcome";
const statuses = {
  conflict: 409,
  closed: 409,
  denied: 403,
  invalid: 400,
  unavailable: 503,
} as const;
const fields = ["csrf", "outcome", "reason", "sourceReference", "key"];
type Failure = keyof typeof statuses;
function fail(res: Response, kind: Failure, jobId?: string) {
  return res.status(statuses[kind]).send(holdDecisionFailurePage(kind, jobId));
}
export function registerLocalAiHoldDecisionRoutes(
  app: Express,
  store: LocalAiHoldDecisionStore,
  mode: ApplicationMode,
) {
  app.get(path, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (mode === "live")
      return res.status(404).send(localAiHoldUnavailablePage("live"));
    if (Object.keys(req.query).length) return fail(res, "invalid");
    const jobId = req.params.jobId as string;
    try {
      const view = await store.read(res.locals.token as string, jobId);
      if (view.kind !== "ready") return fail(res, view.kind);
      return res.send(
        holdDecisionPage({
          jobId: view.jobId,
          open: view.open,
          metered: view.metered,
          decision: view.decision,
          csrf: res.locals.csrf as string,
          key: randomUUID(),
        }),
      );
    } catch {
      return fail(res, "unavailable");
    }
  });
  app.post(path, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (mode === "live")
      return res.status(404).send(localAiHoldUnavailablePage("live"));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const jobId = req.params.jobId as string;
    if (
      Object.keys(req.query).length ||
      Object.keys(body).some((key) => !fields.includes(key)) ||
      fields.slice(1).some((key) => typeof body[key] !== "string")
    )
      return fail(res, "invalid");
    try {
      const result = await store.record(res.locals.token as string, jobId, {
        outcome: body.outcome as never,
        reason: body.reason as never,
        sourceReference: body.sourceReference as string,
        key: body.key as string,
      });
      if (result.kind === "applied" || result.kind === "replayed")
        return res
          .status(result.kind === "applied" ? 201 : 200)
          .send(holdDecisionResultPage(jobId, result.kind, result.decision));
      return fail(res, result.kind, jobId);
    } catch {
      return fail(res, "unavailable");
    }
  });
}
