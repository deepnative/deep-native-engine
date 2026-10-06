import { expect, it } from "vitest";
import { eventDiscoveryPage, eventDetailPage } from "../../src/views.ts";
import { EVENT_PREVIEWS, type EventPreview } from "../../src/events.ts";
const event: EventPreview = {
  ...EVENT_PREVIEWS.find((e) => e.status === "current")!,
  localRegistration: true,
};
const cancelledAt = new Date("2029-01-01T00:00:00.000Z");
it("EVCANCEL-03 discovery and exact detail show dynamic cancellation without offering enrollment", () => {
  const list = eventDiscoveryPage([event], "America/Toronto", false, true, [
    { eventId: event.id, eventVersion: event.version, cancelledAt },
  ]);
  expect(list).toContain("Event cancelled");
  expect(list).toContain(cancelledAt.toISOString());
  expect(list).not.toContain("Try local registration rehearsal");
  const exact = eventDetailPage(
    { status: "current", event },
    "America/Toronto",
    true,
    cancelledAt,
  );
  expect(exact).toContain("Event cancelled");
  expect(exact).not.toContain("Try local registration rehearsal");
});
