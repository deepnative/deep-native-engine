import { hostingText } from "./hosting-presentation.ts";
import { readableTime } from "./display-time.ts";
import type { PreviewMetrics } from "./metrics.ts";
import {
  VOLUME_KEYS,
  type ContributionMetrics,
} from "./contribution-metrics.ts";
import {
  COHORT_KEYS,
  type LearningBand,
  type LearningCohort,
  type LearningSegment,
} from "./learning-metrics.ts";
import { BACKGROUNDS, GOALS } from "./content.ts";
import { escape, page } from "./views.ts";
import { portalActions } from "./backend-portal-presentation.ts";

const path = "/operator/metrics/report";
const definition = (value: string) =>
  escape(
    value
      .replaceAll("asOf", "the snapshot time")
      .replaceAll("returnEligible", "the eligible member group")
      .replaceAll("whose left_at is empty", "with no recorded departure"),
  );
const navigation = portalActions([
  [path, "Reload snapshot"],
  ["/operator/metrics", "View aggregate JSON"],
  ["/staff", "Your staff tools"],
]);

const volumeLabels = {
  submitted: "Submitted revisions",
  reviewed: "Revisions with a first editorial decision",
  accepted: "Accepted revisions",
  published: "Revisions shown to members",
  sourceWithdrawn: "Revisions withdrawn by their owner",
  sharingWithdrawnByOwner: "Member display revoked by the owner",
  sharingWithdrawnBySourceChange: "Member display ended by a source change",
} as const;
const groupLabels = {
  member: "Member-origin contributions",
  sample: "Sample-attested contributions",
} as const;
const hidden = "Suppressed";

function contributionSection(value: ContributionMetrics) {
  const since = value.measuredSince
    ? `<time datetime="${escape(value.measuredSince.toISOString())}">${readableTime(value.measuredSince)}</time>`
    : "an unrecorded time";
  const groups = value.groups
    .map(
      (group) =>
        `<section aria-labelledby="contributions-${group.origin}"><h3 id="contributions-${group.origin}">${groupLabels[group.origin]}</h3>${
          group.disclosure === "suppressed"
            ? `<p data-contributions="${group.origin}-suppressed">Suppressed to protect small groups. No contributor, revision or event count is shown.</p>`
            : `<dl data-contributions="${group.origin}">${VOLUME_KEYS.map((key) => `<dt>${volumeLabels[key]}</dt><dd data-contribution="${group.origin}-${key}">${escape(group.volumes[key] ?? hidden)}</dd>`).join("")}<dt>First-decision acceptance share</dt><dd data-contribution="${group.origin}-share">${escape(group.firstDecisionAcceptanceBand ?? hidden)}</dd></dl>`
        }</section>`,
    )
    .join("");
  return `<section aria-labelledby="metrics-contributions"><h2 id="metrics-contributions">Reviewed contributions</h2><p>Measured since ${since}. Volumes are broad bands of distinct revisions, not exact counts. A group needs at least 20 contributing owners, and each value needs at least five owners; a share also needs five owners on each side. Suppressed values may be zero or not.</p><p>${escape(value.definitions.scope)}</p>${groups}<dl>${VOLUME_KEYS.map((key) => `<dt>${volumeLabels[key]}</dt><dd>${escape(value.definitions[key])}</dd>`).join("")}<dt>First-decision acceptance share</dt><dd>${escape(value.definitions.firstDecisionAcceptance)}</dd></dl></section>`;
}

const shown = (value: LearningBand | null) => value ?? hidden;
const SEGMENT_MEASURES = [
  ["activated", "Opened a lesson"],
  ["selfAssessed", "Self-assessed"],
  ["submittedAssignment", "Submitted"],
  ["crossContentReturned", "Returned"],
  ["reportedOutcome", "Reported an outcome"],
] as const;
const COHORT_LABELS = {
  activated: "Opened a lesson (14 days)",
  selfAssessed: "Self-reported completion (14 days)",
  submittedAssignment: "Submitted (30 days)",
  continued: "Continued (day 7–30)",
} as const;
const table = (label: string, head: string[], rows: string) =>
  `<div class="table-scroll" tabindex="0" role="region" aria-label="${label}"><table class="metrics-table"><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;

function segmentTable(
  title: string,
  group: string,
  labels: Record<string, string>,
  segments: LearningSegment[],
) {
  return `<h3>${title}</h3>${table(
    title,
    ["Segment", "Members", ...SEGMENT_MEASURES.map(([, label]) => label)],
    segments
      .map(
        (s) =>
          `<tr data-segment="${group}-${s.key}"><th scope="row">${escape(labels[s.key]!)}</th><td>${shown(s.members)}</td>${SEGMENT_MEASURES.map(([key]) => `<td>${shown(s.values[key])}</td>`).join("")}</tr>`,
      )
      .join(""),
  )}`;
}

function cohortRows(cohorts: LearningCohort[]) {
  return cohorts
    .map((c) =>
      c.disclosure === "window-open"
        ? `<tr data-cohort="${escape(c.month)}"><th scope="row">${escape(c.month)}</th><td colspan="${COHORT_KEYS.length + 1}">Window still open; no values yet</td></tr>`
        : `<tr data-cohort="${escape(c.month)}"><th scope="row">${escape(c.month)}</th><td>${shown(c.members)}</td>${COHORT_KEYS.map((key) => `<td>${shown(c.values[key])}</td>`).join("")}</tr>`,
    )
    .join("");
}

export function metricsReportPage(snapshot: PreviewMetrics): string {
  const { learning, segments, cohorts, definitions, usefulness } = snapshot;
  const { values } = learning;
  const measures = [
    ["activated", "Opened a versioned lesson"],
    ["selfAssessed", "Self-assessed lesson completion"],
    ["submittedAssignment", "Submitted an assignment"],
    ["participated", "Ever joined a circle"],
    ["activeCircle", "Currently in a circle"],
  ] as const;
  return page(
    "Learning and participation snapshot",
    `<section class="reading"><p class="eyebrow">PRIVATE STAFF SNAPSHOT · ${hostingText("SYNTHETIC LOCAL PREVIEW", "NOT A LIVE REPORT")}</p><h1>Learning and participation snapshot</h1><p>Current retained records in this database. This is not a live business report, an enrollment cohort or a measure of verified skill.</p><p>Snapshot time: <time datetime="${escape(snapshot.asOf.toISOString())}">${readableTime(snapshot.asOf)}</time>. All values describe the same instant. Reload to view a fresh snapshot.</p>${navigation}<section aria-labelledby="metrics-members"><h2 id="metrics-members">Retained accounts</h2><p><strong data-metric="members">${shown(learning.members)}</strong> member records</p><p>${definition(definitions.denominator)}</p><p data-accounts="${snapshot.accounts}">${escape(definitions.accounts)}</p><p>Values are broad bands, not exact counts. Nothing is shown below 20 members, and a value below five, or within five of its denominator, is suppressed. Suppressed values may be zero or not.</p></section><section aria-labelledby="metrics-activity"><h2 id="metrics-activity">Learning and participation</h2><p>Each measure counts distinct retained members. Measures overlap and must not be added together.</p><dl>${measures.map(([key, label]) => `<dt>${label}</dt><dd><strong data-metric="${key}">${shown(values[key])}</strong> retained members<p>${definition(definitions[key])}</p></dd>`).join("")}</dl><p>The completion count covers versioned library lessons. The separate starter exercise is not counted here.</p></section><section aria-labelledby="metrics-return"><h2 id="metrics-return">Observed cross-content return</h2><p><strong data-metric="crossContentReturned">${shown(values.crossContentReturned)}</strong> of <strong data-metric="returnEligible">${shown(values.returnEligible)}</strong> eligible members returned to different content.</p><p>${definition(definitions.returnEligible)}</p><p>${definition(definitions.crossContentReturned)}</p></section><section aria-labelledby="metrics-outcomes"><h2 id="metrics-outcomes">Member-reported career outcomes</h2><p><strong data-metric="reportedOutcome">${shown(values.reportedOutcome)}</strong> retained members reported an outcome on their own plan.</p><p>${definition(definitions.reportedOutcome)}</p></section><section aria-labelledby="metrics-program"><h2 id="metrics-program">Foundation program term</h2><p><strong data-metric="enrolledInProgram">${shown(values.enrolledInProgram)}</strong> retained members enrolled; <strong data-metric="withdrewFromProgram">${shown(values.withdrewFromProgram)}</strong> withdrew.</p><p>${definition(definitions.enrolledInProgram)}</p><p>${definition(definitions.withdrewFromProgram)}</p></section><section aria-labelledby="metrics-usefulness"><h2 id="metrics-usefulness">Member-reported usefulness</h2><p data-usefulness="${usefulness.disclosure}">${usefulness.disclosure === "suppressed" ? "Suppressed to protect small groups. No respondent count or answer count is shown." : `Helpful-share band: <strong>${escape(usefulness.helpfulShareBand!)}</strong>. This is a broad band, not an exact percentage.`}</p><p>${definition(definitions.usefulness)}</p></section><section aria-labelledby="metrics-segments"><h2 id="metrics-segments">By starting point, goal and interest</h2><p>${escape(definitions.segments)}</p>${segmentTable("Current starting point", "background", BACKGROUNDS, segments.background)}${segmentTable("Current goal", "goal", GOALS, segments.goal)}${segmentTable("Interest tags (overlap)", "interests", BACKGROUNDS, segments.interests)}</section><section aria-labelledby="metrics-cohorts"><h2 id="metrics-cohorts">Join-month cohorts</h2><p>${escape(definitions.cohorts)}</p>${
      cohorts.length
        ? table(
            "Join-month cohorts",
            [
              "Joined (UTC)",
              "Members",
              ...COHORT_KEYS.map((key) => COHORT_LABELS[key]),
            ],
            cohortRows(cohorts),
          )
        : "<p>No cohorts yet.</p>"
    }<dl><dt>${COHORT_LABELS.activated}</dt><dd>${escape(definitions.cohortActivated)}</dd><dt>${COHORT_LABELS.selfAssessed}</dt><dd>${escape(definitions.cohortSelfAssessed)}</dd><dt>${COHORT_LABELS.submittedAssignment}</dt><dd>${escape(definitions.cohortSubmittedAssignment)}</dd><dt>${COHORT_LABELS.continued}</dt><dd>${escape(definitions.cohortContinued)}</dd></dl></section>${contributionSection(snapshot.contributions)}<section aria-labelledby="metrics-limits"><h2 id="metrics-limits">What this snapshot cannot tell you</h2><p>Deleted accounts and their activity are excluded. Retained expired or revoked member sessions remain in the denominator; circle departure does not erase earlier participation. No member, lesson or date filters are available, and segments use current choices, not the values at the time of each event.</p><p>The instructional quality of contributions, paid conversion, revenue and service capacity are not included. Career outcomes appear only as member-reported counts; none is verified. A submission or self-report does not establish a qualified review. ${snapshot.accounts === "demo" ? "Demo accounts are test data, not evidence of live outcomes." : "Accounts created before a site stops being a demo stay demo accounts and are never counted here."}</p></section>${navigation}</section>`,
  );
}

export function metricsReportUnavailablePage(
  reason: "query" | "denied" | "unavailable",
): string {
  const messages = {
    query:
      "This snapshot does not accept member, lesson, segment or date filters. Open the unfiltered report to continue.",
    denied:
      "A current operator or platform administrator session is required. No snapshot is shown.",
    unavailable:
      "The snapshot could not be read. No partial counts are shown. You can deliberately reload after the service recovers; nothing is retried automatically.",
  };
  return page(
    "Learning snapshot unavailable",
    `<section class="reading"><h1>Learning snapshot unavailable</h1><p role="alert">${messages[reason]}</p>${navigation}</section>`,
  );
}
