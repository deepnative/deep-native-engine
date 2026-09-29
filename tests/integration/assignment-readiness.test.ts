import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { assignmentReadinessStore } from "../../src/assignment-readiness.ts";
const pool = testPool();
const db = store(pool);
const readiness = assignmentReadinessStore(pool);
const catalog = catalogStore(pool);
const token = () => randomBytes(32).toString("hex");
let editor: string;
let reviewer: string;
beforeAll(async () => {
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
  editor = token();
  reviewer = token();
  const auth = authorizationStore(pool);
  await auth.provisionStaff(editor, "editor", new Date(Date.now() + 86400000));
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86400000),
  );
});
afterEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => {
  await pool.end();
});
async function member(goal: "everyday" | "work" | "build" = "everyday") {
  const t = token();
  await db.create(t, { background: "explorer", goal });
  const session = await db.session(t);
  if (session.kind !== "active") throw new Error("Missing test member");
  return { token: t, id: session.learner.id };
}
function draft(
  id: string,
  kind: "assignment" | "lesson" = "lesson",
  changes: Partial<DraftContent> = {},
): DraftContent {
  return {
    id,
    version: 1,
    kind,
    origin: "curated",
    title: `Invented ${id}`,
    body: "Synthetic only.",
    owner: "Fixture editor",
    sources: "Original invented content",
    rights: "Owned synthetic text",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
    ...changes,
  };
}
const atom = (
  id: string,
  activity: "started" | "self-assessed" = "started",
) => ({ kind: "lesson" as const, id, version: 1, activity });
const spec = (
  id: string,
  activity: "started" | "self-assessed" = "started",
) => ({ schemaVersion: 1 as const, all: [atom(id, activity)] });
async function publish(item: DraftContent) {
  expect(await catalog.createDraft(editor, item)).toBe(true);
  expect(await catalog.submit(editor, item.id, item.version)).toBe(true);
  expect(await catalog.approve(reviewer, item.id, item.version, true)).toBe(
    true,
  );
  expect(await catalog.publish(editor, item.id, item.version)).toBe(true);
}
async function fixtures() {
  const source = draft("SYN-890");
  const assignment = draft("SYN-891", "assignment", {
    goals: ["everyday"],
    prerequisites: "",
    structuredPrerequisites: spec(source.id),
  });
  await publish(source);
  await publish(assignment);
  return { source, assignment };
}

it("shows blocked published matching work, updates from real activity and never writes on repeated reads", async () => {
  const owner = await member();
  const outsider = await member();
  const { source, assignment } = await fixtures();
  const before = await readiness.get(owner.token, assignment.id, 1);
  expect(before).toMatchObject({
    eligible: false,
    requirements: [
      {
        contentId: source.id,
        observed: "not-started",
        satisfied: false,
        action: { kind: "lesson", contentId: source.id, contentVersion: 1 },
      },
    ],
  });
  expect(await readiness.get(owner.token, assignment.id, 1)).toEqual(before);
  expect(
    (
      await pool.query(
        "SELECT (SELECT count(*) FROM lesson_activity)::int AS activity,(SELECT count(*) FROM learner_assignment_choices)::int AS choices,(SELECT count(*) FROM assignment_attempts)::int AS attempts",
      )
    ).rows[0],
  ).toEqual({ activity: 0, choices: 0, attempts: 0 });
  expect(await db.chooseAssignment(owner.id, assignment.id, 1)).toBe(false);
  expect(await db.openLesson(owner.id, source.id, 1)).toBe(true);
  expect(
    (await readiness.get(owner.token, assignment.id, 1))?.requirements[0]
      ?.observed,
  ).toBe("not-started");
  expect(await db.advanceLesson(owner.id, source.id, 1, "start")).toBe(true);
  expect(await readiness.get(owner.token, assignment.id, 1)).toMatchObject({
    eligible: true,
    requirements: [{ observed: "started", satisfied: true }],
  });
  expect(await db.chooseAssignment(owner.id, assignment.id, 1)).toBe(true);
  expect(
    (await readiness.get(outsider.token, assignment.id, 1))?.eligible,
  ).toBe(false);
  await pool.query("UPDATE learners SET goal='work' WHERE id=$1", [owner.id]);
  expect(await readiness.get(owner.token, assignment.id, 1)).toBeNull();
  expect(await readiness.list(owner.token)).toEqual([]);
  expect(await db.chooseAssignment(owner.id, assignment.id, 1)).toBe(false);
  expect(await db.assignmentChoice(owner.id)).toEqual({
    contentId: assignment.id,
    contentVersion: 1,
  });
});

it("uses a repeatable snapshot when progress changes between eligibility and explanation reads", async () => {
  const owner = await member();
  const { source, assignment } = await fixtures();
  await db.openLesson(owner.id, source.id, 1);
  let changed = false;
  const concurrent = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql.includes("FROM content_versions cv") && !changed) {
            changed = true;
            expect(
              await db.advanceLesson(owner.id, source.id, 1, "start"),
            ).toBe(true);
          }
          return result;
        },
        release: (error?: Error) => client.release(error),
      };
    },
  } as unknown as Pool;
  expect(
    await assignmentReadinessStore(concurrent).get(
      owner.token,
      assignment.id,
      1,
    ),
  ).toMatchObject({
    eligible: false,
    requirements: [{ observed: "not-started", satisfied: false }],
  });
  expect(changed).toBe(true);
  expect((await readiness.get(owner.token, assignment.id, 1))?.eligible).toBe(
    true,
  );
});

it("guides nested exact self-assessment and local-exercise dependencies without granting completion", async () => {
  const owner = await member();
  const leaf = draft("SYN-880");
  const parent = draft("SYN-881", "lesson", {
    prerequisites: "",
    structuredPrerequisites: spec(leaf.id, "self-assessed"),
  });
  const assignment = draft("SYN-882", "assignment", {
    prerequisites: "",
    structuredPrerequisites: {
      schemaVersion: 1,
      all: [
        atom(parent.id),
        {
          kind: "exercise",
          id: "clear-instructions",
          version: 1,
          activity: "completed",
        },
      ],
    },
  });
  await publish(leaf);
  await publish(parent);
  await publish(assignment);
  const initial = await readiness.get(owner.token, assignment.id, 1);
  expect(initial?.requirements[0]?.action).toBeUndefined();
  expect(initial?.requirements[0]?.requirements[0]).toMatchObject({
    required: "self-assessed",
    action: { kind: "lesson", contentId: leaf.id, contentVersion: 1 },
  });
  expect(initial?.requirements[1]?.action?.kind).toBe("exercise");
  await db.openLesson(owner.id, leaf.id, 1);
  await db.advanceLesson(owner.id, leaf.id, 1, "start");
  expect(
    (await readiness.get(owner.token, assignment.id, 1))?.requirements[0]
      ?.requirements[0]?.satisfied,
  ).toBe(false);
  await db.advanceLesson(owner.id, leaf.id, 1, "complete");
  expect(
    (await readiness.get(owner.token, assignment.id, 1))?.requirements[0]
      ?.action?.contentId,
  ).toBe(parent.id);
  await db.openLesson(owner.id, parent.id, 1);
  await db.advanceLesson(owner.id, parent.id, 1, "start");
  await db.save(owner.id, {
    instruction: "Invented task only",
    verification: "Check synthetic details",
    complete: true,
  });
  expect((await readiness.get(owner.token, assignment.id, 1))?.eligible).toBe(
    true,
  );
  expect(await db.chooseAssignment(owner.id, assignment.id, 1)).toBe(true);
});

it("hides retired and superseded exact source metadata without version substitution", async () => {
  const owner = await member();
  const { source, assignment } = await fixtures();
  const unavailable = {
    kind: "unavailable",
    observed: "unavailable",
    satisfied: false,
    requirements: [],
  };
  await publish({ ...source, version: 2, title: "Replacement sample" });
  expect(
    (await readiness.get(owner.token, assignment.id, 1))?.requirements,
  ).toEqual([unavailable]);
  expect(await db.chooseAssignment(owner.id, assignment.id, 1)).toBe(false);
  expect(await catalog.retire(editor, source.id)).toBe(true);
  expect(
    (await readiness.get(owner.token, assignment.id, 1))?.requirements,
  ).toEqual([unavailable]);
  expect(await catalog.retire(editor, assignment.id)).toBe(true);
  expect(await readiness.get(owner.token, assignment.id, 1)).toBeNull();
});

it("keeps draft, qualified, missing, cyclic and malformed prerequisite graphs outside personalized readiness", async () => {
  const owner = await member();
  const source = draft("SYN-890");
  expect(await catalog.createDraft(editor, source)).toBe(true);
  const blocked = draft("SYN-891", "assignment", {
    prerequisites: "",
    structuredPrerequisites: spec(source.id),
  });
  expect(await catalog.createDraft(editor, blocked)).toBe(false);
  expect(
    await catalog.createDraft(editor, {
      ...blocked,
      structuredPrerequisites: spec("SYN-899"),
    }),
  ).toBe(false);
  expect(
    await catalog.createDraft(editor, {
      ...blocked,
      structuredPrerequisites: spec(blocked.id),
    }),
  ).toBe(false);
  await pool.query(
    "UPDATE content_versions SET requires_qualified_signoff=true WHERE id=$1",
    [source.id],
  );
  expect(await catalog.createDraft(editor, blocked)).toBe(false);
  expect(await readiness.get(owner.token, blocked.id, 1)).toBeNull();
  expect(await readiness.list(owner.token)).toEqual([]);
  const malformed = draft("SYN-892", "assignment", {
    prerequisites: "Human approval required",
  });
  expect(await catalog.createDraft(editor, malformed)).toBe(true);
  expect(await catalog.submit(editor, malformed.id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, malformed.id, 1, true)).toBe(false);
  expect(await catalog.publish(editor, malformed.id, 1)).toBe(false);
  expect(await readiness.get(owner.token, malformed.id, 1)).toBeNull();
  expect(await readiness.list(owner.token)).toEqual([]);
});

it("denies anonymous, staff, revoked, expired and deleting sessions without personalized data", async () => {
  await fixtures();
  expect(await readiness.list("unknown")).toBeNull();
  expect(await readiness.list(editor)).toBeNull();
  for (const condition of ["revoked", "expired", "deleting"]) {
    const owner = await member();
    if (condition === "revoked")
      await pool.query(
        "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
        [owner.id],
      );
    if (condition === "expired")
      await pool.query(
        "UPDATE principals SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1",
        [owner.id],
      );
    if (condition === "deleting")
      await pool.query(
        "UPDATE workspaces SET deleting_at=CURRENT_TIMESTAMP WHERE owner_principal_id=$1",
        [owner.id],
      );
    expect(await readiness.list(owner.token)).toBeNull();
  }
});

it("summarizes a completed wide shared DAG without contradicting SQL eligibility", async () => {
  const owner = await member();
  const width = 4;
  const depth = 5;
  for (let level = depth - 1; level >= 0; level--) {
    for (let column = 0; column < width; column++) {
      const source = draft(`SYN-${700 + level * 10 + column}`, "lesson", {
        prerequisites: "",
        structuredPrerequisites: {
          schemaVersion: 1,
          all:
            level === depth - 1
              ? []
              : Array.from({ length: width }, (_, child) =>
                  atom(`SYN-${710 + level * 10 + child}`),
                ),
        },
      });
      await publish(source);
      expect(await db.openLesson(owner.id, source.id, 1)).toBe(true);
      expect(await db.advanceLesson(owner.id, source.id, 1, "start")).toBe(
        true,
      );
    }
  }
  const assignment = draft("SYN-799", "assignment", {
    prerequisites: "",
    structuredPrerequisites: {
      schemaVersion: 1,
      all: Array.from({ length: width }, (_, child) =>
        atom(`SYN-${700 + child}`),
      ),
    },
  });
  await publish(assignment);
  const result = await readiness.get(owner.token, assignment.id, 1);
  expect(result?.eligible).toBe(true);
  const collect = (
    nodes: NonNullable<typeof result>["requirements"],
  ): NonNullable<typeof result>["requirements"] =>
    nodes.flatMap((node) => [node, ...collect(node.requirements)]);
  const nodes = collect(result!.requirements);
  expect(nodes.length).toBeLessThanOrEqual(256 * 8);
  expect(nodes.every((node) => node.satisfied)).toBe(true);
  expect(nodes.some((node) => node.kind === "unavailable")).toBe(false);
  expect(await db.chooseAssignment(owner.id, assignment.id, 1)).toBe(true);
}, 30000);

it("marks unmet audience-inaccessible lessons unavailable while retaining historically satisfied prerequisites", async () => {
  const owner = await member();
  const historical = await member("work");
  const source = draft("SYN-870", "lesson", { goals: ["work"] });
  const assignment = draft("SYN-871", "assignment", {
    goals: ["everyday"],
    prerequisites: "",
    structuredPrerequisites: spec(source.id),
  });
  await publish(source);
  await publish(assignment);
  expect(
    (await readiness.get(owner.token, assignment.id, 1))?.requirements,
  ).toEqual([
    {
      kind: "unavailable",
      observed: "unavailable",
      satisfied: false,
      requirements: [],
    },
  ]);
  expect(await db.openLesson(owner.id, source.id, 1)).toBe(false);
  expect(await db.openLesson(historical.id, source.id, 1)).toBe(true);
  expect(await db.advanceLesson(historical.id, source.id, 1, "start")).toBe(
    true,
  );
  await pool.query("UPDATE learners SET goal='everyday' WHERE id=$1", [
    historical.id,
  ]);
  expect(await readiness.get(historical.token, assignment.id, 1)).toMatchObject(
    {
      eligible: true,
      requirements: [{ kind: "lesson", observed: "started", satisfied: true }],
    },
  );
  expect(await db.chooseAssignment(historical.id, assignment.id, 1)).toBe(true);
});

it("finds a safe last unmet leaf in a large valid tree and removes the action after retirement", async () => {
  const owner = await member();
  for (let index = 584; index >= 0; index--) {
    const source = draft(`SYN-${100 + index}`, "lesson", {
      prerequisites: "",
      structuredPrerequisites: {
        schemaVersion: 1,
        all:
          index >= 73
            ? []
            : Array.from({ length: 8 }, (_, child) =>
                atom(`SYN-${101 + index * 8 + child}`),
              ),
      },
    });
    await publish(source);
    if (index !== 584 && (await db.openLesson(owner.id, source.id, 1)))
      expect(await db.advanceLesson(owner.id, source.id, 1, "start")).toBe(
        true,
      );
  }
  const assignment = draft("SYN-899", "assignment", {
    prerequisites: "",
    structuredPrerequisites: spec("SYN-100"),
  });
  await publish(assignment);
  const before = await readiness.get(owner.token, assignment.id, 1);
  const actions = (
    requirements: NonNullable<typeof before>["requirements"],
  ): string[] =>
    requirements.flatMap((item) => [
      ...(item.action ? [item.action.contentId] : []),
      ...actions(item.requirements),
    ]);
  expect(before?.eligible).toBe(false);
  expect(actions(before!.requirements)).toEqual(["SYN-684"]);
  expect(await db.chooseAssignment(owner.id, assignment.id, 1)).toBe(false);
  expect(await catalog.retire(editor, "SYN-684")).toBe(true);
  const after = await readiness.get(owner.token, assignment.id, 1);
  expect(after?.eligible).toBe(false);
  expect(actions(after!.requirements)).toEqual([]);
  expect(JSON.stringify(after?.requirements)).toContain(
    '"observed":"unavailable"',
  );
}, 30000);
