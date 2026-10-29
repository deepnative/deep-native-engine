import type { PreviewMetrics } from "./metrics.ts";
import { escape, page } from "./views.ts";

const path = "/operator/metrics/report";
const definition = (value: string) =>
  escape(
    value
      .replaceAll("asOf", "the snapshot time")
      .replaceAll("returnEligible", "the eligible member group")
      .replaceAll("whose left_at is empty", "with no recorded departure"),
  );
const navigation = `<p><a href="${path}">Reload snapshot</a> · <a href="/operator/metrics">View aggregate JSON</a> · <a href="/staff">Your staff tools</a></p>`;

export function metricsReportPage(snapshot: PreviewMetrics): string {
  const { counts, definitions, usefulness } = snapshot;
  const measures = [
    ["activated", "Opened a versioned lesson"],
    ["selfAssessed", "Self-assessed lesson completion"],
    ["submittedAssignment", "Submitted an assignment"],
    ["participated", "Ever joined a circle"],
    ["activeCircle", "Currently in a circle"],
  ] as const;
  return page(
    "Learning and participation snapshot",
    `<section class="reading"><p class="eyebrow">PRIVATE STAFF SNAPSHOT · SYNTHETIC LOCAL PREVIEW</p><h1>Learning and participation snapshot</h1><p>Current retained records in this database. This is not a live business report, an enrollment cohort or a measure of verified skill.</p><p>Snapshot time: <time datetime="${escape(snapshot.asOf.toISOString())}">${escape(snapshot.asOf.toISOString())}</time>. All counts describe the same instant. Reload to view a fresh snapshot.</p>${navigation}<section aria-labelledby="metrics-members"><h2 id="metrics-members">Retained accounts</h2><p><strong data-metric="members">${counts.members}</strong> member records</p><p>${definition(definitions.denominator)}</p>${counts.members === 0 ? "<p>No retained members yet; a member-based rate is undefined.</p>" : ""}</section><section aria-labelledby="metrics-activity"><h2 id="metrics-activity">Learning and participation</h2><p>Each measure counts distinct retained members. Measures overlap and must not be added together.</p><dl>${measures.map(([key, label]) => `<dt>${label}</dt><dd><strong data-metric="${key}">${counts[key]}</strong> of ${counts.members} retained members<p>${definition(definitions[key])}</p></dd>`).join("")}</dl><p>The completion count covers versioned library lessons. The separate starter exercise is not counted here.</p></section><section aria-labelledby="metrics-return"><h2 id="metrics-return">Observed cross-content return</h2><p><strong data-metric="crossContentReturned">${counts.crossContentReturned}</strong> of <strong data-metric="returnEligible">${counts.returnEligible}</strong> eligible members returned to different content.</p>${counts.returnEligible === 0 ? "<p>No eligible members yet; a return rate is undefined.</p>" : ""}<p>${definition(definitions.returnEligible)}</p><p>${definition(definitions.crossContentReturned)}</p></section><section aria-labelledby="metrics-usefulness"><h2 id="metrics-usefulness">Member-reported usefulness</h2><p data-usefulness="${usefulness.disclosure}">${usefulness.disclosure === "suppressed" ? "Suppressed to protect small groups. No respondent count or answer count is shown." : `Helpful-share band: <strong>${escape(usefulness.helpfulShareBand!)}</strong>. This is a broad band, not an exact percentage.`}</p><p>${definition(definitions.usefulness)}</p></section><section aria-labelledby="metrics-limits"><h2 id="metrics-limits">What this snapshot cannot tell you</h2><p>Deleted accounts and their activity are excluded. Retained expired or revoked member sessions remain in the denominator; circle departure does not erase earlier participation. No member, background, goal, lesson or date filters are available.</p><p>Calendar cohorts, reviewed contribution quality, paid conversion, revenue, service capacity and career outcomes are not included. A submission or self-report does not establish a qualified review. Demo records are not evidence of live outcomes.</p></section>${navigation}</section>`,
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
