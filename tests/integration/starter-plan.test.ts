import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { COOKIE } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

const pool = testPool();
const db = store(pool);
const origin = "http://127.0.0.1:3000";
const server = app(db, { origin, secret: "synthetic-starter-plan-secret" });

beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals, cohorts CASCADE"));
afterAll(async () => pool.end());

async function member(goal: "everyday" | "work") {
  const token = randomBytes(32).toString("hex");
  await db.create(token, {
    background: "explorer",
    goal,
    weeklyMinutes: 15,
  });
  const session = await db.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member unavailable");
  return { token, id: session.learner.id };
}

async function plan(token: string) {
  return withLoopback(server, (listener) =>
    request(listener)
      .get("/learn")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
}

it("advances only the owner's saved exercise and keeps an earlier goal historical", async () => {
  const owner = await member("everyday");
  const other = await member("everyday");
  expect((await plan(owner.token)).text).toContain(
    "Next session: try the sample exercise",
  );
  await db.save(owner.id, {
    instruction: "Plan a small event with invented volunteer details.",
    verification: "Check timing and roles against the invented details.",
    complete: true,
  });
  const completed = (await plan(owner.token)).text;
  expect(completed).toContain("completed for your current goal");
  expect(completed).not.toContain("Next session: try the sample exercise");
  expect((await plan(other.token)).text).toContain(
    "Next session: try the sample exercise",
  );
  expect(await db.withdrawExercise(owner.token, "clear-instructions", 1)).toBe(
    "withdrawn",
  );
  const withdrawn = (await plan(owner.token)).text;
  expect(withdrawn).toContain("completed");
  expect(withdrawn).toContain("withdrawn");
  expect(withdrawn).not.toContain("review your saved starter exercise");
  expect(withdrawn).not.toContain("try the sample exercise");
  await db.updateProfile(owner.id, {
    background: "explorer",
    goal: "work",
    backgroundTags: [],
    domainTags: [],
    itRoles: [],
    experience: null,
    exploratory: false,
    weeklyMinutes: 15,
  });
  const changed = (await plan(owner.token)).text;
  expect(changed).toContain("Turn meeting notes into next steps");
  expect(changed).toContain("earlier goal");
  expect(changed).not.toContain("completed for your current goal");
  expect(changed).not.toContain("Next session: try the sample exercise");
});
