import { escape, page } from "./views.ts";
import type { MemberTestUnitSnapshot } from "./member-test-units.ts";

const names = {
  coach_minutes: "Coach minutes",
  review_minutes: "Review minutes",
  support_minutes: "Support minutes",
  mock_sessions: "Mock sessions",
  study_requests: "Study requests",
};
function time(value: Date) {
  const text = escape(value.toISOString());
  return `<time datetime="${text}">${text}</time>`;
}
export function memberTestUnitsPage(value: MemberTestUnitSnapshot) {
  const empty = value.categories.every((row) => row.grants === 0);
  const categories = value.categories
    .map(
      (row) =>
        `<section data-test-unit-category="${row.category}"><h2>${names[row.category]}</h2>${row.grants === 0 ? "<p>No local test grant in this category.</p>" : ""}<dl>${(
          [
            ["usable", "Usable at the snapshot time", row.usable],
            ["held", "Held for an unresolved outcome", row.held],
            ["future", "Not yet available", row.future],
            [
              "awaitingExpiry",
              "Past deadline — unavailable",
              row.awaitingExpiry,
            ],
            ["consumed", "Consumed", row.consumed],
            ["expired", "Expiry recorded", row.expired],
            ["adjusted", "Removed by a test adjustment", row.adjusted],
          ] as const
        )
          .map(
            ([key, label, quantity]) =>
              `<dt>${label}</dt><dd><span data-field="${key}">${quantity}</span> ${row.unit}</dd>`,
          )
          .join(
            "",
          )}</dl>${row.nextExpiry === null ? "" : `<p>Earliest deadline affecting usable ${row.unit}: ${time(row.nextExpiry)}. Other units may have different deadlines.</p>`}${row.nextStart === null ? "" : `<p>Earliest start affecting future ${row.unit}: ${time(row.nextStart)}.</p>`}</section>`,
    )
    .join("");
  return page(
    "Your local test units",
    `<article class="reading"><p><a href="/availability">Sample availability</a></p><p class="eyebrow">PRIVATE · LOCAL TEST PREVIEW</p><h1>Your local test units</h1><p>These are existing test allowances for this session. Reading this page creates no allowance, purchase or booking. Minutes, sessions and requests are separate.</p><p>Snapshot taken ${time(value.asOf)}. Balances can change after a hold, withdrawal, settlement or deadline; reload before making a request.</p>${empty ? '<p role="status">No local test grants are configured for this session. This does not define a foundation allowance or a paid plan.</p>' : ""}${categories}<p>Held units remain held until an explicit outcome, even after a grant deadline. A zero balance does not describe a purchased service or qualified capacity.</p><p><a href="/member/test-units">Read a fresh snapshot</a> · <a href="/member/test-units/download">Download a current summary (JSON)</a></p><p>The download is another current snapshot. It can differ after an intervening change and contains no historical ledger or private learning content.</p><p><a href="/member/export">Download retained test-unit history</a> as part of your private structured records. History includes expired and released units; stored counters differ from current usable balances.</p></article>`,
  );
}
export function memberTestUnitsUnavailablePage(
  kind: "denied" | "unavailable" | "live" | "query",
) {
  const message = {
    denied: "These test units are not available to this session.",
    unavailable:
      "The test-unit summary is unavailable. No balance was returned.",
    live: "The local test-unit summary is unavailable in live mode.",
    query: "This private summary does not accept query fields.",
  }[kind];
  return page(
    "Test-unit summary unavailable",
    `<article class="reading"><h1>Test-unit summary unavailable</h1><p role="status">${message}</p><p><a href="/member/test-units">Read a fresh snapshot</a> · <a href="/availability">Sample availability</a></p></article>`,
  );
}
