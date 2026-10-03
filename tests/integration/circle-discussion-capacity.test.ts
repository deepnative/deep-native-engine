import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { circleStore } from "../../src/circles.ts";
import {
  circleDiscussionStore,
  CIRCLE_DISCUSSION_POLICY,
} from "../../src/circle-discussion.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  circles = circleStore(pool);
const discussion = circleDiscussionStore(pool, "invented-capacity-secret");
const circle = "everyday-ai";
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
});
afterAll(async () => pool.end());
async function participant() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active")
    throw Error("Invented participant unavailable");
  expect(await circles.join(token, circle)).toBe("joined");
  const selected = await discussion.choose(
    token,
    circle,
    randomUUID(),
    "1",
    CIRCLE_DISCUSSION_POLICY,
    true,
  );
  if (selected.kind !== "ready")
    throw Error("Invented sharing choice unavailable");
  return { token, id: session.learner.id, choice: selected.value.id };
}
async function fill(
  owner: Awaited<ReturnType<typeof participant>>,
  count: number,
  root: string | null = null,
) {
  // Seed retained historical records through the same database constraints. The
  // competing final-slot operations below use public store methods and separate
  // real PostgreSQL connections, rather than a simulated count observation.
  await pool.query(
    `INSERT INTO preview_circle_posts(id,member_id,workspace_id,circle_id,choice_id,root_id,body,idempotency_key,fingerprint)
    SELECT gen_random_uuid(),$1,$1,$2,$3,$4,'Invented retained capacity record',gen_random_uuid(),$5 FROM generate_series(1,$6::integer)`,
    [owner.id, circle, owner.choice, root, "a".repeat(64), count],
  );
}
it("admits exactly one concurrent owner final-slot post and keeps withdrawals counted", async () => {
  const owner = await participant();
  await fill(owner, 199);
  const results = await Promise.all([
    discussion.post(
      owner.token,
      circle,
      randomUUID(),
      "Invented competing question A",
      true,
    ),
    discussion.post(
      owner.token,
      circle,
      randomUUID(),
      "Invented competing question B",
      true,
    ),
  ]);
  expect(results.map((r) => r.kind).sort()).toEqual(["limit", "ready"]);
  const winner = results.find((r) => r.kind === "ready");
  if (!winner || winner.kind !== "ready")
    throw Error("Expected one admitted post");
  expect(
    Number(
      (
        await pool.query(
          "SELECT count(*) n FROM preview_circle_posts WHERE member_id=$1",
          [owner.id],
        )
      ).rows[0].n,
    ),
  ).toBe(200);
  expect(
    await discussion.withdraw(owner.token, circle, winner.value.id, true),
  ).toEqual({ kind: "ready", value: { id: winner.value.id } });
  expect(
    await discussion.post(
      owner.token,
      circle,
      randomUUID(),
      "Invented post after withdrawal",
      true,
    ),
  ).toEqual({ kind: "limit" });
  expect(
    (
      await pool.query(
        "SELECT body,state FROM preview_circle_posts WHERE id=$1",
        [winner.value.id],
      )
    ).rows,
  ).toEqual([{ body: null, state: "withdrawn" }]);
});
it("admits exactly one concurrent root final-slot reply without freeing a withdrawn reply", async () => {
  const author = await participant(),
    peer = await participant();
  const root = await discussion.post(
    author.token,
    circle,
    randomUUID(),
    "Invented root question",
    true,
  );
  if (root.kind !== "ready") throw Error("Invented root unavailable");
  await fill(peer, 99, root.value.id);
  const results = await Promise.all([
    discussion.post(
      peer.token,
      circle,
      randomUUID(),
      "Invented competing reply A",
      true,
      root.value.id,
    ),
    discussion.post(
      peer.token,
      circle,
      randomUUID(),
      "Invented competing reply B",
      true,
      root.value.id,
    ),
  ]);
  expect(results.map((r) => r.kind).sort()).toEqual(["limit", "ready"]);
  const winner = results.find((r) => r.kind === "ready");
  if (!winner || winner.kind !== "ready")
    throw Error("Expected one admitted reply");
  expect(
    Number(
      (
        await pool.query(
          "SELECT count(*) n FROM preview_circle_posts WHERE root_id=$1",
          [root.value.id],
        )
      ).rows[0].n,
    ),
  ).toBe(100);
  expect(
    await discussion.withdraw(peer.token, circle, winner.value.id, true),
  ).toEqual({ kind: "ready", value: { id: winner.value.id } });
  expect(
    await discussion.post(
      peer.token,
      circle,
      randomUUID(),
      "Invented reply after withdrawal",
      true,
      root.value.id,
    ),
  ).toEqual({ kind: "limit" });
});
