import { expect, it } from "vitest";
import {
  coachPracticeSection,
  coachPracticeState,
} from "../../src/coach-practice-views.ts";
import type { SampleHoldReceipt } from "../../src/slot-holds.ts";
import { practiceSessionHistoryPage } from "../../src/views.ts";

const hold = (
  overrides: Partial<SampleHoldReceipt> = {},
): SampleHoldReceipt => ({
  id: "11111111-1111-4111-8111-111111111111",
  slotId: "22222222-2222-4222-8222-222222222222",
  domain: "education",
  serviceType: "coaching",
  startsAt: new Date("2026-11-12T15:00:00.000Z"),
  endsAt: new Date("2026-11-12T16:00:00.000Z"),
  expiresAt: new Date("2026-11-08T20:10:00.000Z"),
  state: "held",
  quantity: 60,
  ...overrides,
});

it("COACHMOCK-01 without coach minutes the section explains the gate and offers no request", () => {
  const html = coachPracticeSection(
    coachPracticeState({ grants: [], receipts: [] }),
  );
  expect(html).toContain("Practice interview with a coach");
  expect(html).toContain(
    "A practice interview with a person needs coach minutes.",
  );
  expect(html).toContain("Foundation membership doesn't include them");
  expect(html).toContain("practice-session units can't be used instead");
  expect(html).toContain("No coach is booked for you.");
  expect(html).not.toContain('href="/availability"');
});

it("COACHMOCK-02 only a current coach-minute grant opens the sample route", () => {
  const review = coachPracticeState({
    grants: [{ id: "g1", category: "review_minutes" }],
    receipts: [],
  });
  expect(review).toEqual({ kind: "ready", coachMinutes: false, holds: [] });
  const html = coachPracticeSection(
    coachPracticeState({
      grants: [{ id: "g2", category: "coach_minutes" }],
      receipts: [],
    }),
  );
  expect(html).toContain('href="/availability"');
  expect(html).toContain("A sample hold isn't a booking");
  expect(html).toContain("no coach has confirmed it");
  expect(html).toContain("nothing is paid");
  expect(html).not.toContain("needs coach minutes");
});

it("COACHMOCK-03 lists only coaching holds with honest labels and states", () => {
  const state = coachPracticeState({
    grants: [],
    receipts: [
      hold(),
      hold({
        id: "33333333-3333-4333-8333-333333333333",
        serviceType: "formal-review",
      }),
      hold({ id: "44444444-4444-4444-8444-444444444444", state: "released" }),
      hold({ id: "55555555-5555-4555-8555-555555555555", state: "expired" }),
    ],
  });
  expect(state.kind === "ready" && state.holds.map((h) => h.id)).toEqual([
    "11111111-1111-4111-8111-111111111111",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
  ]);
  const html = coachPracticeSection(state);
  expect(html).toContain("Your sample coaching holds");
  expect(html.match(/Sample hold with a coach · not a booking/g)).toHaveLength(
    3,
  );
  expect(html).toContain(
    'href="/availability/holds/11111111-1111-4111-8111-111111111111"',
  );
  expect(html).not.toContain("33333333-3333-4333-8333-333333333333");
  expect(html).toContain('datetime="2026-11-12T15:00:00.000Z"');
  expect(html).toContain('datetime="2026-11-12T16:00:00.000Z"');
  expect(html).toContain("Held until");
  expect(html).toContain('datetime="2026-11-08T20:10:00.000Z"');
  expect(html).toContain("You withdrew it");
  expect(html).toContain("Ended without a booking");
});

it("COACHMOCK-04 keeps simulated practice apart from any session with a person", () => {
  for (const state of [
    coachPracticeState({ grants: [], receipts: [] }),
    coachPracticeState({
      grants: [{ id: "g", category: "coach_minutes" }],
      receipts: [hold()],
    }),
  ]) {
    const html = coachPracticeSection(state);
    expect(html).toContain(
      "The sessions listed here are simulated practice. No person reads them",
    );
    expect(html).not.toMatch(/scheduled session|coach feedback|booked with/i);
  }
});

it("COACHMOCK-05 a failed check says so, and the history page shows the section only when given", () => {
  const failed = coachPracticeSection({ kind: "failed" });
  expect(failed).toContain('role="status"');
  expect(failed).toContain(
    "We couldn't check your coach minutes or sample holds just now.",
  );
  expect(failed).not.toContain('href="/availability"');
  const history = { items: [], nextCursor: null };
  expect(practiceSessionHistoryPage(history)).not.toContain(
    "Practice interview with a coach",
  );
  expect(practiceSessionHistoryPage(history, { kind: "failed" })).toContain(
    "Practice interview with a coach",
  );
});
