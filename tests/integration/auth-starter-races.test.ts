import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { careerStore } from "../../src/career.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { hash, migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

const pool = testPool();
const db = store(pool);
const origin = "http://127.0.0.1:3000";
const secret = "synthetic-audit-552";
const answer = {
  instruction: "Use invented details to make a small community plan.",
  verification: "Compare every step with the invented source details.",
  lesson_id: "clear-instructions",
  lesson_version: "1",
  revision: "0",
  goal: "everyday",
  intent: "draft",
};
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals, cohorts CASCADE"));
afterAll(async () => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member unavailable");
  await pool.query(
    "INSERT INTO member_email_identities(email_hash,principal_id) VALUES($1,$2)",
    [hash(`${token}@example.test`), session.learner.id],
  );
  return { token, id: session.learner.id };
}
function post(server: Server, token: string, route: string, fields: object) {
  return request(server)
    .post(route)
    .set("Host", "127.0.0.1:3000")
    .set("Origin", origin)
    .set("Cookie", `${COOKIE}=${token}`)
    .type("form")
    .send({ ...fields, csrf: csrf(token, secret) });
}

it.each([
  [
    "profile",
    "/profile",
    { background: "professional", goal: "work", timezone: "UTC" },
  ],
  ["starter", "/exercise", answer],
  ["career", "/career/enable", { confirm: "yes" }],
] as const)(
  "AUDIT-AUTH-01 denies queued %s mutation after real sign-out rotates its bearer",
  async (_kind, route, fields) => {
    const owner = await member();
    const holder = await pool.connect();
    let unlock!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    // Pause the actual sign-out only after PostgreSQL grants its principal lock.
    const signOutPool = {
      connect: async () => ({
        query: async (sql: string, values?: unknown[]) => {
          const result = await holder.query(sql, values);
          if (sql.startsWith("SELECT id FROM principals")) {
            locked();
            await release;
          }
          return result;
        },
        release: () => {},
      }),
    } as unknown as Pool;
    const access = memberEmailAccess(
      signOutPool,
      { send: async () => {} },
      origin,
    );
    const signingOut = access.signOut(owner.token);
    let pending: Promise<request.Response> | undefined;
    try {
      await held;
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      await withLoopback(
        app(db, { origin, secret, career: careerStore(pool) }),
        async (server) => {
          pending = post(server, owner.token, route, fields).then(
            (response) => response,
          );
          await expect
            .poll(
              async () =>
                (
                  await pool.query(
                    `SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND state='active' AND wait_event_type='Lock'
          AND $1::integer=ANY(pg_blocking_pids(pid))`,
                    [pid],
                  )
                ).rowCount,
              { timeout: 4000, interval: 20 },
            )
            .toBe(1);
          unlock();
          expect(await signingOut).toBe("signed_out");
          expect([403, 409]).toContain((await pending).status);
        },
      );
      expect(
        (await pool.query("SELECT goal FROM learners WHERE id=$1", [owner.id]))
          .rows[0].goal,
      ).toBe("everyday");
      expect(
        (
          await pool.query("SELECT 1 FROM exercises WHERE learner_id=$1", [
            owner.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT 1 FROM career_preferences WHERE member_id=$1",
            [owner.id],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      unlock();
      await signingOut;
      await pending;
      holder.release();
    }
  },
);

it("AUDIT-DRAFT-01 rejects a stale tab and retains its escaped text without overwriting the saved draft", async () => {
  const owner = await member();
  await withLoopback(app(db, { origin, secret }), async (server) => {
    await post(server, owner.token, "/exercise", answer).expect(303);
    const attempted =
      "Different invented <script>sample</script> from the stale tab.";
    const response = await post(server, owner.token, "/exercise", {
      ...answer,
      instruction: attempted,
    }).expect(409);
    expect(response.text).toContain("Draft changed in another tab");
    expect(response.text).toContain("&lt;script&gt;sample&lt;/script&gt;");
    expect(response.text).not.toContain("<script>sample</script>");
    expect((await db.progress(owner.id))?.instruction).toBe(answer.instruction);
    const reloaded = await request(server)
      .get("/lesson")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${owner.token}`)
      .expect(200);
    const revision = reloaded.text.match(/name="revision" value="(\d+)"/)![1]!;
    await post(server, owner.token, "/exercise", {
      ...answer,
      revision,
      instruction: attempted,
    }).expect(303);
    expect((await db.progress(owner.id))?.instruction).toBe(attempted);
  });
});

it("AUDIT-AUTH-02 lets a mutation owning the lock finish before sign-out, then denies both old bearer and cached ID", async () => {
  const owner = await member();
  const writer = await pool.connect();
  let unlock!: () => void;
  let locked!: () => void;
  const held = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const release = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const writePool = {
    connect: async () => ({
      query: async (sql: string, values?: unknown[]) => {
        const result = await writer.query(sql, values);
        if (sql.startsWith("INSERT INTO exercises")) {
          locked();
          await release;
        }
        return result;
      },
      release: () => {},
    }),
  } as unknown as Pool;
  const input = {
    instruction: answer.instruction,
    verification: answer.verification,
    complete: false,
    revision: 0,
  };
  const saving = store(writePool).save(owner.token, input);
  let signingOut: Promise<unknown> | undefined;
  try {
    await held;
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    signingOut = memberEmailAccess(
      pool,
      { send: async () => {} },
      origin,
    ).signOut(owner.token);
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              `SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND state='active' AND wait_event_type='Lock'
      AND $1::integer=ANY(pg_blocking_pids(pid))`,
              [pid],
            )
          ).rowCount,
        { timeout: 4000, interval: 20 },
      )
      .toBe(1);
    unlock();
    expect(await saving).toBe("saved");
    expect(await signingOut).toBe("signed_out");
    const before = await db.progress(owner.id);
    const career = careerStore(pool);
    const milestone = {
      goalTitle: "Invented goal",
      milestoneTitle: "Invented step",
      evidenceNote: "",
      nextAction: "Compare notes",
      reminderDate: null,
      reminderTime: null,
      reminderTimezone: null,
      selfReportedComplete: false,
    };
    const id = "00000000-0000-4000-8000-000000000001";
    const entry = {
      kind: "career" as const,
      title: "Invented career",
      note: "",
      nextAction: "Compare samples",
      selfReportedOutcome: "",
    };
    const draft = {
      kind: "proposal" as const,
      title: "Invented proposal",
      body: "Only invented sample details.",
    };
    for (const credential of [owner.token, owner.id]) {
      expect(
        await db.updateProfile(credential, {
          background: "professional",
          goal: "work",
          backgroundTags: [],
          domainTags: [],
          itRoles: [],
          experience: null,
          exploratory: false,
        }),
      ).toBe(false);
      expect(await db.openLesson(credential, "SYN-001", 1)).toBe(false);
      expect(await db.advanceLesson(credential, "SYN-001", 1, "start")).toBe(
        false,
      );
      expect(await db.chooseAssignment(credential, "SYN-001", 1)).toBeNull();
      expect(await db.milestones(credential)).toBeNull();
      expect(await db.createMilestone(credential, milestone)).toBeNull();
      expect(await db.updateMilestone(credential, id, 1, milestone)).toBeNull();
      expect(await db.deleteMilestone(credential, id, 1)).toBeNull();
      await expect(db.lessonActivities(credential)).rejects.toThrow(
        "Lesson history unavailable",
      );
      expect(await db.save(credential, { ...input, revision: 1 })).toBe(
        "unavailable",
      );
      expect(await career.snapshot(credential)).toBeNull();
      for (const operation of [
        () => career.enable(credential),
        () => career.disable(credential),
        () => career.createEntry(credential, entry),
        () => career.updateEntry(credential, id, 1, entry),
        () => career.deleteEntry(credential, id, 1),
        () => career.createDraft(credential, draft),
        () => career.updateDraft(credential, id, 1, draft),
        () => career.approveDraft(credential, id, 1),
        () => career.revokeDraft(credential, id, 1),
        () => career.deleteDraft(credential, id, 1),
      ])
        expect(await operation()).toBeNull();
    }
    expect(await db.progress(owner.id)).toEqual(before);
  } finally {
    unlock();
    await saving;
    await signingOut;
    writer.release();
  }
});

it("AUDIT-DRAFT-01 serializes simultaneous first drafts and rejects stale completion until explicitly reconciled", async () => {
  const owner = await member(),
    other = await member();
  const input = {
    instruction: answer.instruction,
    verification: answer.verification,
    complete: false,
    revision: 0,
  };
  const alternate = {
    ...input,
    instruction: "An alternate invented plan from a second tab.",
  };
  const outcomes = await Promise.all([
    db.save(owner.token, input),
    db.save(owner.token, alternate),
  ]);
  expect(outcomes.sort()).toEqual(["conflict", "saved"]);
  const saved = (await db.progress(owner.id))!;
  expect([input.instruction, alternate.instruction]).toContain(
    saved.instruction,
  );
  expect(saved.revision).toBe(1);
  expect(await db.save(owner.token, { ...alternate, complete: true })).toBe(
    "conflict",
  );
  expect(await db.progress(owner.id)).toEqual(saved);
  expect(await db.save(other.token, { ...alternate, revision: 1 })).toBe(
    "conflict",
  );
  expect(await db.progress(other.id)).toBeUndefined();
  expect(
    await db.save(owner.token, { ...alternate, revision: 1, complete: true }),
  ).toBe("saved");
  const completed = (await db.progress(owner.id))!;
  expect(completed.revision).toBe(2);
  expect(completed.completed_at).toBeInstanceOf(Date);
  expect(await db.save(owner.token, { ...input, revision: 2 })).toBe(
    "unchanged",
  );
  expect(await db.progress(owner.id)).toEqual(completed);
  await migrate(pool);
  await migrate(pool);
  expect(await db.progress(owner.id)).toEqual(completed);
});

it.each([
  undefined,
  "",
  "-1",
  "1.5",
  "01",
  "2147483647",
  "9007199254740992",
  ["0", "1"],
])(
  "AUDIT-DRAFT-02 rejects malformed or missing draft revision %j before writing",
  async (revision) => {
    const owner = await member();
    await withLoopback(app(db, { origin, secret }), async (server) => {
      await post(server, owner.token, "/exercise", {
        ...answer,
        revision,
      }).expect(409);
    });
    expect(await db.progress(owner.id)).toBeUndefined();
  },
);

it.each(["draft", "complete"])(
  "AUDIT-DRAFT-01 preserves stale %s text after another tab saves the completed version",
  async (intent) => {
    const owner = await member();
    await withLoopback(app(db, { origin, secret }), async (server) => {
      await post(server, owner.token, "/exercise", {
        ...answer,
        intent: "complete",
        checked: "yes",
      }).expect(303);
      const completed = await db.progress(owner.id);
      const attempted =
        "Different invented text retained after another tab completes.";
      const response = await post(server, owner.token, "/exercise", {
        ...answer,
        instruction: attempted,
        intent,
        checked: "yes",
      }).expect(409);
      expect(response.text).toContain("Draft changed in another tab");
      expect(response.text).toContain(attempted);
      expect(await db.progress(owner.id)).toEqual(completed);
    });
  },
);
