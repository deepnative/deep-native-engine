import { AsyncLocalStorage } from "node:async_hooks";

// The request path, so shared headers can mark where the member is.
const currentPath = new AsyncLocalStorage<string>();
export function withCurrentPath<T>(path: string, render: () => T): T {
  return currentPath.run(path, render);
}
const owns: Record<string, (path: string) => boolean> = {
  "/learn": (p) => p === "/learn" || p.startsWith("/learn/"),
  "/account/coaching": (p) =>
    p === "/account/coaching" || p.startsWith("/account/coaching/"),
  "/account/sign-out": (p) => p === "/account/sign-out",
  "/email/sign-in": (p) => p === "/email/sign-in",
  // SEAM-01 (#850): a coach's page, and the tools under the admin menu's More.
  "/coach": (p) => p === "/coach",
  "/admin": (p) =>
    p === "/admin" ||
    p.startsWith("/admin/") ||
    p.startsWith("/operator") ||
    p === "/staff" ||
    p.startsWith("/moderate/"),
  "/account": (p) =>
    (p === "/account" || p.startsWith("/account/")) &&
    !owns["/account/coaching"]!(p) &&
    !owns["/account/sign-out"]!(p),
};
/** A header link, marked as the current page when this request is inside it. */
export function navigationLink(href: string, label: string): string {
  const path = currentPath.getStore();
  const current = path !== undefined && owns[href]?.(path) === true;
  return `<a href="${href}"${current ? ' aria-current="page"' : ""}>${label}</a>`;
}
