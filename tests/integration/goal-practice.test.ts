import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals, cohorts CASCADE"));
afterAll(async () => pool.end());
const answer = {
  instruction: "Plan a community event with invented details.",
  verification: "Check every step against the original invented details.",
  complete: true,
};
async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw Error("Synthetic member missing");
  return { token, id: session.learner.id };
}
it("preserves exact completed practice for both goals after a direction change", async () => {
  const owner = await member();
  await db.save(owner.id, answer);
  const before = await db.progress(owner.id);
  await db.updateProfile(owner.id, {
    background: "professional",
    goal: "work",
    backgroundTags: [],
    domainTags: [],
    itRoles: [],
    experience: null,
    exploratory: false,
  });
  expect(
    await db.save(owner.id, {
      ...answer,
      instruction: "Summarize invented meeting notes into clear next steps.",
    }),
  ).toBe("saved");
  const rows = await db.withExerciseRead(owner.token, (rows) => rows);
  expect(rows).toHaveLength(2);
  expect(rows?.find((row) => row.goalAtStart === "everyday")).toMatchObject({
    instruction: answer.instruction,
    completedAt: before!.completed_at,
  });
  expect(rows?.find((row) => row.goalAtStart === "work")).toMatchObject({
    instruction: "Summarize invented meeting notes into clear next steps.",
  });
});

it("keeps drafts, exact withdrawals, completion prerequisites and deletion scoped by goal", async () => {
  const owner = await member(),
    other = await member();
  await db.save(owner.id, answer);
  await pool.query("UPDATE learners SET goal='work' WHERE id=$1", [owner.id]);
  expect(
    await db.save(owner.id, { ...answer, complete: false, goal: "everyday" }),
  ).toBe("stale-goal");
  expect(
    await db.save(owner.id, {
      ...answer,
      instruction: "Work draft",
      complete: false,
      goal: "work",
    }),
  ).toBe("saved");
  expect(await db.progress(owner.id)).toMatchObject({
    goal_at_start: "work",
    completed_at: null,
    has_completed_version: true,
  });
  expect(await db.withdrawExercise(owner.token, "clear-instructions", 1)).toBe(
    "unavailable",
  );
  expect(
    await db.withdrawExercise(other.token, "clear-instructions", 1, "everyday"),
  ).toBe("unavailable");
  expect(
    await db.withdrawExercise(owner.token, "clear-instructions", 1, "everyday"),
  ).toBe("withdrawn");
  expect(
    await db.withdrawExercise(owner.token, "clear-instructions", 1, "everyday"),
  ).toBe("already-withdrawn");
  expect(await db.progress(owner.id)).toMatchObject({
    instruction: "Work draft",
    has_completed_version: true,
  });
  await pool.query("UPDATE learners SET goal='everyday' WHERE id=$1", [
    owner.id,
  ]);
  expect(await db.save(owner.id, { ...answer, goal: "everyday" })).toBe(
    "withdrawn",
  );
  await db.remove(owner.id);
  expect(await db.save(owner.id, answer)).toBe("unavailable");
  expect(await db.withExerciseRead(owner.token, (rows) => rows)).toBeNull();
  expect(
    (
      await pool.query("SELECT count(*) FROM exercises WHERE learner_id=$1", [
        owner.id,
      ])
    ).rows[0].count,
  ).toBe("0");
});

it("serializes concurrent first completions into one immutable exact goal slot", async () => {
  const owner = await member();
  const results = await Promise.all([
    db.save(owner.id, { ...answer, goal: "everyday" }),
    db.save(owner.id, {
      ...answer,
      instruction: "Different invented completion",
      goal: "everyday",
    }),
  ]);
  expect(results.sort()).toEqual(["saved", "unchanged"]);
  const rows = await db.withExerciseRead(owner.token, (rows) => rows);
  expect(rows).toHaveLength(1);
  const before = rows![0];
  await db.save(owner.id, { ...answer, complete: false });
  expect(await db.withExerciseRead(owner.token, (rows) => rows)).toEqual([
    before,
  ]);
});

import request from "supertest";
import { app } from "../../src/app.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { createHmac } from "node:crypto";
import { hash } from "../../src/store.ts";
const origin = "http://127.0.0.1:3000",
  secret = "synthetic-goal-practice";
function get(token: string, path: string) {
  return withLoopback(app(db, { origin, secret }), (server) =>
    request(server)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
}
function post(token: string, fields: Record<string, string>, saving = db.save) {
  return withLoopback(
    app({ ...db, save: saving }, { origin, secret }),
    (server) =>
      request(server)
        .post("/exercise")
        .set("Host", "127.0.0.1:3000")
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${token}`)
        .type("form")
        .send({
          csrf: csrf(token, secret),
          lesson_id: "clear-instructions",
          lesson_version: "1",
          intent: "complete",
          checked: "yes",
          instruction: answer.instruction,
          verification: answer.verification,
          ...fields,
        }),
  );
}

it("shows fresh goal practice, exact read-only history, safe validation and stale-form recovery", async () => {
  const owner = await member(),
    other = await member();
  await db.save(owner.id, answer);
  await pool.query("UPDATE learners SET goal='work' WHERE id=$1", [owner.id]);
  expect((await get(owner.token, "/learn")).text).toContain(
    'value="0" max="1"',
  );
  const fresh = await get(owner.token, "/lesson");
  expect(fresh.text).toContain('name="goal" value="work"');
  expect(fresh.text).toContain('name="instruction" maxlength="2000"');
  expect((await post(owner.token, { goal: "everyday" })).status).toBe(409);
  const invalid = await post(owner.token, {
    goal: "work",
    instruction: "<script>x</script>",
    verification: "",
  });
  expect(invalid.status).toBe(422);
  expect(invalid.text).toContain("&lt;script&gt;x&lt;/script&gt;");
  expect(await db.withExerciseRead(owner.token, (rows) => rows.length)).toBe(1);
  expect(
    (
      await post(owner.token, {
        goal: "work",
        instruction: "Create a plan from invented meeting notes.",
      })
    ).status,
  ).toBe(303);
  const history = (await get(owner.token, "/progress")).text;
  expect(history).toContain("goal=everyday");
  expect(history).toContain("goal=work");
  const exact = await get(owner.token, "/lesson?version=1&goal=everyday");
  expect(exact.status).toBe(200);
  expect(exact.text).toContain(answer.instruction);
  expect(exact.text).not.toContain('action="/exercise"');
  expect((await get(owner.token, "/lesson?version=1")).status).toBe(404);
  expect((await get(owner.token, "/lesson?version=1&goal=forged")).status).toBe(
    404,
  );
  expect(
    (await get(other.token, "/lesson?version=1&goal=everyday")).status,
  ).toBe(404);
  await db.withdrawExercise(owner.token, "clear-instructions", 1, "everyday");
  expect(
    (await get(owner.token, "/lesson?version=1&goal=everyday")).text,
  ).not.toContain(answer.instruction);
  expect(
    (await get(owner.token, "/lesson?version=1&goal=work")).text,
  ).toContain("Create a plan from invented meeting notes.");
  const uncertain = await post(owner.token, { goal: "work" }, async () => {
    throw Error("Synthetic lost acknowledgement");
  });
  expect(uncertain.status).toBe(503);
  expect(uncertain.text).toContain("version=1&amp;goal=work");
  await db.withdrawExercise(owner.token, "clear-instructions", 1, "work");
  const withdrawn = await post(owner.token, { goal: "work" }, async () => {
    throw Error("Synthetic lost acknowledgement");
  });
  expect(withdrawn.text).not.toContain("Attempted instruction");
  expect(withdrawn.text).not.toContain(answer.instruction);
});

it("exports same-version goal slots across page boundaries once, redacts withdrawn text and rejects obsolete cursors", async () => {
  const owner = await member();
  await pool.query(
    `INSERT INTO exercises(learner_id,workspace_id,lesson_id,lesson_version,instruction,verification,completed_at,goal_at_start)
 SELECT $1,$1,'a-synthetic-'||n,1,'Invented sample','Invented check',clock_timestamp(),'everyday' FROM generate_series(1,99) n`,
    [owner.id],
  );
  await db.save(owner.id, answer);
  await pool.query("UPDATE learners SET goal='work' WHERE id=$1", [owner.id]);
  await db.save(owner.id, { ...answer, instruction: "Work private answer" });
  const key = Buffer.alloc(32, 7),
    exports = memberExportStore(pool, key);
  const first = await exports.exportOwned(owner.token);
  expect(first.kind).toBe("ready");
  if (first.kind !== "ready") throw Error("missing page");
  expect(first.payload.page.recordCount).toBe(100);
  const cursor = first.payload.page.nextCursor!;
  await db.withdrawExercise(owner.token, "clear-instructions", 1, "work");
  const second = await exports.exportOwned(owner.token, cursor);
  expect(second.kind).toBe("ready");
  if (second.kind !== "ready") throw Error("missing page");
  const all = [
    ...first.payload.records.exercises!,
    ...second.payload.records.exercises!,
  ];
  expect(all).toHaveLength(101);
  expect(
    new Set(
      all.map(
        (row) => `${row.lessonId}/${row.lessonVersion}/${row.goalAtStart}`,
      ),
    ).size,
  ).toBe(101);
  expect(second.payload.records.exercises).toMatchObject([
    { goalAtStart: "work", instruction: null, state: "withdrawn" },
  ]);
  const body = Buffer.from(
    JSON.stringify([1, 0, ["clear-instructions", 1], 2, Date.now() + 60000]),
  ).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(hash(owner.token))
    .update(".")
    .update(body)
    .digest("base64url");
  expect(
    await exports.exportOwned(owner.token, body + "." + signature),
  ).toEqual({ kind: "denied" });
  expect(await exports.exportOwned((await member()).token, cursor)).toEqual({
    kind: "denied",
  });
});

it("migrates legacy completed, draft, withdrawn, old-version and unattributed rows without changing business fields", async () => {
  const owner = await member();
  await pool.query(
    "ALTER TABLE exercises DROP CONSTRAINT exercises_pkey; ALTER TABLE exercises DROP COLUMN goal_slot; ALTER TABLE exercises ADD PRIMARY KEY(learner_id,lesson_id,lesson_version); DELETE FROM schema_migrations WHERE version=48",
  );
  await pool.query(
    `INSERT INTO exercises(learner_id,workspace_id,lesson_id,lesson_version,instruction,verification,completed_at,goal_at_start,withdrawn_at) VALUES
 ($1,$1,'clear-instructions',1,'Legacy unknown goal','Legacy check',clock_timestamp(),NULL,NULL),
 ($1,$1,'clear-instructions',2,'Legacy draft','Draft check',NULL,'work',NULL),
 ($1,$1,'clear-instructions',3,NULL,NULL,clock_timestamp(),'build',clock_timestamp()),
 ($1,$1,'clear-instructions',4,'Legacy completed','Completed check',clock_timestamp(),'everyday',NULL)`,
    [owner.id],
  );
  const before = (
    await pool.query("SELECT * FROM exercises ORDER BY lesson_version")
  ).rows;
  await migrate(pool);
  await migrate(pool);
  const after = (
    await pool.query("SELECT * FROM exercises ORDER BY lesson_version")
  ).rows;
  expect(after.map(({ goal_slot: _goalSlot, ...row }) => row)).toEqual(before);
  expect(after.map((row) => row.goal_slot)).toEqual([
    "unattributed",
    "work",
    "build",
    "everyday",
  ]);
  const unknown = await get(owner.token, "/lesson?version=1&goal=unattributed");
  expect(unknown.text).toContain("Unattributed historical goal");
  expect(unknown.text).not.toContain('action="/exercise"');
  expect(
    await db.withdrawExercise(
      owner.token,
      "clear-instructions",
      1,
      "unattributed",
    ),
  ).toBe("withdrawn");
  expect(await db.save(owner.id, answer)).toBe("saved");
  expect(await db.withExerciseRead(owner.token, (rows) => rows.length)).toBe(5);
});

import type { Pool, PoolClient } from "pg";
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
}
function pausedStore(fragment: string) {
  const reached = gate(),
    resume = gate();
  const controlled = store({
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql.startsWith(fragment)) {
            reached.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      } as unknown as PoolClient;
    },
  } as unknown as Pool);
  return { controlled, reached, resume };
}
async function blocked(fragment: string) {
  for (let n = 0; n < 100; n++) {
    const rows = (
      await pool.query(
        `SELECT pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND position($1 in query)>0`,
        [fragment],
      )
    ).rows;
    if (rows.some((r) => r.blockers.length)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}
it("rejects a stale form after waiting behind a committed profile change", async () => {
  const owner = await member(),
    client = await pool.connect();
  let saving: Promise<string> | undefined;
  try {
    await client.query("BEGIN");
    await client.query("UPDATE learners SET goal='work' WHERE id=$1", [
      owner.id,
    ]);
    saving = db.save(owner.id, { ...answer, goal: "everyday" });
    expect(await blocked("SELECT goal FROM learners")).toBe(true);
    await client.query("COMMIT");
    expect(await saving).toBe("stale-goal");
    expect(await db.withExerciseRead(owner.token, (rows) => rows)).toEqual([]);
  } finally {
    await client.query("ROLLBACK");
    await Promise.allSettled(saving ? [saving] : []);
    client.release();
  }
});
it("commits the submitted goal before a waiting profile update without relabeling its record", async () => {
  const owner = await member(),
    pause = pausedStore("INSERT INTO exercises");
  const saving = pause.controlled.save(owner.id, {
    ...answer,
    goal: "everyday",
  });
  let changing: Promise<unknown> | undefined;
  try {
    await pause.reached.wait;
    changing = pool.query("UPDATE learners SET goal='work' WHERE id=$1", [
      owner.id,
    ]);
    expect(await blocked("UPDATE learners SET goal")).toBe(true);
    pause.resume.release();
    expect(await saving).toBe("saved");
    await changing;
    expect(
      await db.withExerciseRead(owner.token, (rows) => rows),
    ).toMatchObject([
      { goalAtStart: "everyday", instruction: answer.instruction },
    ]);
  } finally {
    pause.resume.release();
    await Promise.allSettled([saving, ...(changing ? [changing] : [])]);
  }
});
it.each(["save-first", "withdraw-first"] as const)(
  "keeps exact goal tombstones irreversible with %s ordering",
  async (order) => {
    const owner = await member();
    await db.save(owner.id, answer);
    const pause = pausedStore(
      order === "save-first"
        ? "SELECT goal FROM learners"
        : "UPDATE exercises SET instruction=NULL",
    );
    const first =
      order === "save-first"
        ? pause.controlled.save(owner.id, { ...answer, goal: "everyday" })
        : pause.controlled.withdrawExercise(
            owner.token,
            "clear-instructions",
            1,
            "everyday",
          );
    let second: Promise<string> | undefined;
    try {
      await pause.reached.wait;
      second =
        order === "save-first"
          ? db.withdrawExercise(
              owner.token,
              "clear-instructions",
              1,
              "everyday",
            )
          : db.save(owner.id, { ...answer, goal: "everyday" });
      expect(await blocked("SELECT id FROM workspaces")).toBe(true);
      pause.resume.release();
      expect(await first).toBe(
        order === "save-first" ? "unchanged" : "withdrawn",
      );
      expect(await second).toBe("withdrawn");
      expect(await db.progress(owner.id)).toMatchObject({
        instruction: null,
        verification: null,
        withdrawn_at: expect.any(Date),
      });
    } finally {
      pause.resume.release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  },
);
it.each(["delete", "revoke", "expire", "deleting"] as const)(
  "denies a save waiting behind %s and never resurrects a deleted account",
  async (action) => {
    const owner = await member(),
      client = await pool.connect();
    let saving: Promise<string> | undefined;
    try {
      await client.query("BEGIN");
      await client.query(
        action === "delete"
          ? "DELETE FROM principals WHERE id=$1"
          : action === "revoke"
            ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
            : action === "expire"
              ? "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1"
              : "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
        [owner.id],
      );
      saving = db.save(owner.id, { ...answer, goal: "everyday" });
      expect(
        await blocked(
          action === "deleting"
            ? "SELECT id FROM workspaces"
            : "SELECT id,expires_at FROM principals",
        ),
      ).toBe(true);
      await client.query("COMMIT");
      expect(await saving).toBe("unavailable");
      expect(await db.withExerciseRead(owner.token, (rows) => rows)).toBeNull();
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM exercises WHERE learner_id=$1",
            [owner.id],
          )
        ).rows[0].count,
      ).toBe("0");
    } finally {
      await client.query("ROLLBACK");
      await Promise.allSettled(saving ? [saving] : []);
      client.release();
    }
  },
);

import { assignmentReadinessStore } from "../../src/assignment-readiness.ts";
it("orders readiness behind a paused starter save without a learner/workspace deadlock", async () => {
  const owner = await member(),
    pause = pausedStore("SELECT id FROM workspaces");
  const saving = pause.controlled.save(owner.id, {
    ...answer,
    goal: "everyday",
  });
  let reading:
    ReturnType<ReturnType<typeof assignmentReadinessStore>["list"]> | undefined;
  try {
    await pause.reached.wait;
    reading = assignmentReadinessStore(pool).list(owner.token);
    expect(await blocked("SELECT id FROM workspaces")).toBe(true);
    pause.resume.release();
    expect(await saving).toBe("saved");
    expect(await reading).toEqual([]);
  } finally {
    pause.resume.release();
    await Promise.allSettled([saving, ...(reading ? [reading] : [])]);
  }
});
it("rolls back a save when authorization expires while it waits for the workspace", async () => {
  const owner = await member(),
    blocker = await pool.connect();
  let saving: Promise<string> | undefined;
  const expiry = new Date(Date.now() + 250);
  try {
    await pool.query("UPDATE principals SET expires_at=$2 WHERE id=$1", [
      owner.id,
      expiry,
    ]);
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
      owner.id,
    ]);
    saving = db.save(owner.id, { ...answer, goal: "everyday" });
    expect(await blocked("SELECT id FROM workspaces")).toBe(true);
    await pool.query(
      "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.02)",
      [expiry],
    );
    await blocker.query("COMMIT");
    expect(await saving).toBe("unavailable");
    expect(
      (
        await pool.query("SELECT count(*) FROM exercises WHERE learner_id=$1", [
          owner.id,
        ])
      ).rows[0].count,
    ).toBe("0");
  } finally {
    await blocker.query("ROLLBACK");
    await Promise.allSettled(saving ? [saving] : []);
    blocker.release();
  }
});
it("finishes a save before waiting account deletion then removes every goal slot", async () => {
  const owner = await member(),
    pause = pausedStore("INSERT INTO exercises");
  const saving = pause.controlled.save(owner.id, {
    ...answer,
    goal: "everyday",
  });
  let deletion: Promise<void> | undefined;
  try {
    await pause.reached.wait;
    deletion = db.remove(owner.id);
    expect(await blocked("DELETE FROM principals")).toBe(true);
    pause.resume.release();
    expect(await saving).toBe("saved");
    await deletion;
    expect(await db.withExerciseRead(owner.token, (rows) => rows)).toBeNull();
    expect(
      (
        await pool.query("SELECT count(*) FROM exercises WHERE learner_id=$1", [
          owner.id,
        ])
      ).rows[0].count,
    ).toBe("0");
  } finally {
    pause.resume.release();
    await Promise.allSettled([saving, ...(deletion ? [deletion] : [])]);
  }
});
