import { expect, it } from "vitest";
import type { Pool } from "pg";
import {
  assignmentReadinessStore,
  disabledAssignmentReadinessStore,
} from "../../src/assignment-readiness.ts";

const assignment = {
  id: "SYN-891",
  version: 1,
  kind: "assignment",
  title: "Synthetic assignment",
  prerequisites: "",
  structuredPrerequisites: {
    schemaVersion: 1,
    all: [{ kind: "lesson", id: "SYN-890", version: 1, activity: "started" }],
  },
  matchesAudience: true,
  eligible: false,
};
const lesson = {
  id: "SYN-890",
  version: 1,
  kind: "lesson",
  title: "Synthetic source",
  prerequisites: "None",
  structuredPrerequisites: null,
  matchesAudience: true,
  eligible: true,
  prerequisitesSatisfied: true,
};
function fake(
  items: unknown[] = [assignment, lesson],
  activity: unknown[] = [],
  complete = false,
  owner = true,
  failAt = "",
  expires = false,
) {
  const statements: string[] = [];
  let released: Error | boolean = false;
  const pool = {
    connect: async () => {
      if (failAt === "connect") throw new Error("private db details");
      return {
        query: async (sql: string) => {
          statements.push(sql);
          if (failAt && sql.includes(failAt))
            throw new Error("private db details");
          if (sql.includes("FROM principals p JOIN learners l"))
            return { rows: owner ? [{ id: "member-1" }] : [] };
          if (sql.includes("FROM content_versions cv")) return { rows: items };
          if (sql.includes("FROM exercises"))
            return { rows: complete ? [{ completed_at: new Date() }] : [] };
          if (sql.includes("FROM lesson_activity")) return { rows: activity };
          if (sql.startsWith("SELECT id FROM principals"))
            return { rows: expires ? [] : [{ id: "member-1" }] };
          return { rows: [] };
        },
        release: (error?: Error) => {
          released = error ?? true;
        },
      };
    },
  } as unknown as Pool;
  return { pool, statements, released: () => released };
}

it("explains a blocked assignment without recording activity and offers its exact eligible lesson", async () => {
  const f = fake();
  expect(
    await assignmentReadinessStore(f.pool).get("token", "SYN-891", 1),
  ).toEqual({
    contentId: "SYN-891",
    contentVersion: 1,
    title: "Synthetic assignment",
    eligible: false,
    requirements: [
      {
        kind: "lesson",
        contentId: "SYN-890",
        contentVersion: 1,
        title: "Synthetic source",
        required: "started",
        observed: "not-started",
        satisfied: false,
        action: { kind: "lesson", contentId: "SYN-890", contentVersion: 1 },
        requirements: [],
      },
    ],
  });
  expect(f.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
  expect(f.statements.join("\n")).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  expect(f.statements).toContain("COMMIT");
  expect(f.released()).toBe(true);
});

const started = {
  contentId: "SYN-890",
  contentVersion: 1,
  startedAt: new Date(),
  selfAssessedAt: null,
};
const assessed = { ...started, selfAssessedAt: new Date() };
const leaf = {
  kind: "lesson",
  id: "SYN-890",
  version: 1,
  activity: "self-assessed",
};
const exercise = {
  kind: "exercise",
  id: "clear-instructions",
  version: 1,
  activity: "completed",
};
it("distinguishes opened, wrong-version, started and self-assessed states and trusts SQL eligibility", async () => {
  for (const [activity, observed] of [
    [[{ ...started, startedAt: null }], "not-started"],
    [[{ ...started, contentVersion: 2 }], "not-started"],
    [[{ ...started, contentId: "SYN-899" }], "not-started"],
    [[started], "started"],
    [[assessed], "self-assessed"],
  ] as const) {
    const f = fake([assignment, lesson], [...activity]);
    const result = await assignmentReadinessStore(f.pool).get(
      "token",
      assignment.id,
      1,
    );
    expect(result?.requirements[0]?.observed).toBe(observed);
    expect(result?.requirements[0]?.satisfied).toBe(observed !== "not-started");
    expect(result?.eligible).toBe(false);
  }
  const f = fake(
    [
      {
        ...assignment,
        eligible: true,
        structuredPrerequisites: { schemaVersion: 1, all: [leaf] },
      },
      lesson,
    ],
    [assessed],
  );
  expect(
    (await assignmentReadinessStore(f.pool).list("token"))?.[0],
  ).toMatchObject({
    eligible: true,
    requirements: [{ observed: "self-assessed", satisfied: true }],
  });
});

it("finds a nested actionable leaf while preserving the outer unmet requirement", async () => {
  const inner = { ...lesson, id: "SYN-889" };
  const outer = {
    ...lesson,
    eligible: false,
    structuredPrerequisites: {
      schemaVersion: 1,
      all: [{ ...leaf, id: inner.id }],
    },
  };
  const f = fake([assignment, outer, inner]);
  const req = (await assignmentReadinessStore(f.pool).get(
    "token",
    assignment.id,
    1,
  ))!.requirements[0]!;
  expect(req.action).toBeUndefined();
  expect(req.requirements[0]).toMatchObject({
    contentId: inner.id,
    required: "self-assessed",
    satisfied: false,
    action: { kind: "lesson", contentId: inner.id, contentVersion: 1 },
  });
  expect(
    (
      await assignmentReadinessStore(
        fake([assignment, { ...lesson, eligible: false }]).pool,
      ).list("token")
    )?.[0]?.requirements[0]?.action,
  ).toBeUndefined();
});

it("offers the existing exercise only until completion and hides mismatched assignments", async () => {
  const local = {
    ...assignment,
    structuredPrerequisites: { schemaVersion: 1, all: [exercise] },
  };
  for (const completed of [false, true]) {
    const f = fake(
      [local, { ...assignment, id: "SYN-892", matchesAudience: false }, lesson],
      [],
      completed,
    );
    const result = await assignmentReadinessStore(f.pool).list("token");
    expect(result).toHaveLength(1);
    expect(result![0]!.requirements[0]).toMatchObject({
      kind: "exercise",
      observed: completed ? "completed" : "not-started",
      satisfied: completed,
    });
    expect(Boolean(result![0]!.requirements[0]!.action)).toBe(!completed);
  }
});

it("uses generic unavailable nodes for missing, malformed and cyclic exact sources without substituting a version", async () => {
  const unavailable = {
    kind: "unavailable",
    observed: "unavailable",
    satisfied: false,
    requirements: [],
  };
  for (const items of [
    [assignment],
    [assignment, { ...lesson, version: 2 }],
    [assignment, { ...lesson, kind: "assignment" }],
    [{ ...assignment, structuredPrerequisites: { schemaVersion: 2, all: [] } }],
    [
      {
        ...assignment,
        structuredPrerequisites: null,
        prerequisites: "Human approval",
      },
    ],
    [
      assignment,
      {
        ...lesson,
        structuredPrerequisites: {
          schemaVersion: 1,
          all: [{ ...leaf, id: lesson.id }],
        },
      },
    ],
  ]) {
    const result = (await assignmentReadinessStore(fake(items).pool).get(
      "token",
      assignment.id,
      1,
    ))!;
    expect(JSON.stringify(result.requirements)).toContain(
      '"observed":"unavailable"',
    );
    if (
      items.length === 1 ||
      items[1]?.version === 2 ||
      items[1]?.kind === "assignment"
    )
      expect(result.requirements).toEqual([unavailable]);
  }
});

it("bounds deep and wide graphs without recursion exhaustion", async () => {
  const nodes = Array.from({ length: 35 }, (_, index) => ({
    ...lesson,
    id: `SYN-${100 + index}`,
    eligible: false,
    structuredPrerequisites: {
      schemaVersion: 1,
      all: [{ ...leaf, id: `SYN-${101 + index}` }],
    },
  }));
  const deep = {
    ...assignment,
    structuredPrerequisites: {
      schemaVersion: 1,
      all: [{ ...leaf, id: "SYN-100" }],
    },
  };
  expect(
    JSON.stringify(
      await assignmentReadinessStore(fake([deep, ...nodes]).pool).list("token"),
    ),
  ).toContain('"observed":"unavailable"');
  const wide = Array.from({ length: 8 }, (_, index) => ({
    ...lesson,
    id: `SYN-${200 + index}`,
    eligible: false,
    structuredPrerequisites: {
      schemaVersion: 1,
      all: Array.from({ length: 8 }, (_, child) => ({
        ...leaf,
        id: `SYN-${200 + child}`,
      })),
    },
  }));
  // The shared layered DAG expands without a cycle; the total budget caps it.
  const layers = Array.from({ length: 4 }, (_, layer) =>
    wide.map((node, index) => ({
      ...node,
      id: `SYN-${200 + layer * 10 + index}`,
      structuredPrerequisites: {
        schemaVersion: 1,
        all:
          layer === 3
            ? []
            : Array.from({ length: 8 }, (_, child) => ({
                ...leaf,
                id: `SYN-${210 + layer * 10 + child}`,
              })),
      },
    })),
  ).flat();
  const broad = {
    ...assignment,
    structuredPrerequisites: {
      schemaVersion: 1,
      all: [{ ...leaf, id: "SYN-200" }],
    },
  };
  expect(
    JSON.stringify(
      await assignmentReadinessStore(fake([broad, ...layers]).pool).list(
        "token",
      ),
    ),
  ).toContain('"detailsLimited":true');
});

it("denies missing configuration, inactive/expired ownership and invalid or stale identities", async () => {
  expect(await disabledAssignmentReadinessStore().list("token")).toEqual([]);
  expect(
    await disabledAssignmentReadinessStore().get("token", assignment.id, 1),
  ).toBeNull();
  for (const f of [
    fake([], [], false, false),
    fake([], [], false, true, "", true),
  ]) {
    expect(await assignmentReadinessStore(f.pool).list("token")).toBeNull();
    expect(f.statements).not.toContain("COMMIT");
    expect(f.released()).toBe(true);
  }
  for (const [id, version] of [
    ["bad", 1],
    [assignment.id, 0],
    [assignment.id, 1.5],
    [assignment.id, 2147483648],
  ] as const) {
    const f = fake();
    expect(
      await assignmentReadinessStore(f.pool).get("token", id, version),
    ).toBeNull();
    expect(f.statements).toEqual([]);
  }
  expect(
    await assignmentReadinessStore(fake().pool).get("token", assignment.id, 2),
  ).toBeNull();
  expect(
    await assignmentReadinessStore(fake().pool).get("token", "SYN-899", 1),
  ).toBeNull();
  expect(
    await assignmentReadinessStore(fake([], [], false, false).pool).get(
      "token",
      assignment.id,
      1,
    ),
  ).toBeNull();
});

it("fails closed without exposing database errors and destroys a failed rollback connection", async () => {
  for (const failure of [
    "connect",
    "BEGIN",
    "FROM content_versions",
    "COMMIT",
  ]) {
    const f = fake([], [], false, true, failure);
    expect(await assignmentReadinessStore(f.pool).list("token")).toBeNull();
    if (failure !== "connect") expect(f.released()).toBe(true);
  }
  const f = fake([], [], false, false, "ROLLBACK");
  expect(await assignmentReadinessStore(f.pool).list("token")).toBeNull();
  expect(f.released()).toBeInstanceOf(Error);
});

it("counts a previously started outer lesson only when its nested observed requirement is satisfied", async () => {
  const inner = { ...lesson, id: "SYN-889" };
  const outer = {
    ...lesson,
    structuredPrerequisites: {
      schemaVersion: 1,
      all: [{ ...leaf, id: inner.id }],
    },
  };
  for (const complete of [false, true]) {
    const activities = [
      started,
      ...(complete ? [{ ...assessed, contentId: inner.id }] : []),
    ];
    const result = await assignmentReadinessStore(
      fake(
        [assignment, { ...outer, prerequisitesSatisfied: complete }, inner],
        activities,
      ).pool,
    ).get("token", assignment.id, 1);
    expect(result?.requirements[0]?.satisfied).toBe(complete);
  }
});

it("reports inaccessible unmet lessons as unavailable but retains historical satisfaction", async () => {
  const inaccessible = { ...lesson, matchesAudience: false, eligible: false };
  const unmet = await assignmentReadinessStore(
    fake([assignment, inaccessible]).pool,
  ).get("token", assignment.id, 1);
  expect(unmet?.requirements).toEqual([
    {
      kind: "unavailable",
      observed: "unavailable",
      satisfied: false,
      requirements: [],
    },
  ]);
  const historical = await assignmentReadinessStore(
    fake([{ ...assignment, eligible: true }, inaccessible], [started]).pool,
  ).get("token", assignment.id, 1);
  expect(historical?.requirements[0]).toMatchObject({
    observed: "started",
    satisfied: true,
  });
  expect(historical?.requirements[0]?.action).toBeUndefined();
});

it("summarizes a large completed tree at the display budget without introducing a false unmet prerequisite", async () => {
  const nodes = Array.from({ length: 585 }, (_, index) => ({
    ...lesson,
    id: `SYN-${100 + index}`,
    structuredPrerequisites: {
      schemaVersion: 1,
      all:
        index >= 73
          ? []
          : Array.from({ length: 8 }, (_, child) => ({
              ...leaf,
              id: `SYN-${101 + index * 8 + child}`,
              activity: "started",
            })),
    },
  }));
  const activities = nodes.map((node) => ({ ...started, contentId: node.id }));
  const result = await assignmentReadinessStore(
    fake(
      [
        {
          ...assignment,
          eligible: true,
          structuredPrerequisites: {
            schemaVersion: 1,
            all: [{ ...leaf, id: nodes[0]!.id, activity: "started" }],
          },
        },
        ...nodes,
      ],
      activities,
    ).pool,
  ).get("token", assignment.id, 1);
  expect(result?.eligible).toBe(true);
  const text = JSON.stringify(result?.requirements);
  expect(text).toContain('"detailsLimited":true');
  expect(text).not.toContain('"satisfied":false');
  expect(text).not.toContain('"observed":"unavailable"');
});

it("finds the final unmet leaf in a 585-node tree before spending the display budget on satisfied branches", async () => {
  const waiting = new Set([0, 8, 72]);
  const nodes = Array.from({ length: 585 }, (_, index) => ({
    ...lesson,
    id: `SYN-${100 + index}`,
    eligible: !waiting.has(index),
    prerequisitesSatisfied: !waiting.has(index),
    structuredPrerequisites: {
      schemaVersion: 1,
      all:
        index >= 73
          ? []
          : Array.from({ length: 8 }, (_, child) => ({
              ...leaf,
              id: `SYN-${101 + index * 8 + child}`,
              activity: "started",
            })),
    },
  }));
  const activities = nodes
    .slice(0, -1)
    .map((node) => ({ ...started, contentId: node.id }));
  const target = {
    ...assignment,
    structuredPrerequisites: {
      schemaVersion: 1,
      all: [{ ...leaf, id: nodes[0]!.id, activity: "started" }],
    },
  };
  const result = await assignmentReadinessStore(
    fake([target, ...nodes], activities).pool,
  ).get("token", assignment.id, 1);
  const actions = (
    requirements: NonNullable<typeof result>["requirements"],
  ): string[] =>
    requirements.flatMap((item) => [
      ...(item.action ? [item.action.contentId] : []),
      ...actions(item.requirements),
    ]);
  expect(result?.eligible).toBe(false);
  expect(actions(result!.requirements)).toContain("SYN-684");
});

it("prioritizes an unmet exercise or lesson and preserves authored order among equal states", async () => {
  const target = {
    ...assignment,
    structuredPrerequisites: { schemaVersion: 1, all: [leaf, exercise] },
  };
  const exerciseFirst = await assignmentReadinessStore(
    fake([target, lesson], [assessed]).pool,
  ).get("token", assignment.id, 1);
  expect(exerciseFirst?.requirements.map((item) => item.kind)).toEqual([
    "exercise",
    "lesson",
  ]);
  const lessonFirst = await assignmentReadinessStore(
    fake([target, lesson], [], true).pool,
  ).get("token", assignment.id, 1);
  expect(lessonFirst?.requirements.map((item) => item.kind)).toEqual([
    "lesson",
    "exercise",
  ]);
  const missingFirst = await assignmentReadinessStore(
    fake([target], [], true).pool,
  ).get("token", assignment.id, 1);
  expect(missingFirst?.requirements.map((item) => item.kind)).toEqual([
    "unavailable",
    "exercise",
  ]);
});
