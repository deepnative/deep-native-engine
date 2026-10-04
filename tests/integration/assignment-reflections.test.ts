import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { attemptStore } from "../../src/attempts.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const attempts = attemptStore(pool);
const exports = memberExportStore(pool);
const response = "An invented response showing synthetic comparison evidence.";
const reflection = {
  evidence: "I can point to the invented outline.",
  gaps: "I am uncertain about the invented source.",
  intention: "I will revise the synthetic explanation.",
};

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

function pausedExport(fragment: string) {
  const reached = gate();
  const resume = gate();
  const state = { pid: 0 };
  const controlled = {
    async connect() {
      const client = await pool.connect();
      state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (sql.includes(fragment)) {
            reached.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  return { exporter: memberExportStore(controlled), reached, resume, state };
}

async function waitUntilBlocked(waiting: number, blocker: number) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(
      "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
      [blocker, waiting],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected private reflection deletion to wait on export");
}

beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(async () => pool.end());

async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active")
    throw Error("Synthetic member was not created");
  return { token, id: session.learner.id };
}

async function fixture(
  rubric: string | null = "Exact invented version-one rubric",
) {
  const owner = await member();
  const outsider = await member();
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  const auth = authorizationStore(pool);
  const expiry = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  const catalog = catalogStore(pool);
  const draft: DraftContent = {
    id: "SYN-969",
    version: 1,
    kind: "assignment",
    origin: "curated",
    title: "Invented private reflection assignment",
    body: "Use an invented example.",
    owner: "Synthetic editor",
    sources: "Invented source",
    rights: "Owned synthetic sample",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites: "None",
    rubric,
    rubricVersion: rubric === null ? null : 4,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, draft.id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, draft.id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, draft.id, 1)).toBe(true);
  expect(await db.chooseAssignment(owner.id, draft.id, 1)).toBe(true);
  const id = await attempts.start(owner.token);
  if (!id) throw Error("Synthetic attempt was not created");
  expect(await attempts.save(owner.token, id, 1, response)).toBe(true);
  expect(await attempts.submit(owner.token, id, 2)).toBe(true);
  return { owner, outsider, editor, reviewer, catalog, draft, id };
}

it("pins the exact rubric and reflection to immutable submission versions", async () => {
  const item = await fixture();
  const beforeReflection = (await attempts.detail(item.owner.token, item.id))
    ?.submissions;
  expect(typeof beforeReflection?.[0]?.submittedAt).toBe("string");
  expect(beforeReflection).toMatchObject([
    { sequence: 1, response, reflection: null, reflectionRevision: 0 },
  ]);
  expect(
    await attempts.saveReflection(item.owner.token, item.id, 1, 0, reflection),
  ).toBe(true);
  expect(
    await attempts.saveReflection(item.owner.token, item.id, 1, 0, reflection),
  ).toBe(false);
  const first = await attempts.detail(item.owner.token, item.id);
  expect(first).toMatchObject({
    contentId: "SYN-969",
    contentVersion: 1,
    rubric: "Exact invented version-one rubric",
    rubricVersion: 4,
    submissions: [
      {
        sequence: 1,
        response,
        reflection: { ...reflection, revision: 1 },
        reflectionRevision: 1,
      },
    ],
  });
  const revised = {
    ...reflection,
    intention: "A different invented revision intention.",
  };
  expect(
    await attempts.saveReflection(item.owner.token, item.id, 1, 1, revised),
  ).toBe(true);
  expect(
    await attempts.saveReflection(item.owner.token, item.id, 1, 1, reflection),
  ).toBe(false);
  expect(await attempts.revise(item.owner.token, item.id)).toBe(true);
  const draft = await attempts.detail(item.owner.token, item.id);
  expect(draft?.submissions?.[0]?.reflection).toMatchObject({
    ...revised,
    revision: 2,
  });
  expect(
    await attempts.save(
      item.owner.token,
      item.id,
      draft!.revision,
      "A second invented response using revised synthetic evidence.",
    ),
  ).toBe(true);
  expect(
    await attempts.submit(item.owner.token, item.id, draft!.revision + 1),
  ).toBe(true);
  expect(
    (await attempts.detail(item.owner.token, item.id))?.submissions,
  ).toMatchObject([
    { sequence: 1, reflection: { ...revised, revision: 2 } },
    { sequence: 2, reflection: null, reflectionRevision: 0 },
  ]);
  const nextVersion = {
    ...item.draft,
    version: 2,
    rubric: "A different newer rubric",
    rubricVersion: 5,
  };
  expect(await item.catalog.createDraft(item.editor, nextVersion)).toBe(true);
  expect(await item.catalog.submit(item.editor, nextVersion.id, 2)).toBe(true);
  expect(
    await item.catalog.approve(item.reviewer, nextVersion.id, 2, true),
  ).toBe(true);
  expect(await item.catalog.publish(item.editor, nextVersion.id, 2)).toBe(true);
  expect((await attempts.detail(item.owner.token, item.id))?.rubric).toBe(
    item.draft.rubric,
  );
});

it("keeps an absent rubric absent and a deleted reflection permanently text-free", async () => {
  const item = await fixture(null);
  expect(await attempts.detail(item.owner.token, item.id)).toMatchObject({
    rubric: null,
    rubricVersion: null,
  });
  expect(
    await attempts.saveReflection(item.owner.token, item.id, 1, 0, reflection),
  ).toBe(true);
  expect(await attempts.deleteReflection(item.owner.token, item.id, 1, 1)).toBe(
    true,
  );
  expect(await attempts.deleteReflection(item.owner.token, item.id, 1, 1)).toBe(
    false,
  );
  expect(
    await attempts.saveReflection(item.owner.token, item.id, 1, 1, reflection),
  ).toBe(false);
  expect(
    await attempts.saveReflection(item.owner.token, item.id, 1, 0, reflection),
  ).toBe(false);
  expect(
    (await attempts.detail(item.owner.token, item.id))?.submissions,
  ).toMatchObject([
    { sequence: 1, reflection: null, reflectionRevision: 2, response },
  ]);
  const retained = (
    await pool.query(
      "SELECT evidence,gaps,intention,deleted_at FROM assignment_submission_reflections WHERE attempt_id=$1 AND sequence=1",
      [item.id],
    )
  ).rows[0];
  expect(retained).toMatchObject({
    evidence: "",
    gaps: "",
    intention: "",
    deleted_at: expect.any(Date),
  });
  await expect(
    pool.query(
      "UPDATE assignment_submission_reflections SET deleted_at=NULL WHERE attempt_id=$1 AND sequence=1",
      [item.id],
    ),
  ).rejects.toThrow();
  const exported = await exports.exportOwned(item.owner.token);
  expect(exported.kind).toBe("ready");
  if (exported.kind === "ready") {
    expect(exported.payload.version).toBe("local-member-records-v20");
    expect(exported.payload.records.assignmentReflections).toEqual([]);
    expect(JSON.stringify(exported.payload)).not.toContain(reflection.evidence);
  }
});

it("requires the current owner session and removes text with attempt or account deletion", async () => {
  const item = await fixture();
  expect(
    await attempts.saveReflection(
      item.outsider.token,
      item.id,
      1,
      0,
      reflection,
    ),
  ).toBe(false);
  expect(await attempts.detail(item.outsider.token, item.id)).toBeNull();
  expect(
    await attempts.saveReflection(item.editor, item.id, 1, 0, reflection),
  ).toBe(false);
  expect(
    await attempts.saveReflection(item.owner.token, item.id, 2, 0, reflection),
  ).toBe(false);
  expect(
    await attempts.saveReflection(item.owner.token, item.id, 1, 0, reflection),
  ).toBe(true);
  expect(
    await attempts.deleteReflection(item.outsider.token, item.id, 1, 1),
  ).toBe(false);
  expect((await exports.exportOwned(item.outsider.token)).kind).toBe("ready");
  const own = await exports.exportOwned(item.owner.token);
  expect(own).toMatchObject({
    kind: "ready",
    payload: {
      records: {
        assignmentReflections: [
          {
            attemptId: item.id,
            sequence: 1,
            contentId: "SYN-969",
            contentVersion: 1,
            ...reflection,
            label: "SELF-REPORTED · SIMULATED · UNREVIEWED",
          },
        ],
      },
    },
  });
  const other = await exports.exportOwned(item.outsider.token);
  if (other.kind === "ready")
    expect(other.payload.records.assignmentReflections).toEqual([]);
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [item.owner.id],
  );
  expect(await attempts.detail(item.owner.token, item.id)).toBeNull();
  expect(
    await attempts.saveReflection(item.owner.token, item.id, 1, 1, reflection),
  ).toBe(false);
  expect(await exports.exportOwned(item.owner.token)).toEqual({
    kind: "denied",
  });
  await pool.query("UPDATE principals SET revoked_at=NULL WHERE id=$1", [
    item.owner.id,
  ]);
  expect(await attempts.remove(item.owner.token, item.id)).toBe(true);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM assignment_submission_reflections",
      )
    ).rows[0].n,
  ).toBe(0);
  const replacement = await attempts.start(item.owner.token);
  expect(replacement).toBeTruthy();
  expect(await attempts.save(item.owner.token, replacement!, 1, response)).toBe(
    true,
  );
  expect(await attempts.submit(item.owner.token, replacement!, 2)).toBe(true);
  expect(
    await attempts.saveReflection(
      item.owner.token,
      replacement!,
      1,
      0,
      reflection,
    ),
  ).toBe(true);
  await db.remove(item.owner.id);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM assignment_submission_reflections",
      )
    ).rows[0].n,
  ).toBe(0);
});

it("rolls back a reflection save when its session expires during a row wait", async () => {
  const item = await fixture();
  const holder = await pool.connect();
  await holder.query("BEGIN");
  await holder.query(
    "SELECT id FROM assignment_attempts WHERE id=$1 FOR UPDATE",
    [item.id],
  );
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
    [item.owner.id],
  );
  const pending = attempts.saveReflection(
    item.owner.token,
    item.id,
    1,
    0,
    reflection,
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await holder.query("COMMIT");
    expect(await pending).toBe(false);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM assignment_submission_reflections",
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
});

it("paginates owned reflections with their exact submission reference", async () => {
  const item = await fixture();
  expect(
    await attempts.saveReflection(item.owner.token, item.id, 1, 0, reflection),
  ).toBe(true);
  for (let index = 0; index < 100; index++)
    await pool.query(
      `INSERT INTO exercises(learner_id,workspace_id,lesson_id,lesson_version,
        instruction,verification)
       VALUES($1,$1,$2,1,'Invented exercise','Invented check')`,
      [item.owner.id, `reflection-page-${index}`],
    );
  const first = await exports.exportOwned(item.owner.token);
  expect(first).toMatchObject({
    kind: "ready",
    payload: { page: { recordCount: 100, complete: false } },
  });
  if (first.kind !== "ready") throw Error("Missing first export page");
  expect(first.payload.records.assignmentReflections).toEqual([]);
  const second = await exports.exportOwned(
    item.owner.token,
    first.payload.page.nextCursor!,
  );
  expect(second).toMatchObject({
    kind: "ready",
    payload: {
      version: "local-member-records-v20",
      records: {
        assignmentReflections: [
          {
            attemptId: item.id,
            sequence: 1,
            contentId: "SYN-969",
            contentVersion: 1,
            ...reflection,
            label: "SELF-REPORTED · SIMULATED · UNREVIEWED",
          },
        ],
      },
    },
  });
});

it("serializes retained reflection export before deletion when export holds the text row", async () => {
  const item = await fixture();
  expect(
    await attempts.saveReflection(item.owner.token, item.id, 1, 0, reflection),
  ).toBe(true);
  const controlled = pausedExport("FROM assignment_submission_reflections r");
  const reading = controlled.exporter.exportOwned(item.owner.token);
  const writer = await pool.connect();
  let deleting: Promise<boolean> | undefined;
  try {
    await controlled.reached.wait;
    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid as number;
    const writerPool = {
      connect: async () => ({
        query: writer.query.bind(writer),
        release: () => {},
      }),
    } as unknown as Pool;
    deleting = attemptStore(writerPool).deleteReflection(
      item.owner.token,
      item.id,
      1,
      1,
    );
    await waitUntilBlocked(writerPid, controlled.state.pid);
    controlled.resume.release();
    expect(await reading).toMatchObject({
      kind: "ready",
      payload: {
        records: { assignmentReflections: [{ evidence: reflection.evidence }] },
      },
    });
    expect(await deleting).toBe(true);
    const later = await exports.exportOwned(item.owner.token);
    if (later.kind !== "ready") throw Error("Missing later export");
    expect(later.payload.records.assignmentReflections).toEqual([]);
    expect(JSON.stringify(later.payload)).not.toContain(reflection.evidence);
  } finally {
    controlled.resume.release();
    await Promise.allSettled([reading, ...(deleting ? [deleting] : [])]);
    writer.release();
  }
});

it("withholds a stale export snapshot when reflection deletion commits first", async () => {
  const item = await fixture();
  expect(
    await attempts.saveReflection(item.owner.token, item.id, 1, 0, reflection),
  ).toBe(true);
  const controlled = pausedExport("FROM principals p JOIN learners l");
  const reading = controlled.exporter.exportOwned(item.owner.token);
  try {
    await controlled.reached.wait;
    expect(
      await attempts.deleteReflection(item.owner.token, item.id, 1, 1),
    ).toBe(true);
    controlled.resume.release();
    expect(await reading).toEqual({ kind: "unavailable" });
    const fresh = await exports.exportOwned(item.owner.token);
    if (fresh.kind !== "ready") throw Error("Missing fresh export");
    expect(fresh.payload.records.assignmentReflections).toEqual([]);
  } finally {
    controlled.resume.release();
    await Promise.allSettled([reading]);
  }
});
