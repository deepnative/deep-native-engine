import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  disabledWorkflowFeedbackStore,
  parseWorkflowFeedback,
  workflowFeedbackStore,
} from "../../src/workflow-feedback.ts";

it("accepts only bounded, nonempty invented feedback text", () => {
  expect(parseWorkflowFeedback("  A useful invented improvement.  ")).toBe(
    "A useful invented improvement.",
  );
  for (const value of ["", "  ", "x".repeat(1001), 1, null, []])
    expect(parseWorkflowFeedback(value)).toBeNull();
  expect(parseWorkflowFeedback("x".repeat(1000))).toHaveLength(1000);
});

it("rejects invalid, unknown and stale workflow versions without a database write", async () => {
  const query = vi.fn();
  const feedback = workflowFeedbackStore({ query } as unknown as Pool);
  for (const [id, version, revision] of [
    ["WF-999", 1, 0],
    ["WF-001", 0, 0],
    ["WF-001", 2, 0],
    ["WF-001", 1.5, 0],
    ["WF-001", 1, -1],
    ["WF-001", 1, 1.5],
  ] as const)
    expect(
      await feedback.save("owner", id, version, "Invented note", revision),
    ).toBe(false);
  expect(await feedback.save("owner", "WF-001", 1, " ", 0)).toBe(false);
  expect(query).not.toHaveBeenCalled();
});

it("keeps disabled feedback unavailable without implying persistence", async () => {
  const feedback = disabledWorkflowFeedbackStore();
  expect(await feedback.list("owner")).toEqual([]);
  expect(await feedback.save("owner", "WF-001", 1, "Invented note", 0)).toBe(
    false,
  );
  expect(await feedback.withdraw("owner", "WF-001", 1, 1)).toBe(false);
});

it("uses optimistic create, correction and withdrawal results without inventing a save", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rowCount: 1 })
    .mockResolvedValueOnce({ rowCount: 0 })
    .mockResolvedValueOnce({ rowCount: 1 })
    .mockResolvedValueOnce({ rowCount: 0 })
    .mockResolvedValueOnce({ rowCount: 1 })
    .mockResolvedValueOnce({ rowCount: 0 });
  const feedback = workflowFeedbackStore({ query } as unknown as Pool);
  expect(await feedback.list("owner")).toEqual([]);
  expect(await feedback.save("owner", "WF-001", 1, " First ", 0)).toBe(true);
  expect(await feedback.save("owner", "WF-001", 1, "Replay", 0)).toBe(false);
  expect(await feedback.save("owner", "WF-001", 1, "Correction", 1)).toBe(true);
  expect(await feedback.save("owner", "WF-001", 1, "Stale", 1)).toBe(false);
  expect(await feedback.withdraw("owner", "WF-001", 1, 2)).toBe(true);
  expect(await feedback.withdraw("owner", "WF-001", 1, 2)).toBe(false);
  expect(query).toHaveBeenCalledTimes(7);
  expect(query.mock.calls[1]![1]).toContain("First");
  for (const [id, version, revision] of [
    ["invalid", 1, 1],
    ["WF-001", 0, 1],
    ["WF-001", 1.5, 1],
    ["WF-001", 1, 0],
    ["WF-001", 1, 1.5],
  ] as const)
    expect(await feedback.withdraw("owner", id, version, revision)).toBe(false);
  expect(query).toHaveBeenCalledTimes(7);
});
