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
