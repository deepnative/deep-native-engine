import { beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { migrate, store, hash, type Learner } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  db = store(pool);
const input = {
  instruction: "Use the provided sample to make a plan.",
  verification: "Compare the plan with the original details.",
  complete: true,
};
beforeAll(async () => {
  await migrate(pool);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE learners CASCADE");
});
afterAll(async () => {
  await pool.end();
});
async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  expect(session.kind).toBe("active");
  return {
    token,
    learner: (session as { kind: "active"; learner: Learner }).learner,
  };
}
it("persists drafts and completions across independent database connections and migrations", async () => {
  const { learner, token } = await member();
  await db.save(learner.id, { ...input, complete: false });
  const reopened = testPool();
  try {
    expect(await store(reopened).progress(learner.id)).toMatchObject({
      instruction: input.instruction,
      completed_at: null,
    });
    await db.save(learner.id, input);
    expect(
      (await store(reopened).progress(learner.id))?.completed_at,
    ).toBeInstanceOf(Date);
    expect(
      (await pool.query("SELECT token_hash FROM learners")).rows[0].token_hash,
    ).toBe(hash(token));
    await migrate(pool);
    expect((await db.progress(learner.id))?.instruction).toBe(
      input.instruction,
    );
  } finally {
    await reopened.end();
  }
});
it("makes duplicate onboarding and simultaneous completion idempotent without cross-member writes", async () => {
  const { learner, token } = await member();
  await Promise.all([
    db.create(token, { background: "technical", goal: "build" }),
    db.create(token, { background: "professional", goal: "work" }),
  ]);
  expect(
    (await pool.query("SELECT count(*) FROM learners")).rows[0].count,
  ).toBe("1");
  const alternative = {
    instruction: "Alternative useful instruction with details.",
    verification: "Alternative way of checking the result.",
    complete: true,
  };
  await Promise.all([
    db.save(learner.id, input),
    db.save(learner.id, alternative),
  ]);
  const saved = await db.progress(learner.id);
  expect([input.instruction, alternative.instruction]).toContain(
    saved?.instruction,
  );
  expect(saved?.verification).toBe(
    saved?.instruction === input.instruction
      ? input.verification
      : alternative.verification,
  );
  await db.save(learner.id, { ...alternative, complete: false });
  await db.save(learner.id, alternative);
  expect(await db.progress(learner.id)).toEqual(saved);
  expect(
    (await pool.query("SELECT count(*) FROM exercises")).rows[0].count,
  ).toBe("1");
  const other = await member();
  expect(await db.progress(other.learner.id)).toBeUndefined();
});
it("keeps concurrent draft/completion coherent and complete", async () => {
  const { learner } = await member();
  await Promise.all([
    db.save(learner.id, {
      instruction: "unfinished",
      verification: "draft",
      complete: false,
    }),
    db.save(learner.id, input),
  ]);
  expect(await db.progress(learner.id)).toMatchObject({
    instruction: input.instruction,
    verification: input.verification,
    completed_at: expect.any(Date),
  });
});
it("enforces expiry and deletion including cascaded exercise records", async () => {
  const { learner, token } = await member();
  await db.save(learner.id, input);
  await pool.query(
    "UPDATE learners SET expires_at=CURRENT_TIMESTAMP WHERE id=$1",
    [learner.id],
  );
  expect(await db.session(token)).toEqual({ kind: "expired" });
  await db.remove(learner.id);
  expect(await db.session(token)).toEqual({ kind: "new" });
  expect(
    (await pool.query("SELECT count(*) FROM exercises")).rows[0].count,
  ).toBe("0");
});
it("enforces relational constraints and parameterizes hostile content", async () => {
  const { learner } = await member();
  await expect(
    pool.query("UPDATE learners SET background='admin' WHERE id=$1", [
      learner.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    db.save(randomBytes(16).toString("hex"), input),
  ).rejects.toThrow();
  await expect(
    db.save(learner.id, { ...input, instruction: "a".repeat(2001) }),
  ).rejects.toMatchObject({ code: "23514" });
  const hostile = "'; DROP TABLE learners;-- <script>alert(1)</script>";
  await db.save(learner.id, { ...input, instruction: hostile });
  expect((await db.progress(learner.id))?.instruction).toBe(hostile);
  expect(
    (await pool.query("SELECT count(*) FROM learners")).rows[0].count,
  ).toBe("1");
});
