import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import request from "supertest";
import { app } from "../../src/app.ts";
import { LESSON, type Goal } from "../../src/content.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";

const pool = testPool();
const members = store(pool);
const origin = "http://127.0.0.1:3000";
const secret = "guided-native-test";
const owned: string[] = [];
const servers: Server[] = [];
beforeAll(() => migrate(pool));
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeLoopback));
  for (const id of owned.splice(0))
    await pool.query("DELETE FROM principals WHERE id=$1", [id]);
});
afterAll(() => pool.end());

async function member(goal: Goal) {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Synthetic member unavailable");
  owned.push(session.learner.id);
  return { token, id: session.learner.id };
}
async function fixture(goal: Goal = "everyday") {
  const owner = await member(goal);
  const server = await listenLoopback(app(members, { origin, secret }));
  servers.push(server);
  return {
    owner,
    get: (path: string, token = owner.token) =>
      request(server)
        .get(path)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${token}`),
    post: (path: string, fields: Record<string, string>, token = owner.token) =>
      request(server)
        .post(path)
        .set("Host", "127.0.0.1:3000")
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${token}`)
        .type("form")
        .send({ ...fields, csrf: csrf(token, secret) }),
  };
}

for (const [goal, correct, transfer] of [
  ["everyday", "a", "b"],
  ["work", "b", "c"],
  ["build", "c", "a"],
] as const)
  it(`GUIDE-04 ${goal} guidance preserves the actual private draft, completion and foreign isolation`, async () => {
    const f = await fixture(goal);
    const instruction = `Private ${goal} instruction ${randomBytes(8).toString("hex")}`;
    const verification = "Compare each claim with the supplied original note.";
    await members.save(f.owner.id, {
      instruction,
      verification,
      complete: false,
      goal,
    });
    const draft = await members.progress(f.owner.id);
    expect(draft).toMatchObject({
      instruction,
      verification,
      completed_at: null,
    });
    expect((await f.get("/lesson/guide")).status).toBe(200);
    for (const [step, choice] of [
      ["practise", correct],
      ["transfer", transfer],
    ] as const) {
      expect((await f.get(`/lesson/guide/${step}`)).status).toBe(200);
      const feedback = await f.post("/lesson/guide/check", {
        version: "1",
        goal,
        step,
        choice,
      });
      expect(feedback.status).toBe(200);
      expect(feedback.text).toContain("That's the right check");
      expect(feedback.text).not.toContain(instruction);
      expect(await members.progress(f.owner.id)).toEqual(draft);
    }
    expect((await f.get("/lesson")).text).toContain(instruction);
    const other = await member(goal);
    expect((await f.get("/lesson", other.token)).text).not.toContain(
      instruction,
    );
    const forged = await f.post(
      "/lesson/guide/check",
      {
        version: "1",
        goal,
        step: "practise",
        choice: correct,
        member_id: f.owner.id,
      },
      other.token,
    );
    expect(forged.status).toBe(422);
    expect(await members.progress(f.owner.id)).toEqual(draft);
    const save = await f.post("/exercise", {
      lesson_id: LESSON.id,
      lesson_version: String(LESSON.version),
      goal,
      instruction,
      verification,
      checked: "yes",
      intent: "complete",
    });
    expect(save.status).toBe(303);
    const completed = await members.progress(f.owner.id);
    expect(completed?.completed_at).toBeInstanceOf(Date);
    expect(completed).toMatchObject({ instruction, verification });
    expect((await f.get("/lesson/guide")).status).toBe(200);
    expect((await f.get("/lesson")).text).toContain("Exercise completed");
    expect(await members.progress(f.owner.id)).toEqual(completed);
  });

it("GUIDE-06 an actual goal change makes the old form stale without moving the saved draft", async () => {
  const f = await fixture();
  await members.save(f.owner.id, {
    instruction: "Keep this original everyday draft",
    verification: "Check its original source details",
    complete: false,
  });
  const before = await members.withExerciseRead(f.owner.token, (rows) => rows);
  await f.get("/lesson/guide/practise");
  await pool.query("UPDATE learners SET goal='work' WHERE id=$1", [f.owner.id]);
  const result = await f.post("/lesson/guide/check", {
    version: "1",
    goal: "everyday",
    step: "practise",
    choice: "a",
  });
  expect(result.status).toBe(409);
  expect(result.text).toContain("Open your current lesson guide");
  expect(result.text).not.toContain("That's the right check");
  expect(await members.withExerciseRead(f.owner.token, (rows) => rows)).toEqual(
    before,
  );
  expect((await f.get("/lesson/guide")).text).toContain(
    "Sam will write the checklist",
  );
});

it("GUIDE-05 revoked or deleted native accounts cannot submit a retained guidance form", async () => {
  const f = await fixture();
  await f.get("/lesson/guide/practise");
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [f.owner.id],
  );
  const fields = {
    version: "1",
    goal: "everyday",
    step: "practise",
    choice: "a",
  };
  expect((await f.post("/lesson/guide/check", fields)).status).toBe(303);
  await pool.query("DELETE FROM principals WHERE id=$1", [f.owner.id]);
  expect((await f.get("/lesson/guide")).status).toBe(303);
  expect((await f.post("/lesson/guide/check", fields)).status).toBe(303);
});
