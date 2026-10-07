import { expect, it } from "vitest";
import { rehearsalSnapshot } from "../../src/event-rehearsal-values.ts";
import {
  eventRehearsalHome,
  eventRehearsalConfirm,
  eventRehearsalReceipt,
  eventRehearsalNotice,
} from "../../src/event-rehearsal-views.ts";
const snapshot = rehearsalSnapshot({
  templateId: "local-registration-rehearsal",
  templateVersion: 1,
  startsAt: "2026-10-07T12:00:00.000Z",
})!;
const attempt = { key: "44444444-4444-4444-8444-444444444444", snapshot };
it.each([true, false])(
  "REHSCHED-01/08 creation enabled=%s preserves protected manual inspection",
  (enabled) => {
    const html = eventRehearsalHome('csrf"<invented>', enabled);
    expect(html).toContain('action="/operator/event-rehearsals/inspect"');
    expect(html).not.toContain('csrf"<invented>');
    expect(html.includes('action="/operator/event-rehearsals/check"')).toBe(
      enabled,
    );
    expect(html).toContain(
      enabled ? "Check a proposed schedule" : "New scheduling is paused",
    );
  },
);
it.each([true, false])(
  "REHSCHED-01 exact readonly snapshot requires affirmative confirmation only when enabled=%s",
  (enabled) => {
    const html = eventRehearsalConfirm("csrf", attempt, enabled);
    expect(html).toContain(snapshot.startsAt);
    expect(html).toContain(attempt.key);
    expect(html).toContain('name="startsAt" readonly');
    expect(html.includes('action="/operator/event-rehearsals/schedule"')).toBe(
      enabled,
    );
    expect(html).not.toMatch(/type="checkbox"[^>]*\bchecked\b/);
    expect(html).toContain('target="_blank"');
  },
);
it("REHSCHED-06 receipt discloses canonical facts without operation key and absence does not promise rollback", () => {
  const receipt = {
    id: "33333333-3333-4333-8333-333333333333",
    eventId: "local-rehearsal-33333333-3333-4333-8333-333333333333",
    eventVersion: 1,
    title: "Invented <script>unsafe</script>",
    startsAt: new Date(snapshot.startsAt),
    endsAt: new Date(snapshot.endsAt),
    scheduledAt: new Date("2026-10-06T12:00:00Z"),
  };
  const html = eventRehearsalReceipt(receipt);
  expect(html).toContain(receipt.id);
  expect(html).toContain(snapshot.startsAt);
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain(receipt.title);
  expect(html).not.toContain(attempt.key);
  expect(eventRehearsalReceipt(null)).toContain(
    "earlier uncertain instruction could still complete",
  );
});
it("REHSCHED-06 unavailable outcome preserves original instruction without automatic repeat or replacement key", () => {
  const html = eventRehearsalNotice(
    "csrf",
    "Unknown <script>diagnostic</script>",
    attempt,
  );
  expect(html).not.toContain("<script>diagnostic</script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain(attempt.key);
  expect(html).toContain(snapshot.startsAt);
  expect(html).toContain("No automatic retry, replacement key or compensation");
  expect(html).not.toMatch(/type="checkbox"[^>]*\bchecked\b/);
  expect(eventRehearsalNotice("csrf", "Denied")).not.toContain(
    'action="/operator/event-rehearsals/schedule"',
  );
});
