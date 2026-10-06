export const STAFF_COOKIE = "dne_staff";
export const ENTRY_COOKIE = "dne_staff_entry";
export const SIGNED_OUT = "signed-out";
export const staffCredential = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export type CookieValue =
  { kind: "absent" | "invalid" } | { kind: "value"; value: string };
/** Read relevant raw cookies before cookie-parser can discard duplicate names. */
export function uniqueCookie(
  raw: string | undefined,
  name: string,
): CookieValue {
  const matches = (raw ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.split("=", 1)[0]!.trim() === name);
  if (!matches.length) return { kind: "absent" };
  const item = matches[0]!;
  if (matches.length !== 1 || !item.startsWith(name + "="))
    return { kind: "invalid" };
  try {
    const value = decodeURIComponent(item.slice(name.length + 1));
    return value ? { kind: "value", value } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}
export function staffCookie(raw: string | undefined): CookieValue {
  const selected = uniqueCookie(raw, STAFF_COOKIE);
  return selected.kind === "value" &&
    !staffCredential(selected.value) &&
    selected.value !== SIGNED_OUT
    ? { kind: "invalid" }
    : selected;
}
/** Match Express's default case-insensitive, non-strict route families exactly. */
export function staffFamily(path: string) {
  return /^\/(?:editor|review|operator|moderate)(?:\/|$)/i.test(path);
}
export function selectedStaffToken(
  path: string,
  raw: string | undefined,
  legacy: string,
  enabled: boolean,
): string | null {
  if (!enabled || !staffFamily(path)) return legacy;
  const selected = staffCookie(raw);
  if (selected.kind === "absent") return legacy;
  return selected.kind === "value" && staffCredential(selected.value)
    ? selected.value
    : null;
}
