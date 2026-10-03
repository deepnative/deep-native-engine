import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { circleStore } from "../../src/circles.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
const members = store(pool);
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
afterAll(async () => pool.end());

async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  return { token, id: session.learner.id };
}
async function choice(owner: { token: string; id: string }) {
  expect(await circleStore(pool).join(owner.token, "everyday-ai")).toBe(
    "joined",
  );
  const id = randomUUID();
  await pool.query(
    `INSERT INTO preview_circle_choices(id,member_id,workspace_id,circle_id,generation,policy_version,pseudonym,idempotency_key)
    VALUES($1,$2,$2,'everyday-ai',1,'circle-discussion-test-v1',$3,$4)`,
    [id, owner.id, "Peer " + randomBytes(8).toString("hex"), randomUUID()],
  );
  return id;
}
async function post(
  owner: { id: string },
  choiceId: string,
  body: string,
  rootId: string | null = null,
) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO preview_circle_posts(id,member_id,workspace_id,circle_id,choice_id,root_id,body,idempotency_key,fingerprint)
    VALUES($1,$2,$2,'everyday-ai',$3,$4,$5,$6,$7)`,
    [id, owner.id, choiceId, rootId, body, randomUUID(), "a".repeat(64)],
  );
  return id;
}

it("upgrades populated legacy membership twice without inferring a discussion permission or staff scope", async () => {
  const schema = "legacy_circle_" + randomUUID().replaceAll("-", "");
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const directory = new URL("../../migrations/", import.meta.url);
    for (const file of (await readdir(directory))
      .filter(
        (name) =>
          /^\d{3}-.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 54,
      )
      .sort())
      await client.query(await readFile(new URL(file, directory), "utf8"));
    const scoped = {
      query: client.query.bind(client),
      async connect() {
        return { query: client.query.bind(client), release() {} };
      },
    } as unknown as Pool;
    const token = randomBytes(32).toString("hex");
    await store(scoped).create(token, {
      background: "professional",
      goal: "work",
    });
    const session = await store(scoped).session(token);
    if (session.kind !== "active") throw Error("Legacy fixture unavailable");
    await client.query(
      "INSERT INTO preview_circle_memberships(circle_id,member_id,left_at) VALUES('professional-work',$1,clock_timestamp())",
      [session.learner.id],
    );
    const before = (
      await client.query(
        "SELECT circle_id,member_id,joined_at,left_at FROM preview_circle_memberships",
      )
    ).rows;
    const migration = await readFile(
      new URL("055-circle-discussion.sql", directory),
      "utf8",
    );
    await client.query(migration);
    await client.query(migration);
    expect(
      (
        await client.query(
          "SELECT circle_id,member_id,joined_at,left_at FROM preview_circle_memberships",
        )
      ).rows,
    ).toEqual(before);
    expect(
      (await client.query("SELECT generation FROM preview_circle_memberships"))
        .rows,
    ).toEqual([{ generation: "1" }]);
    expect(
      (
        await client.query(
          "SELECT circle_id,member_id,joined_at,left_at FROM preview_circle_membership_history",
        )
      ).rows,
    ).toEqual(before);
    for (const table of [
      "preview_circle_choices",
      "preview_circle_posts",
      "preview_circle_reports",
      "preview_circle_moderator_grants",
      "preview_circle_grant_audit",
      "preview_circle_moderation_audit",
    ])
      expect(
        (await client.query(`SELECT count(*)::integer n FROM ${table}`)).rows,
      ).toEqual([{ n: 0 }]);
  } finally {
    await client.query("ROLLBACK");
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    client.release();
  }
});

it("advances only a genuine rejoin generation and leaves old consent pinned to its original generation", async () => {
  const a = await member();
  const id = await choice(a);
  expect(await circleStore(pool).join(a.token, "everyday-ai")).toBe("joined");
  expect(
    (
      await pool.query(
        "SELECT generation FROM preview_circle_memberships WHERE member_id=$1",
        [a.id],
      )
    ).rows,
  ).toEqual([{ generation: "1" }]);
  expect(await circleStore(pool).leave(a.token, "everyday-ai")).toBe(true);
  expect(await circleStore(pool).join(a.token, "everyday-ai")).toBe("joined");
  expect(
    (
      await pool.query(
        "SELECT generation FROM preview_circle_memberships WHERE member_id=$1",
        [a.id],
      )
    ).rows,
  ).toEqual([{ generation: "2" }]);
  expect(
    (
      await pool.query(
        "SELECT generation,revoked_at FROM preview_circle_choices WHERE id=$1",
        [id],
      )
    ).rows,
  ).toEqual([{ generation: "1", revoked_at: null }]);
});

it("erases root-author text and owned audit while preserving the other author's independent reply and report receipt", async () => {
  const a = await member(),
    b = await member();
  const ac = await choice(a),
    bc = await choice(b);
  const root = await post(a, ac, "Invented root-owner private text");
  const reply = await post(
    b,
    bc,
    "Invented peer independently owned text",
    root,
  );
  await pool.query(
    `INSERT INTO preview_circle_reports(id,member_id,workspace_id,circle_id,target_id,category,idempotency_key)
 VALUES($1,$2,$2,'everyday-ai',$3,'privacy',$4)`,
    [randomUUID(), b.id, root, randomUUID()],
  );
  await pool.query(
    "UPDATE preview_circle_posts SET state='hidden',revision=2,changed_at=clock_timestamp() WHERE id=$1",
    [root],
  );
  await pool.query(
    `INSERT INTO preview_circle_moderation_audit(actor_id,actor_role,member_id,workspace_id,circle_id,post_id,action,reason,old_revision,new_revision,idempotency_key,fingerprint)
 VALUES($1,'moderator',$2,$2,'everyday-ai',$3,'hidden','privacy',1,2,$4,$5)`,
    [randomUUID(), a.id, root, randomUUID(), "b".repeat(64)],
  );
  await expect(
    pool.query("DELETE FROM preview_circle_posts WHERE id=$1", [root]),
  ).rejects.toThrow("owner erasure");
  await members.remove(a.id);
  expect(
    (
      await pool.query(
        "SELECT id FROM preview_circle_posts WHERE member_id=$1",
        [a.id],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT id FROM preview_circle_choices WHERE member_id=$1",
        [a.id],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT id FROM preview_circle_moderation_audit WHERE member_id=$1",
        [a.id],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT id,body,root_id FROM preview_circle_posts WHERE member_id=$1",
        [b.id],
      )
    ).rows,
  ).toEqual([
    {
      id: reply,
      body: "Invented peer independently owned text",
      root_id: root,
    },
  ]);
  expect(
    (
      await pool.query(
        "SELECT category,target_id FROM preview_circle_reports WHERE member_id=$1",
        [b.id],
      )
    ).rows,
  ).toEqual([{ category: "privacy", target_id: root }]);
  await members.remove(b.id);
  expect(
    (await pool.query("SELECT id FROM preview_circle_posts")).rows,
  ).toEqual([]);
  expect(
    (await pool.query("SELECT id FROM preview_circle_reports")).rows,
  ).toEqual([]);
});

it("rejects the 201st retained item without permitting withdrawal to pad the storage allowance", async () => {
  const a = await member(),
    c = await choice(a);
  for (let n = 0; n < 200; n++) await post(a, c, `Invented question ${n}`);
  await pool.query(
    `UPDATE preview_circle_posts SET state='withdrawn',body=NULL,fingerprint=NULL,
    withdrawn_at=clock_timestamp(),changed_at=clock_timestamp(),revision=2
    WHERE id IN (SELECT id FROM preview_circle_posts WHERE member_id=$1 ORDER BY id LIMIT 20)`,
    [a.id],
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM preview_circle_posts WHERE member_id=$1 AND state='withdrawn'",
        [a.id],
      )
    ).rows,
  ).toEqual([{ n: 20 }]);
  await expect(
    post(a, c, "Item beyond the hard fixture bound"),
  ).rejects.toThrow();
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM preview_circle_posts WHERE member_id=$1",
        [a.id],
      )
    ).rows,
  ).toEqual([{ n: 200 }]);
});

it("rejects the 101st retained reply on one root across independently owned posts", async () => {
  const a = await member(),
    b = await member(),
    ac = await choice(a),
    bc = await choice(b);
  const root = await post(a, ac, "Invented bounded question");
  for (let n = 0; n < 100; n++) await post(b, bc, `Invented reply ${n}`, root);
  await expect(
    post(b, bc, "Reply beyond the root bound", root),
  ).rejects.toThrow();
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM preview_circle_posts WHERE root_id=$1",
        [root],
      )
    ).rows,
  ).toEqual([{ n: 100 }]);
});

it("rejects new replies to unavailable historical references and nested replies without deleting independent old reply history", async () => {
  const a = await member(),
    b = await member(),
    ac = await choice(a),
    bc = await choice(b);
  const root = await post(a, ac, "Invented root");
  const reply = await post(b, bc, "Independent peer reply", root);
  await expect(post(b, bc, "Invalid nested reply", reply)).rejects.toThrow();
  await members.remove(a.id);
  await expect(
    post(b, bc, "New reply to missing root", root),
  ).rejects.toThrow();
  expect(
    (
      await pool.query(
        "SELECT id,body FROM preview_circle_posts WHERE member_id=$1",
        [b.id],
      )
    ).rows,
  ).toEqual([{ id: reply, body: "Independent peer reply" }]);
});
