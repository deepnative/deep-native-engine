import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

const pool = testPool();
const db = store(pool);
const origin = "http://127.0.0.1:3000";
const secret = "synthetic-exercise-recovery-secret";
const prior = {
  instruction: "Use invented notes to make a two-step plan.",
  verification: "Compare the plan with the invented notes.",
  complete: false,
};
const attempted = {
  instruction:
    "Revise the invented plan with <script>bad()</script> and a clear next step.",
  verification: "Check each revised step against the invented source notes.",
  intent: "complete",
  checked: "yes",
};

beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals, cohorts CASCADE"));
afterAll(async () => pool.end());

async function fixture() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member unavailable");
  await db.save(session.learner.id, prior);
  return { token, id: session.learner.id };
}

function postExercise(token: string, save: typeof db.save) {
  return withLoopback(app({ ...db, save }, { origin, secret }), (server) =>
    request(server)
      .post("/exercise")
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({
        ...attempted,
        csrf: csrf(token, secret),
        lesson_id: "clear-instructions",
        lesson_version: "1",
      }),
  );
}

async function savedRow(id: string) {
  const result = await pool.query<{
    instruction: string;
    verification: string;
    completed_at: Date | null;
  }>(
    "SELECT instruction, verification, completed_at FROM exercises WHERE learner_id=$1",
    [id],
  );
  return result.rows;
}

it("keeps attempted text available when save rejects before commit", async () => {
  const { token, id } = await fixture();
  const save: typeof db.save = async () => {
    throw new Error("Synthetic write fault before commit");
  };

  const response = await postExercise(token, save);
  expect(response.status).toBe(503);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.text).toContain("Save outcome unknown");
  expect(response.text).toContain("Attempted instruction");
  expect(response.text).toContain("Attempted way to check");
  expect(response.text).toContain("&lt;script&gt;bad()&lt;/script&gt;");
  expect(response.text).toContain('href="/lesson"');
  expect(response.text).not.toContain("Your draft is saved");
  expect(response.text).not.toContain("Synthetic write fault");
  expect(await savedRow(id)).toMatchObject([
    {
      instruction: prior.instruction,
      verification: prior.verification,
      completed_at: null,
    },
  ]);
});

it("does not claim rollback when commit succeeds but acknowledgement fails", async () => {
  const { token, id } = await fixture();
  const save: typeof db.save = async (memberId, input) => {
    await db.save(memberId, input);
    throw new Error("Synthetic acknowledgement fault after commit");
  };

  const response = await postExercise(token, save);
  expect(response.status).toBe(503);
  expect(response.text).toContain("Save outcome unknown");
  expect(response.text).toContain("Inspect saved lesson");
  expect(response.text).not.toContain("Your draft is saved");
  expect(response.text).not.toContain("Synthetic acknowledgement fault");
  expect(await savedRow(id)).toMatchObject([
    {
      instruction: attempted.instruction,
      verification: attempted.verification,
      completed_at: expect.any(Date),
    },
  ]);

  const inspect = await withLoopback(app(db, { origin, secret }), (server) =>
    request(server)
      .get("/lesson")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
  expect(inspect.status).toBe(200);
  expect(inspect.text).toContain("Revise the invented plan");
  expect(inspect.text).toContain("completed");
});
