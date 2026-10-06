import { afterEach, expect, it, vi } from "vitest";
import { csrf } from "../../src/session.ts";
import {
  entryNonce,
  entryCsrf,
  validEntry,
  ENTRY_LIFETIME,
} from "../../src/staff-entry-integrity.ts";
afterEach(() => vi.useRealTimers());
it("STAFF-05-INTEGRITY binds separate signed nonces and CSRF to finite server expiry and secret", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  const first = entryNonce("secret"),
    second = entryNonce("secret"),
    form = entryCsrf(first, "secret");
  expect(first).not.toBe(second);
  expect(validEntry(first, form, "secret")).toBe(true);
  for (const [nonce, value, key] of [
    ["malformed", form, "secret"],
    [second, form, "secret"],
    [first, "bad", "secret"],
    [first, form, "changed"],
    [first, undefined, "secret"],
  ])
    expect(validEntry(nonce!, value, key!)).toBe(false);
  const altered = first.slice(0, -1) + (first.endsWith("a") ? "b" : "a");
  expect(validEntry(altered, entryCsrf(altered, "secret"), "secret")).toBe(
    false,
  );
  const future = `${Date.now() + ENTRY_LIFETIME + 1}.${"a".repeat(64)}`;
  const signed = future + "." + csrf("staff-entry-nonce:" + future, "secret");
  expect(validEntry(signed, entryCsrf(signed, "secret"), "secret")).toBe(false);
  vi.advanceTimersByTime(ENTRY_LIFETIME);
  expect(validEntry(first, form, "secret")).toBe(false);
});
