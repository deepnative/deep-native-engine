import request from "supertest";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { app } from "../../src/app.ts";
import type { ExerciseHistory, Store } from "../../src/store.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import type { Goal } from "../../src/content.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";

const servers: Server[] = [];
const origin = "http://127.0.0.1:3000";
const credential = "a".repeat(64);
const secret = "guided-test";
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeLoopback));
});

async function fixture(goal: Goal = "everyday") {
  const member = { id: "member", background: "explorer", goal };
  const state = { active: true };
  const store = {
    session: vi.fn(async (token: string) =>
      state.active && token === credential
        ? {
            kind: "active",
            expiresAt: new Date("2090-01-01"),
            learner: member,
          }
        : { kind: "expired" },
    ),
    progress: vi.fn(async () => undefined),
    withExerciseRead: vi.fn(
      async (_token: string, render: (rows: ExerciseHistory[]) => unknown) =>
        render([]),
    ),
    save: vi.fn(),
  } as unknown as Store;
  const server = await listenLoopback(app(store, { origin, secret }));
  servers.push(server);
  return {
    store,
    member,
    state,
    emptyPost: () =>
      request(server)
        .post("/lesson/guide/check")
        .set("Host", "127.0.0.1:3000")
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${credential}`)
        .set("x-csrf-token", csrf(credential, secret)),
    get: (path: string) =>
      request(server)
        .get(path)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${credential}`),
    post: (
      fields: Record<string, unknown>,
      path = "/lesson/guide/check",
      from = origin,
    ) =>
      request(server)
        .post(path)
        .set("Host", "127.0.0.1:3000")
        .set("Origin", from)
        .set("Cookie", `${COOKIE}=${credential}`)
        .type("form")
        .send({
          csrf: csrf(credential, secret),
          version: "1",
          goal: member.goal,
          step: "practise",
          choice: "a",
          ...fields,
        }),
  };
}

it("GUIDE-01 teaches an original worked example before asking a new member to write", async () => {
  const f = await fixture();
  const result = await f.get("/lesson/guide");
  expect(result.status).toBe(200);
  expect(result.text).toContain("Turn a vague request into a useful one");
  expect(result.text).toContain("Try a quick check");
  expect(result.text).toContain("12 volunteers");
  expect(f.store.save).not.toHaveBeenCalled();
  const entry = await f.get("/lesson");
  expect(entry.status).toBe(200);
  expect(entry.text).toContain("Start with a guided example");
  expect(entry.text).toContain('action="/exercise"');
});

const cases = [
  {
    goal: "everyday",
    step: "practise",
    correct: "a",
    explanation: "12 volunteers, two hours and Saturday",
    wrong: { b: "The note says 12", c: "neither a library nor a start time" },
  },
  {
    goal: "everyday",
    step: "transfer",
    correct: "b",
    explanation: "preserves the note",
    wrong: {
      a: "Plausibility is not a source",
      c: "does not mean the event is cancelled",
    },
  },
  {
    goal: "work",
    step: "practise",
    correct: "b",
    explanation: "Both the owner and date need confirmation",
    wrong: { a: "explicitly gives Sam this task", c: "task assigned to Alex" },
  },
  {
    goal: "work",
    step: "transfer",
    correct: "c",
    explanation: "without inventing a date",
    wrong: { a: "Friday does not appear", b: "Wednesday is the pilot date" },
  },
  {
    goal: "build",
    step: "practise",
    correct: "c",
    explanation: "remains to be tested",
    wrong: {
      a: "cannot establish a test result",
      b: "does not prove that a leak exists",
    },
  },
  {
    goal: "build",
    step: "transfer",
    correct: "a",
    explanation: "absence of an observed result",
    wrong: {
      b: "does not prove the form actually rejected",
      c: "depends on the observed response",
    },
  },
] as const;

for (const example of cases)
  it(`GUIDE-02/03 explains each ${example.goal} ${example.step} choice against its own source`, async () => {
    const f = await fixture(example.goal);
    const question = await f.get(`/lesson/guide/${example.step}`);
    expect(question.status).toBe(200);
    expect(question.text).toContain("Give me a hint");
    expect(question.text).not.toContain("That's the right check");
    for (const [choice, explanation] of Object.entries(example.wrong)) {
      const result = await f.post({ step: example.step, choice });
      expect(result.status).toBe(200);
      expect(result.text).toContain("Look at the source again");
      expect(result.text).toContain(explanation);
      expect(result.text).toContain("Check again");
      expect(result.text).not.toContain("That's the right check");
      expect(result.text).toContain(`value="${choice}" required checked`);
    }
    const corrected = await f.post({
      step: example.step,
      choice: example.correct,
    });
    expect(corrected.status).toBe(200);
    expect(corrected.text).toContain("That's the right check");
    expect(corrected.text).toContain(example.explanation);
    expect(corrected.text).not.toContain('action="/lesson/guide/check"');
    expect(corrected.text).toContain(
      example.step === "practise"
        ? 'href="/lesson/guide/transfer"'
        : "Write your own request",
    );
    expect(f.store.save).not.toHaveBeenCalled();
  });

it("GUIDE-01 gives each goal its own original example and a route back to saved work", async () => {
  for (const [goal, source] of [
    ["work", "Sam will write the checklist"],
    ["build", "No tests have been run"],
  ] as const) {
    const f = await fixture(goal);
    const page = await f.get("/lesson/guide");
    expect(page.status).toBe(200);
    expect(page.text).toContain(source);
    expect(page.text).toContain('href="/lesson#exercise-title"');
    expect(page.text).not.toContain("AZURE HOSTED");
    expect(page.text).not.toContain("No AI provider");
  }
});

for (const fields of [
  { extra: "foreign-member" },
  { version: ["1", "2"] },
  { goal: ["everyday", "work"] },
  { step: "unknown" },
  { choice: ["a", "b"] },
  { choice: "<script>private-text</script>" },
])
  it(`GUIDE-05 rejects malformed fixed-choice input ${JSON.stringify(fields)}`, async () => {
    const f = await fixture();
    const result = await f.post(fields);
    expect(result.status).toBe(422);
    expect(result.text).toContain("Choose an answer from the lesson");
    expect(result.text).not.toContain("private-text");
    expect(result.text).not.toContain("foreign-member");
    expect(f.store.save).not.toHaveBeenCalled();
  });

it("GUIDE-05 rejects query payloads, forged CSRF and foreign origins", async () => {
  const f = await fixture();
  expect((await f.post({}, "/lesson/guide/check?choice=c")).status).toBe(422);
  expect((await f.post({ csrf: "forged" })).status).toBe(403);
  expect(
    (await f.post({}, "/lesson/guide/check", "https://foreign.invalid")).status,
  ).toBe(403);
  expect(f.store.save).not.toHaveBeenCalled();
});

it("GUIDE-05 rejects a missing form body even when the CSRF header is valid", async () => {
  const f = await fixture();
  const result = await f.emptyPost();
  expect(result.status).toBe(422);
  expect(result.text).toContain("Choose an answer from the lesson");
  expect(f.store.save).not.toHaveBeenCalled();
});

it("GUIDE-05 requires current member access for the example, choices and feedback", async () => {
  const f = await fixture();
  f.state.active = false;
  for (const route of [
    "/lesson/guide",
    "/lesson/guide/practise",
    "/lesson/guide/transfer",
  ])
    expect((await f.get(route)).status).toBe(303);
  expect((await f.post({})).status).toBe(303);
  expect(f.store.save).not.toHaveBeenCalled();
});

it("GUIDE-06 restarts stale goal/version forms without writing or claiming a result", async () => {
  const f = await fixture();
  await f.get("/lesson/guide/practise");
  f.member.goal = "work";
  for (const fields of [{ goal: "everyday" }, { version: "0" }]) {
    const result = await f.post(fields);
    expect(result.status).toBe(409);
    expect(result.text).toContain("Your lesson direction has changed");
    expect(result.text).toContain("Open your current lesson guide");
    expect(result.text).not.toContain("That's the right check");
  }
  expect(f.store.save).not.toHaveBeenCalled();
});
