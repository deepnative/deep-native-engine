import type { Express } from "express";
import type { ApplicationMode } from "./adapters.ts";
import type { MyStaffTimeStore } from "./my-staff-time.ts";
import {
  myStaffTimePage,
  myStaffTimeUnavailablePage,
} from "./my-staff-time-views.ts";

export function registerMyStaffTimeRoutes(
  app: Express,
  store: MyStaffTimeStore,
  mode: ApplicationMode,
) {
  app.get("/review/my-time", async (req, res) => {
    res.set("Cache-Control", "no-store");
    // MYTIME-05: these are test roster records, so live mode shows none.
    if (mode === "live")
      return res.status(404).send(myStaffTimeUnavailablePage("live"));
    if (Object.keys(req.query).length)
      return res.status(400).send(myStaffTimeUnavailablePage("query"));
    const result = await store.snapshot(res.locals.token as string);
    if (result.kind === "ready") return res.send(myStaffTimePage(result.value));
    if (result.kind === "denied")
      return res.status(403).send(myStaffTimeUnavailablePage("denied"));
    return res.status(503).send(myStaffTimeUnavailablePage("unavailable"));
  });
}
