import request from "supertest";
import { app } from "../../src/app.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { migrate, store } from "../../src/store.ts";
import { usefulnessStore } from "../../src/usefulness.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const reports = usefulnessStore(pool);
const token = () => randomBytes(32).toString("hex");
const lessonId = "SYN-893";

async function publishLesson(version = 1, restricted = false) {
  const auth = authorizationStore(pool);
  const catalog = catalogStore(pool);
  const editor = token();
  const reviewer = token();
  const expiry = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  const draft: DraftContent = {
    id: lessonId,
    version,
    kind: "lesson",
    origin: "curated",
    title: `Invented usefulness lesson ${version}`,
    body: "Use only an invented example to choose and check a next step.",
    owner: "Test editor",
    sources: "Original synthetic lesson",
    rights: "Owned test text",
    goals: restricted ? ["work"] : [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, lessonId, version)).toBe(true);
  expect(await catalog.approve(reviewer, lessonId, version, true)).toBe(true);
  expect(await catalog.publish(editor, lessonId, version)).toBe(true);
  return { editor, catalog };
}

async function member(background: "explorer" | "professional" | "technical") {
  const value = token();
  await db.create(value, {
    background,
    goal: background === "explorer" ? "everyday" : "work",
  });
  const session = await db.session(value);
  expect(session.kind).toBe("active");
  return {
    token: value,
    id: session.kind === "active" ? session.learner.id : "",
  };
}

async function selfAssess(id: string, version = 1) {
  expect(await db.openLesson(id, lessonId, version)).toBe(true);
  expect(await db.advanceLesson(id, lessonId, version, "start")).toBe(true);
  expect(await db.advanceLesson(id, lessonId, version, "complete")).toBe(true);
}

beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(async () => pool.end());

it("records one private exact-version report per member and supports stale-safe correction and withdrawal", async () => {
  await publishLesson();
  const people = await Promise.all([
    member("explorer"),
    member("professional"),
    member("technical"),
  ]);
  for (const person of people) {
    expect(await reports.save(person.token, lessonId, 1, "helpful", 0)).toBe(
      false,
    );
    await selfAssess(person.id);
    expect(await reports.save(person.token, lessonId, 1, "helpful", 0)).toBe(
      true,
    );
    expect(await reports.save(person.token, lessonId, 1, "not_yet", 0)).toBe(
      false,
    );
    expect(await reports.list(person.token)).toMatchObject([
      {
        contentId: lessonId,
        contentVersion: 1,
        choice: "helpful",
        revision: 1,
      },
    ]);
  }
  const a = people[0]!;
  const b = people[1]!;
  expect(await reports.list(b.token)).toHaveLength(1);
  expect(await reports.list(token())).toEqual([]);
  const concurrent = await Promise.all([
    reports.save(a.token, lessonId, 1, "not_yet", 1),
    reports.save(a.token, lessonId, 1, "not_yet", 1),
  ]);
  expect(concurrent.sort()).toEqual([false, true]);
  expect(await reports.save(a.token, lessonId, 1, "helpful", 1)).toBe(false);
  expect(await reports.list(a.token)).toMatchObject([
    { choice: "not_yet", revision: 2 },
  ]);
  expect(await reports.withdraw(a.token, lessonId, 1, 1)).toBe(false);
  expect(await reports.withdraw(a.token, lessonId, 1, 2)).toBe(true);
  expect(await reports.list(a.token)).toEqual([]);
  expect(await reports.list(b.token)).toHaveLength(1);
});

it("denies staff, expired and forged writes; retains historical answers but permits their withdrawal", async () => {
  const { editor, catalog } = await publishLesson();
  const a = await member("explorer");
  const b = await member("technical");
  expect(await db.openLesson(a.id, lessonId, 1)).toBe(true);
  expect(await reports.save(a.token, lessonId, 1, "helpful", 0)).toBe(false);
  await db.advanceLesson(a.id, lessonId, 1, "start");
  expect(await reports.save(a.token, lessonId, 1, "helpful", 0)).toBe(false);
  await db.advanceLesson(a.id, lessonId, 1, "complete");
  expect(await reports.save(b.token, lessonId, 1, "helpful", 0)).toBe(false);
  expect(await reports.save(editor, lessonId, 1, "helpful", 0)).toBeNull();
  expect(await reports.save(a.token, lessonId, 2, "helpful", 0)).toBe(false);
  expect(await reports.save(a.token, lessonId, 1, "invalid" as never, 0)).toBe(
    false,
  );
  expect(await reports.save(a.token, lessonId, 1, "helpful", 0)).toBe(true);
  const ownExport = await memberExportStore(pool).exportOwned(a.token);
  expect(ownExport).toMatchObject({
    kind: "ready",
    payload: {
      version: "local-member-records-v24",
      records: {
        lessonUsefulness: [{ choice: "helpful", contentId: lessonId }],
      },
    },
  });
  const otherExport = await memberExportStore(pool).exportOwned(b.token);
  expect(otherExport).toMatchObject({
    kind: "ready",
    payload: { records: { lessonUsefulness: [] } },
  });
  await publishLesson(2);
  expect(await reports.save(a.token, lessonId, 1, "not_yet", 1)).toBe(false);
  expect(await reports.list(a.token)).toMatchObject([
    { choice: "helpful", contentVersion: 1 },
  ]);
  expect(await db.lessonActivities(a.id)).toMatchObject([
    { contentVersion: 1, reportable: false },
  ]);
  expect(await reports.withdraw(a.token, lessonId, 1, 1)).toBe(true);
  expect(await reports.list(a.token)).toEqual([]);
  await selfAssess(a.id, 2);
  expect(await reports.save(a.token, lessonId, 2, "not_yet", 0)).toBe(true);
  expect(await catalog.retire(editor, lessonId)).toBe(true);
  expect(await reports.save(a.token, lessonId, 2, "helpful", 1)).toBe(false);
  expect(await reports.withdraw(a.token, lessonId, 2, 1)).toBe(true);
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1",
    [a.id],
  );
  expect(await reports.list(a.token)).toEqual([]);
  expect(await reports.withdraw(a.token, lessonId, 2, 1)).toBeNull();
  await pool.query("DELETE FROM learners WHERE id=$1", [a.id]);
  expect(
    (
      await pool.query("SELECT 1 FROM lesson_usefulness WHERE member_id=$1", [
        a.id,
      ])
    ).rowCount,
  ).toBe(0);
});

const origin = "http://127.0.0.1:3000";
async function retained(id: string) {
  return (
    await pool.query(
      "SELECT * FROM lesson_usefulness WHERE member_id=$1 ORDER BY content_id,content_version",
      [id],
    )
  ).rows;
}
it("denies a valid usefulness creation POST after deletion begins without inserting a report", async () => {
  await publishLesson();
  const owner = await member("professional");
  await selfAssess(owner.id);
  const before = await retained(owner.id);
  await withLoopback(
    app(db, {
      origin,
      secret: "synthetic-usefulness-secret",
      usefulness: reports,
    }),
    async (server) => {
      const agent = request.agent(server);
      const page = await agent
        .get("/progress")
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${owner.token}`)
        .expect(200);
      const csrf = page.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
      await pool.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [owner.id],
      );
      const response = await agent
        .post(`/library/${lessonId}/usefulness`)
        .set("Host", "127.0.0.1:3000")
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${owner.token}`)
        .type("form")
        .send({
          csrf,
          content_version: "1",
          revision: "0",
          choice: "helpful",
          confirm: "yes",
          intent: "save",
        });
      expect.soft(response.status).toBe(403);
      expect.soft(await retained(owner.id)).toEqual(before);
    },
  );
});

type Operation = "create" | "correct" | "withdraw";
async function fixture(op: Operation, restricted = false) {
  await publishLesson(1, restricted);
  const owner = await member("professional");
  await selfAssess(owner.id);
  if (op !== "create")
    expect(await reports.save(owner.token, lessonId, 1, "helpful", 0)).toBe(
      true,
    );
  return owner;
}
function mutate(
  target: ReturnType<typeof usefulnessStore>,
  op: Operation,
  owner: { token: string },
) {
  return op === "withdraw"
    ? target.withdraw(owner.token, lessonId, 1, 1)
    : target.save(owner.token, lessonId, 1, "not_yet", op === "create" ? 0 : 1);
}
const operations: Operation[] = ["create", "correct", "withdraw"];
it.each(operations)(
  "denies %s during deletion with identical rows and content-free HTTP response",
  async (op) => {
    const owner = await fixture(op);
    const before = await retained(owner.id);
    await withLoopback(
      app(db, { origin, secret: "synthetic-secret", usefulness: reports }),
      async (server) => {
        const agent = request.agent(server);
        const page = await agent
          .get("/progress")
          .set("Host", "127.0.0.1:3000")
          .set("Cookie", `${COOKIE}=${owner.token}`)
          .expect(200);
        const csrf = page.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
        await pool.query(
          "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
          [owner.id],
        );
        expect(await mutate(reports, op, owner)).toBeNull();
        const response = await agent
          .post(`/library/${lessonId}/usefulness`)
          .set("Host", "127.0.0.1:3000")
          .set("Origin", origin)
          .set("Cookie", `${COOKIE}=${owner.token}`)
          .type("form")
          .send({
            csrf,
            content_version: "1",
            revision: op === "create" ? "0" : "1",
            choice: "not_yet",
            intent: op === "withdraw" ? "withdraw" : "save",
            confirm: "yes",
          })
          .expect(403);
        expect(response.text).toContain("Usefulness response unavailable");
        expect(response.text).not.toContain(lessonId);
        expect(response.text).not.toContain("Invented usefulness lesson");
        expect(await retained(owner.id)).toEqual(before);
      },
    );
  },
);
it.each([
  "missing",
  "revoked",
  "expired",
  "staff",
  "workspace-missing",
] as const)("denies all mutations for %s authorization", async (state) => {
  const owner = await fixture("correct");
  if (state === "missing") owner.token = token();
  if (state === "revoked")
    await pool.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [owner.id],
    );
  if (state === "expired")
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1",
      [owner.id],
    );
  if (state === "staff") {
    const staffToken = token();
    await authorizationStore(pool).provisionStaff(
      staffToken,
      "editor",
      new Date(Date.now() + 86400000),
    );
    owner.token = staffToken;
  }
  if (state === "workspace-missing")
    await pool.query("DELETE FROM workspaces WHERE owner_principal_id=$1", [
      owner.id,
    ]);
  const before = await retained(owner.id);
  for (const op of operations)
    expect(await mutate(reports, op, owner)).toBeNull();
  expect(await retained(owner.id)).toEqual(before);
});
it("preserves historical withdrawal after profile eligibility changes and outsider/stale isolation", async () => {
  const owner = await fixture("correct", true);
  const other = await member("technical");
  const before = await retained(owner.id);
  expect(await reports.withdraw(other.token, lessonId, 1, 1)).toBe(false);
  expect(await reports.withdraw(owner.token, lessonId, 1, 2)).toBe(false);
  expect(await retained(owner.id)).toEqual(before);
  await pool.query("UPDATE learners SET goal='everyday' WHERE id=$1", [
    owner.id,
  ]);
  expect(await reports.save(owner.token, lessonId, 1, "not_yet", 1)).toBe(
    false,
  );
  expect(await reports.withdraw(owner.token, lessonId, 1, 1)).toBe(true);
  expect(await reports.withdraw(owner.token, lessonId, 1, 1)).toBe(false);
  expect(await retained(owner.id)).toEqual([]);
});
async function waitUntil(check: () => Promise<boolean>, reason: string) {
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(reason);
}
async function blockedBy(blocker: number, waiter: number) {
  return (
    await pool.query(
      "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
      [blocker, waiter],
    )
  ).rows[0].blocked as boolean;
}
async function controlledWriter() {
  const client = await pool.connect();
  const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid as number;
  return {
    client,
    pid,
    reports: usefulnessStore({
      connect: async () => ({ query: client.query.bind(client), release() {} }),
    } as unknown as import("pg").Pool),
  };
}
const invalidations = ["revoked", "deleting"] as const;
const invalidateSQL = (state: (typeof invalidations)[number]) =>
  state === "revoked"
    ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
    : "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1";
for (const op of operations) {
  it.each(invalidations)(
    `denies ${op} when %s invalidation wins the lock`,
    async (state) => {
      const owner = await fixture(op);
      const before = await retained(owner.id);
      const blocker = await pool.connect();
      const writer = await controlledWriter();
      let writing: Promise<boolean | null> | undefined;
      try {
        await blocker.query("BEGIN");
        const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        await blocker.query(invalidateSQL(state), [owner.id]);
        writing = mutate(writer.reports, op, owner);
        await waitUntil(
          () => blockedBy(pid, writer.pid),
          "Mutation did not wait for invalidation",
        );
        await blocker.query("COMMIT");
        expect(await writing).toBeNull();
        expect(await retained(owner.id)).toEqual(before);
      } finally {
        await blocker.query("ROLLBACK");
        if (writing) await Promise.allSettled([writing]);
        blocker.release();
        writer.client.release();
      }
    },
  );
  it.each(invalidations)(
    `commits ${op} before queued %s invalidation`,
    async (state) => {
      const owner = await fixture(op);
      const blocker = await pool.connect();
      const writer = await controlledWriter();
      const invalidator = await pool.connect();
      let writing: Promise<boolean | null> | undefined;
      let invalidating: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        const invalidatorPid = (
          await invalidator.query("SELECT pg_backend_pid() AS pid")
        ).rows[0].pid;
        await blocker.query(
          op === "create"
            ? "SELECT member_id FROM lesson_activity WHERE member_id=$1 FOR UPDATE"
            : "SELECT member_id FROM lesson_usefulness WHERE member_id=$1 FOR UPDATE",
          [owner.id],
        );
        writing = mutate(writer.reports, op, owner);
        await waitUntil(
          () => blockedBy(pid, writer.pid),
          "Mutation did not reach report/activity after authorization",
        );
        invalidating = invalidator.query(invalidateSQL(state), [owner.id]);
        await waitUntil(
          () => blockedBy(writer.pid, invalidatorPid),
          "Invalidation did not wait for authorized mutation",
        );
        await blocker.query("COMMIT");
        expect(await writing).toBe(true);
        await invalidating;
        expect(await retained(owner.id)).toMatchObject(
          op === "withdraw"
            ? []
            : [{ choice: "not_yet", revision: op === "create" ? 1 : 2 }],
        );
        expect(await mutate(reports, op, owner)).toBeNull();
      } finally {
        await blocker.query("ROLLBACK");
        await Promise.allSettled([
          ...(writing ? [writing] : []),
          ...(invalidating ? [invalidating] : []),
        ]);
        blocker.release();
        writer.client.release();
        invalidator.release();
      }
    },
  );
  it.each(["principal", "workspace", "row"] as const)(
    `rolls back ${op} after wall-clock expiry during %s wait`,
    async (boundary) => {
      const owner = await fixture(op);
      const before = await retained(owner.id);
      const blocker = await pool.connect();
      const writer = await controlledWriter();
      let writing: Promise<boolean | null> | undefined;
      try {
        await pool.query(
          "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
          [owner.id],
        );
        await blocker.query("BEGIN");
        const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        await blocker.query(
          boundary === "principal"
            ? "SELECT id FROM principals WHERE id=$1 FOR UPDATE"
            : boundary === "workspace"
              ? "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE"
              : op === "create"
                ? "SELECT member_id FROM lesson_activity WHERE member_id=$1 FOR UPDATE"
                : "SELECT member_id FROM lesson_usefulness WHERE member_id=$1 FOR UPDATE",
          [owner.id],
        );
        writing = mutate(writer.reports, op, owner);
        await waitUntil(
          () => blockedBy(pid, writer.pid),
          "Mutation did not wait at expiry boundary",
        );
        await waitUntil(
          async () =>
            (
              await pool.query(
                "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
                [owner.id],
              )
            ).rows[0].expired,
          "Principal did not expire",
        );
        await blocker.query("COMMIT");
        expect(await writing).toBeNull();
        expect(await retained(owner.id)).toEqual(before);
      } finally {
        await blocker.query("ROLLBACK");
        if (writing) await Promise.allSettled([writing]);
        blocker.release();
        writer.client.release();
      }
    },
    10000,
  );
}
it("commits only one concurrent create and withdrawal for the same report", async () => {
  const owner = await fixture("create");
  expect(
    (
      await Promise.all([
        mutate(reports, "create", owner),
        mutate(reports, "create", owner),
      ])
    ).sort(),
  ).toEqual([false, true]);
  expect(await retained(owner.id)).toMatchObject([{ revision: 1 }]);
  expect(
    (
      await Promise.all([
        mutate(reports, "withdraw", owner),
        mutate(reports, "withdraw", owner),
      ])
    ).sort(),
  ).toEqual([false, true]);
  expect(await retained(owner.id)).toEqual([]);
});
it("does not replay a committed correction after a lost COMMIT reply", async () => {
  const owner = await fixture("correct");
  const client = await pool.connect();
  let released = false;
  let discarded: Error | undefined;
  let writes = 0;
  const ambiguous = usefulnessStore({
    connect: async () => ({
      async query(sql: string, values?: unknown[]) {
        if (sql.includes("UPDATE lesson_usefulness")) writes++;
        const result = await client.query(sql, values);
        if (sql === "COMMIT")
          throw new Error("Synthetic lost commit acknowledgement");
        return result;
      },
      release(error?: Error) {
        released = true;
        discarded = error;
        client.release(error);
      },
    }),
  } as unknown as import("pg").Pool);
  try {
    await expect(mutate(ambiguous, "correct", owner)).rejects.toThrow(
      "Usefulness operation unconfirmed",
    );
    expect(writes).toBe(1);
    expect(discarded).toBeInstanceOf(Error);
    expect(await retained(owner.id)).toMatchObject([
      { choice: "not_yet", revision: 2 },
    ]);
    expect(await mutate(reports, "correct", owner)).toBe(false);
    expect(await retained(owner.id)).toMatchObject([
      { choice: "not_yet", revision: 2 },
    ]);
  } finally {
    if (!released) client.release();
  }
});
it("rolls back query failure, releases authorization locks and returns a generic HTTP failure", async () => {
  const owner = await fixture("correct");
  const before = await retained(owner.id);
  const client = await pool.connect();
  const broken = usefulnessStore({
    connect: async () => ({
      query: (sql: string, values?: unknown[]) =>
        client.query(
          sql.includes("UPDATE lesson_usefulness")
            ? "SELECT * FROM synthetic_missing_usefulness_table"
            : sql,
          sql.includes("UPDATE lesson_usefulness") ? [] : values,
        ),
      release() {},
    }),
  } as unknown as import("pg").Pool);
  try {
    await withLoopback(
      app(db, { origin, secret: "synthetic-secret", usefulness: broken }),
      async (server) => {
        const agent = request.agent(server);
        const page = await agent
          .get("/learn")
          .set("Host", "127.0.0.1:3000")
          .set("Cookie", `${COOKIE}=${owner.token}`)
          .expect(200);
        const csrf = page.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
        const response = await agent
          .post(`/library/${lessonId}/usefulness`)
          .set("Host", "127.0.0.1:3000")
          .set("Origin", origin)
          .set("Cookie", `${COOKIE}=${owner.token}`)
          .type("form")
          .send({
            csrf,
            content_version: "1",
            revision: "1",
            choice: "not_yet",
            intent: "save",
            confirm: "yes",
          })
          .expect(503);
        expect(response.text).toContain("Usefulness response unconfirmed");
        expect(response.text).toContain('href="/progress"');
        expect(response.text).not.toMatch(
          /synthetic_missing_usefulness_table|Invented usefulness lesson/,
        );
      },
    );
    expect(await retained(owner.id)).toEqual(before);
    const probe = await pool.connect();
    try {
      await probe.query("BEGIN");
      await probe.query(
        "SELECT id FROM principals WHERE id=$1 FOR UPDATE NOWAIT",
        [owner.id],
      );
      await probe.query(
        "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE NOWAIT",
        [owner.id],
      );
      await probe.query("ROLLBACK");
    } finally {
      probe.release();
    }
    expect(await mutate(reports, "correct", owner)).toBe(true);
  } finally {
    client.release();
  }
});
it("times out a blocked report without mutation and allows later correction", async () => {
  const owner = await fixture("correct");
  const before = await retained(owner.id);
  const blocker = await pool.connect();
  let result: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT member_id FROM lesson_usefulness WHERE member_id=$1 FOR UPDATE",
      [owner.id],
    );
    result = mutate(reports, "correct", owner).catch((error) => error);
    expect(await result).toMatchObject({
      message: "Usefulness operation unconfirmed",
    });
    expect(await retained(owner.id)).toEqual(before);
    await blocker.query("COMMIT");
    expect(await mutate(reports, "correct", owner)).toBe(true);
  } finally {
    await blocker.query("ROLLBACK");
    if (result) await Promise.allSettled([result]);
    blocker.release();
  }
}, 10000);

const lifetimeCases = (["save", "correct", "withdraw"] as const).flatMap(
  (operation) =>
    (["commit", "handback"] as const).map((boundary) => ({
      operation,
      boundary,
    })),
);
it.each(lifetimeCases)(
  "recovers $operation without replay after expiry at $boundary",
  async ({ operation, boundary }) => {
    await publishLesson();
    const owner = await member("explorer");
    await selfAssess(owner.id);
    if (operation !== "save")
      expect(await reports.save(owner.token, lessonId, 1, "helpful", 0)).toBe(
        true,
      );
    const statements: string[] = [],
      replies: Promise<unknown>[] = [];
    let committed = false,
      discarded = false;
    const target = usefulnessStore({
      connect: async () => {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            statements.push(sql);
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              committed = true;
              if (boundary === "commit") {
                const reply = pool.query("SELECT pg_sleep(2.3)");
                replies.push(reply);
                await reply;
              }
            }
            return result;
          },
          release(error?: Error) {
            if (committed && boundary === "handback") {
              const until = performance.now() + 2300;
              while (performance.now() < until) {
                /* native handback */
              }
            }
            discarded = !!error;
            client.release(error);
          },
        };
      },
    } as unknown as import("pg").Pool);
    const secret = "invented-usefulness-lifetime";
    try {
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
        [owner.id],
      );
      const response = await withLoopback(
        app(db, { origin, secret, usefulness: target }),
        (server) =>
          request(server)
            .post(`/library/${lessonId}/usefulness`)
            .set("Host", "127.0.0.1:3000")
            .set("Cookie", `${COOKIE}=${owner.token}`)
            .set("Origin", origin)
            .type("form")
            .send({
              csrf: csrf(owner.token, secret),
              content_version: "1",
              revision: operation === "save" ? "0" : "1",
              intent: operation === "withdraw" ? "withdraw" : "save",
              choice: operation === "save" ? "helpful" : "not_yet",
              confirm: "yes",
            }),
      );
      await Promise.all(replies);
      expect(committed).toBe(true);
      expect(
        (
          await pool.query(
            "SELECT expires_at<=clock_timestamp() expired FROM principals WHERE id=$1",
            [owner.id],
          )
        ).rows[0].expired,
      ).toBe(true);
      expect.soft(response.status).toBe(503);
      expect.soft(response.headers.location).toBeUndefined();
      expect.soft(response.text).toMatch(/unconfirmed/i);
      expect.soft(response.text).toContain('href="/progress"');
      expect.soft(response.text).not.toContain("<form");
      expect.soft(response.text).not.toContain("Nothing was saved");
      expect.soft(discarded).toBe(true);
      expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
      expect(statements).not.toContain("ROLLBACK");
      const durable = await retained(owner.id);
      expect(durable).toHaveLength(operation === "withdraw" ? 0 : 1);
      if (operation !== "withdraw")
        expect(durable[0]).toMatchObject({
          choice: operation === "save" ? "helpful" : "not_yet",
          revision: operation === "save" ? 1 : 2,
        });
      expect(await reports.list(owner.token)).toEqual([]);
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [owner.id],
      );
      const fresh = await withLoopback(
        app(db, { origin, secret, usefulness: reports }),
        (server) =>
          request(server)
            .get("/progress")
            .set("Host", "127.0.0.1:3000")
            .set("Cookie", `${COOKIE}=${owner.token}`),
      );
      expect(fresh.status).toBe(200);
      if (operation === "withdraw")
        expect(fresh.text).not.toContain("Your current answer:");
      else
        expect(fresh.text).toContain(
          operation === "save" ? "Helpful for my next step" : "Not helpful yet",
        );
      expect(await retained(owner.id)).toEqual(durable);
    } finally {
      await Promise.all(replies);
    }
  },
  10000,
);

it.each(["query", "commit", "rollback"] as const)(
  "bounds unresolved %s without replay or queued rollback",
  async (boundary) => {
    await publishLesson();
    const owner = await member("professional");
    await selfAssess(owner.id);
    let resume!: () => void;
    const stalled = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const statements: string[] = [],
      replies: Promise<unknown>[] = [];
    let released = 0,
      intercepted = false;
    const backend = usefulnessStore({
      connect: async () => {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            statements.push(sql);
            if (
              boundary === "rollback" &&
              sql.startsWith("SELECT id,expires_at")
            )
              return { rows: [] };
            const result = await client.query(sql, values);
            if (
              (boundary === "query" &&
                sql.includes("INSERT INTO lesson_usefulness")) ||
              (boundary === "commit" && sql === "COMMIT") ||
              (boundary === "rollback" && sql === "ROLLBACK")
            ) {
              intercepted = true;
              replies.push(stalled);
              await stalled;
            }
            return result;
          },
          release(error?: Error) {
            released++;
            expect(error).toBeInstanceOf(Error);
            client.release(error);
          },
        };
      },
    } as unknown as import("pg").Pool);
    try {
      const entered = performance.now();
      await expect(
        backend.save(owner.token, lessonId, 1, "helpful", 0),
      ).rejects.toThrow("Usefulness operation unconfirmed");
      expect(intercepted).toBe(true);
      expect(released).toBe(1);
      expect(performance.now() - entered).toBeLessThan(8000);
      expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(
        boundary === "commit" ? 1 : 0,
      );
      expect(statements.filter((sql) => sql === "ROLLBACK")).toHaveLength(
        boundary === "rollback" ? 1 : 0,
      );
      resume();
      await Promise.all(replies);
      expect(await retained(owner.id)).toHaveLength(
        boundary === "commit" ? 1 : 0,
      );
    } finally {
      resume();
      await Promise.allSettled(replies);
    }
  },
  12000,
);

it("bounds pool exhaustion and disposes a late connection without work", async () => {
  const { Pool } = await import("pg");
  const limited = new Pool({
    connectionString: process.env.DNE_TEST_DATABASE_URL,
    max: 1,
  });
  const held = await limited.connect();
  let heldReturned = false,
    released = 0,
    queried = false,
    late!: Promise<void>;
  const backend = usefulnessStore({
    connect: () => {
      const acquisition = limited.connect().then((client) => ({
        query(sql: string, values?: unknown[]) {
          queried = true;
          return client.query(sql, values);
        },
        release(error?: Error) {
          released++;
          expect(error).toBeInstanceOf(Error);
          client.release(error);
        },
      }));
      late = acquisition.then(() => {});
      return acquisition;
    },
  } as unknown as import("pg").Pool);
  try {
    const entered = performance.now();
    await expect(backend.withdraw("invented", lessonId, 1, 1)).rejects.toThrow(
      "Usefulness operation unconfirmed",
    );
    expect(performance.now() - entered).toBeLessThan(5000);
    expect(released).toBe(0);
    held.release();
    heldReturned = true;
    await late;
    await Promise.resolve();
    expect(released).toBe(1);
    expect(queried).toBe(false);
  } finally {
    if (!heldReturned) held.release();
    await limited.end();
  }
}, 10000);
