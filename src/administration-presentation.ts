import { AsyncLocalStorage } from "node:async_hooks";

// Whether this request's member may use administrator entry. Only a request
// that confirmed a verified owner shows the link; routes still authorize.
const administration = new AsyncLocalStorage<boolean>();
export function withAdministration<T>(available: boolean, render: () => T): T {
  return administration.run(available, render);
}
export function administrationLink(html: string): string {
  return administration.getStore() === true ? html : "";
}
