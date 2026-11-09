import { AsyncLocalStorage } from "node:async_hooks";

// Rendering follows this request's validated runtime, including async errors.
// A hostname, forwarded header or another app instance cannot select hosting.
const hosting = new AsyncLocalStorage<boolean>();
export function withHosting<T>(hosted: boolean, render: () => T): T {
  return hosting.run(hosted, render);
}
export function hostingText(local: string, hosted: string): string {
  return hosting.getStore() === true ? hosted : local;
}
// DEMOSITE-01/02: a visible demo site marks every page as test data. The banner
// brings its own styles, because some page frames use another main stylesheet.
const demo = new AsyncLocalStorage<boolean>();
export function withDemoSite<T>(enabled: boolean, render: () => T): T {
  return demo.run(enabled, render);
}
export function demoBanner(): string {
  return demo.getStore() === true
    ? '<link rel="stylesheet" href="/assets/demo-banner.css"><p class="demo-banner" role="note"><strong>Demo site</strong> · Test data only. Invoices are samples and nothing is payable.</p>'
    : "";
}
/**
 * #717 Event text is versioned content, and titles are also stored in saved
 * registrations, so hosted pages reword it when shown and the records stay as
 * they are. Text with no entry here reads the same on every site.
 */
const HOSTED_EVENT_TEXT = new Map([
  ["Read a synthetic example", "Read an invented example"],
  ["Local event registration rehearsal", "Event registration practice"],
  ["Local platform administrator", "Platform administrator"],
]);
export function eventText(text: string): string {
  return hostingText(text, HOSTED_EVENT_TEXT.get(text) ?? text);
}
/**
 * #730 Provided-sample labels and practice comparisons are saved or exported as
 * written, so hosted pages reword them when shown. Only the fixed start and end
 * of a comparison change, never the member's or the source's words between them.
 */
export function providedSampleLabel(label: string): string {
  return hostingText(label, "Provided invented example · unreviewed");
}
export function practiceComparison(saved: string): string {
  return hostingText(
    saved,
    saved
      .replace(
        /^Simulation — unreviewed local comparison\./,
        "Simulation — unreviewed comparison.",
      )
      .replace(
        /This deterministic comparison (does not verify accuracy and cannot judge competence\. Uncertainty remains; no qualified review has occurred\.)(\n[^\n]*)?$/,
        "This comparison $1$2",
      ),
  );
}
export function privateRecordsLabel(): string {
  return hostingText(
    "Download private preview records",
    "Download my private records",
  );
}
/**
 * #653 Members may use real information on hosted private learning forms. The
 * local preview still takes invented data only, and this request's validated
 * runtime is the only thing that selects between them.
 */
export function inventedInputOnly(): boolean {
  return hosting.getStore() !== true;
}
// WFB-NORMAL-03 (#115): proposal pages follow whether member contributions
// (intake, editorial acceptance and member sharing) are on for this app.
const contributions = new AsyncLocalStorage<boolean>();
export function withMemberContributions<T>(
  enabled: boolean,
  render: () => T,
): T {
  return contributions.run(enabled, render);
}
export function memberContributionsOn(): boolean {
  return contributions.getStore() === true;
}
