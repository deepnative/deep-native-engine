import type { Express } from "express";
import type { ApplicationMode } from "./adapters.ts";
import type { MemberTestUnitsStore } from "./member-test-units.ts";
import {
  memberTestUnitsPage,
  memberTestUnitsUnavailablePage,
} from "./member-test-units-views.ts";

export function registerMemberTestUnitsRoutes(
  app: Express,
  store: MemberTestUnitsStore,
  mode: ApplicationMode,
) {
  app.get(
    ["/member/test-units", "/member/test-units/download"],
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      if (mode === "live")
        return res.status(404).send(memberTestUnitsUnavailablePage("live"));
      if (Object.keys(req.query).length)
        return res.status(400).send(memberTestUnitsUnavailablePage("query"));
      try {
        const result = await store.snapshot(res.locals.token as string);
        if (result.kind === "ready") {
          const value = result.value;
          if (req.path.replace(/\/$/, "") === "/member/test-units/download") {
            // Explicit whitelist: never serialize extra dependency-store metadata.
            const body = {
              scope: "synthetic-local-preview",
              asOf: value.asOf.toISOString(),
              categories: value.categories.map((row) => ({
                category: row.category,
                unit: row.unit,
                grants: row.grants,
                granted: row.granted,
                usable: row.usable,
                future: row.future,
                awaitingExpiry: row.awaitingExpiry,
                held: row.held,
                consumed: row.consumed,
                expired: row.expired,
                adjusted: row.adjusted,
                nextExpiry: row.nextExpiry?.toISOString() ?? null,
                nextStart: row.nextStart?.toISOString() ?? null,
              })),
            };
            res.set(
              "Content-Disposition",
              'attachment; filename="local-test-units.json"',
            );
            return res.json(body);
          }
          return res.send(memberTestUnitsPage(value));
        }
        return res
          .status(result.kind === "denied" ? 403 : 503)
          .send(memberTestUnitsUnavailablePage(result.kind));
      } catch {
        return res
          .status(503)
          .send(memberTestUnitsUnavailablePage("unavailable"));
      }
    },
  );
}
