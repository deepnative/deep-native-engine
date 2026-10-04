import { afterEach, expect, it, vi } from "vitest";
import { reviewerWorklistCursor } from "../../src/reviewer-worklist-cursor.ts";
const secret = Buffer.alloc(32, 7);
const token = "a".repeat(64);
const key = {
  at: "2026-10-04T12:00:00.123456Z",
  id: "11111111-1111-4111-8111-111111111111",
};
afterEach(() => vi.useRealTimers());
it("preserves microsecond order keys for the current session and view", () => {
  const cursor = reviewerWorklistCursor(secret);
  const encoded = cursor.encode(token, "active", key);
  expect(cursor.decode(token, "active", encoded)).toMatchObject(key);
  expect(cursor.decode(token, "active", undefined)).toBeNull();
  expect(cursor.decode(token, "completed", encoded)).toBe("invalid");
  expect(cursor.decode("b".repeat(64), "active", encoded)).toBe("invalid");
  expect(
    cursor.decode(
      token,
      "active",
      encoded.slice(0, -1) + (encoded.endsWith("A") ? "B" : "A"),
    ),
  ).toBe("invalid");
});
it("does not extend the original continuation lifetime", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
  const cursor = reviewerWorklistCursor(secret);
  const first = cursor.encode(token, "completed", key);
  const decoded = cursor.decode(token, "completed", first);
  if (!decoded || decoded === "invalid") throw Error("Expected cursor");
  vi.advanceTimersByTime(600000);
  const second = cursor.encode(token, "completed", key, decoded.expires);
  vi.advanceTimersByTime(300000);
  expect(cursor.decode(token, "completed", first)).toBe("invalid");
  expect(cursor.decode(token, "completed", second)).toBe("invalid");
});
it.each(["", "x".repeat(1025), "a.b", "@@.abc", "a".repeat(50)])(
  "rejects malformed cursor %s",
  (value) => {
    expect(reviewerWorklistCursor(secret).decode(token, "active", value)).toBe(
      "invalid",
    );
  },
);
it("rejects correctly signed payloads that are not valid ordering keys", async () => {
  const { createHmac } = await import("node:crypto");
  const { hash } = await import("../../src/store.ts");
  const sign = (raw: string) => {
    const body = Buffer.from(raw).toString("base64url");
    return (
      body +
      "." +
      createHmac("sha256", secret)
        .update(hash(token))
        .update("\0reviewer-worklist\0active\0")
        .update(body)
        .digest("base64url")
    );
  };
  const future = Date.now() + 900000;
  const payloads = [
    "{",
    JSON.stringify({}),
    JSON.stringify([]),
    JSON.stringify([1, key.id, future]),
    JSON.stringify(["bad", key.id, future]),
    JSON.stringify(["2026-99-01T12:00:00.000000Z", key.id, future]),
    JSON.stringify(["2026-02-30T12:00:00.000000Z", key.id, future]),
    JSON.stringify([key.at, 1, future]),
    JSON.stringify([key.at, "wrong", future]),
    JSON.stringify([key.at, key.id, 1.5]),
    JSON.stringify([key.at, key.id, Date.now() - 1]),
  ];
  for (const payload of payloads)
    expect(
      reviewerWorklistCursor(secret).decode(token, "active", sign(payload)),
    ).toBe("invalid");
});
