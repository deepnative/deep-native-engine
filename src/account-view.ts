import { AsyncLocalStorage } from "node:async_hooks";

/** #673 Every account is a student; coach and admin come from stored roles. */
export const ACCOUNT_ROLES = ["student", "coach", "admin"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];
/** Remembers the chosen view. It only changes what is shown, never authority. */
export const VIEW_COOKIE = "dne_view";
const LANDING: Record<AccountRole, string> = {
  student: "/learn",
  coach: "/coach",
  admin: "/admin",
};

export function accountRole(value: unknown): value is AccountRole {
  return ACCOUNT_ROLES.includes(value as AccountRole);
}
/** The saved view when the account holds it, otherwise its highest role. */
export function chooseView(
  roles: readonly AccountRole[],
  saved: unknown,
): AccountRole {
  if (accountRole(saved) && roles.includes(saved)) return saved;
  return (
    [...ACCOUNT_ROLES].reverse().find((r) => roles.includes(r)) ?? "student"
  );
}
export function landingPath(view: AccountRole): string {
  return LANDING[view];
}

type AccountView = { roles: AccountRole[]; view: AccountRole; csrf: string };
const state = new AsyncLocalStorage<AccountView>();
export function withAccountView<T>(value: AccountView, render: () => T): T {
  return state.run(value, render);
}
/** Undefined outside a signed-in request whose roles were read. */
export function accountView(): AccountView | undefined {
  return state.getStore();
}
/** One button per other view the account holds; nothing for a student only. */
export function viewSwitch(): string {
  const current = accountView();
  if (!current) return "";
  const others = current.roles.filter((r) => r !== current.view);
  if (!others.length) return "";
  return `<form class="view-switch" method="post" action="/account/view"><input type="hidden" name="csrf" value="${current.csrf}">${others
    .map(
      (r) =>
        `<button type="submit" name="view" value="${r}">Switch to ${r} view</button>`,
    )
    .join("")}</form>`;
}
