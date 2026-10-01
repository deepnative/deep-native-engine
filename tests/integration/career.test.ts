import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { careerStore, type CareerStore } from "../../src/career.ts";
import { COOKIE } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

const pool = testPool();
const db = store(pool);
const career = careerStore(pool);
const origin = "http://127.0.0.1:3000";
const entry = {
  kind: "career" as const,
  title: "Invented career plan",
  note: "Private invented note",
  nextAction: "Compare invented paths",
  selfReportedOutcome: "Private invented outcome",
};
const draft = {
  kind: "proposal" as const,
  title: "Invented private proposal",
  body: "Private invented proposal details for an unsent practice draft.",
};
beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(async () => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "professional", goal: "work" });
  const session = await db.session(token);
  if (session.kind !== "active") throw new Error("Fixture member unavailable");
  return { id: session.learner.id, token };
}
async function fixture() {
  const owner = await member();
  await career.enable(owner.id);
  await career.createEntry(owner.id, entry);
  await career.createDraft(owner.id, draft);
  const snapshot = (await career.snapshot(owner.id))!;
  return {
    ...owner,
    entryId: snapshot.entries[0]!.id,
    draftId: snapshot.drafts[0]!.id,
  };
}
async function retained(id: string) {
  return {
    preferences: (
      await pool.query("SELECT * FROM career_preferences WHERE member_id=$1", [
        id,
      ])
    ).rows,
    entries: (
      await pool.query(
        "SELECT * FROM career_entries WHERE member_id=$1 ORDER BY id",
        [id],
      )
    ).rows,
    drafts: (
      await pool.query(
        "SELECT * FROM career_drafts WHERE member_id=$1 ORDER BY id",
        [id],
      )
    ).rows,
  };
}
it("denies a valid career creation POST after deletion begins without changing retained rows", async () => {
  const owner = await fixture();
  const before = await retained(owner.id);
  await withLoopback(
    app(db, { origin, secret: "synthetic-career-secret", career }),
    async (server) => {
      const agent = request.agent(server);
      const active = await agent
        .get("/career")
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${owner.token}`)
        .expect(200);
      const csrf = active.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
      await pool.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [owner.id],
      );
      const response = await agent
        .post("/career/entries")
        .set("Host", "127.0.0.1:3000")
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${owner.token}`)
        .type("form")
        .send({
          csrf,
          ...entry,
          next_action: entry.nextAction,
          self_reported_outcome: entry.selfReportedOutcome,
          sample_only: "yes",
        });
      expect.soft(response.status).toBe(403);
      expect.soft(response.text).toContain("Career planning unavailable");
      expect.soft(await retained(owner.id)).toEqual(before);
    },
  );
});

type Owner = Awaited<ReturnType<typeof fixture>>;
const operations = [
  "enable",
  "disable",
  "createEntry",
  "updateEntry",
  "deleteEntry",
  "createDraft",
  "updateDraft",
  "approveDraft",
  "revokeDraft",
  "deleteDraft",
] as const;
type Operation = (typeof operations)[number];
function mutate(
  target: CareerStore,
  op: Operation,
  owner: Owner,
  memberId = owner.id,
) {
  switch (op) {
    case "enable":
      return target.enable(memberId);
    case "disable":
      return target.disable(memberId);
    case "createEntry":
      return target.createEntry(memberId, entry);
    case "updateEntry":
      return target.updateEntry(memberId, owner.entryId, 1, {
        ...entry,
        title: "Changed invented career",
      });
    case "deleteEntry":
      return target.deleteEntry(memberId, owner.entryId, 1);
    case "createDraft":
      return target.createDraft(memberId, draft);
    case "updateDraft":
      return target.updateDraft(memberId, owner.draftId, 1, {
        ...draft,
        title: "Changed invented draft",
      });
    case "approveDraft":
      return target.approveDraft(memberId, owner.draftId, 1);
    case "revokeDraft":
      return target.revokeDraft(memberId, owner.draftId, 1);
    case "deleteDraft":
      return target.deleteDraft(memberId, owner.draftId, 1);
  }
}
function submission(
  op: Operation,
  owner: Owner,
): [string, Record<string, string>] {
  const entryFields = {
    ...entry,
    next_action: entry.nextAction,
    self_reported_outcome: entry.selfReportedOutcome,
    sample_only: "yes",
    version: "1",
  };
  const draftFields = { ...draft, sample_only: "yes", version: "1" };
  switch (op) {
    case "enable":
    case "disable":
      return [`/career/${op}`, { confirm: "yes" }];
    case "createEntry":
      return ["/career/entries", entryFields];
    case "updateEntry":
      return [`/career/entries/${owner.entryId}/update`, entryFields];
    case "deleteEntry":
      return [
        `/career/entries/${owner.entryId}/delete`,
        { confirm: "yes", version: "1" },
      ];
    case "createDraft":
      return ["/career/drafts", draftFields];
    case "updateDraft":
      return [`/career/drafts/${owner.draftId}/update`, draftFields];
    case "approveDraft":
    case "revokeDraft":
    case "deleteDraft":
      return [
        `/career/drafts/${owner.draftId}/${op.replace("Draft", "")}`,
        { confirm: "yes", version: "1" },
      ];
  }
}
it.each(operations)(
  "denies %s at store and HTTP boundaries during deletion without any row changes",
  async (op) => {
    const owner = await fixture();
    if (op === "revokeDraft")
      await pool.query("UPDATE career_drafts SET approved=true WHERE id=$1", [
        owner.draftId,
      ]);
    const before = await retained(owner.id);
    await withLoopback(
      app(db, { origin, secret: "synthetic-career-secret", career }),
      async (server) => {
        const agent = request.agent(server);
        const active = await agent
          .get("/career")
          .set("Host", "127.0.0.1:3000")
          .set("Cookie", `${COOKIE}=${owner.token}`)
          .expect(200);
        const csrf = active.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
        await pool.query(
          "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
          [owner.id],
        );
        expect(await mutate(career, op, owner)).toBeNull();
        const [path, fields] = submission(op, owner);
        for (let duplicate = 0; duplicate < 2; duplicate++) {
          const response = await agent
            .post(path)
            .set("Host", "127.0.0.1:3000")
            .set("Origin", origin)
            .set("Cookie", `${COOKIE}=${owner.token}`)
            .type("form")
            .send({ csrf, ...fields })
            .expect(403);
          expect(response.text).toContain("Career planning unavailable");
          for (const privateText of [
            entry.title,
            entry.note,
            draft.title,
            draft.body,
          ])
            expect(response.text).not.toContain(privateText);
          expect(await retained(owner.id)).toEqual(before);
        }
      },
    );
  },
);
it("denies enabling an opted-out deleting member and all operations for inactive or missing owners", async () => {
  const owner = await fixture();
  await career.disable(owner.id);
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
    [owner.id],
  );
  expect(await career.enable(owner.id)).toBeNull();
  expect(await retained(owner.id)).toEqual({
    preferences: [],
    entries: [],
    drafts: [],
  });
  for (const state of [
    "revoked",
    "expired",
    "non-member",
    "workspace-missing",
    "principal-missing",
  ] as const) {
    const invalid = await fixture();
    if (state === "revoked")
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [invalid.id],
      );
    if (state === "expired")
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1",
        [invalid.id],
      );
    if (state === "non-member") {
      invalid.id = randomUUID();
      await pool.query(
        "INSERT INTO principals(id,token_hash,kind,expires_at) VALUES($1,$2,'staff',clock_timestamp()+interval '1 day')",
        [invalid.id, randomBytes(32).toString("hex")],
      );
    }
    if (state === "workspace-missing")
      await pool.query("DELETE FROM workspaces WHERE owner_principal_id=$1", [
        invalid.id,
      ]);
    if (state === "principal-missing")
      await pool.query("DELETE FROM principals WHERE id=$1", [invalid.id]);
    const before = await retained(invalid.id);
    for (const op of operations)
      expect(await mutate(career, op, invalid), `${state} ${op}`).toBeNull();
    expect(await retained(invalid.id)).toEqual(before);
  }
});
it("preserves opt-in, exact-version ownership, approval reset and destructive opt-out behavior", async () => {
  const owner = await fixture();
  const other = await member();
  await career.enable(other.id);
  const before = await retained(owner.id);
  for (const op of [
    "updateEntry",
    "deleteEntry",
    "updateDraft",
    "approveDraft",
    "revokeDraft",
    "deleteDraft",
  ] as const)
    expect(await mutate(career, op, owner, other.id)).toBe(false);
  expect(await retained(owner.id)).toEqual(before);
  expect(await career.enable(owner.id)).toBe(true);
  expect(
    await career.updateEntry(owner.id, owner.entryId, 1, {
      ...entry,
      title: "Changed invented career",
    }),
  ).toBe(true);
  expect(await career.updateEntry(owner.id, owner.entryId, 1, entry)).toBe(
    false,
  );
  expect(await career.deleteEntry(owner.id, owner.entryId, 1)).toBe(false);
  expect(await career.deleteEntry(owner.id, owner.entryId, 2)).toBe(true);
  expect(await career.approveDraft(owner.id, owner.draftId, 1)).toBe(true);
  expect(await career.approveDraft(owner.id, owner.draftId, 1)).toBe(false);
  expect(
    await career.updateDraft(owner.id, owner.draftId, 2, {
      ...draft,
      title: "Revised private draft",
    }),
  ).toBe(true);
  expect((await career.snapshot(owner.id))?.drafts[0]).toMatchObject({
    approved: false,
    version: 3,
  });
  expect(await career.approveDraft(owner.id, owner.draftId, 3)).toBe(true);
  expect(await career.revokeDraft(owner.id, owner.draftId, 4)).toBe(true);
  expect(await career.revokeDraft(owner.id, owner.draftId, 4)).toBe(false);
  expect(await career.deleteDraft(owner.id, owner.draftId, 5)).toBe(true);
  await career.createEntry(owner.id, entry);
  await career.createDraft(owner.id, draft);
  expect(await career.disable(owner.id)).toBe(true);
  expect(await career.disable(owner.id)).toBe(false);
  expect(await career.createEntry(owner.id, entry)).toBe(false);
  expect(await career.createDraft(owner.id, draft)).toBe(false);
  expect(await retained(owner.id)).toEqual({
    preferences: [],
    entries: [],
    drafts: [],
  });
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
    career: careerStore({
      connect: async () => ({ query: client.query.bind(client), release() {} }),
    } as unknown as import("pg").Pool),
  };
}
it.each([
  "principal",
  "workspace",
  "entry-row",
  "draft-row",
  "enable-row",
  "disable-cascade",
] as const)(
  "rolls back career work after expiry during an observed %s wait",
  async (boundary) => {
    const owner = await fixture();
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
      const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      const lock =
        boundary === "principal"
          ? "SELECT id FROM principals WHERE id=$1 FOR UPDATE"
          : boundary === "workspace"
            ? "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE"
            : boundary === "entry-row"
              ? "SELECT id FROM career_entries WHERE member_id=$1 FOR UPDATE"
              : boundary === "enable-row"
                ? "SELECT member_id FROM career_preferences WHERE member_id=$1 FOR UPDATE"
                : "SELECT id FROM career_drafts WHERE member_id=$1 FOR UPDATE";
      await blocker.query(lock, [owner.id]);
      const op =
        boundary === "enable-row"
          ? "enable"
          : boundary === "disable-cascade"
            ? "disable"
            : boundary === "entry-row"
              ? "updateEntry"
              : "approveDraft";
      writing = mutate(writer.career, op, owner);
      await waitUntil(
        () => blockedBy(blockerPid, writer.pid),
        "Write did not reach the controlled lock",
      );
      await waitUntil(
        async () =>
          (
            await pool.query(
              "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
              [owner.id],
            )
          ).rows[0].expired,
        "Principal did not expire during observed wait",
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
it.each(["revoked", "deleting"] as const)(
  "denies mutation when %s invalidation wins the lock",
  async (boundary) => {
    const owner = await fixture();
    const before = await retained(owner.id);
    const blocker = await pool.connect();
    const writer = await controlledWriter();
    let writing: Promise<boolean | null> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      await blocker.query(
        boundary === "revoked"
          ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
          : "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [owner.id],
      );
      writing = writer.career.approveDraft(owner.id, owner.draftId, 1);
      await waitUntil(
        () => blockedBy(pid, writer.pid),
        "Write did not wait for invalidation",
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
it.each(["revoked", "deleting"] as const)(
  "commits valid career work before queued %s invalidation",
  async (boundary) => {
    const owner = await fixture();
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
        "SELECT id FROM career_drafts WHERE id=$1 FOR UPDATE",
        [owner.draftId],
      );
      writing = writer.career.approveDraft(owner.id, owner.draftId, 1);
      await waitUntil(
        () => blockedBy(pid, writer.pid),
        "Write did not reach private row after authorization locks",
      );
      invalidating = invalidator.query(
        boundary === "revoked"
          ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
          : "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [owner.id],
      );
      await waitUntil(
        () => blockedBy(writer.pid, invalidatorPid),
        "Invalidation did not serialize after write",
      );
      await blocker.query("COMMIT");
      expect(await writing).toBe(true);
      await invalidating;
      expect((await retained(owner.id)).drafts[0]).toMatchObject({
        approved: true,
        version: 2,
      });
      expect(await career.revokeDraft(owner.id, owner.draftId, 2)).toBeNull();
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
it("allows only one concurrent approval for the same draft version", async () => {
  const owner = await fixture();
  const results = await Promise.all([
    career.approveDraft(owner.id, owner.draftId, 1),
    career.approveDraft(owner.id, owner.draftId, 1),
  ]);
  expect(results.sort()).toEqual([false, true]);
  expect((await retained(owner.id)).drafts[0]).toMatchObject({
    approved: true,
    version: 2,
  });
});
it("returns a generic HTTP failure after a real mutation fault and releases authorization locks", async () => {
  const owner = await fixture();
  const before = await retained(owner.id);
  const writer = await pool.connect();
  const broken = careerStore({
    connect: async () => ({
      query: (sql: string, values?: unknown[]) =>
        writer.query(
          sql.startsWith("UPDATE career_drafts")
            ? "SELECT * FROM synthetic_missing_career_table"
            : sql,
          sql.startsWith("UPDATE career_drafts") ? [] : values,
        ),
      release() {},
    }),
  } as unknown as import("pg").Pool);
  try {
    await withLoopback(
      app(db, { origin, secret: "synthetic-career-secret", career: broken }),
      async (server) => {
        const agent = request.agent(server);
        const page = await agent
          .get("/career")
          .set("Host", "127.0.0.1:3000")
          .set("Cookie", `${COOKIE}=${owner.token}`)
          .expect(200);
        const csrf = page.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
        const response = await agent
          .post(`/career/drafts/${owner.draftId}/approve`)
          .set("Host", "127.0.0.1:3000")
          .set("Origin", origin)
          .set("Cookie", `${COOKIE}=${owner.token}`)
          .type("form")
          .send({ csrf, version: "1", confirm: "yes" })
          .expect(503);
        expect(response.text).toContain("We could not confirm the result");
        expect(response.text).not.toMatch(
          /synthetic_missing_career_table|Private invented proposal/,
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
    expect(await career.approveDraft(owner.id, owner.draftId, 1)).toBe(true);
  } finally {
    writer.release();
  }
});
it("times out a blocked career row without mutation and permits later recovery", async () => {
  const owner = await fixture();
  const before = await retained(owner.id);
  const blocker = await pool.connect();
  let result: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM career_drafts WHERE id=$1 FOR UPDATE", [
      owner.draftId,
    ]);
    result = career
      .approveDraft(owner.id, owner.draftId, 1)
      .catch((error) => error);
    expect(await result).toMatchObject({ code: "55P03" });
    expect(await retained(owner.id)).toEqual(before);
    await blocker.query("COMMIT");
    expect(await career.approveDraft(owner.id, owner.draftId, 1)).toBe(true);
  } finally {
    await blocker.query("ROLLBACK");
    if (result) await Promise.allSettled([result]);
    blocker.release();
  }
}, 10000);
it("reports an uncertain committed career write without replaying it after a lost COMMIT reply", async () => {
  const owner = await fixture();
  const client = await pool.connect();
  let released = false;
  let discarded: Error | undefined;
  let writes = 0;
  const ambiguous = careerStore({
    connect: async () => ({
      async query(sql: string, values?: unknown[]) {
        if (sql.startsWith("UPDATE career_drafts")) writes++;
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
    await expect(
      ambiguous.approveDraft(owner.id, owner.draftId, 1),
    ).rejects.toThrow("Synthetic lost commit acknowledgement");
    expect(writes).toBe(1);
    expect(discarded).toBeInstanceOf(Error);
    expect((await retained(owner.id)).drafts[0]).toMatchObject({
      approved: true,
      version: 2,
    });
    expect(await career.approveDraft(owner.id, owner.draftId, 1)).toBe(false);
    expect((await retained(owner.id)).drafts[0]).toMatchObject({
      approved: true,
      version: 2,
    });
  } finally {
    if (!released) client.release();
  }
});
