import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { sampleAssignmentCursor } from "../../src/sample-assignment-cursor.ts";
import { hash } from "../../src/store.ts";
const secret = Buffer.alloc(32, 7),
  token = "a".repeat(64),
  source = {
    evidenceId: "a12f4499-6652-4a39-8d68-0e390a19beef",
    sourceRevision: 1,
  };
const key = {
    at: "2026-10-06T09:00:00.123456Z",
    id: "b12f4499-6652-4a39-8d68-0e390a19beef",
  },
  cursor = sampleAssignmentCursor(secret);
const sign = (raw: string) => {
  const body = Buffer.from(raw).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(hash(token)).update("\0sample-assignment-history\0").update(source.evidenceId).update("\0").update(String(source.sourceRevision)).update("\0").update(body).digest("base64url")}`;
};
afterEach(() => vi.useRealTimers());
it("REVADM-08 binds history navigation to administrator session and exact source while preserving microseconds and initial expiry", () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-06T09:01:00.000Z"));
  const encoded = cursor.encode(token, source, key),
    first = cursor.decode(token, source, encoded);
  expect(first).toEqual({ ...key, expires: Date.now() + 900000 });
  expect(cursor.decode(token, source, undefined)).toBeNull();
  expect(cursor.decode("b".repeat(64), source, encoded)).toBe("invalid");
  expect(cursor.decode(token, { ...source, sourceRevision: 2 }, encoded)).toBe(
    "invalid",
  );
  expect(cursor.decode(token, { ...source, evidenceId: key.id }, encoded)).toBe(
    "invalid",
  );
  vi.advanceTimersByTime(899000);
  if (!first || first === "invalid") throw Error("Expected bounded cursor");
  const next = cursor.encode(token, source, key, first.expires);
  expect(cursor.decode(token, source, next)).toEqual(first);
  vi.advanceTimersByTime(1000);
  expect(cursor.decode(token, source, next)).toBe("invalid");
});
it("REVADM-06/08 rejects malformed, oversized, forged and impossible history keys", () => {
  for (const bad of [
    "",
    "x".repeat(1025),
    "a.a",
    "a." + "a".repeat(43),
    sign("not json"),
  ])
    expect(cursor.decode(token, source, bad)).toBe("invalid");
  const valid = [key.at, key.id, Date.now() + 10000];
  for (const bad of [
    {},
    [],
    [1, key.id, valid[2]],
    ["bad", key.id, valid[2]],
    ["2026-99-06T09:00:00.123456Z", key.id, valid[2]],
    ["2026-02-29T09:00:00.123456Z", key.id, valid[2]],
    [key.at, 1, valid[2]],
    [key.at, "bad", valid[2]],
    [key.at, key.id, 1.5],
    [key.at, key.id, 0],
  ])
    expect(cursor.decode(token, source, sign(JSON.stringify(bad)))).toBe(
      "invalid",
    );
});
