import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  memberExportStore,
  MAX_MEMBER_EXPORT_BYTES,
  MAX_MEMBER_EXPORT_RECORDS,
} from "../../src/member-export.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const members = store(pool);
const exports = memberExportStore(pool);
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Synthetic member unavailable");
  return { token, id: session.learner.id };
}
async function proposals(id: string, count: number, text: string) {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const key = randomUUID();
    ids.push(key);
    await pool.query(
      `INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at)
      VALUES($1,$2,'Invented proposal',$3,'Original',CURRENT_TIMESTAMP)`,
      [key, id, text],
    );
  }
  return ids.sort();
}

it.each([
  [205, "Invented sample"],
  [80, 'é\\"'.repeat(1000)],
])(
  "retrieves all %i retained records across bounded live pages without omissions or duplicates",
  async (count, text) => {
    const owner = await member();
    const expected = await proposals(owner.id, Number(count), String(text));
    const found: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await exports.exportOwned(owner.token, cursor);
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") throw Error("Owner page unavailable");
      const payload = result.payload;
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(
        MAX_MEMBER_EXPORT_BYTES,
      );
      expect(payload.page.recordCount).toBeLessThanOrEqual(
        MAX_MEMBER_EXPORT_RECORDS,
      );
      expect(payload.page.consistency).toBe("live-pages");
      expect(payload.page.complete).toBe(payload.page.nextCursor === null);
      found.push(...payload.records.proposals!.map((row) => String(row.id)));
      cursor = payload.page.nextCursor ?? undefined;
      expect(++pages).toBeLessThan(10);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(found).toEqual(expected);
    expect(new Set(found).size).toBe(expected.length);
  },
);

async function firstCursor(token: string, exporter = exports) {
  const result = await exporter.exportOwned(token);
  if (result.kind !== "ready" || !result.payload.page.nextCursor)
    throw Error("Synthetic continuation unavailable");
  return result.payload.page.nextCursor;
}
async function exercises(id: string, count: number) {
  await pool.query(
    `INSERT INTO exercises(learner_id,workspace_id,lesson_id,lesson_version,instruction,verification)
    SELECT $1,$1,'synthetic-'||n,1,'Invented instruction','Invented check' FROM generate_series(1,$2) AS n`,
    [id, count],
  );
}
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function controlled(secret: Buffer, trigger: string) {
  const reached = gate(),
    resume = gate();
  const state = { pause: false, pid: 0 };
  const wrapper = {
    connect: async () => {
      const client = await pool.connect();
      state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (state.pause && sql.includes(trigger)) {
            reached.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as import("pg").Pool;
  return {
    exporter: memberExportStore(wrapper, secret),
    state,
    reached,
    resume,
  };
}
async function blocked(waiting: number, blocker: number) {
  const until = performance.now() + 3000;
  while (performance.now() < until) {
    if (
      (
        await pool.query(
          "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
          [blocker, waiting],
        )
      ).rows[0].blocked
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected database lock wait was not observed");
}

it("rechecks owner, revocation, deletion markers, expiry and cursor integrity on continuation", async () => {
  const owner = await member(),
    other = await member();
  await proposals(owner.id, 101, "Invented private page text");
  const cursor = await firstCursor(owner.token);
  expect(await exports.exportOwned(other.token, cursor)).toEqual({
    kind: "denied",
  });
  expect(await exports.exportOwned(owner.token, `${cursor}x`)).toEqual({
    kind: "denied",
  });
  expect(
    await memberExportStore(pool).exportOwned(owner.token, cursor),
  ).toEqual({ kind: "denied" });
  for (const [deny, restore] of [
    [
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      "UPDATE principals SET revoked_at=NULL WHERE id=$1",
    ],
    [
      "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
      "UPDATE workspaces SET deleting_at=NULL WHERE owner_principal_id=$1",
    ],
    [
      "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
    ],
  ]) {
    await pool.query(deny!, [owner.id]);
    expect(await exports.exportOwned(owner.token, cursor)).toEqual({
      kind: "denied",
    });
    await pool.query(restore!, [owner.id]);
  }
  expect(await exports.exportOwned(owner.token, cursor)).toMatchObject({
    kind: "ready",
    payload: { page: { number: 2, complete: true } },
  });
  await members.remove(owner.id);
  expect(await exports.exportOwned(owner.token, cursor)).toEqual({
    kind: "denied",
  });
});

it("reads current redaction and does not skip remaining keys when earlier records disappear", async () => {
  const owner = await member();
  const ids = await proposals(
    owner.id,
    102,
    "Invented private withdrawn page text",
  );
  const cursor = await firstCursor(owner.token);
  await pool.query("DELETE FROM member_proposals WHERE id=$1", [ids[0]]);
  await pool.query(
    "UPDATE member_proposals SET state='withdrawn',title=NULL,body=NULL,sources=NULL,withdrawn_at=clock_timestamp() WHERE id=$1",
    [ids[100]],
  );
  const result = await exports.exportOwned(owner.token, cursor);
  expect(result).toMatchObject({
    kind: "ready",
    payload: {
      records: {
        proposals: [
          { id: ids[100], body: null, state: "withdrawn" },
          { id: ids[101], body: "Invented private withdrawn page text" },
        ],
      },
      page: { complete: true },
    },
  });
});

it("uses the same key order for mixed text identifiers and composite numeric versions", async () => {
  const owner = await member();
  const keys = ["A", "a", "AA", "aa", "Z", "z", "x-2", "x-10", "é", "中"];
  for (const id of keys)
    for (let version = 1; version <= 12; version++)
      await pool.query(
        `INSERT INTO exercises(learner_id,workspace_id,lesson_id,lesson_version,instruction,verification)
    VALUES($1,$1,$2,$3,'Invented instruction','Invented check')`,
        [owner.id, id, version],
      );
  const expected = (
    await pool.query(
      `SELECT lesson_id AS id,lesson_version AS version FROM exercises WHERE learner_id=$1 ORDER BY jsonb_build_array(lesson_id,lesson_version)`,
      [owner.id],
    )
  ).rows;
  const found: unknown[] = [];
  let cursor: string | undefined;
  do {
    const result = await exports.exportOwned(owner.token, cursor);
    if (result.kind !== "ready") throw Error("Missing page");
    found.push(
      ...result.payload.records.exercises!.map((row) => ({
        id: row.lessonId,
        version: row.lessonVersion,
      })),
    );
    cursor = result.payload.page.nextCursor ?? undefined;
  } while (cursor);
  expect(found).toEqual(expected);
  expect(found).toHaveLength(120);
});

it.each([
  "learning_milestones",
  "career_entries",
  "career_drafts",
  "member_proposals",
])(
  "withholds a resumed %s page when deletion commits after its snapshot",
  async (table) => {
    const owner = await member();
    await exercises(owner.id, table.startsWith("career") ? 98 : 99);
    const ids = [randomUUID(), randomUUID()].sort();
    if (table.startsWith("career"))
      await pool.query("INSERT INTO career_preferences(member_id) VALUES($1)", [
        owner.id,
      ]);
    for (const id of ids) {
      if (table === "learning_milestones")
        await pool.query(
          "INSERT INTO learning_milestones(id,member_id,goal_title,milestone_title,next_action) VALUES($1,$2,'Invented goal','Private pending milestone','Invented action')",
          [id, owner.id],
        );
      if (table === "career_entries")
        await pool.query(
          "INSERT INTO career_entries(id,member_id,kind,title,note,next_action) VALUES($1,$2,'career','Invented title','Private pending career note','Invented action')",
          [id, owner.id],
        );
      if (table === "career_drafts")
        await pool.query(
          "INSERT INTO career_drafts(id,member_id,kind,title,body) VALUES($1,$2,'professional','Invented title','Private pending career draft body')",
          [id, owner.id],
        );
      if (table === "member_proposals")
        await pool.query(
          "INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at) VALUES($1,$2,'Invented title','Private pending proposal','Original',clock_timestamp())",
          [id, owner.id],
        );
    }
    const secret = randomBytes(32),
      current = controlled(secret, "FROM principals p JOIN learners l");
    const cursor = await firstCursor(owner.token, current.exporter);
    current.state.pause = true;
    const reading = current.exporter.exportOwned(owner.token, cursor);
    try {
      await current.reached.wait;
      await pool.query(`DELETE FROM ${table} WHERE id=$1`, [ids[1]]);
      current.resume.release();
      expect(await reading).toEqual({ kind: "unavailable" });
      const fresh = await memberExportStore(pool, secret).exportOwned(
        owner.token,
        cursor,
      );
      expect(fresh).toMatchObject({
        kind: "ready",
        payload: { page: { complete: true, recordCount: 0 } },
      });
    } finally {
      current.resume.release();
      await Promise.allSettled([reading]);
    }
  },
);

it("serializes a resumed text page before deletion if export locks it first", async () => {
  const owner = await member();
  await exercises(owner.id, 99);
  const ids = [randomUUID(), randomUUID()].sort();
  for (const id of ids)
    await pool.query(
      "INSERT INTO learning_milestones(id,member_id,goal_title,milestone_title,next_action) VALUES($1,$2,'Invented goal','Private retained milestone','Invented action')",
      [id, owner.id],
    );
  const current = controlled(randomBytes(32), "FROM learning_milestones");
  const cursor = await firstCursor(owner.token, current.exporter);
  current.state.pause = true;
  const reading = current.exporter.exportOwned(owner.token, cursor);
  const writer = await pool.connect();
  let writing: Promise<unknown> | undefined;
  try {
    await current.reached.wait;
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    writing = writer.query("DELETE FROM learning_milestones WHERE id=$1", [
      ids[1],
    ]);
    await blocked(pid, current.state.pid);
    current.resume.release();
    expect(await reading).toMatchObject({
      kind: "ready",
      payload: { records: { milestones: [{ id: ids[1] }] } },
    });
    await writing;
  } finally {
    current.resume.release();
    await Promise.allSettled([reading, ...(writing ? [writing] : [])]);
    writer.release();
  }
});
