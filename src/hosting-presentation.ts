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
