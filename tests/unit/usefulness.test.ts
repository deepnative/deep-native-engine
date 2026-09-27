import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  disabledUsefulnessStore,
  usefulnessStore,
} from "../../src/usefulness.ts";

it("rejects invalid choices and revision tokens before any write", async () => {
  const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
  const reports = usefulnessStore({ query } as unknown as Pool);
  for (const [version, revision, choice] of [
    [0, 0, "helpful"],
    [1.5, 0, "helpful"],
    [1, -1, "helpful"],
    [1, 1.5, "helpful"],
    [1, 0, "unsure"],
  ] as const) {
    expect(
      await reports.save(
        "owner",
        "SYN-971",
        version,
        choice as never,
        revision,
      ),
    ).toBe(false);
  }
  expect(await reports.withdraw("owner", "SYN-971", 0, 1)).toBe(false);
  expect(await reports.withdraw("owner", "SYN-971", 1, 0)).toBe(false);
  expect(await reports.withdraw("owner", "SYN-971", 1.5, 1)).toBe(false);
  expect(query).not.toHaveBeenCalled();
});

it("returns accepted, stale and empty outcomes without implying a save", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rowCount: 1 })
    .mockResolvedValueOnce({ rowCount: 0 })
    .mockResolvedValueOnce({ rowCount: 1 })
    .mockResolvedValueOnce({ rowCount: 0 })
    .mockResolvedValueOnce({ rowCount: 1 });
  const reports = usefulnessStore({ query } as unknown as Pool);
  expect(await reports.list("unknown")).toEqual([]);
  expect(await reports.save("owner", "SYN-971", 1, "helpful", 0)).toBe(true);
  expect(await reports.save("owner", "SYN-971", 1, "helpful", 0)).toBe(false);
  expect(await reports.save("owner", "SYN-971", 1, "not_yet", 1)).toBe(true);
  expect(await reports.save("owner", "SYN-971", 1, "not_yet", 1)).toBe(false);
  expect(await reports.withdraw("owner", "SYN-971", 1, 2)).toBe(true);
  expect(query).toHaveBeenCalledTimes(6);
  const disabled = disabledUsefulnessStore();
  expect(await disabled.list("owner")).toEqual([]);
  expect(await disabled.save("owner", "SYN-971", 1, "helpful", 0)).toBe(false);
  expect(await disabled.withdraw("owner", "SYN-971", 1, 1)).toBe(false);
});
