import { portalActions } from "./backend-portal-presentation.ts";
import { readableTime } from "./display-time.ts";
import { hostingText } from "./hosting-presentation.ts";
import type {
  AgreementGroup,
  AgreementOutcomesSnapshot,
} from "./agreement-outcomes.ts";
import { share } from "./agreement-outcomes.ts";
import { escape, page } from "./views.ts";

function fields(rows: [string, string, string][]) {
  return `<dl>${rows.map(([key, label, value]) => `<dt>${label}</dt><dd data-field="${key}">${value}</dd>`).join("")}</dl>`;
}
const when = (value: Date | null) =>
  value
    ? `<time datetime="${escape(value.toISOString())}">${readableTime(value)}</time>`
    : "None";

function groupSection(kind: "real" | "test", row: AgreementGroup) {
  const key = (name: string) => `${kind}.${name}`;
  const title = kind === "real" ? "Real agreements" : "Test agreements";
  const intro =
    kind === "real"
      ? "Agreements whose terms say they aren't a test. These are the only figures that could describe real members."
      : "Agreements whose terms say they are a test, or don't say. They are never added to the real figures.";
  const status = row.consistent
    ? ""
    : '<p role="alert" data-agreement-status="inconsistent">These outcomes don\'t add up to their totals. Check the agreements before reading the rates. This report corrects nothing.</p>';
  return `<section class="portal-card" data-agreement-group="${kind}"><h2>${title}</h2><p>${intro}</p>${status}<h3>Offers</h3>${fields(
    [
      [key("offered"), "Offered", String(row.offered)],
      [
        key("acceptance"),
        "Accepted, of all offered",
        share(row.accepted, row.offered, "No agreements offered"),
      ],
      [key("waiting"), "Still waiting for the member", String(row.waiting)],
      [
        key("withdrawn"),
        "Withdrawn before acceptance (still counted as offered)",
        String(row.withdrawn),
      ],
    ],
  )}<h3>Accepted agreements</h3>${fields([
    [key("active"), "Active now", String(row.active)],
    [
      key("cancellation"),
      "Cancelled after acceptance, of all accepted",
      share(row.cancelled, row.accepted, "None accepted"),
    ],
  ])}<h3>Dates</h3>${fields([
    [key("firstOffered"), "First offer", when(row.firstOffered)],
    [key("lastOffered"), "Latest offer", when(row.lastOffered)],
    [key("firstAccepted"), "First acceptance", when(row.firstAccepted)],
    [key("lastAccepted"), "Latest acceptance", when(row.lastAccepted)],
  ])}</section>`;
}

export function agreementOutcomesPage(snapshot: AgreementOutcomesSnapshot) {
  return page(
    "Course agreement outcomes",
    `<article class="reading"><p class="eyebrow">STAFF · ${hostingText("PREVIEW RECORDS", "TEST DATA")} · NOT A LIVE FIGURE</p><h1>Course agreement outcomes</h1><p>One read-only snapshot of the course-billing agreements offered to members: how many were accepted, withdrawn or cancelled. Real and test agreements are shown apart and are never added together.</p><p>As of <time datetime="${escape(snapshot.asOf.toISOString())}">${readableTime(snapshot.asOf)}</time>. Each agreement is counted once, by what has happened to it so far. A later read may differ.</p>${portalActions(
      [
        ["/operator/invoice-reconciliation", "Invoice reconciliation"],
        ["/operator", "Administration console"],
      ],
    )}${groupSection("real", snapshot.real)}${groupSection("test", snapshot.test)}<h2>How these are counted</h2><ul><li>Offered counts every agreement, including offers later withdrawn. Accepted counts every agreement a member accepted, including ones cancelled since.</li><li>Cancellation has no recorded date, so cancelled and withdrawn counts are as of this snapshot, not a period.</li><li>An agreement goes when its member deletes their account, so deleted accounts aren't counted.</li></ul><h2>What this report cannot establish</h2><ul><li>This is not revenue or collected cash. Invoices and payments have their own reconciliation.</li><li>Renewal of monthly agreements isn't counted here.</li><li>A small number of agreements can't show a trend. No forecast is made.</li><li>No member names, emails, agreement terms, amounts or identifiers are shown. Nothing is corrected or stored.</li></ul><p><a href="/operator/course-agreements">Read a fresh snapshot</a></p></article>`,
  );
}
export function agreementOutcomesUnavailablePage(
  kind: "denied" | "unavailable" | "live" | "query",
) {
  const message = {
    denied: "This report is not available to this session.",
    unavailable:
      "The snapshot could not be confirmed. No figures are shown. Nothing is retried automatically.",
    live: "This report is unavailable in live mode, so it shows no live figures.",
    query:
      "This report does not accept query fields or filters. Open the report using its original link.",
  }[kind];
  return page(
    "Agreement outcomes unavailable",
    `<section class="error-page"><h1>Agreement outcomes unavailable</h1><p role="alert">${message}</p>${portalActions(
      [
        ["/operator/course-agreements", "Open the report"],
        ["/operator", "Administration console"],
      ],
    )}</section>`,
  );
}
