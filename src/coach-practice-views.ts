import { rangeTag, timeTag } from "./display-time.ts";
import type { MemberHoldSnapshot, SampleHoldReceipt } from "./slot-holds.ts";

// #201 COACHMOCK-01..05: the member's practice history says honestly whether a
// practice interview with a person is open to them. This reads delivered sample
// coaching holds only; it books, reserves and charges nothing.
export type CoachPracticeState =
  | { kind: "failed" }
  | { kind: "ready"; coachMinutes: boolean; holds: SampleHoldReceipt[] };

export function coachPracticeState(
  snapshot: MemberHoldSnapshot,
): CoachPracticeState {
  return {
    kind: "ready",
    // The snapshot already keeps only current grants with 60 free minutes.
    coachMinutes: snapshot.grants.some(
      (grant) => grant.category === "coach_minutes",
    ),
    holds: snapshot.receipts.filter(
      (receipt) => receipt.serviceType === "coaching",
    ),
  };
}

const states: Record<
  SampleHoldReceipt["state"],
  (hold: SampleHoldReceipt) => string
> = {
  held: (hold) => `Held until ${timeTag(hold.expiresAt, "UTC")}`,
  released: () => "You withdrew it",
  expired: () => "Ended without a booking",
  cancelled: () => "Cancelled by staff, with a replacement credit",
};

export function coachPracticeSection(state: CoachPracticeState): string {
  const body =
    state.kind === "failed"
      ? `<p role="status">We couldn't check your coach minutes or sample holds just now. Your practice history isn't affected. Reload the page to try again.</p>`
      : `${
          state.coachMinutes
            ? `<p>You have test coach minutes, so you can ask for a <a href="/availability">sample coaching window</a>. A sample hold isn't a booking: no coach has confirmed it, and nothing is paid.</p>`
            : `<p>A practice interview with a person needs coach minutes. Foundation membership doesn't include them, and practice-session units can't be used instead. No coach is booked for you.</p>`
        }${
          state.holds.length
            ? `<h3>Your sample coaching holds</h3><ul>${state.holds
                .map(
                  (hold) =>
                    `<li><a href="/availability/holds/${encodeURIComponent(hold.id)}">Sample hold with a coach · not a booking</a><p class="small">${rangeTag(hold.startsAt, hold.endsAt, "UTC")} · ${states[hold.state](hold)}</p></li>`,
                )
                .join("")}</ul>`
            : ""
        }`;
  return `<section aria-labelledby="coach-practice-title"><h2 id="coach-practice-title">Practice interview with a coach</h2><p>The sessions listed here are simulated practice. No person reads them, and their comparisons don't come from a coach.</p><p>No coaches are available to book yet, so a practice interview with a person can't be arranged.</p>${body}</section>`;
}
