import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { administratorEntry } from "../../src/administrator-entry.ts";

it("ADMINLINK-03 ROLES-01/06 the roles lookup is one read-only query and skips malformed tokens", async () => {
  const query = vi.fn();
  const entry = administratorEntry({ query } as unknown as Pool);

  expect(await entry.accountRoles!("not-a-token")).toEqual([]);
  expect(query).not.toHaveBeenCalled();

  // An owner's identity rows list its stored roles; order is fixed.
  query.mockResolvedValueOnce({
    rowCount: 2,
    rows: [{ role: "admin" }, { role: "coach" }],
  });
  expect(await entry.accountRoles!("a".repeat(64))).toEqual([
    "student",
    "coach",
    "admin",
  ]);
  // A member without a role row, or without a verified email, is a student.
  query.mockResolvedValueOnce({ rowCount: 1, rows: [{ role: null }] });
  expect(await entry.accountRoles!("a".repeat(64))).toEqual(["student"]);
  // No current member: no roles at all.
  query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
  expect(await entry.accountRoles!("a".repeat(64))).toEqual([]);
  expect(query).toHaveBeenCalledTimes(3);
  const sql = String(query.mock.calls[0]![0]);
  expect(sql).toMatch(/^\s*SELECT/);
  expect(sql).toContain("account_roles");
  expect(sql).not.toMatch(/FOR (UPDATE|SHARE)|INSERT|UPDATE |DELETE/);

  query.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(entry.accountRoles!("a".repeat(64))).rejects.toThrow();
});
