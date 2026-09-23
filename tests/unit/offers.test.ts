import { describe, it, expect } from "vitest";
import {
  FOUNDATION_ACCESS,
  COACHING_OFFERS,
  billingMonth,
  plannedPeriods,
  continuationEligibility,
} from "../../src/offers.ts";

describe("separate access and coaching hypotheses", () => {
  it("does not turn the local foundation preview into an approved live tier", () => {
    expect(FOUNDATION_ACCESS).toMatchObject({
      preview: "synthetic-local-only",
      live: "pending-owner-decision",
      priceCents: null,
      participationLimit: null,
      aiAllowance: null,
    });
    expect(Object.isFrozen(FOUNDATION_ACCESS)).toBe(true);
    expect(
      COACHING_OFFERS.every(
        (offer) =>
          offer.state === "hypothesis" && offer.livePurchasable === false,
      ),
    ).toBe(true);
  });

  it.each([
    ["pilot", 300_000, 2, null, 0],
    ["continuation", 900_000, 10, 90_000, 2],
    ["professional", 1_200_000, 12, 100_000, 0],
    ["specialist", 2_400_000, 12, 200_000, 0],
    ["practice", 4_800_000, 12, 400_000, 0],
    ["partner", 12_000_000, 12, 1_000_000, 0],
  ] as const)(
    "keeps %s price and term in immutable CAD cents",
    (id, price, months, installment, offset) => {
      const offer = COACHING_OFFERS.find((item) => item.id === id)!;
      expect(offer).toMatchObject({
        id,
        priceCents: price,
        months,
        installmentCents: installment,
        startMonth: offset,
        currency: "CAD",
        state: "hypothesis",
        livePurchasable: false,
      });
      expect(offer.termsVersion).toBe("2026-09-15-hypothesis-v1");
      expect(Object.isFrozen(offer)).toBe(true);
      expect(Object.isFrozen(offer.monthly)).toBe(true);
    },
  );

  it("funds exactly the pilot's two coaching units, four 30-minute reviews and monthly support/AI", () => {
    const pilot = COACHING_OFFERS.find((offer) => offer.id === "pilot")!;
    expect(pilot.monthly).toMatchObject({
      coachMinutes: 60,
      reviewMinutes: 60,
      supportMinutes: 60,
      mockSessions: 20,
      studyRequests: 100,
      pooledClinics: 4,
    });
    expect(pilot.reviewUnitMinutes).toBe(30);
    expect(pilot.internalOnboardingReserve).toEqual({
      coachMinutes: 60,
      supportMinutes: 30,
    });
    const months = plannedPeriods("pilot", "2026-01-31");
    expect(months).toHaveLength(2);
    expect(
      months.reduce((sum, period) => sum + period.monthly.coachMinutes, 0),
    ).toBe(120);
    expect(
      months.reduce((sum, period) => sum + period.monthly.reviewMinutes, 0),
    ).toBe(120);
    expect(
      months.reduce((sum, period) => sum + period.monthly.supportMinutes, 0),
    ).toBe(120);
    expect(
      months.reduce((sum, period) => sum + period.monthly.mockSessions!, 0),
    ).toBe(40);
    expect(
      months.reduce((sum, period) => sum + period.monthly.studyRequests!, 0),
    ).toBe(200);
    expect(
      months.every(
        (period) => period.state === "planned-only" && Object.isFrozen(period),
      ),
    ).toBe(true);
  });

  it("reduces continuation review/support to the Professional monthly bundle without releasing future months early", () => {
    const months = plannedPeriods("continuation", "2026-01-31");
    expect(months).toHaveLength(10);
    expect(months[0]).toMatchObject({
      startsOn: "2026-03-31",
      endsOn: "2026-04-30",
      monthly: { coachMinutes: 60, reviewMinutes: 30, supportMinutes: 30 },
    });
    expect(months.at(-1)).toMatchObject({
      startsOn: "2026-12-31",
      endsOn: "2027-01-31",
    });
    expect(
      months.reduce((sum, period) => sum + period.monthly.reviewMinutes, 0),
    ).toBe(300);
  });

  it("keeps future-tier allowances as hypotheses and Partner AI explicitly negotiated", () => {
    expect(
      COACHING_OFFERS.find((item) => item.id === "specialist")?.monthly,
    ).toMatchObject({
      coachMinutes: 120,
      reviewMinutes: 60,
      implementationMinutes: 60,
      supportMinutes: 60,
      mockSessions: 40,
      studyRequests: 200,
    });
    expect(
      COACHING_OFFERS.find((item) => item.id === "practice")?.monthly,
    ).toMatchObject({
      coachMinutes: 180,
      reviewMinutes: 120,
      engineeringMinutes: 180,
      supportMinutes: 120,
      mockSessions: 60,
      studyRequests: 300,
    });
    expect(
      COACHING_OFFERS.find((item) => item.id === "partner")?.monthly,
    ).toMatchObject({
      coachMinutes: 240,
      seniorAdvisorMinutes: 120,
      reviewMinutes: 240,
      engineeringMinutes: 720,
      analystMinutes: 480,
      supportMinutes: 240,
      mockSessions: null,
      studyRequests: null,
    });
  });
});

describe("date and purchase boundaries", () => {
  it("clips January 31 to February end and restores the original anniversary day", () => {
    expect(billingMonth("2026-01-31", 0)).toBe("2026-01-31");
    expect(billingMonth("2026-01-31", 1)).toBe("2026-02-28");
    expect(billingMonth("2026-01-31", 2)).toBe("2026-03-31");
    expect(billingMonth("2028-01-31", 1)).toBe("2028-02-29");
    expect(billingMonth("2028-01-31", 12)).toBe("2029-01-31");
  });

  it("requires timely explicit continuation and sends late returns to a new manual agreement", () => {
    expect(continuationEligibility("2026-01-31", "2026-03-30")).toBe(
      "eligible",
    );
    expect(continuationEligibility("2026-01-31", "2026-03-31")).toBe(
      "manual-agreement-required",
    );
    expect(continuationEligibility("2026-01-31", "2026-01-30")).toBe(
      "not-started",
    );
  });

  it.each(["2026-02-30", "2026-1-1", "not-a-date"])(
    "rejects invalid date %s",
    (date) => {
      expect(() => billingMonth(date, 1)).toThrow();
    },
  );
  it.each([-1, 1.5])("rejects invalid month offset %s", (offset) => {
    expect(() => billingMonth("2026-01-31", offset)).toThrow();
  });
  it("rejects unknown offers and invalid acceptance dates", () => {
    expect(() => plannedPeriods("unknown", "2026-01-31")).toThrow();
    expect(() => continuationEligibility("2026-01-31", "2026-02-30")).toThrow();
  });
});
