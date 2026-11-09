import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { ApplicationMode } from "./adapters.ts";
import type { SampleHoldCancellationStore } from "./sample-hold-cancellations.ts";
import {
  sampleHoldCancellationBase,
  staffCancelFailurePage,
  staffCancelResultPage,
  staffSampleHoldsPage,
  staffSampleHoldsUnavailablePage,
} from "./sample-hold-cancellation-views.ts";

const statuses = {
  stale: 409,
  ended: 409,
  conflict: 409,
  denied: 403,
  invalid: 400,
  unavailable: 503,
} as const;
const fields = ["csrf", "requestId", "reason"];

export function registerSampleHoldCancellationRoutes(
  app: Express,
  store: SampleHoldCancellationStore,
  mode: ApplicationMode,
) {
  app.get(sampleHoldCancellationBase, async (req, res) => {
    res.set("Cache-Control", "no-store");
    // These are test records, so a live site offers none.
    if (mode === "live")
      return res.status(404).send(staffSampleHoldsUnavailablePage());
    if (Object.keys(req.query).length)
      return res.status(400).send(staffCancelFailurePage("invalid"));
    const view = await store.list(res.locals.token as string);
    if (view.kind !== "ready")
      return res
        .status(statuses[view.kind])
        .send(staffCancelFailurePage(view.kind));
    return res.send(
      staffSampleHoldsPage({
        held: view.held,
        recent: view.recent,
        csrf: res.locals.csrf as string,
        requestIds: Object.fromEntries(
          view.held.map((hold) => [hold.holdId, randomUUID()]),
        ),
      }),
    );
  });
  app.post(`${sampleHoldCancellationBase}/:holdId/cancel`, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (mode === "live")
      return res.status(404).send(staffSampleHoldsUnavailablePage());
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      Object.keys(req.query).length ||
      Object.keys(body).some((key) => !fields.includes(key)) ||
      typeof body.requestId !== "string" ||
      typeof body.reason !== "string"
    )
      return res.status(400).send(staffCancelFailurePage("invalid"));
    const result = await store.cancel(
      res.locals.token as string,
      req.params.holdId as string,
      body.requestId,
      body.reason,
    );
    if (result.kind === "applied" || result.kind === "replayed")
      return res
        .status(result.kind === "applied" ? 201 : 200)
        .send(staffCancelResultPage(result.kind, result.cancellation));
    return res
      .status(statuses[result.kind])
      .send(staffCancelFailurePage(result.kind));
  });
}
