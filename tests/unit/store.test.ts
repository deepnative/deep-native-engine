import { it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { store, hash, migrate } from "../../src/store.ts";
function pool() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return { query, value: { query } as unknown as Pool };
}
it("binds the hash rather than raw bearer tokens and distinguishes new, expired and active sessions", async () => {
  const p = pool(),
    db = store(p.value);
  expect(await db.session("private-token")).toEqual({ kind: "new" });
  expect(p.query.mock.calls[0]![1]).toEqual([hash("private-token")]);
  p.query.mockResolvedValueOnce({
    rows: [{ id: "a", background: "explorer", goal: "work", active: false }],
  });
  expect(await db.session("private-token")).toEqual({ kind: "expired" });
  p.query.mockResolvedValueOnce({
    rows: [{ id: "a", background: "explorer", goal: "work", active: true }],
  });
  expect(await db.session("private-token")).toEqual({
    kind: "active",
    learner: { id: "a", background: "explorer", goal: "work" },
  });
  p.query.mockResolvedValueOnce({
    rows: [
      {
        id: "b",
        background: "technical",
        goal: "build",
        backgroundTags: ["professional"],
        domainTags: ["education"],
        itRoles: ["security"],
        experience: null,
        exploratory: false,
        timezone: "America/Toronto",
        weeklyMinutes: 30,
        active: true,
      },
    ],
  });
  expect(await db.session("private-token")).toMatchObject({
    kind: "active",
    learner: {
      backgroundTags: ["professional"],
      domainTags: ["education"],
      itRoles: ["security"],
      experience: null,
      exploratory: false,
      timezone: "America/Toronto",
      weeklyMinutes: 30,
    },
  });
});
it("passes untrusted answers as bound parameters and scopes versioned reads and deletes by learner", async () => {
  const p = pool(),
    db = store(p.value);
  await db.create("private-token", { background: "technical", goal: "build" });
  expect(p.query.mock.calls[0]![1]).toEqual([
    expect.any(String),
    hash("private-token"),
    "technical",
    "build",
    [],
    [],
    [],
    null,
    false,
    null,
    null,
  ]);
  expect(await db.progress("owned")).toBeUndefined();
  const answer = "'; DROP TABLE learners;--";
  await db.save("owned", {
    instruction: answer,
    verification: "check",
    complete: true,
  });
  expect(p.query.mock.calls[2]![1]).toEqual([
    "owned",
    "clear-instructions",
    1,
    answer,
    "check",
    true,
  ]);
  expect(p.query.mock.calls[2]![0]).not.toContain(answer);
  await db.remove("owned");
  expect(p.query.mock.calls[3]![1]).toEqual(["owned"]);
});
it("saves profile changes by the session-derived learner and preserves the practice goal", async () => {
  const p = pool(),
    db = store(p.value);
  await db.create("private-token", {
    background: "professional",
    goal: "work",
    backgroundTags: ["technical"],
    domainTags: ["education"],
    itRoles: ["analysis"],
    experience: "some",
    exploratory: true,
    timezone: "UTC",
    weeklyMinutes: 60,
  });
  expect(p.query.mock.calls[0]![1]).toEqual([
    expect.any(String),
    hash("private-token"),
    "professional",
    "work",
    ["technical"],
    ["education"],
    ["analysis"],
    "some",
    true,
    "UTC",
    60,
  ]);
  await db.updateProfile("owned", {
    background: "professional",
    goal: "work",
    backgroundTags: ["technical"],
    domainTags: ["education"],
    itRoles: ["analysis"],
    experience: "some",
    exploratory: true,
    timezone: "UTC",
    weeklyMinutes: 60,
  });
  expect(p.query.mock.calls[1]![1]).toEqual([
    "owned",
    "professional",
    "work",
    ["technical"],
    ["education"],
    ["analysis"],
    "some",
    true,
    "UTC",
    60,
  ]);
  await db.updateProfile("owned", {
    background: "explorer",
    goal: "everyday",
    backgroundTags: [],
    domainTags: [],
    itRoles: [],
    experience: null,
    exploratory: false,
  });
  expect(p.query.mock.calls[2]![1]).toEqual([
    "owned",
    "explorer",
    "everyday",
    [],
    [],
    [],
    null,
    false,
    null,
    null,
  ]);
  await db.save("owned", {
    instruction: "sample",
    verification: "check",
    complete: false,
  });
  expect(p.query.mock.calls[3]![0]).toContain(
    "goal_at_start=COALESCE(exercises.goal_at_start",
  );
});
it("applies the transactional migration and surfaces database failures to the caller", async () => {
  const p = pool();
  await migrate(p.value);
  expect(p.query.mock.calls[0]![0]).toContain("BEGIN;");
  expect(p.query.mock.calls[0]![0]).toContain("ON DELETE CASCADE");
  expect(p.query.mock.calls[0]![0]).toContain("adapter_jobs");
  p.query.mockRejectedValueOnce(new Error("offline"));
  await expect(
    store(p.value).save("a", {
      instruction: "",
      verification: "",
      complete: false,
    }),
  ).rejects.toThrow("offline");
});
it("pins only a currently published assignment version to a session-owned learner", async () => {
  const p = pool(),
    db = store(p.value);
  expect(await db.assignmentChoice("member-1")).toBeNull();
  p.query.mockResolvedValueOnce({
    rows: [{ contentId: "SYN-920", contentVersion: 1 }],
  });
  expect(await db.assignmentChoice("member-1")).toEqual({
    contentId: "SYN-920",
    contentVersion: 1,
  });
  p.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
  expect(await db.chooseAssignment("member-1", "SYN-920", 1)).toBe(true);
  expect(p.query.mock.calls[2]![0]).toContain("state='published'");
  expect(p.query.mock.calls[2]![1]).toEqual(["member-1", "SYN-920", 1]);
  p.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
  expect(await db.chooseAssignment("member-1", "SYN-920", 2)).toBe(false);
});
