import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { practiceSessionStore } from "../../src/practice-sessions.ts";
import { practiceStore } from "../../src/practice.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
const pool = testPool(),
  db = store(pool),
  practiceSessions = practiceSessionStore(pool),
  catalog = catalogStore(pool);
const origin = "http://127.0.0.1:3000",
  secret = "synthetic-practice-http";
const application = app(db, {
  origin,
  secret,
  practiceSessions,
  catalog,
  practice: practiceStore(pool),
});
beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE principals, content_versions, cohorts CASCADE"),
);
afterAll(async () => pool.end());
async function member(
  background: "explorer" | "professional" | "technical" = "explorer",
  goal: "everyday" | "work" | "build" = "everyday",
) {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background, goal });
  return token;
}
async function fixture() {
  const editor = randomBytes(32).toString("hex"),
    reviewer = randomBytes(32).toString("hex");
  const auth = authorizationStore(pool);
  await auth.provisionStaff(editor, "editor", new Date(Date.now() + 86400000));
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86400000),
  );
  const draft: DraftContent = {
    id: "SYN-841",
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: "Invented HTTP practice lesson",
    body: "Check every invented detail against the supplied sample.",
    owner: "Synthetic editor",
    sources: "Original invented sample",
    rights: "Owned",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
  };
  const publish = async (version: number) => {
    expect(await catalog.createDraft(editor, { ...draft, version })).toBe(true);
    expect(await catalog.submit(editor, draft.id, version)).toBe(true);
    expect(await catalog.approve(reviewer, draft.id, version, true)).toBe(true);
    expect(await catalog.publish(editor, draft.id, version)).toBe(true);
  };
  await publish(1);
  return { draft, publish, editor };
}
function get(token: string, path: string) {
  return withLoopback(application, (server) =>
    request(server)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
}
function post(token: string, path: string, fields: Record<string, string>) {
  return withLoopback(application, (server) =>
    request(server)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf: csrf(token, secret), ...fields }),
  );
}
const startFields = {
  content_version: "1",
  goal: "everyday",
  prompt_version: "practice-v1",
  synthetic: "yes",
};
it("persists ordered pairs through real HTTP for all three backgrounds without replacing one-note practice", async () => {
  const { draft } = await fixture();
  for (const [background, goal] of [
    ["explorer", "everyday"],
    ["professional", "work"],
    ["technical", "build"],
  ] as const) {
    const token = await member(background, goal);
    const preview = await get(token, `/library/${draft.id}/practice-session`);
    expect(preview.status).toBe(200);
    expect(preview.text).toContain('name="synthetic"');
    expect((await practiceSessions.history(token))?.items).toHaveLength(0);
    const begun = await post(
      token,
      `/library/${draft.id}/practice-session/start`,
      { ...startFields, goal },
    );
    expect(begun.status).toBe(303);
    const location = begun.headers.location as string;
    expect(
      (
        await post(token, `/library/${draft.id}/practice-session/start`, {
          ...startFields,
          goal,
        })
      ).headers.location,
    ).toBe(location);
    for (const sequence of [1, 2])
      expect(
        (
          await post(token, `${location}/responses`, {
            expected_sequence: String(sequence),
            response: `  Invented ${goal} response ${sequence}\n`,
            synthetic: "yes",
          })
        ).status,
      ).toBe(303);
    const reloaded = await get(token, location);
    expect(reloaded.text).toContain(
      "2 of 15 saved pairs · 4 of 30 visible turns",
    );
    expect(reloaded.text.indexOf(`Invented ${goal} response 1`)).toBeLessThan(
      reloaded.text.indexOf(`Invented ${goal} response 2`),
    );
    expect(
      (
        await practiceSessions.detail(token, location.split("/").at(-1)!)
      )?.exchanges.map((pair) => pair.response),
    ).toEqual([
      `  Invented ${goal} response 1\n`,
      `  Invented ${goal} response 2\n`,
    ]);
    const note = await get(token, `/library/${draft.id}/practice`);
    expect(note.text).toContain("Save private practice");
    expect(note.text).not.toContain(`Invented ${goal} response`);
    expect(
      (
        await post(token, `${location}/responses`, {
          expected_sequence: "1",
          response: `  Invented ${goal} response 1\n`,
          synthetic: "yes",
        })
      ).status,
    ).toBe(303);
    expect(
      (
        await post(token, `${location}/responses`, {
          expected_sequence: "1",
          response: "Different invented response",
          synthetic: "yes",
        })
      ).status,
    ).toBe(409);
  }
});
it("denies forged owners and strict-form extras then retains read-only history after source replacement", async () => {
  const { draft, publish } = await fixture();
  const owner = await member(),
    other = await member();
  const begun = await post(
    owner,
    `/library/${draft.id}/practice-session/start`,
    startFields,
  );
  const location = begun.headers.location as string;
  expect(
    (
      await post(owner, `${location}/responses`, {
        expected_sequence: "1",
        response: "Private invented response",
        synthetic: "yes",
      })
    ).status,
  ).toBe(303);
  expect((await get(other, location)).status).toBe(404);
  for (const token of [owner, other]) {
    expect(
      (
        await post(token, `${location}/responses`, {
          expected_sequence: "2",
          response: "Forged member response",
          synthetic: "yes",
          memberId: "forged",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post(token, `${location}/withdraw`, {
          confirm: "yes",
          sessionId: "forged",
        })
      ).status,
    ).toBe(422);
  }
  expect(
    (
      await post(other, `${location}/responses`, {
        expected_sequence: "2",
        response: "Other response",
        synthetic: "yes",
      })
    ).status,
  ).toBe(409);
  expect(
    (await post(other, `${location}/withdraw`, { confirm: "yes" })).status,
  ).toBe(404);
  expect(
    (
      await post(owner, `${location}/responses`, {
        expected_sequence: "2",
        response: "Bad CSRF",
        synthetic: "yes",
        csrf: "forged",
      })
    ).status,
  ).toBe(403);
  await publish(2);
  const retired = await get(owner, location);
  expect(retired.status).toBe(200);
  expect(retired.text).toContain("Saved pairs are read-only");
  expect(retired.text).toContain("Private invented response");
  expect(retired.text).not.toContain("Save response and compare");
  expect(
    (
      await post(owner, `${location}/responses`, {
        expected_sequence: "1",
        response: "Private invented response",
        synthetic: "yes",
      })
    ).status,
  ).toBe(409);
  expect(
    (await post(owner, `${location}/withdraw`, { confirm: "yes" })).status,
  ).toBe(303);
  expect(
    (await post(owner, `${location}/withdraw`, { confirm: "yes" })).status,
  ).toBe(303);
  const marker = await get(owner, location);
  expect(marker.text).toContain("Session withdrawn");
  expect(marker.text).not.toContain("Private invented response");
  expect((await get(other, "/practice-sessions")).text).toContain(
    "No private sessions are saved yet",
  );
});
it("traverses bounded owned keyset history pages over HTTP with no omissions", async () => {
  const { draft, publish } = await fixture();
  const owner = await member(),
    other = await member();
  const ids: string[] = [];
  for (let version = 1; version <= 21; version++) {
    if (version > 1) await publish(version);
    const result = await post(
      owner,
      `/library/${draft.id}/practice-session/start`,
      { ...startFields, content_version: String(version) },
    );
    expect(result.status).toBe(303);
    ids.push(result.headers.location as string);
  }
  const first = await get(owner, "/practice-sessions");
  expect(first.status).toBe(200);
  expect(first.text.match(/<li>/g) ?? []).toHaveLength(20);
  const next = first.text.match(
    /href="(\/practice-sessions\?after=[^"]+)"/,
  )![1]!;
  const last = await get(owner, next);
  expect(last.status).toBe(200);
  expect(last.text.match(/<li>/g) ?? []).toHaveLength(1);
  expect(last.text).not.toContain("Next session page");
  for (const id of ids)
    expect(first.text + last.text).toContain(`href="${id}"`);
  expect((await get(other, next)).text).not.toContain(draft.id);
  expect((await get(owner, "/practice-sessions?after=invalid")).status).toBe(
    404,
  );
});

it.each(
  (["detail", "history", "append"] as const).flatMap((operation) =>
    (["commit-reply", "native-handback"] as const).map((delay) => ({
      operation,
      delay,
    })),
  ),
)(
  "withholds HTTP $operation after successful $delay crosses authority expiry",
  async ({ operation, delay }) => {
    const { draft } = await fixture(),
      token = await member();
    const begun = await post(
      token,
      `/library/${draft.id}/practice-session/start`,
      startFields,
    );
    const location = begun.headers.location as string;
    await post(token, `${location}/responses`, {
      expected_sequence: "1",
      response: "Private invented expiry marker",
      synthetic: "yes",
    });
    const identity = await db.session(token);
    if (identity.kind !== "active") throw Error("Fixture member missing");
    const expires = (
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1 RETURNING expires_at",
        [identity.learner.id],
      )
    ).rows[0].expires_at as Date;
    let commits = 0;
    let deliver!: () => void;
    const delivered = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const delayed = practiceSessionStore({
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              commits++;
              if (delay === "commit-reply")
                while (
                  !(
                    await pool.query(
                      "SELECT clock_timestamp()>=$1::timestamptz expired",
                      [expires],
                    )
                  ).rows[0].expired
                )
                  await new Promise((resolve) => setTimeout(resolve, 5));
              deliver();
            }
            return result;
          },
          release(error?: Error) {
            client.release(error);
            if (delay === "native-handback" && commits === 1)
              Atomics.wait(
                new Int32Array(new SharedArrayBuffer(4)),
                0,
                0,
                1100,
              );
          },
        };
      },
    } as unknown as import("pg").Pool);
    const actualApp = app(db, {
      origin,
      secret,
      practiceSessions: delayed,
      catalog,
      practice: practiceStore(pool),
    });
    const response = await withLoopback(actualApp, (server) => {
      const call =
        operation === "append"
          ? request(server)
              .post(`${location}/responses`)
              .set("Origin", origin)
              .type("form")
              .send({
                csrf: csrf(token, secret),
                expected_sequence: "2",
                response: "Another invented response",
                synthetic: "yes",
              })
          : request(server).get(
              operation === "detail" ? location : "/practice-sessions",
            );
      return call
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${token}`);
    });
    expect(commits).toBe(1);
    await delivered;
    expect(
      (
        await pool.query("SELECT clock_timestamp()>=$1::timestamptz expired", [
          expires,
        ])
      ).rows[0].expired,
    ).toBe(true);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.text.includes("Private invented expiry marker")).toBe(
      false,
    );
    expect(response.text.includes(draft.title)).toBe(false);
    expect(response.headers.location).toBeUndefined();
  },
);
