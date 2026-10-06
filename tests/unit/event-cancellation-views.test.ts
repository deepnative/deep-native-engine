import { expect, it } from "vitest";
import { EVENT_PREVIEWS } from "../../src/events.ts";
import {
  eventCancellationHome,
  eventCancellationConfirm,
  eventCancellationReceipt,
  eventCancellationNotice,
} from "../../src/event-cancellation-views.ts";
const event = EVENT_PREVIEWS[0]!;
const attempt = {
  eventId: event.id,
  eventVersion: event.version,
  key: "44444444-4444-4444-8444-444444444444",
  title: 'Invented <script>alert("x")</script>',
  startsAt: event.startsAt,
  endsAt: event.endsAt,
  capacity: event.fixtureCapacity,
};
const receipt = {
  eventId: event.id,
  eventVersion: event.version,
  id: "33333333-3333-4333-8333-333333333333",
  title: attempt.title,
  startsAt: new Date(event.startsAt),
  endsAt: new Date(event.endsAt),
  cancelledAt: new Date("2026-10-06T12:00:00.000Z"),
};
it.each([true, false])(
  "EVCANCEL-08 home preserves exact inspection while creation enabled=%s",
  (enabled) => {
    const html = eventCancellationHome('csrf"<private>', enabled);
    expect(html).toContain('action="/operator/event-cancellations/inspect"');
    expect(html).not.toContain('csrf"<private>');
    expect(html).toContain(
      enabled ? "future opted-in" : "New cancellations are paused",
    );
    expect(html).not.toContain('action="/operator/event-cancellations/cancel"');
  },
);
it("EVCANCEL-01 confirmation preserves escaped readonly checked fields and requires an unchecked affirmative choice", () => {
  const html = eventCancellationConfirm(
    "invented-csrf",
    { event, creationEnabled: true, receipt: null },
    attempt,
  );
  expect(html).toContain('action="/operator/event-cancellations/cancel"');
  expect(html).toContain(attempt.key);
  expect(html).toContain('name="title"');
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain(attempt.title);
  expect(html).not.toMatch(/type="checkbox"[^>]*\bchecked\b/);
  expect(html).toContain('target="_blank"');
});
it("EVCANCEL-01 unavailable preview does not offer a cancellation write", () => {
  const html = eventCancellationConfirm(
    "csrf",
    { event, creationEnabled: false, receipt: null },
    attempt,
  );
  expect(html).toContain("New cancellation is unavailable");
  expect(html).not.toContain('action="/operator/event-cancellations/cancel"');
});
it("EVCANCEL-03 already cancelled preview shows canonical receipt rather than a new write", () => {
  const html = eventCancellationConfirm(
    "csrf",
    { event, creationEnabled: true, receipt },
    attempt,
  );
  expect(html).toContain(receipt.id);
  expect(html).toContain("New registrations are closed");
  expect(html).not.toContain('action="/operator/event-cancellations/cancel"');
});
it("EVCANCEL-03 receipt retains the original schedule and separates cancellation from member withdrawal", () => {
  const html = eventCancellationReceipt("csrf", attempt, receipt, attempt.key);
  expect(html).toContain(receipt.cancelledAt.toISOString());
  expect(html).toContain(event.startsAt);
  expect(html).toContain(event.endsAt);
  expect(html).toContain("may separately withdraw");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain(attempt.key);
  expect(html).not.toContain(attempt.title);
});
it("EVCANCEL-06 absence is not a promise that an uncertain cancellation cannot commit", () => {
  const html = eventCancellationReceipt("csrf", attempt, null);
  expect(html).toContain("not a guarantee");
  expect(html).toContain("Nothing was created or reversed");
  expect(html).not.toContain("Original submission key:");
});
it("EVCANCEL-06 unavailable write offers only explicit inspection and an unchecked original-key repeat", () => {
  const html = eventCancellationNotice(
    'csrf"<private>',
    "Unknown <script>diagnostic</script>",
    attempt,
  );
  expect(html).toContain(attempt.key);
  expect(html).toContain(
    'method="post" action="/operator/event-cancellations/inspect" target="_blank"',
  );
  expect(html).toContain("Repeat the exact original instruction manually");
  expect(html).not.toMatch(/type="checkbox"[^>]*\bchecked\b/);
  expect(html).not.toContain("<script>diagnostic</script>");
  expect(html).not.toContain('csrf"<private>');
  expect(html).not.toContain("setTimeout");
});
it("EVCANCEL-05 ordinary denial exposes no original attempt or repeat form", () => {
  const html = eventCancellationNotice("csrf", "Denied");
  expect(html).not.toContain('action="/operator/event-cancellations/cancel"');
  expect(html).not.toContain(attempt.key);
});
