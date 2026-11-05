import { AsyncLocalStorage } from "node:async_hooks";
import type { Store } from "./store.ts";

type SessionResult = Awaited<ReturnType<Store["session"]>>;
type Membership = {
  signedIn: boolean | undefined;
  signInAvailable: boolean;
  // The header's lookup, handed once to the route's own first session check.
  lookup?: { token: string; result: Promise<SessionResult>; used: boolean };
};
// Pages rendered outside a request, or when the session could not be
// checked, keep the member links.
const membership = new AsyncLocalStorage<Membership>();
export function withMembership<T>(state: Membership, render: () => T): T {
  return membership.run(state, render);
}
export function signedIn(): boolean {
  return membership.getStore()?.signedIn !== false;
}
/** What an earlier check found, undefined when it has not been checked. */
export function knownSignedIn(): boolean | undefined {
  return membership.getStore()?.signedIn;
}
export function signInAvailable(): boolean {
  return membership.getStore()?.signInAvailable === true;
}
/** Let a route reuse the header's session lookup instead of repeating it. */
export function sharingHeaderSession(store: Store): Store {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property !== "session")
        return Reflect.get(target, property, receiver);
      return (token: string, scope?: "account") => {
        const lookup = membership.getStore()?.lookup;
        if (
          lookup &&
          !lookup.used &&
          scope === undefined &&
          lookup.token === token
        ) {
          lookup.used = true;
          return lookup.result;
        }
        return scope === undefined
          ? target.session(token)
          : target.session(token, scope);
      };
    },
  });
}
