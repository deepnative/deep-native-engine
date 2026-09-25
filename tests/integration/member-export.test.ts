import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  memberExportStore,
  MAX_MEMBER_EXPORT_RECORDS,
} from "../../src/member-export.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const exported = memberExportStore(pool);
const token = () => randomBytes(32).toString("hex");
const ready = async (value: string) => {
  const result = await exported.exportOwned(value);
  expect(result.kind).toBe("ready");
  return result.kind === "ready" ? result.payload : {};
};
const member = async () => {
  const value = token();
  await db.create(value, { background: "explorer", goal: "everyday" });
  const session = await db.session(value);
  expect(session.kind).toBe("active");
  return {
    token: value,
    id: session.kind === "active" ? session.learner.id : "",
  };
};

beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(async () => pool.end());

it("exports current structured records only for their active owner, with redaction and deletion", async () => {
  const a = await member();
  const b = await member();
  await pool.query(
    `INSERT INTO learning_milestones(id,member_id,goal_title,milestone_title,next_action)
     VALUES($1,$2,'Invented goal','Invented milestone','Review next step')`,
    [randomUUID(), a.id],
  );
  await pool.query(
    `INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at)
     VALUES($1,$2,'Private idea','Invented proposal text','Original',CURRENT_TIMESTAMP)`,
    [randomUUID(), a.id],
  );
  await pool.query(
    `INSERT INTO member_proposals(id,member_id,title,body,sources,state,
       sample_attested_at,withdrawn_at)
     VALUES($1,$2,NULL,NULL,NULL,'withdrawn',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [randomUUID(), a.id],
  );
  const own = await ready(a.token);
  expect(own).toMatchObject({
    version: "local-member-records-v1",
    profile: { id: a.id, background: "explorer" },
    records: {
      milestones: [{ milestoneTitle: "Invented milestone" }],
    },
  });
  expect(
    (own.records as { proposals: { body: string | null }[] }).proposals,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ body: "Invented proposal text" }),
    ]),
  );
  expect(JSON.stringify(own)).not.toContain("token_hash");
  const other = await ready(b.token);
  expect(other).toMatchObject({ records: { milestones: [], proposals: [] } });
  expect(JSON.stringify(other)).not.toContain("Invented milestone");
  expect(await exported.exportOwned(token())).toEqual({ kind: "denied" });
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1",
    [a.id],
  );
  expect(await exported.exportOwned(a.token)).toEqual({ kind: "denied" });
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP+INTERVAL '1 day' WHERE id=$1",
    [a.id],
  );
  await pool.query(
    "UPDATE member_proposals SET state='withdrawn',title=NULL,body=NULL,sources=NULL,withdrawn_at=CURRENT_TIMESTAMP WHERE member_id=$1",
    [a.id],
  );
  await pool.query("DELETE FROM learning_milestones WHERE member_id=$1", [
    a.id,
  ]);
  const after = await ready(a.token);
  expect(after).toMatchObject({ records: { milestones: [] } });
  expect(
    (after.records as { proposals: { body: string | null }[] }).proposals,
  ).toHaveLength(2);
  expect(
    (after.records as { proposals: { body: string | null }[] }).proposals,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ body: null })]));
  expect(JSON.stringify(after)).not.toContain("Invented proposal text");
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [a.id],
  );
  expect(await exported.exportOwned(a.token)).toEqual({ kind: "denied" });
});

it("fails closed at record and byte limits without returning a partial snapshot", async () => {
  const a = await member();
  for (let i = 0; i <= MAX_MEMBER_EXPORT_RECORDS; i++) {
    await pool.query(
      `INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at)
       VALUES($1,$2,$3,'Invented sample','Original',CURRENT_TIMESTAMP)`,
      [randomUUID(), a.id, `Idea ${i}`],
    );
  }
  expect(await exported.exportOwned(a.token)).toEqual({ kind: "limit" });
  await pool.query("DELETE FROM member_proposals WHERE member_id=$1", [a.id]);
  for (let i = 0; i < 70; i++) {
    await pool.query(
      `INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at)
       VALUES($1,$2,$3,$4,'Original',CURRENT_TIMESTAMP)`,
      [randomUUID(), a.id, `Idea ${i}`, `${i}${"x".repeat(3990)}`],
    );
  }
  expect(await exported.exportOwned(a.token)).toEqual({ kind: "limit" });
});

it("keeps one repeatable-read snapshot when another connection changes a record mid-export", async () => {
  const a = await member();
  const id = randomUUID();
  await pool.query(
    `INSERT INTO learning_milestones(id,member_id,goal_title,milestone_title,next_action)
     VALUES($1,$2,'Original goal','Original milestone','Original next action')`,
    [id, a.id],
  );
  const wrapper = {
    connect: async () => {
      const client = await pool.connect();
      let changed = false;
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (!changed && sql.includes("FROM principals p JOIN learners l")) {
            changed = true;
            await pool.query(
              "UPDATE learning_milestones SET milestone_title='Later milestone' WHERE id=$1",
              [id],
            );
          }
          return result;
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool;
  const result = await memberExportStore(wrapper).exportOwned(a.token);
  expect(result).toMatchObject({
    kind: "ready",
    payload: {
      records: { milestones: [{ milestoneTitle: "Original milestone" }] },
    },
  });
  expect((await ready(a.token)).records).toMatchObject({
    milestones: [{ milestoneTitle: "Later milestone" }],
  });
});

it("returns unavailable on database failure without exposing query or member data", async () => {
  const bad = memberExportStore({
    connect: async () => {
      throw new Error("private db details");
    },
  } as unknown as Pool);
  expect(await bad.exportOwned(token())).toEqual({ kind: "unavailable" });
});
