import type { Express } from "express";
import type { MetricsStore } from "./metrics.ts";
import {
  metricsReportPage,
  metricsReportUnavailablePage,
} from "./metrics-report-views.ts";

export function registerMetricsReportRoutes(app: Express, store: MetricsStore) {
  app.get("/operator/metrics/report", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (Object.keys(req.query).length)
      return res.status(400).send(metricsReportUnavailablePage("query"));
    try {
      const snapshot = await store.snapshot(res.locals.token as string);
      if (!snapshot)
        return res.status(403).send(metricsReportUnavailablePage("denied"));
      return res.send(metricsReportPage(snapshot));
    } catch {
      return res.status(503).send(metricsReportUnavailablePage("unavailable"));
    }
  });
}
