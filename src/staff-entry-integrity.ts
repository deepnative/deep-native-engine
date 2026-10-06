import { randomBytes } from "node:crypto";
import { csrf, validCsrf } from "./session.ts";
const lifetime = 5 * 60 * 1000;
export function entryNonce(secret: string) {
  const payload = `${Date.now() + lifetime}.${randomBytes(32).toString("hex")}`;
  return `${payload}.${csrf("staff-entry-nonce:" + payload, secret)}`;
}
export function entryCsrf(nonce: string, secret: string) {
  return csrf("staff-entry-form:" + nonce, secret);
}
export function validEntry(nonce: string, provided: unknown, secret: string) {
  const parts = /^(\d{13})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(nonce);
  if (!parts) return false;
  const expiry = Number(parts[1]),
    now = Date.now();
  return (
    expiry > now &&
    expiry <= now + lifetime &&
    validCsrf(
      parts[3],
      "staff-entry-nonce:" + parts[1] + "." + parts[2],
      secret,
    ) &&
    validCsrf(provided, "staff-entry-form:" + nonce, secret)
  );
}
export const ENTRY_LIFETIME = lifetime;
