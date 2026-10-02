import type { Express } from "express";
import type { ApplicationMode } from "./adapters.ts";
import type { LedgerReconciliationStore } from "./ledger-reconciliation.ts";
import {
  ledgerReconciliationPage,
  ledgerReconciliationUnavailablePage,
} from "./ledger-reconciliation-views.ts";

export function registerLedgerReconciliationRoutes(
  app: Express,
  store: LedgerReconciliationStore,
  mode: ApplicationMode,
) {
  app.get("/operator/ledger-reconciliation", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (mode === "live")
      return res.status(404).send(ledgerReconciliationUnavailablePage("live"));
    if (Object.keys(req.query).length)
      return res.status(400).send(ledgerReconciliationUnavailablePage("query"));
    try {
      const result = await store.snapshot(res.locals.token as string);
      if (result.kind === "ready")
        return res.send(ledgerReconciliationPage(result.value));
      if (result.kind === "denied")
        return res
          .status(403)
          .send(ledgerReconciliationUnavailablePage("denied"));
      return res
        .status(503)
        .send(ledgerReconciliationUnavailablePage("unavailable"));
    } catch {
      return res
        .status(503)
        .send(ledgerReconciliationUnavailablePage("unavailable"));
    }
  });
}
