// #122 contribution-metrics-v1 disclosure. Raw counts never leave this module:
// the HTML and JSON reports share the sanitized result.
export const CONTRIBUTION_METRICS_VERSION = "contribution-metrics-v1";
export const MIN_CONTRIBUTORS = 20;
export const MIN_CELL_OWNERS = 5;

export const VOLUME_KEYS = [
  "submitted",
  "reviewed",
  "accepted",
  "published",
  "sourceWithdrawn",
  "sharingWithdrawnByOwner",
  "sharingWithdrawnBySourceChange",
] as const;
export type VolumeKey = (typeof VOLUME_KEYS)[number];
export type VolumeBand = "5-19" | "20-49" | "50-99" | "100-199" | "200+";
export type ShareBand = "0-24%" | "25-49%" | "50-74%" | "75-100%";
export type ContributionOrigin = "member" | "sample";

export interface ContributionGroup {
  origin: ContributionOrigin;
  disclosure: "suppressed" | "disclosed";
  volumes: Record<VolumeKey, VolumeBand | null>;
  firstDecisionAcceptanceBand: ShareBand | null;
}
export interface ContributionMetrics {
  version: typeof CONTRIBUTION_METRICS_VERSION;
  measuredSince: Date | null;
  groups: ContributionGroup[];
  definitions: Record<VolumeKey | "firstDecisionAcceptance" | "scope", string>;
}

// Each cell: distinct revisions with the event and distinct owners behind them.
interface Cell {
  revisions: number;
  owners: number;
}
export interface RawContributionGroup {
  contributors: number;
  volumes: Record<VolumeKey, Cell>;
  firstAccepted: Cell;
  firstNotAccepted: Cell;
}

const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const cell = (value: unknown): value is Cell =>
  !!value &&
  typeof value === "object" &&
  count((value as Cell).revisions) &&
  count((value as Cell).owners) &&
  (value as Cell).owners <= (value as Cell).revisions;

function volumeBand(value: Cell): VolumeBand | null {
  if (value.owners < MIN_CELL_OWNERS) return null;
  const n = value.revisions;
  return n < 20
    ? "5-19"
    : n < 50
      ? "20-49"
      : n < 100
        ? "50-99"
        : n < 200
          ? "100-199"
          : "200+";
}

function shareBand(accepted: Cell, other: Cell): ShareBand | null {
  // A share and its complement are disclosed together or not at all.
  if (accepted.owners < MIN_CELL_OWNERS || other.owners < MIN_CELL_OWNERS)
    return null;
  const share = accepted.revisions / (accepted.revisions + other.revisions);
  return share < 0.25
    ? "0-24%"
    : share < 0.5
      ? "25-49%"
      : share < 0.75
        ? "50-74%"
        : "75-100%";
}

const suppressed = (origin: ContributionOrigin): ContributionGroup => ({
  origin,
  disclosure: "suppressed",
  volumes: Object.fromEntries(VOLUME_KEYS.map((key) => [key, null])) as Record<
    VolumeKey,
    null
  >,
  firstDecisionAcceptanceBand: null,
});

export function contributionGroup(
  origin: ContributionOrigin,
  raw: unknown,
): ContributionGroup {
  const value = raw as RawContributionGroup | null;
  if (
    !value ||
    typeof value !== "object" ||
    !count(value.contributors) ||
    !value.volumes ||
    !VOLUME_KEYS.every((key) => cell(value.volumes[key])) ||
    !cell(value.firstAccepted) ||
    !cell(value.firstNotAccepted) ||
    value.contributors < MIN_CONTRIBUTORS
  )
    return suppressed(origin);
  return {
    origin,
    disclosure: "disclosed",
    volumes: Object.fromEntries(
      VOLUME_KEYS.map((key) => [key, volumeBand(value.volumes[key])]),
    ) as Record<VolumeKey, VolumeBand | null>,
    firstDecisionAcceptanceBand: shareBand(
      value.firstAccepted,
      value.firstNotAccepted,
    ),
  };
}

export function contributionMetrics(
  measuredSince: unknown,
  raw: unknown,
): ContributionMetrics {
  const groups = (raw ?? {}) as Partial<Record<ContributionOrigin, unknown>>;
  return {
    version: CONTRIBUTION_METRICS_VERSION,
    measuredSince:
      measuredSince instanceof Date && Number.isFinite(+measuredSince)
        ? measuredSince
        : null,
    groups: (["member", "sample"] as const).map((origin) =>
      contributionGroup(origin, groups[origin]),
    ),
    definitions: {
      scope:
        "Committed contribution events recorded since measurement started, for retained accounts only. Deleted accounts and their events are excluded. Earlier history is incomplete, not zero. Member-origin proposals may still be invented preview data; origin alone does not establish live activity.",
      submitted:
        "Distinct proposal revisions submitted by their owner with a rights attestation. A replayed submission adds nothing.",
      reviewed:
        "Distinct revisions that received their first editorial decision: changes requested, rejected or accepted. Reads, quarantine and automated output are not decisions.",
      accepted:
        "Distinct revisions accepted by a current moderator or platform administrator.",
      published:
        "Distinct accepted revisions their owner chose to show to signed-in members. This is not public-web publication.",
      sourceWithdrawn:
        "Distinct revisions whose owner withdrew the proposal itself.",
      sharingWithdrawnByOwner:
        "Distinct published revisions whose owner revoked member display.",
      sharingWithdrawnBySourceChange:
        "Distinct published revisions whose display ended automatically because the source changed. This is not an owner action.",
      firstDecisionAcceptance:
        "Of revisions submitted since measurement started that received a first editorial decision, the share first accepted. It is an editorial outcome, not instructional quality, verified skill or expert qualification. A later withdrawal or decision does not rewrite the first decision.",
    },
  };
}
