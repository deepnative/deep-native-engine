import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { practiceStore } from "../../src/practice.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { authorizationStore } from "../../src/authorization.ts";
import type { Pool } from "pg";
import {
  memberExportStore,
  MAX_MEMBER_EXPORT_RECORDS,
} from "../../src/member-export.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const practice = practiceStore(pool);
const catalog = catalogStore(pool);
const token = () => randomBytes(32).toString("hex");
beforeAll(async () => {
  await migrate(pool);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE adapter_jobs, principals, cohorts, content_versions CASCADE",
  );
});
afterAll(async () => {
  await pool.end();
});
async function member() {
  const value = token();
  await db.create(value, { background: "explorer", goal: "everyday" });
  const session = await db.session(value);
  if (session.kind !== "active") throw Error("Synthetic member unavailable");
  return { token: value, id: session.learner.id };
}
async function fixture() {
  const owner = await member(),
    other = await member();
  const editor = token(),
    reviewer = token();
  const auth = authorizationStore(pool);
  await auth.provisionStaff(editor, "editor", new Date(Date.now() + 86400000));
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86400000),
  );
  const source: DraftContent = {
    id: "SYN-130",
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: "Invented practice source",
    body: "Compare only invented examples.",
    owner: "Synthetic editor",
    sources: "Original synthetic work",
    rights: "Owned synthetic work",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
  };
  const publish = async (version: number, id = source.id) => {
    expect(await catalog.createDraft(editor, { ...source, id, version })).toBe(
      true,
    );
    expect(await catalog.submit(editor, id, version)).toBe(true);
    expect(await catalog.approve(reviewer, id, version, true)).toBe(true);
    expect(await catalog.publish(editor, id, version)).toBe(true);
  };
  await publish(1);
  return { owner, other, editor, publish, source };
}
it("redacts one owned saved response and retains an idempotent marker that rejects stale saves", async () => {
  const { owner, other, source } = await fixture();
  expect(
    await practice.save(owner.token, source.id, 1, "Private invented response"),
  ).toBe("saved");
  expect(
    await practice.save(other.token, source.id, 1, "Other invented response"),
  ).toBe("saved");
  expect(await practice.withdraw(owner.token, source.id, 1)).toBe("withdrawn");
  const history = await practice.history(owner.token);
  expect(history).toMatchObject([
    { response: null, withdrawnAt: expect.any(Date) },
  ]);
  expect(await practice.withdraw(owner.token, source.id, 1)).toBe(
    "already-withdrawn",
  );
  expect(await practice.history(owner.token)).toEqual(history);
  expect(
    await practice.save(owner.token, source.id, 1, "Private invented response"),
  ).toBe("withdrawn");
  expect(await practice.current(owner.token, source.id)).toMatchObject({
    response: null,
    withdrawnAt: expect.any(Date),
  });
  expect(await practice.history(other.token)).toMatchObject([
    { response: "Other invented response", withdrawnAt: null },
  ]);
});

it("withdraws retained exact versions after replacement, retirement and goal changes without restoring eligibility", async () => {
  const { owner, publish, editor, source } = await fixture();
  await practice.save(
    owner.token,
    source.id,
    1,
    "Version one invented response",
  );
  await publish(2);
  await practice.save(
    owner.token,
    source.id,
    2,
    "Version two invented response",
  );
  await publish(1, "SYN-131");
  await practice.save(owner.token, "SYN-131", 1, "Unrelated invented response");
  expect(await practice.withdraw(owner.token, source.id, 1)).toBe("withdrawn");
  await catalog.retire(editor, source.id);
  await pool.query("UPDATE learners SET goal='work' WHERE id=$1", [owner.id]);
  expect(await practice.withdraw(owner.token, source.id, 2)).toBe("withdrawn");
  expect(await practice.current(owner.token, source.id)).toBeNull();
  expect(await practice.history(owner.token)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: source.id,
        version: 1,
        response: null,
        available: false,
      }),
      expect.objectContaining({
        id: source.id,
        version: 2,
        response: null,
        available: false,
      }),
      expect.objectContaining({
        id: "SYN-131",
        response: "Unrelated invented response",
        withdrawnAt: null,
      }),
    ]),
  );
  expect(
    (
      await pool.query(
        "SELECT state FROM content_versions WHERE id=$1 ORDER BY version",
        [source.id],
      )
    ).rows,
  ).toEqual([{ state: "retired" }, { state: "retired" }]);
});
it("denies other identities and forged keys while preserving their separate notes", async () => {
  const { owner, other, editor, source } = await fixture();
  await practice.save(
    owner.token,
    source.id,
    1,
    "Owner-only invented response",
  );
  for (const outsider of [other.token, editor, token()]) {
    expect(await practice.withdraw(outsider, source.id, 1)).toBe("unavailable");
    expect(await practice.history(outsider)).toEqual([]);
  }
  for (const [id, version] of [
    ["SYN-999", 1],
    [source.id, 2],
    ["bad", 1],
    [source.id, 0],
    [source.id, 2147483648],
  ] as const)
    expect(await practice.withdraw(owner.token, id, version)).toBe(
      "unavailable",
    );
  expect(await practice.history(owner.token)).toMatchObject([
    { response: "Owner-only invented response", withdrawnAt: null },
  ]);
});

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function controlled(match = "SELECT id FROM workspaces") {
  const connected = latch(),
    reached = latch(),
    resume = latch();
  const state = { pid: 0 };
  const wrapper = {
    async connect() {
      const client = await pool.connect();
      state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      connected.release();
      let paused = false;
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (!paused && sql.startsWith(match)) {
            paused = true;
            reached.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  return {
    practice: practiceStore(wrapper),
    connected,
    reached,
    resume,
    state,
  };
}
async function blocked(pid: number, by: number) {
  for (let count = 0; count < 200; count++) {
    if (
      (
        await pool.query(
          "SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked",
          [by, pid],
        )
      ).rows[0].blocked
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected real PostgreSQL lock wait was not observed");
}
async function unlocked(ownerId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT id FROM principals WHERE id=$1 FOR UPDATE NOWAIT",
      [ownerId],
    );
    await client.query(
      "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE NOWAIT",
      [ownerId],
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
it.each(["save-first", "withdraw-first"] as const)(
  "serializes %s with observed blocking and no response resurrection",
  async (order) => {
    const { owner, source } = await fixture();
    if (order === "withdraw-first")
      await practice.save(
        owner.token,
        source.id,
        1,
        "Original invented response",
      );
    const first = controlled(),
      second = controlled("never-paused");
    second.resume.release();
    const a =
      order === "save-first"
        ? first.practice.save(
            owner.token,
            source.id,
            1,
            "Original invented response",
          )
        : first.practice.withdraw(owner.token, source.id, 1);
    let b: Promise<string> | undefined;
    try {
      await first.reached.wait;
      b =
        order === "save-first"
          ? second.practice.withdraw(owner.token, source.id, 1)
          : second.practice.save(
              owner.token,
              source.id,
              1,
              "Original invented response",
            );
      await second.connected.wait;
      await blocked(second.state.pid, first.state.pid);
      first.resume.release();
      expect(await a).toBe(order === "save-first" ? "saved" : "withdrawn");
      expect(await b).toBe("withdrawn");
      expect(await practice.history(owner.token)).toMatchObject([
        { response: null, withdrawnAt: expect.any(Date) },
      ]);
      expect(
        await practice.save(owner.token, source.id, 1, "New invented response"),
      ).toBe("withdrawn");
    } finally {
      first.resume.release();
      await Promise.allSettled([a, ...(b ? [b] : [])]);
    }
  },
);
it("does not invent a marker when withdrawal precedes the first-ever save", async () => {
  const { owner, source } = await fixture();
  expect(await practice.withdraw(owner.token, source.id, 1)).toBe(
    "unavailable",
  );
  expect(
    await practice.save(owner.token, source.id, 1, "First invented response"),
  ).toBe("saved");
});
it.each(["delete", "revoke", "deletion-marker"] as const)(
  "commits withdrawal before a later %s can acquire its lock",
  async (action) => {
    const { owner, source } = await fixture();
    await practice.save(owner.token, source.id, 1, "Private invented response");
    const first = controlled();
    const withdrawing = first.practice.withdraw(owner.token, source.id, 1);
    const mutator = await pool.connect();
    let changing: Promise<unknown> | undefined;
    try {
      await first.reached.wait;
      const pid = (await mutator.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      changing =
        action === "delete"
          ? store(mutator as unknown as Pool).remove(owner.id)
          : mutator.query(
              action === "revoke"
                ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
                : "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
              [owner.id],
            );
      await blocked(pid, first.state.pid);
      first.resume.release();
      expect(await withdrawing).toBe("withdrawn");
      await changing;
      expect(await practice.withdraw(owner.token, source.id, 1)).toBe(
        "unavailable",
      );
      expect(
        await practice.save(owner.token, source.id, 1, "Stale response"),
      ).toBe("unavailable");
      expect(await practice.history(owner.token)).toEqual([]);
      const rows = (
        await pool.query(
          "SELECT response,withdrawn_at FROM private_practice WHERE member_id=$1",
          [owner.id],
        )
      ).rows;
      expect(rows).toEqual(
        action === "delete"
          ? []
          : [{ response: null, withdrawn_at: expect.any(Date) }],
      );
    } finally {
      first.resume.release();
      await Promise.allSettled([withdrawing, ...(changing ? [changing] : [])]);
      mutator.release();
    }
  },
);
it.each(["save", "withdraw"] as const)(
  "denies waiting %s when deletion, revocation, or a deletion marker commits first",
  async (operation) => {
    for (const action of ["delete", "revoke", "deletion-marker"] as const) {
      const { owner, source } = await fixture();
      await practice.save(
        owner.token,
        source.id,
        1,
        "Private invented response",
      );
      const mutator = await pool.connect(),
        waiting = controlled("never-paused");
      waiting.resume.release();
      let pending: Promise<string> | undefined;
      try {
        await mutator.query("BEGIN");
        const pid = (await mutator.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid as number;
        if (action === "delete")
          await store(mutator as unknown as Pool).remove(owner.id);
        else
          await mutator.query(
            action === "revoke"
              ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
              : "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
            [owner.id],
          );
        pending = waiting.practice[operation](
          owner.token,
          source.id,
          1,
          "Stale response",
        );
        await waiting.connected.wait;
        await blocked(waiting.state.pid, pid);
        await mutator.query("COMMIT");
        expect(await pending).toBe("unavailable");
        expect(await practice.current(owner.token, source.id)).toBeNull();
        expect(await practice.history(owner.token)).toEqual([]);
        const rows = (
          await pool.query(
            "SELECT response FROM private_practice WHERE member_id=$1",
            [owner.id],
          )
        ).rows;
        expect(rows).toEqual(
          action === "delete"
            ? []
            : [{ response: "Private invented response" }],
        );
      } finally {
        await mutator.query("ROLLBACK");
        await Promise.allSettled(pending ? [pending] : []);
        mutator.release();
      }
      // Release published synthetic sources before the next independent case.
      await pool.query(
        "TRUNCATE adapter_jobs, principals, cohorts, content_versions CASCADE",
      );
    }
  },
);
it.each(["save", "withdraw"] as const)(
  "rolls back %s if its session expires while waiting on the workspace",
  async (operation) => {
    const { owner, source } = await fixture();
    if (operation === "withdraw")
      await practice.save(
        owner.token,
        source.id,
        1,
        "Preserve invented response",
      );
    const expires = (
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+INTERVAL '1 second' WHERE id=$1 RETURNING expires_at",
        [owner.id],
      )
    ).rows[0].expires_at as Date;
    const mutator = await pool.connect(),
      waiting = controlled("never-paused");
    waiting.resume.release();
    let pending: Promise<string> | undefined;
    try {
      await mutator.query("BEGIN");
      const pid = (await mutator.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      await mutator.query(
        "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
        [owner.id],
      );
      pending = waiting.practice[operation](
        owner.token,
        source.id,
        1,
        "Uncommitted invented response",
      );
      await waiting.connected.wait;
      await blocked(waiting.state.pid, pid);
      while (
        !(
          await pool.query("SELECT clock_timestamp()>=$1 AS expired", [expires])
        ).rows[0].expired
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      await mutator.query("COMMIT");
      expect(await pending).toBe("unavailable");
      expect(
        (
          await pool.query(
            "SELECT response,withdrawn_at FROM private_practice WHERE member_id=$1",
            [owner.id],
          )
        ).rows,
      ).toEqual(
        operation === "save"
          ? []
          : [{ response: "Preserve invented response", withdrawn_at: null }],
      );
      expect(await practice.withdraw(owner.token, source.id, 1)).toBe(
        "unavailable",
      );
      expect(await practice.current(owner.token, source.id)).toBeNull();
      expect(await practice.history(owner.token)).toEqual([]);
      await unlocked(owner.id);
    } finally {
      await mutator.query("ROLLBACK");
      await Promise.allSettled(pending ? [pending] : []);
      mutator.release();
    }
  },
);

it.each(["immediate", "deferred"] as const)(
  "rolls back the entire redaction when a real PostgreSQL %s constraint fails",
  async (timing) => {
    const { owner, source } = await fixture();
    await practice.save(
      owner.token,
      source.id,
      1,
      "Preserve on failed redaction",
    );
    await pool.query(
      `CREATE FUNCTION dne_test_practice_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic practice failure'; END $$`,
    );
    await pool.query(
      `CREATE ${timing === "deferred" ? "CONSTRAINT" : ""} TRIGGER dne_test_practice_reject AFTER UPDATE ON private_practice ${timing === "deferred" ? "DEFERRABLE INITIALLY DEFERRED" : ""} FOR EACH ROW EXECUTE FUNCTION dne_test_practice_reject()`,
    );
    try {
      await expect(
        practice.withdraw(owner.token, source.id, 1),
      ).rejects.toThrow("Synthetic practice failure");
      expect(await practice.history(owner.token)).toMatchObject([
        { response: "Preserve on failed redaction", withdrawnAt: null },
      ]);
      await unlocked(owner.id);
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS dne_test_practice_reject ON private_practice",
      );
      await pool.query("DROP FUNCTION IF EXISTS dne_test_practice_reject()");
    }
    expect(await practice.withdraw(owner.token, source.id, 1)).toBe(
      "withdrawn",
    );
  },
);
it("discards a failed rollback connection so redaction and authorization locks cannot leak", async () => {
  const { owner, source } = await fixture();
  await practice.save(
    owner.token,
    source.id,
    1,
    "Preserve on rollback failure",
  );
  const isolated = testPool();
  const wrapper = {
    async connect() {
      const client = await isolated.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql === "COMMIT" || sql === "ROLLBACK")
            throw Error("Synthetic disconnected commit");
          return client.query(sql, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  try {
    await expect(
      practiceStore(wrapper).withdraw(owner.token, source.id, 1),
    ).rejects.toThrow("Synthetic disconnected commit");
    await unlocked(owner.id);
    expect(await practice.history(owner.token)).toMatchObject([
      { response: "Preserve on rollback failure", withdrawnAt: null },
    ]);
  } finally {
    await isolated.end();
  }
});
it("returns an unknown commit error even if redaction committed, and retry reads the retained marker", async () => {
  const { owner, source } = await fixture();
  await practice.save(
    owner.token,
    source.id,
    1,
    "Private commit ambiguity response",
  );
  const wrapper = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (sql === "COMMIT")
            throw Error("Synthetic lost commit acknowledgement");
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  await expect(
    practiceStore(wrapper).withdraw(owner.token, source.id, 1),
  ).rejects.toThrow("Synthetic lost commit acknowledgement");
  expect(await practice.history(owner.token)).toMatchObject([
    { response: null, withdrawnAt: expect.any(Date) },
  ]);
  expect(await practice.withdraw(owner.token, source.id, 1)).toBe(
    "already-withdrawn",
  );
});
it("preserves response boundaries and rejects inconsistent active/withdrawn rows at the database boundary", async () => {
  const { owner, source } = await fixture();
  for (const response of ["", " ", "x".repeat(1001)])
    await expect(
      practice.save(owner.token, source.id, 1, response),
    ).rejects.toMatchObject({ code: "23514" });
  expect(await practice.save(owner.token, source.id, 1, "x".repeat(1000))).toBe(
    "saved",
  );
  await expect(
    pool.query("UPDATE private_practice SET response=NULL WHERE member_id=$1", [
      owner.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    pool.query(
      "UPDATE private_practice SET withdrawn_at=clock_timestamp() WHERE member_id=$1",
      [owner.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  expect(await practice.withdraw(owner.token, source.id, 1)).toBe("withdrawn");
  await expect(
    pool.query(
      "UPDATE private_practice SET response='Restored text' WHERE member_id=$1",
      [owner.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it("exports v8 marker metadata with null response, keeps other notes private and cascades account deletion", async () => {
  const { owner, other, source, publish } = await fixture();
  const exports = memberExportStore(pool);
  await practice.save(
    owner.token,
    source.id,
    1,
    "Withdraw this private response",
  );
  await practice.save(
    other.token,
    source.id,
    1,
    "Other member private response",
  );
  await publish(1, "SYN-131");
  await practice.save(owner.token, "SYN-131", 1, "Keep this private response");
  await practice.withdraw(owner.token, source.id, 1);
  const exported = await exports.exportOwned(owner.token);
  expect(exported).toMatchObject({
    kind: "ready",
    payload: {
      version: "local-member-records-v15",
      records: {
        privatePractice: [
          {
            contentId: source.id,
            contentVersion: 1,
            response: null,
            state: "withdrawn",
            withdrawnAt: expect.any(Date),
          },
          {
            contentId: "SYN-131",
            response: "Keep this private response",
            state: "saved",
            withdrawnAt: null,
          },
        ],
      },
    },
  });
  expect(JSON.stringify(exported)).not.toMatch(
    /Withdraw this private response|Other member private response|comparison/,
  );
  expect(await exports.exportOwned(other.token)).toMatchObject({
    kind: "ready",
    payload: {
      records: {
        privatePractice: [
          {
            response: "Other member private response",
            state: "saved",
            withdrawnAt: null,
          },
        ],
      },
    },
  });
  await db.remove(owner.id);
  expect(
    (
      await pool.query(
        "SELECT response FROM private_practice WHERE member_id=$1",
        [owner.id],
      )
    ).rows,
  ).toEqual([]);
  expect(await exports.exportOwned(owner.token)).toEqual({ kind: "denied" });
  expect(await practice.history(other.token)).toMatchObject([
    { response: "Other member private response" },
  ]);
});
it("continues beyond the per-page cap without losing or disclosing withdrawn practice text", async () => {
  const owner = await member();
  await pool.query(
    `INSERT INTO content_versions(id,version,kind,origin,title,body,owner,sources,rights)
    SELECT 'SYN-139',n,'lesson','curated','Synthetic source','Synthetic body','Synthetic owner','Original','Owned'
    FROM generate_series(1,$1) n`,
    [MAX_MEMBER_EXPORT_RECORDS + 1],
  );
  await pool.query(
    `INSERT INTO private_practice(member_id,content_id,content_version,goal_at_save,response,withdrawn_at)
    SELECT $1,'SYN-139',n,'everyday',NULL,clock_timestamp() FROM generate_series(1,$2) n`,
    [owner.id, MAX_MEMBER_EXPORT_RECORDS],
  );
  const exports = memberExportStore(pool);
  const exact = await exports.exportOwned(owner.token);
  expect(exact.kind).toBe("ready");
  if (exact.kind !== "ready") throw Error("Synthetic export unavailable");
  expect(
    (exact.payload.records as { privatePractice: unknown[] }).privatePractice,
  ).toHaveLength(MAX_MEMBER_EXPORT_RECORDS);
  await pool.query(
    `INSERT INTO private_practice(member_id,content_id,content_version,goal_at_save,response,withdrawn_at)
    VALUES($1,'SYN-139',$2,'everyday',NULL,clock_timestamp())`,
    [owner.id, MAX_MEMBER_EXPORT_RECORDS + 1],
  );
  const first = await exports.exportOwned(owner.token);
  expect(first).toMatchObject({
    kind: "ready",
    payload: {
      page: {
        recordCount: 100,
        complete: false,
        nextCursor: expect.any(String),
      },
    },
  });
  if (first.kind !== "ready") throw Error("Synthetic first page unavailable");
  expect(first.payload.records.privatePractice).toHaveLength(100);
  expect(
    first.payload.records.privatePractice!.every(
      (row) => row.response === null && row.state === "withdrawn",
    ),
  ).toBe(true);
  const last = await exports.exportOwned(
    owner.token,
    first.payload.page.nextCursor!,
  );
  expect(last).toMatchObject({
    kind: "ready",
    payload: {
      records: {
        privatePractice: [
          {
            contentId: "SYN-139",
            contentVersion: 101,
            response: null,
            state: "withdrawn",
          },
        ],
      },
      page: { number: 2, recordCount: 1, complete: true, nextCursor: null },
    },
  });
  if (last.kind !== "ready") throw Error("Synthetic last page unavailable");
  expect(
    [
      ...first.payload.records.privatePractice!,
      ...last.payload.records.privatePractice!,
    ].map((row) => row.contentVersion),
  ).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
});

it("never exports a stale response after waiting for a concurrent withdrawal to commit", async () => {
  const { owner, source } = await fixture();
  await practice.save(
    owner.token,
    source.id,
    1,
    "Private export race response",
  );
  const first = controlled();
  const withdrawing = first.practice.withdraw(owner.token, source.id, 1);
  const connected = latch();
  const state = { pid: 0 };
  const exportPool = {
    async connect() {
      const client = await pool.connect();
      state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      connected.release();
      return client;
    },
  } as unknown as Pool;
  let exporting:
    ReturnType<ReturnType<typeof memberExportStore>["exportOwned"]> | undefined;
  try {
    await first.reached.wait;
    exporting = memberExportStore(exportPool).exportOwned(owner.token);
    await connected.wait;
    await blocked(state.pid, first.state.pid);
    first.resume.release();
    expect(await withdrawing).toBe("withdrawn");
    const result = await exporting;
    expect(JSON.stringify(result)).not.toContain(
      "Private export race response",
    );
    expect(result.kind).toMatch(/^(ready|unavailable)$/);
    if (result.kind === "ready")
      expect(result.payload.records).toMatchObject({
        privatePractice: [
          { response: null, state: "withdrawn", withdrawnAt: expect.any(Date) },
        ],
      });
    expect(
      await memberExportStore(pool).exportOwned(owner.token),
    ).toMatchObject({
      kind: "ready",
      payload: {
        records: { privatePractice: [{ response: null, state: "withdrawn" }] },
      },
    });
  } finally {
    first.resume.release();
    await Promise.allSettled([withdrawing, ...(exporting ? [exporting] : [])]);
  }
});

it("finishes an export holding the workspace before concurrent withdrawal can commit", async () => {
  const { owner, source } = await fixture();
  await practice.save(
    owner.token,
    source.id,
    1,
    "Saved before withdrawal begins",
  );
  const reached = latch(),
    resume = latch();
  const state = { pid: 0, xid: "" };
  const exportPool = {
    async connect() {
      const client = await pool.connect();
      state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (sql.includes("FROM principals p JOIN learners l")) {
            state.xid = (
              await client.query("SELECT pg_current_xact_id()::text AS xid")
            ).rows[0].xid as string;
            reached.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const exporting = memberExportStore(exportPool).exportOwned(owner.token);
  const second = controlled("never-paused");
  second.resume.release();
  let withdrawing: Promise<string> | undefined;
  try {
    await reached.wait;
    withdrawing = second.practice.withdraw(owner.token, source.id, 1);
    await second.connected.wait;
    await blocked(second.state.pid, state.pid);
    resume.release();
    expect(await exporting).toMatchObject({
      kind: "ready",
      payload: {
        records: {
          privatePractice: [
            { response: "Saved before withdrawal begins", state: "saved" },
          ],
        },
      },
    });
    expect(await withdrawing).toBe("withdrawn");
    expect(
      (
        await pool.query("SELECT pg_xact_status($1::xid8) AS state", [
          state.xid,
        ])
      ).rows[0].state,
    ).toBe("committed");
    expect(
      await memberExportStore(pool).exportOwned(owner.token),
    ).toMatchObject({
      kind: "ready",
      payload: {
        records: { privatePractice: [{ response: null, state: "withdrawn" }] },
      },
    });
  } finally {
    resume.release();
    await Promise.allSettled([
      exporting,
      ...(withdrawing ? [withdrawing] : []),
    ]);
  }
});
