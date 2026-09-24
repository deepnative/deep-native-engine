import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { attemptStore, disabledAttemptStore } from "../../src/attempts.ts";
import { hash } from "../../src/store.ts";

it("keeps attempts disabled unless a real store is wired", async () => {
  const disabled = disabledAttemptStore();
  expect(await disabled.list("token")).toEqual([]);
  expect(await disabled.detail("token", "id")).toBeNull();
  expect(await disabled.start("token")).toBeNull();
  expect(await disabled.save("token", "id", 1, "draft")).toBe(false);
  expect(await disabled.submit("token", "id", 1)).toBe(false);
  expect(await disabled.remove("token", "id")).toBe(false);
});

it("scopes every operation to a hashed session, member and pinned content", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const attempts = attemptStore({ query } as unknown as Pool);
  const credential = "a".repeat(64);
  expect(await attempts.list(credential)).toEqual([]);
  expect(await attempts.detail(credential, "attempt-id")).toBeNull();
  expect(await attempts.start(credential)).toBeNull();
  expect(await attempts.save(credential, "attempt-id", 1, "draft")).toBe(false);
  expect(await attempts.submit(credential, "attempt-id", 1)).toBe(false);
  expect(await attempts.remove(credential, "attempt-id")).toBe(false);
  expect(query.mock.calls.map((call) => call[1][0])).toEqual(
    Array.from({ length: 6 }, () => hash(credential)),
  );
  expect(query.mock.calls[2]![0]).toContain(
    "ON CONFLICT(member_id,content_id,content_version)",
  );
  expect(query.mock.calls[3]![0]).toContain("a.revision=$3");
  expect(query.mock.calls[4]![0]).toContain("a.saved_at IS NOT NULL");
  expect(query.mock.calls[5]![0]).toContain("a.id=$2");
  query.mockResolvedValueOnce({ rows: [{ id: "owned" }] });
  expect(await attempts.start(credential)).toBe("owned");
  query.mockResolvedValueOnce({ rows: [{ id: "owned", revision: 2 }] });
  expect(await attempts.detail(credential, "owned")).toMatchObject({
    id: "owned",
    revision: 2,
  });
  query.mockResolvedValueOnce({ rows: [{ id: "owned" }] });
  expect(await attempts.list(credential)).toEqual([{ id: "owned" }]);
  query.mockResolvedValue({ rowCount: 1 });
  expect(await attempts.save(credential, "owned", 2, "draft")).toBe(true);
  expect(await attempts.submit(credential, "owned", 2)).toBe(true);
  expect(await attempts.remove(credential, "owned")).toBe(true);
});
