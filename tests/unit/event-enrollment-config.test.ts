import { expect, it } from "vitest";
import { config } from "../../src/config.ts";
import { eventDiscoveryPage, eventDetailPage } from "../../src/views.ts";
import { EVENT_PREVIEWS } from "../../src/events.ts";
const database = "postgresql://dne:sample@127.0.0.1:54329/dne_dev";
it("requires an exact enabled local flag and refuses malformed configuration or live hosting", () => {
  expect(config({ DNE_DATABASE_URL: database }).eventRegistration).toBe(false);
  expect(
    config({ DNE_DATABASE_URL: database, DNE_EVENT_REGISTRATION: "disabled" })
      .eventRegistration,
  ).toBe(false);
  expect(
    config({ DNE_DATABASE_URL: database, DNE_EVENT_REGISTRATION: "enabled" })
      .eventRegistration,
  ).toBe(true);
  for (const value of ["", "yes", "true", "ENABLED"])
    expect(() =>
      config({ DNE_DATABASE_URL: database, DNE_EVENT_REGISTRATION: value }),
    ).toThrow("DNE_EVENT_REGISTRATION must be enabled or disabled.");
  expect(() =>
    config({
      DNE_DATABASE_URL: database,
      DNE_EVENT_REGISTRATION: "enabled",
      DNE_APP_MODE: "live",
    }),
  ).toThrow("Live application hosting");
});
it("offers rehearsal only with both configuration and event opt-in while keeping retained history reachable", () => {
  const event = EVENT_PREVIEWS.find((item) => item.localRegistration)!;
  for (const enabled of [true, false])
    for (const opted of [true, false]) {
      const source = { ...event, localRegistration: opted };
      const discovery = eventDiscoveryPage([source], undefined, false, enabled);
      const detail = eventDetailPage(
        { status: "current", event: source },
        undefined,
        enabled,
      );
      for (const html of [discovery, detail]) {
        if (enabled && opted) {
          expect(html).toContain("Try local registration rehearsal");
          expect(html).toContain("local registration rehearsal only");
        } else {
          expect(html).not.toContain("Try local registration rehearsal");
          expect(html).toContain("enrollment unavailable");
        }
        expect(html).toContain("Expert coverage: unresolved");
      }
      expect(discovery).toContain("Your registration history");
    }
});
