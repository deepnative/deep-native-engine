import type { Express } from "express";
import type { ApplicationMode } from "./adapters.ts";
import type { AgreementOutcomesStore } from "./agreement-outcomes.ts";
import {
  agreementOutcomesPage,
  agreementOutcomesUnavailablePage,
} from "./agreement-outcomes-views.ts";

export function registerAgreementOutcomesRoutes(
  app: Express,
  store: AgreementOutcomesStore,
  mode: ApplicationMode,
) {
  app.get("/operator/course-agreements", async (req, res) => {
    res.set("Cache-Control", "no-store");
    // AGREE-06: no live metric claim without live evidence, so live shows none.
    if (mode === "live")
      return res.status(404).send(agreementOutcomesUnavailablePage("live"));
    if (Object.keys(req.query).length)
      return res.status(400).send(agreementOutcomesUnavailablePage("query"));
    const result = await store.snapshot(res.locals.token as string);
    if (result.kind === "ready")
      return res.send(agreementOutcomesPage(result.value));
    if (result.kind === "denied")
      return res.status(403).send(agreementOutcomesUnavailablePage("denied"));
    return res
      .status(503)
      .send(agreementOutcomesUnavailablePage("unavailable"));
  });
}
