import { AsyncLocalStorage } from "node:async_hooks";

// Whether this request's app offers administrator entry. Pages rendered
// outside a request keep showing the link, as before.
const administration = new AsyncLocalStorage<boolean>();
export function withAdministration<T>(available: boolean, render: () => T): T {
  return administration.run(available, render);
}
export function administrationLink(html: string): string {
  return administration.getStore() === false ? "" : html;
}
