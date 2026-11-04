import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { administratorEntry } from "../../src/administrator-entry.ts";

it("ADMINLINK-03 the owner check is one read-only query and skips malformed tokens", async () => {
  const query = vi.fn();
  const entry = administratorEntry({ query } as unknown as Pool);

  expect(await entry.verifiedOwner!("not-a-token")).toBe(false);
  expect(query).not.toHaveBeenCalled();

  query.mockResolvedValueOnce({ rowCount: 1 });
  expect(await entry.verifiedOwner!("a".repeat(64))).toBe(true);
  query.mockResolvedValueOnce({ rowCount: 0 });
  expect(await entry.verifiedOwner!("a".repeat(64))).toBe(false);
  expect(query).toHaveBeenCalledTimes(2);
  const sql = String(query.mock.calls[0]![0]);
  expect(sql).toMatch(/^\s*SELECT/);
  expect(sql).not.toMatch(/FOR (UPDATE|SHARE)|INSERT|UPDATE |DELETE/);

  query.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(entry.verifiedOwner!("a".repeat(64))).rejects.toThrow();
});
