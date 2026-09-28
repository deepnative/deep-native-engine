import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  memberExportStore,
  MAX_MEMBER_EXPORT_RECORDS,
} from "../../src/member-export.ts";
import { migrate, store } from "../../src/store.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const exported = memberExportStore(pool);
const token = () => randomBytes(32).toString("hex");
const ready = async (value: string) => {
  const result = await exported.exportOwned(value);
  expect(result.kind).toBe("ready");
  return result.kind === "ready" ? result.payload : {};
};
const member = async () => {
  const value = token();
  await db.create(value, { background: "explorer", goal: "everyday" });
  const session = await db.session(value);
  expect(session.kind).toBe("active");
  return {
    token: value,
    id: session.kind === "active" ? session.learner.id : "",
  };
};

let storageRoot = "";
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
  storageRoot = await mkdtemp(join(tmpdir(), "dne-member-export-race-"));
});
afterEach(async () => rm(storageRoot, { recursive: true, force: true }));
afterAll(async () => pool.end());

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function controlledExport() {
  const authorized = gate(),
    resume = gate(),
    connected = gate();
  const state = { pid: 0, xid: "" };
  const wrapper = {
    async connect() {
      const client = await pool.connect();
      state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      connected.release();
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (
            sql.includes("FROM principals p JOIN learners l") &&
            result.rows[0]
          ) {
            state.xid = (
              await client.query("SELECT pg_current_xact_id()::text AS xid")
            ).rows[0].xid as string;
            authorized.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  return {
    exported: memberExportStore(wrapper),
    authorized,
    resume,
    connected,
    state,
  };
}
async function waitForOperation(
  pid: number,
  blocker: number,
  done: () => boolean,
) {
  const until = performance.now() + 3000;
  while (performance.now() < until) {
    if (done()) return "finished";
    const result = await pool.query(
      "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
      [blocker, pid],
    );
    if (result.rows[0].blocked) return "blocked";
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    "Expected transaction blocking or completion was not observed",
  );
}
function clientPool(client: PoolClient) {
  return {
    query: client.query.bind(client),
    connect: async () => ({ query: client.query.bind(client), release() {} }),
  } as unknown as Pool;
}

async function assertAuthorizationUnlocked(id: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='1s'");
    expect(
      (
        await client.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await client.query(
          "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
          [id],
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

it.each([
  "session revocation",
  "principal deletion",
  "workspace deletion started",
] as const)(
  "withholds private records when %s wins authorization locking",
  async (action) => {
    const owner = await member(),
      other = await member();
    await db.save(owner.id, {
      instruction: "Private losing export marker",
      verification: "Original verification",
      complete: false,
    });
    const mutator = await pool.connect();
    const controlled = controlledExport();
    controlled.resume.release();
    let reading: ReturnType<typeof exported.exportOwned> | undefined;
    let finished = false;
    try {
      const pid = (await mutator.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      await mutator.query("BEGIN");
      if (action === "session revocation")
        await mutator.query(
          "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [owner.id],
        );
      else if (action === "principal deletion")
        await store(clientPool(mutator)).remove(owner.id);
      else
        await mutator.query(
          "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
          [owner.id],
        );
      reading = controlled.exported.exportOwned(owner.token).then((result) => {
        finished = true;
        return result;
      });
      await Promise.race([
        controlled.connected.wait,
        reading.then(() => {
          throw new Error("Export completed before connection gate");
        }),
      ]);
      expect(
        await waitForOperation(controlled.state.pid, pid, () => finished),
      ).toBe("blocked");
      // An unrelated member's export is not blocked by this member's mutation.
      expect(await exported.exportOwned(other.token)).toMatchObject({
        kind: "ready",
        payload: { profile: { id: other.id }, records: { exercises: [] } },
      });
      await mutator.query("COMMIT");
      expect(await reading).toEqual({ kind: "unavailable" });
      expect(await exported.exportOwned(owner.token)).toEqual({
        kind: "denied",
      });
    } finally {
      controlled.resume.release();
      await mutator.query("ROLLBACK");
      await Promise.allSettled(reading ? [reading] : []);
      mutator.release();
    }
  },
);

it("bounds authorization lock waiting, releases failure state and recovers after rollback", async () => {
  const owner = await member();
  await db.save(owner.id, {
    instruction: "Private timeout recovery marker",
    verification: "Original verification",
    complete: false,
  });
  const mutator = await pool.connect();
  const controlled = controlledExport();
  controlled.resume.release();
  let reading: ReturnType<typeof exported.exportOwned> | undefined;
  try {
    await mutator.query("BEGIN");
    const pid = (await mutator.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    await mutator.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [owner.id],
    );
    reading = controlled.exported.exportOwned(owner.token);
    await Promise.race([
      controlled.connected.wait,
      reading.then(() => {
        throw new Error("Export completed before connection gate");
      }),
    ]);
    expect(await waitForOperation(controlled.state.pid, pid, () => false)).toBe(
      "blocked",
    );
    // Leave the competing transaction open until the actual database timeout.
    expect(await reading).toEqual({ kind: "unavailable" });
    expect((await mutator.query("SELECT 1")).rowCount).toBe(1);
    await mutator.query("ROLLBACK");
    await assertAuthorizationUnlocked(owner.id);
    expect(await exported.exportOwned(owner.token)).toMatchObject({
      kind: "ready",
      payload: {
        records: {
          exercises: [{ instruction: "Private timeout recovery marker" }],
        },
      },
    });
  } finally {
    await mutator.query("ROLLBACK");
    await Promise.allSettled(reading ? [reading] : []);
    mutator.release();
  }
}, 15_000);

it("rolls back authorization locks on a database error without disclosing a partial export", async () => {
  const owner = await member();
  await db.save(owner.id, {
    instruction: "Private database recovery marker",
    verification: "Original verification",
    complete: false,
  });
  const wrapper = {
    async connect() {
      const client = await pool.connect();
      return {
        query(sql: string, values?: unknown[]) {
          return sql.includes("FROM lesson_activity")
            ? client.query("SELECT dne_private_export_failure FROM principals")
            : client.query(sql, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  expect(await memberExportStore(wrapper).exportOwned(owner.token)).toEqual({
    kind: "unavailable",
  });
  await assertAuthorizationUnlocked(owner.id);
  expect(await exported.exportOwned(owner.token)).toMatchObject({
    kind: "ready",
    payload: {
      records: {
        exercises: [{ instruction: "Private database recovery marker" }],
      },
    },
  });
});

it("discards a connection whose rollback fails so authorization locks cannot leak into the pool", async () => {
  const owner = await member();
  const exportPool = testPool();
  const wrapper = {
    async connect() {
      const client = await exportPool.connect();
      return {
        query(sql: string, values?: unknown[]) {
          if (sql.includes("FROM exercises") || sql === "ROLLBACK")
            return Promise.reject(new Error("Synthetic failed client write"));
          return client.query(sql, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  try {
    expect(await memberExportStore(wrapper).exportOwned(owner.token)).toEqual({
      kind: "unavailable",
    });
    // No SQL error reached this transaction: it still owns both SHARE locks
    // unless cleanup discards the client after the failed rollback request.
    await assertAuthorizationUnlocked(owner.id);
    expect(await exported.exportOwned(owner.token)).toMatchObject({
      kind: "ready",
      payload: { profile: { id: owner.id } },
    });
  } finally {
    await exportPool.end();
  }
});

async function localDelete(
  client: PoolClient,
  owner: { id: string; token: string },
) {
  const scoped = clientPool(client);
  await evidenceStore(
    scoped,
    fileObjectStorage(storageRoot),
    "synthetic-export-race",
  ).removeWorkspace(owner.token);
  await store(scoped).remove(owner.id);
}

it.each(["session revocation", "account deletion"] as const)(
  "commits the authorized export before concurrent %s can complete",
  async (action) => {
    const owner = await member();
    await db.save(owner.id, {
      instruction: "Private synthetic export marker",
      verification: "Original verification",
      complete: false,
    });
    const controlled = controlledExport();
    const reading = controlled.exported.exportOwned(owner.token);
    const mutator = await pool.connect();
    let changing: Promise<void> | undefined;
    let finished = false;
    let exportStateAtMutation = "";
    try {
      await Promise.race([
        controlled.authorized.wait,
        reading.then(() => {
          throw new Error("Export completed before authorization gate");
        }),
      ]);
      const pid = (await mutator.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      changing = (async () => {
        if (action === "session revocation")
          await mutator.query(
            "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
            [owner.id],
          );
        else await localDelete(mutator, owner);
        exportStateAtMutation = (
          await mutator.query("SELECT pg_xact_status($1::xid8) AS state", [
            controlled.state.xid,
          ])
        ).rows[0].state as string;
        finished = true;
      })();
      const observed = await waitForOperation(
        pid,
        controlled.state.pid,
        () => finished,
      );
      controlled.resume.release();
      expect(await reading).toMatchObject({
        kind: "ready",
        payload: {
          records: {
            exercises: [{ instruction: "Private synthetic export marker" }],
          },
        },
      });
      await changing;
      expect(exportStateAtMutation).toBe("committed");
      expect(observed).toBe("blocked");
      expect(await exported.exportOwned(owner.token)).toEqual({
        kind: "denied",
      });
    } finally {
      controlled.resume.release();
      await Promise.allSettled([reading, ...(changing ? [changing] : [])]);
      mutator.release();
    }
  },
);

it("withholds private records if the session expires during export assembly", async () => {
  const owner = await member();
  await db.save(owner.id, {
    instruction: "Private expiry marker",
    verification: "Invented verification",
    complete: false,
  });
  const deadline = (
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+INTERVAL '5 seconds' WHERE id=$1 RETURNING expires_at",
      [owner.id],
    )
  ).rows[0].expires_at as Date;
  const controlled = controlledExport();
  const reading = controlled.exported.exportOwned(owner.token);
  try {
    await Promise.race([
      controlled.authorized.wait,
      reading.then(() => {
        throw new Error("Export completed before authorization gate");
      }),
    ]);
    const until = performance.now() + 10_000;
    let expired = false;
    while (performance.now() < until) {
      expired = (
        await pool.query(
          "SELECT clock_timestamp()>=$1::timestamptz AS expired",
          [deadline],
        )
      ).rows[0].expired as boolean;
      if (expired) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(expired).toBe(true);
    controlled.resume.release();
    expect(await reading).toEqual({ kind: "denied" });
  } finally {
    controlled.resume.release();
    await Promise.allSettled([reading]);
  }
}, 15_000);

it("exports current structured records only for their active owner, with redaction and deletion", async () => {
  const a = await member();
  const b = await member();
  await pool.query(
    `INSERT INTO learning_milestones(id,member_id,goal_title,milestone_title,next_action)
     VALUES($1,$2,'Invented goal','Invented milestone','Review next step')`,
    [randomUUID(), a.id],
  );
  await pool.query(
    `INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at)
     VALUES($1,$2,'Private idea','Invented proposal text','Original',CURRENT_TIMESTAMP)`,
    [randomUUID(), a.id],
  );
  await pool.query(
    `INSERT INTO member_proposals(id,member_id,title,body,sources,state,
       sample_attested_at,withdrawn_at)
     VALUES($1,$2,NULL,NULL,NULL,'withdrawn',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [randomUUID(), a.id],
  );
  const own = await ready(a.token);
  expect(own).toMatchObject({
    version: "local-member-records-v5",
    profile: { id: a.id, background: "explorer" },
    records: {
      milestones: [{ milestoneTitle: "Invented milestone" }],
    },
  });
  expect(
    (own.records as { proposals: { body: string | null }[] }).proposals,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ body: "Invented proposal text" }),
    ]),
  );
  expect(JSON.stringify(own)).not.toContain("token_hash");
  const other = await ready(b.token);
  expect(other).toMatchObject({ records: { milestones: [], proposals: [] } });
  expect(JSON.stringify(other)).not.toContain("Invented milestone");
  expect(await exported.exportOwned(token())).toEqual({ kind: "denied" });
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1",
    [a.id],
  );
  expect(await exported.exportOwned(a.token)).toEqual({ kind: "denied" });
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP+INTERVAL '1 day' WHERE id=$1",
    [a.id],
  );
  await pool.query(
    "UPDATE member_proposals SET state='withdrawn',title=NULL,body=NULL,sources=NULL,withdrawn_at=CURRENT_TIMESTAMP WHERE member_id=$1",
    [a.id],
  );
  await pool.query("DELETE FROM learning_milestones WHERE member_id=$1", [
    a.id,
  ]);
  const after = await ready(a.token);
  expect(after).toMatchObject({ records: { milestones: [] } });
  expect(
    (after.records as { proposals: { body: string | null }[] }).proposals,
  ).toHaveLength(2);
  expect(
    (after.records as { proposals: { body: string | null }[] }).proposals,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ body: null })]));
  expect(JSON.stringify(after)).not.toContain("Invented proposal text");
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [a.id],
  );
  expect(await exported.exportOwned(a.token)).toEqual({ kind: "denied" });
});

it("fails closed at record and byte limits without returning a partial snapshot", async () => {
  const a = await member();
  for (let i = 0; i <= MAX_MEMBER_EXPORT_RECORDS; i++) {
    await pool.query(
      `INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at)
       VALUES($1,$2,$3,'Invented sample','Original',CURRENT_TIMESTAMP)`,
      [randomUUID(), a.id, `Idea ${i}`],
    );
  }
  expect(await exported.exportOwned(a.token)).toEqual({ kind: "limit" });
  await assertAuthorizationUnlocked(a.id);
  await pool.query("DELETE FROM member_proposals WHERE member_id=$1", [a.id]);
  for (let i = 0; i < 70; i++) {
    await pool.query(
      `INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at)
       VALUES($1,$2,$3,$4,'Original',CURRENT_TIMESTAMP)`,
      [randomUUID(), a.id, `Idea ${i}`, `${i}${"x".repeat(3990)}`],
    );
  }
  expect(await exported.exportOwned(a.token)).toEqual({ kind: "limit" });
  await assertAuthorizationUnlocked(a.id);
  await pool.query("DELETE FROM member_proposals WHERE member_id=$1", [a.id]);
  expect(await exported.exportOwned(a.token)).toMatchObject({
    kind: "ready",
    payload: { records: { proposals: [] } },
  });
});

it("keeps one repeatable-read snapshot when another connection changes a record mid-export", async () => {
  const a = await member();
  const id = randomUUID();
  await pool.query(
    `INSERT INTO learning_milestones(id,member_id,goal_title,milestone_title,next_action)
     VALUES($1,$2,'Original goal','Original milestone','Original next action')`,
    [id, a.id],
  );
  const wrapper = {
    connect: async () => {
      const client = await pool.connect();
      let changed = false;
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (!changed && sql.includes("FROM principals p JOIN learners l")) {
            changed = true;
            await pool.query(
              "UPDATE learning_milestones SET milestone_title='Later milestone' WHERE id=$1",
              [id],
            );
          }
          return result;
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool;
  const result = await memberExportStore(wrapper).exportOwned(a.token);
  expect(result).toMatchObject({
    kind: "ready",
    payload: {
      records: { milestones: [{ milestoneTitle: "Original milestone" }] },
    },
  });
  expect((await ready(a.token)).records).toMatchObject({
    milestones: [{ milestoneTitle: "Later milestone" }],
  });
});

it("returns unavailable on database failure without exposing query or member data", async () => {
  const bad = memberExportStore({
    connect: async () => {
      throw new Error("private db details");
    },
  } as unknown as Pool);
  expect(await bad.exportOwned(token())).toEqual({ kind: "unavailable" });
});
