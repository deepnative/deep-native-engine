import type { Express } from "express";
import type { ApplicationMode } from "./adapters.ts";
import type { StaffCapacityStore } from "./staff-capacity.ts";
import {
  staffCapacityPage,
  staffCapacityUnavailablePage,
} from "./staff-capacity-views.ts";

export function registerStaffCapacityRoutes(
  app: Express,
  store: StaffCapacityStore,
  mode: ApplicationMode,
) {
  app.get("/operator/staff-capacity", async (req, res) => {
    res.set("Cache-Control", "no-store");
    // CAP-08: these are test roster records, so live mode shows none.
    if (mode === "live")
      return res.status(404).send(staffCapacityUnavailablePage("live"));
    if (Object.keys(req.query).length)
      return res.status(400).send(staffCapacityUnavailablePage("query"));
    const result = await store.snapshot(res.locals.token as string);
    if (result.kind === "ready")
      return res.send(staffCapacityPage(result.value));
    if (result.kind === "denied")
      return res.status(403).send(staffCapacityUnavailablePage("denied"));
    return res.status(503).send(staffCapacityUnavailablePage("unavailable"));
  });
}
