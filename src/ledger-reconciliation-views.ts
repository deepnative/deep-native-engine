import { escape, page } from "./views.ts";
import type { LedgerReconciliationSnapshot } from "./ledger-reconciliation.ts";

const categoryNames = {
  coach_minutes: "Coach minutes",
  review_minutes: "Review minutes",
  support_minutes: "Support minutes",
  mock_sessions: "Mock sessions",
  study_requests: "Study requests",
};
function values(fields: [string, string, number][]) {
  return `<dl>${fields.map(([key, label, value]) => `<dt>${label}</dt><dd data-field="${key}">${String(value)}</dd>`).join("")}</dl>`;
}
export function ledgerReconciliationPage(
  snapshot: LedgerReconciliationSnapshot,
) {
  const categories = snapshot.categories
    .map((row) => {
      const name = categoryNames[row.category],
        units = row.unit;
      const empty =
        row.observed.grants === 0 &&
        row.observed.reservations === 0 &&
        row.observed.events === 0 &&
        row.observed.completions === 0;
      const attached =
        row.category === "review_minutes" ||
        row.category === "support_minutes" ||
        row.category === "study_requests";
      return `<details data-ledger-category="${row.category}"${row.reconciliation.status === "discrepancies" ? " open" : ""}><summary><strong>${name}</strong> — ${row.reconciliation.status === "discrepancies" ? "Structural discrepancies detected" : "Structural checks consistent"}</summary>${empty ? '<p role="status">No retained records to compare. Zero observed records do not establish service use or external reconciliation.</p>' : ""}<h2>${name}: observed accounting</h2><p>All quantities in this category use ${units}. Available and expired are observed accounting buckets. Available units are not bookable or qualified capacity.</p>${values(
        [
          ["observed.grants", "Retained grants", row.observed.grants],
          [
            "observed.reservations",
            "Retained reservations",
            row.observed.reservations,
          ],
          ["observed.events", "Retained events", row.observed.events],
          [
            "observed.completions",
            "Retained completion attachments",
            row.observed.completions,
          ],
          [
            "observed.granted",
            `Original granted ${units}`,
            row.observed.granted,
          ],
          [
            "observed.available",
            `Observed available ${units}`,
            row.observed.available,
          ],
          [
            "observed.reserved",
            `Observed reserved ${units}`,
            row.observed.reserved,
          ],
          [
            "observed.consumed",
            `Observed consumed ${units}`,
            row.observed.consumed,
          ],
          [
            "observed.expired",
            `Observed expired ${units}`,
            row.observed.expired,
          ],
          [
            "observed.adjusted",
            `Observed adjusted ${units}`,
            row.observed.adjusted,
          ],
        ],
      )}<h3>Recorded events</h3><p>These are event counts, not extra units. Counts do not authenticate request fingerprints or prove that an asserted service occurred.</p>${values(
        [
          ["events.grant", "Grant events", row.events.grant],
          ["events.reserve", "Reserve events", row.events.reserve],
          ["events.consume", "Consume events", row.events.consume],
          ["events.release", "Release events", row.events.release],
          ["events.expire", "Expire events", row.events.expire],
          ["events.adjust", "Adjust events", row.events.adjust],
        ],
      )}<h3>Completion attachments</h3><p>${attached ? "An attached synthetic completion is an invented assertion, not evidence of qualified service or provider execution." : "Completion attachments are unsupported for this category. An ordinary consumption remains valid without an attachment."}</p>${values(
        [
          [
            "completion.attachedQuantity",
            `Attached ${units}`,
            row.completion.attachedQuantity,
          ],
          [
            "completion.consumedWithoutAttachment",
            "Consumed reservations with no attached synthetic completion",
            row.completion.consumedWithoutAttachment,
          ],
        ],
      )}${
        row.unit === "minutes" && attached
          ? `<p>Attached whole minutes include delivery and preparation once.</p>${values(
              [
                [
                  "completion.deliveredMinutes",
                  "Attached delivered minutes",
                  row.completion.deliveredMinutes,
                ],
                [
                  "completion.preparationMinutes",
                  "Attached preparation minutes",
                  row.completion.preparationMinutes,
                ],
              ],
            )}`
          : "<p>Delivered/preparation minute breakdown: not applicable.</p>"
      }<p>No attached synthetic completion is a valid state for ordinary consumption; it is not itself a discrepancy.</p><h3>Structural reconciliation</h3><p data-reconciliation-status="${row.reconciliation.status}">${row.reconciliation.status === "discrepancies" ? "Discrepancies remain visible. This report makes no correction." : "The listed retained structural relationships are consistent. This does not establish complete event reconstruction or real service delivery."}</p><p>Counts below identify records that fail one or more checks within each group. Groups may overlap; they are not a net difference or an additive total.</p>${values(
        [
          [
            "reconciliation.grants",
            "Grants with structural discrepancies",
            row.reconciliation.grants,
          ],
          [
            "reconciliation.reservations",
            "Reservations with structural discrepancies",
            row.reconciliation.reservations,
          ],
          [
            "reconciliation.events",
            "Events with structural discrepancies",
            row.reconciliation.events,
          ],
          [
            "reconciliation.completions",
            "Completion attachments with structural discrepancies",
            row.reconciliation.completions,
          ],
        ],
      )}</details>`;
    })
    .join("");
  return page(
    "Synthetic ledger reconciliation",
    `<article class="reading"><p><a href="/operator/experts">Expert coverage registry</a></p><p class="eyebrow">OPERATOR · SYNTHETIC LOCAL PREVIEW</p><h1>Synthetic ledger reconciliation</h1><p>One read-only snapshot of current retained local test records. Expand a category to inspect observed totals, structural checks and completion attachments. Categories use different units and are never added together.</p><p>As of <time datetime="${escape(snapshot.asOf.toISOString())}">${escape(snapshot.asOf.toISOString())}</time>. A later read may change after settlement or deletion; this is not a historical retention record.</p>${categories}<h2>What this report cannot establish</h2><ul><li>Release events do not record whether units returned to available or expired. That attribution is unrecorded; timestamps do not prove it.</li><li>Invoice, collected cash, provider, job and manual-source reconciliation are unavailable.</li><li>Qualified capacity, booked service, revenue, actual cost and production entitlement policy are unavailable.</li><li>No member identifiers, completion references, private text or drill-down are provided. Nothing is corrected, granted or retained as new analytics.</li></ul><p><a href="/operator/ledger-reconciliation">Read a fresh snapshot</a></p></article>`,
  );
}
export function ledgerReconciliationUnavailablePage(
  kind: "denied" | "unavailable" | "live" | "query",
) {
  const message = {
    denied: "This report is not available to this session.",
    unavailable:
      "The snapshot could not be confirmed. No report results are shown. Nothing is retried automatically.",
    live: "This synthetic report is unavailable in live mode.",
    query:
      "This report does not accept query fields or filters. Open the report using its original link.",
  }[kind];
  return page(
    "Ledger report unavailable",
    `<section class="error-page"><h1>Ledger report unavailable</h1><p role="alert">${message}</p><p><a href="/operator/ledger-reconciliation">Open the report</a> · <a href="/operator/experts">Expert coverage registry</a></p></section>`,
  );
}
