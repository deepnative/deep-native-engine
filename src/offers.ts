// Historical coaching terms are planning hypotheses. This module never grants
// access, reserves staff time, charges a card, or activates a live offer.
export const FOUNDATION_ACCESS = Object.freeze({
  preview: "synthetic-local-only",
  live: "pending-owner-decision",
  priceCents: null,
  participationLimit: null,
  aiAllowance: null,
} as const);

export type OfferId =
  | "pilot"
  | "continuation"
  | "professional"
  | "specialist"
  | "practice"
  | "partner";

export interface MonthlyAllowance {
  coachMinutes: number;
  reviewMinutes: number;
  supportMinutes: number;
  mockSessions: number | null;
  studyRequests: number | null;
  pooledClinics: number;
  implementationMinutes?: number;
  engineeringMinutes?: number;
  seniorAdvisorMinutes?: number;
  analystMinutes?: number;
}

export interface CoachingOffer {
  id: OfferId;
  termsVersion: "2026-09-15-hypothesis-v1";
  currency: "CAD";
  state: "hypothesis";
  livePurchasable: false;
  priceCents: number;
  months: number;
  installmentCents: number | null;
  startMonth: number;
  monthly: Readonly<MonthlyAllowance>;
  reviewUnitMinutes: number | null;
  internalOnboardingReserve: Readonly<{
    coachMinutes: number;
    supportMinutes: number;
  }> | null;
}

function offer(
  id: OfferId,
  priceCents: number,
  months: number,
  installmentCents: number | null,
  startMonth: number,
  monthly: MonthlyAllowance,
  reviewUnitMinutes: number | null = null,
  internalOnboardingReserve: CoachingOffer["internalOnboardingReserve"] = null,
): Readonly<CoachingOffer> {
  return Object.freeze({
    id,
    termsVersion: "2026-09-15-hypothesis-v1",
    currency: "CAD",
    state: "hypothesis",
    livePurchasable: false,
    priceCents,
    months,
    installmentCents,
    startMonth,
    monthly: Object.freeze(monthly),
    reviewUnitMinutes,
    internalOnboardingReserve,
  });
}

export const COACHING_OFFERS: readonly Readonly<CoachingOffer>[] =
  Object.freeze([
    offer(
      "pilot",
      300_000,
      2,
      null,
      0,
      {
        coachMinutes: 60,
        reviewMinutes: 60,
        supportMinutes: 60,
        mockSessions: 20,
        studyRequests: 100,
        pooledClinics: 4,
      },
      30,
      Object.freeze({ coachMinutes: 60, supportMinutes: 30 }),
    ),
    offer(
      "continuation",
      900_000,
      10,
      90_000,
      2,
      {
        coachMinutes: 60,
        reviewMinutes: 30,
        supportMinutes: 30,
        mockSessions: 20,
        studyRequests: 100,
        pooledClinics: 4,
      },
      30,
    ),
    offer(
      "professional",
      1_200_000,
      12,
      100_000,
      0,
      {
        coachMinutes: 60,
        reviewMinutes: 30,
        supportMinutes: 30,
        mockSessions: 20,
        studyRequests: 100,
        pooledClinics: 4,
      },
      30,
    ),
    offer("specialist", 2_400_000, 12, 200_000, 0, {
      coachMinutes: 120,
      reviewMinutes: 60,
      implementationMinutes: 60,
      supportMinutes: 60,
      mockSessions: 40,
      studyRequests: 200,
      pooledClinics: 4,
    }),
    offer("practice", 4_800_000, 12, 400_000, 0, {
      coachMinutes: 180,
      reviewMinutes: 120,
      engineeringMinutes: 180,
      supportMinutes: 120,
      mockSessions: 60,
      studyRequests: 300,
      pooledClinics: 4,
    }),
    offer("partner", 12_000_000, 12, 1_000_000, 0, {
      coachMinutes: 240,
      seniorAdvisorMinutes: 120,
      reviewMinutes: 240,
      engineeringMinutes: 720,
      analystMinutes: 480,
      supportMinutes: 240,
      mockSessions: null,
      studyRequests: null,
      pooledClinics: 4,
    }),
  ]);

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError("Expected a calendar date in YYYY-MM-DD form");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new RangeError("Invalid calendar date");
  }
  return parsed;
}

// Compute every boundary from the original activation day. Repeatedly adding
// months to a clipped February date would incorrectly move a Jan 31 anniversary.
export function billingMonth(activationDate: string, offset: number): string {
  const anchor = parseDate(activationDate);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("Month offset must be a nonnegative integer");
  }
  const first = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + offset, 1),
  );
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const result = new Date(
    Date.UTC(
      first.getUTCFullYear(),
      first.getUTCMonth(),
      Math.min(anchor.getUTCDate(), lastDay),
    ),
  );
  return result.toISOString().slice(0, 10);
}

export function plannedPeriods(id: string, activationDate: string) {
  const selected = COACHING_OFFERS.find((item) => item.id === id);
  if (!selected) throw new RangeError("Unknown coaching-offer hypothesis");
  return Array.from({ length: selected.months }, (_, index) =>
    Object.freeze({
      startsOn: billingMonth(activationDate, selected.startMonth + index),
      endsOn: billingMonth(activationDate, selected.startMonth + index + 1),
      monthly: selected.monthly,
      state: "planned-only" as const,
    }),
  );
}

export function continuationEligibility(
  pilotActivationDate: string,
  acceptedOn: string,
): "not-started" | "eligible" | "manual-agreement-required" {
  const start = billingMonth(pilotActivationDate, 0);
  const accepted = parseDate(acceptedOn).toISOString().slice(0, 10);
  if (accepted < start) return "not-started";
  if (accepted < billingMonth(start, 2)) return "eligible";
  return "manual-agreement-required";
}
