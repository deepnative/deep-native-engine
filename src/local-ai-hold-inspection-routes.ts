import type { Express } from "express";
import type { ApplicationMode } from "./adapters.ts";
import type { LocalAiHoldInspectionStore } from "./local-ai-hold-inspection.ts";
import {
  localAiHoldDetailPage,
  localAiHoldListPage,
  localAiHoldUnavailablePage,
} from "./local-ai-hold-inspection-views.ts";
export function registerLocalAiHoldInspectionRoutes(
  app: Express,
  store: LocalAiHoldInspectionStore,
  mode: ApplicationMode,
) {
  app.get("/operator/local-ai-holds", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (mode === "live")
      return res.status(404).send(localAiHoldUnavailablePage("live"));
    if (
      Object.keys(req.query).some((key) => key !== "after") ||
      (req.query.after !== undefined && typeof req.query.after !== "string")
    )
      return res.status(400).send(localAiHoldUnavailablePage("invalid"));
    try {
      const result = await store.list(
        res.locals.token as string,
        req.query.after as string | undefined,
      );
      if (result.kind === "ready")
        return res.send(localAiHoldListPage(result.items, result.next));
      return res
        .status(
          result.kind === "denied"
            ? 403
            : result.kind === "invalid"
              ? 400
              : 503,
        )
        .send(localAiHoldUnavailablePage(result.kind));
    } catch {
      return res.status(503).send(localAiHoldUnavailablePage("unavailable"));
    }
  });
  app.get("/operator/local-ai-holds/:jobId", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (mode === "live")
      return res.status(404).send(localAiHoldUnavailablePage("live"));
    if (Object.keys(req.query).length)
      return res.status(400).send(localAiHoldUnavailablePage("invalid"));
    try {
      const result = await store.detail(
        res.locals.token as string,
        req.params.jobId as string,
      );
      if (result.kind === "ready")
        return res.send(localAiHoldDetailPage(result.value));
      return res
        .status(
          result.kind === "denied"
            ? 403
            : result.kind === "invalid"
              ? 400
              : 503,
        )
        .send(localAiHoldUnavailablePage(result.kind));
    } catch {
      return res.status(503).send(localAiHoldUnavailablePage("unavailable"));
    }
  });
}
