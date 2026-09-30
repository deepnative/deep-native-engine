import { it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { store, hash, migrate } from "../../src/store.ts";
import type { MilestoneInput } from "../../src/milestones.ts";
function pool() {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
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
  await db.remove("owned");
  expect(p.query.mock.calls[2]![1]).toEqual(["owned"]);
});
it("binds member and exact lesson version for observed reading and explicit state changes", async () => {
  const p = pool(),
    db = store(p.value);
  p.query.mockResolvedValueOnce({
    rows: [{ contentId: "SYN-100", contentVersion: 2, available: false }],
  });
  expect(await db.lessonActivities("member-a")).toMatchObject([
    { contentId: "SYN-100", available: false },
  ]);
  expect(p.query.mock.calls[0]![1]).toEqual(["member-a"]);
  p.query.mockResolvedValueOnce({ rowCount: 1 });
  expect(await db.openLesson("member-a", "SYN-100", 2)).toBe(true);
  expect(p.query.mock.calls[1]![1]).toEqual(["member-a", "SYN-100", 2]);
  p.query.mockResolvedValueOnce({ rowCount: 0 });
  expect(await db.openLesson("member-a", "SYN-100", 1)).toBe(false);
  p.query.mockResolvedValueOnce({ rowCount: 1 });
  expect(await db.advanceLesson("member-a", "SYN-100", 2, "start")).toBe(true);
  expect(p.query.mock.calls[3]![1]).toEqual([
    "member-a",
    "SYN-100",
    2,
    "start",
  ]);
  p.query.mockResolvedValueOnce({ rowCount: 0 });
  expect(await db.advanceLesson("member-b", "SYN-100", 2, "complete")).toBe(
    false,
  );
  expect(p.query.mock.calls[4]![1]).toEqual([
    "member-b",
    "SYN-100",
    2,
    "complete",
  ]);
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
});
it("applies the transactional migration and surfaces database failures to the caller", async () => {
  const p = pool();
  await migrate(p.value);
  expect(p.query.mock.calls[0]![0]).toContain("BEGIN;");
  expect(p.query.mock.calls[0]![0]).toContain("ON DELETE CASCADE");
  expect(p.query.mock.calls[0]![0]).toContain("adapter_jobs");
  p.query.mockRejectedValueOnce(new Error("offline"));
  await expect(store(p.value).remove("a")).rejects.toThrow("offline");
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
it("keeps milestone reads and optimistic edits scoped to the owning member", async () => {
  const p = pool(),
    db = store(p.value);
  const input: MilestoneInput = {
    goalTitle: "Plan a local project",
    milestoneTitle: "Draft the first example",
    evidenceNote: "I checked the invented brief and its constraints.",
    nextAction: "Compare two approaches",
    reminderDate: "2028-02-29",
    reminderTime: "14:30",
    reminderTimezone: "America/Toronto",
    selfReportedComplete: true,
  };
  expect(await db.milestones("member-a")).toEqual([]);
  expect(p.query.mock.calls[0]![1]).toEqual(["member-a"]);
  p.query.mockResolvedValueOnce({
    rows: [{ id: "milestone-a", ...input, version: 1 }],
  });
  expect(await db.milestones("member-a")).toMatchObject([
    { id: "milestone-a", version: 1 },
  ]);
  expect(await db.createMilestone("member-a", input)).toBeNull();
  expect(p.query.mock.calls[2]![1]).toEqual([
    "member-a",
    expect.any(String),
    input.goalTitle,
    input.milestoneTitle,
    input.evidenceNote,
    input.nextAction,
    input.reminderDate,
    input.reminderTime,
    input.reminderTimezone,
    true,
  ]);
  p.query.mockResolvedValueOnce({ rows: [{ id: "milestone-a" }] });
  expect(await db.createMilestone("member-a", input)).toBe("milestone-a");
  p.query.mockResolvedValueOnce({ rowCount: 1 });
  expect(await db.updateMilestone("member-a", "milestone-a", 1, input)).toBe(
    true,
  );
  expect(p.query.mock.calls[4]![0]).toContain(
    "WHERE member_id=$1 AND id=$2 AND version=$3",
  );
  expect(p.query.mock.calls[4]![1]).toEqual([
    "member-a",
    "milestone-a",
    1,
    input.goalTitle,
    input.milestoneTitle,
    input.evidenceNote,
    input.nextAction,
    input.reminderDate,
    input.reminderTime,
    input.reminderTimezone,
    true,
  ]);
  p.query.mockResolvedValueOnce({ rowCount: 0 });
  expect(await db.updateMilestone("member-b", "milestone-a", 1, input)).toBe(
    false,
  );
  p.query.mockResolvedValueOnce({ rowCount: 1 });
  expect(await db.deleteMilestone("member-a", "milestone-a", 2)).toBe(true);
  expect(p.query.mock.calls[6]![1]).toEqual(["member-a", "milestone-a", 2]);
  p.query.mockResolvedValueOnce({ rowCount: 0 });
  expect(await db.deleteMilestone("member-a", "milestone-a", 1)).toBe(false);
});

function exercisePool(
  options: {
    principal?: boolean;
    workspace?: boolean;
    completed?: boolean;
    existing?: boolean;
    withdrawn?: boolean;
    expired?: boolean;
    failAt?: string;
    rollbackFails?: boolean;
    saveCount?: number;
    goal?: string;
    missingLearner?: boolean;
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (sql === options.failAt || (sql === "ROLLBACK" && options.rollbackFails))
      throw new Error("synthetic failure");
    if (sql.startsWith("SELECT id,expires_at"))
      return {
        rows:
          options.principal === false
            ? []
            : [{ id: "owned", expires_at: new Date("2035-01-01") }],
      };
    if (sql.startsWith("SELECT id FROM workspaces"))
      return { rows: options.workspace === false ? [] : [{ id: "owned" }] };
    if (sql.startsWith("SELECT goal FROM learners"))
      return {
        rows: options.missingLearner
          ? []
          : [{ goal: options.goal ?? "everyday" }],
      };
    if (sql.startsWith("INSERT INTO exercises"))
      return { rows: [], rowCount: options.saveCount ?? 1 };
    if (sql.startsWith("SELECT withdrawn_at"))
      return {
        rows:
          options.existing === false
            ? []
            : [{ withdrawn_at: options.withdrawn ? new Date() : null }],
      };
    if (sql.startsWith("SELECT completed_at"))
      return {
        rows:
          options.existing === false
            ? []
            : [
                {
                  goal_slot: "everyday",
                  completed_at:
                    options.completed === false ? null : new Date("2026-01-01"),
                  withdrawn_at: options.withdrawn
                    ? new Date("2026-01-02")
                    : null,
                },
              ],
      };
    if (sql.startsWith("SELECT lesson_id"))
      return {
        rows: [
          {
            lessonId: "clear-instructions",
            version: 1,
            instruction: "Invented private text",
            verification: "Invented check",
            completedAt: new Date("2026-01-01"),
            withdrawnAt: null,
            goalAtStart: "everyday",
          },
        ],
      };
    if (sql.startsWith("SELECT clock_timestamp"))
      return { rows: [{ valid: !options.expired }] };
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  return {
    query,
    release,
    connect,
    value: { query, connect } as unknown as Pool,
  };
}

it.each([
  [{}, "withdrawn"],
  [{ withdrawn: true }, "already-withdrawn"],
  [{ existing: false }, "unavailable"],
  [{ completed: false }, "unavailable"],
  [{ principal: false }, "unavailable"],
  [{ workspace: false }, "unavailable"],
  [{ expired: true }, "unavailable"],
] as const)(
  "reports the truthful exercise withdrawal outcome for %j",
  async (options, outcome) => {
    const p = exercisePool(options);
    expect(
      await store(p.value).withdrawExercise(
        "private-owner-token",
        "clear-instructions",
        1,
      ),
    ).toBe(outcome);
    expect(p.release).toHaveBeenCalledExactlyOnceWith(undefined);
  },
);

it("renders exercise history under read locks, denies unavailable owners and binds historical versions", async () => {
  const p = exercisePool();
  const render = vi.fn((rows) => JSON.stringify(rows));
  expect(await store(p.value).withExerciseRead("owner", render)).toContain(
    "Invented private text",
  );
  expect(render).toHaveBeenCalledOnce();
  expect(
    p.query.mock.calls.find(([sql]) =>
      sql.startsWith("SELECT id FROM workspaces"),
    )![0],
  ).toContain("FOR SHARE");
  expect(
    await store(exercisePool({ principal: false }).value).withExerciseRead(
      "owner",
      render,
    ),
  ).toBeNull();
  const old = pool();
  await store(old.value).progress("owned", "older-lesson", 2);
  expect(old.query).toHaveBeenCalledWith(expect.any(String), [
    "owned",
    "older-lesson",
    2,
  ]);
});

it("rejects malformed exercise withdrawal identifiers and bearer tokens before connecting", async () => {
  const p = exercisePool(),
    db = store(p.value);
  for (const [id, version] of [
    [null, 1],
    ["../x", 1],
    ["clear-instructions", 0],
    ["clear-instructions", 1.1],
    ["clear-instructions", 2147483648],
  ] as const) {
    expect(await db.withdrawExercise("owner", id as string, version)).toBe(
      "unavailable",
    );
  }
  for (const token of ["", " ", null] as const) {
    expect(
      await db.withdrawExercise(token as string, "clear-instructions", 1),
    ).toBe("unavailable");
    expect(
      await db.withExerciseRead(token as string, () => "unexpected"),
    ).toBeNull();
  }
  expect(p.connect).not.toHaveBeenCalled();
});

it("rolls back exercise callback/query/commit failures and discards a failed rollback connection", async () => {
  for (const options of [
    { failAt: "COMMIT" },
    { failAt: "SET LOCAL lock_timeout='5s'", rollbackFails: true },
  ]) {
    const p = exercisePool(options);
    await expect(
      store(p.value).withdrawExercise("owner", "clear-instructions", 1),
    ).rejects.toThrow("synthetic failure");
    expect(p.query).toHaveBeenCalledWith("ROLLBACK");
    expect(p.release).toHaveBeenCalledWith(
      options.rollbackFails ? expect.any(Error) : undefined,
    );
  }
  const p = exercisePool();
  await expect(
    store(p.value).withExerciseRead("owner", () => {
      throw new Error("render unavailable");
    }),
  ).rejects.toThrow("render unavailable");
  expect(p.query).toHaveBeenCalledWith("ROLLBACK");
  p.connect.mockRejectedValueOnce(new Error("connection unavailable"));
  await expect(
    store(p.value).withdrawExercise("owner", "clear-instructions", 1),
  ).rejects.toThrow("connection unavailable");
});

it.each([
  [{}, "saved"],
  [{ saveCount: 0 }, "unchanged"],
  [{ saveCount: 0, existing: false }, "unchanged"],
  [{ saveCount: 0, withdrawn: true }, "withdrawn"],
  [{ principal: false }, "unavailable"],
  [{ workspace: false }, "unavailable"],
  [{ expired: true }, "unavailable"],
  [{ missingLearner: true }, "unavailable"],
  [{ goal: "work" }, "stale-goal"],
] as const)(
  "saves only the locked matching goal and reports %j",
  async (options, outcome) => {
    const p = exercisePool(options);
    const input = {
      instruction: "'; DROP TABLE learners;--",
      verification: "Invented check",
      complete: true,
      goal: "everyday" as const,
    };
    expect(await store(p.value).save("owned", input)).toBe(outcome);
    const insert = p.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO exercises"),
    );
    if (outcome !== "unavailable" && outcome !== "stale-goal") {
      expect(insert).toBeDefined();
      expect(insert![0]).not.toContain(input.instruction);
      expect(p.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO exercises"),
        [
          "owned",
          "clear-instructions",
          1,
          input.instruction,
          input.verification,
          true,
          "everyday",
        ],
      );
    }
  },
);
it("rejects a forged goal slot before opening a withdrawal transaction", async () => {
  const p = exercisePool();
  expect(
    await store(p.value).withdrawExercise(
      "owner",
      "clear-instructions",
      1,
      "other" as "work",
    ),
  ).toBe("unavailable");
  expect(p.connect).not.toHaveBeenCalled();
});
