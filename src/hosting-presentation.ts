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
