import { BACKGROUNDS, GOALS } from "./content.ts";

/** #649 Exact learning counts stay inside the store; only these leave it. */
export const MIN_LEARNING_GROUP = 20;
export const MIN_LEARNING_CELL = 5;
export const LEARNING_KEYS = [
  "activated",
  "selfAssessed",
  "participated",
  "activeCircle",
  "submittedAssignment",
  "returnEligible",
  "crossContentReturned",
  // #123 OUTCOME: member-reported, never verified.
  "reportedOutcome",
] as const;
export const COHORT_KEYS = [
  "activated",
  "selfAssessed",
  "submittedAssignment",
  "continued",
] as const;
export type LearningKey = (typeof LEARNING_KEYS)[number];
export type CohortKey = (typeof COHORT_KEYS)[number];
export type LearningBand = "5-19" | "20-49" | "50-99" | "100-199" | "200+";
export type RawLearningCell = { members: number } & Record<LearningKey, number>;
export interface LearningDisclosure {
  disclosure: "suppressed" | "coarse-band";
  members: LearningBand | null;
  values: Record<LearningKey, LearningBand | null>;
}
export interface LearningSegment extends LearningDisclosure {
  key: string;
}
export interface LearningSegments {
  background: LearningSegment[];
  goal: LearningSegment[];
  interests: LearningSegment[];
}
export interface LearningCohort {
  month: string;
  disclosure: "window-open" | "suppressed" | "coarse-band";
  members: LearningBand | null;
  values: Record<CohortKey, LearningBand | null>;
}

const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function band(value: number): LearningBand {
  return value < 20
    ? "5-19"
    : value < 50
      ? "20-49"
      : value < 100
        ? "50-99"
        : value < 200
          ? "100-199"
          : "200+";
}

/** A value and its complement are disclosed together or not at all. */
export function learningBand(
  value: number,
  denominator: number,
): LearningBand | null {
  return count(value) &&
    value >= MIN_LEARNING_CELL &&
    denominator - value >= MIN_LEARNING_CELL
    ? band(value)
    : null;
}

function blank<K extends string>(keys: readonly K[]) {
  return Object.fromEntries(keys.map((key) => [key, null])) as Record<K, null>;
}

const SUPPRESSED: LearningDisclosure = {
  disclosure: "suppressed",
  members: null,
  values: blank(LEARNING_KEYS),
};

function valid<K extends string>(
  raw: unknown,
  keys: readonly K[],
): raw is { members: number } & Record<K, number> {
  return (
    !!raw &&
    typeof raw === "object" &&
    count((raw as { members?: unknown }).members) &&
    keys.every((key) => count((raw as Record<K, unknown>)[key]))
  );
}

export function learningDisclosure(raw: unknown): LearningDisclosure {
  if (!valid(raw, LEARNING_KEYS) || raw.members < MIN_LEARNING_GROUP)
    return SUPPRESSED;
  return {
    disclosure: "coarse-band",
    members: band(raw.members),
    values: Object.fromEntries(
      LEARNING_KEYS.map((key) => [
        key,
        learningBand(
          raw[key],
          // Return is a share of the eligible group; the rest of all members.
          key === "crossContentReturned" ? raw.returnEligible : raw.members,
        ),
      ]),
    ) as LearningDisclosure["values"],
  };
}

function segmentGroup(
  keys: readonly string[],
  raw: unknown,
  total: number,
): LearningSegment[] {
  const cells = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    { members?: number }
  >;
  // Every known key is listed, so a suppressed row never reveals a zero.
  return keys.map((key) => {
    const cell = cells[key];
    const outside = total - (cell?.members ?? total);
    return {
      key,
      ...(outside >= MIN_LEARNING_CELL ? learningDisclosure(cell) : SUPPRESSED),
    };
  });
}

export function learningSegments(raw: unknown, total: number) {
  const groups = (raw && typeof raw === "object" ? raw : {}) as Record<
    keyof LearningSegments,
    unknown
  >;
  return {
    background: segmentGroup(
      Object.keys(BACKGROUNDS),
      groups.background,
      total,
    ),
    goal: segmentGroup(Object.keys(GOALS), groups.goal, total),
    interests: segmentGroup(Object.keys(BACKGROUNDS), groups.interests, total),
  } satisfies LearningSegments;
}

export function learningCohorts(raw: unknown): LearningCohort[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((cohort: unknown): LearningCohort[] => {
    const month = (cohort as { month?: unknown } | null)?.month;
    if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) return [];
    const hidden = { month, members: null, values: blank(COHORT_KEYS) };
    // A window still open would show partial values that later change.
    if ((cohort as { closed?: unknown }).closed !== true)
      return [{ ...hidden, disclosure: "window-open" }];
    if (!valid(cohort, COHORT_KEYS) || cohort.members < MIN_LEARNING_GROUP)
      return [{ ...hidden, disclosure: "suppressed" }];
    return [
      {
        month,
        disclosure: "coarse-band",
        members: band(cohort.members),
        values: Object.fromEntries(
          COHORT_KEYS.map((key) => [
            key,
            learningBand(cohort[key], cohort.members),
          ]),
        ) as LearningCohort["values"],
      },
    ];
  });
}
