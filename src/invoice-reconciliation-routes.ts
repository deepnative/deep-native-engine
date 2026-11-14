import type { Express } from "express";
import { adminMenuFor } from "./administration-presentation.ts";
import type { ApplicationMode } from "./adapters.ts";
import type { InvoiceReconciliationStore } from "./invoice-reconciliation.ts";
import {
  invoiceReconciliationPage,
  invoiceReconciliationUnavailablePage,
} from "./invoice-reconciliation-views.ts";

export function registerInvoiceReconciliationRoutes(
  app: Express,
  store: InvoiceReconciliationStore,
  mode: ApplicationMode,
) {
  app.get("/operator/invoice-reconciliation", async (req, res) => {
    res.set("Cache-Control", "no-store");
    // RECON-04: nothing here is evidence for a live figure, so live shows none.
    if (mode === "live")
      return res.status(404).send(invoiceReconciliationUnavailablePage("live"));
    if (Object.keys(req.query).length)
      return res
        .status(400)
        .send(invoiceReconciliationUnavailablePage("query"));
    const result = await store.snapshot(res.locals.token as string);
    if (result.kind === "ready")
      return res.send(
        invoiceReconciliationPage(result.value, adminMenuFor(res, "more")),
      );
    if (result.kind === "denied")
      return res
        .status(403)
        .send(invoiceReconciliationUnavailablePage("denied"));
    return res
      .status(503)
      .send(invoiceReconciliationUnavailablePage("unavailable"));
  });
}
