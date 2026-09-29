import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { LESSON } from "../../src/content.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const access = authorizationStore(pool);
const token = () => randomBytes(32).toString("hex");
const paths = ["member", "assignment", "support"] as const;
type AccessPath = (typeof paths)[number];
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, cohorts CASCADE");
});
afterAll(async () => pool.end());

async function member() {
  const value = token();
  await db.create(value, { background: "explorer", goal: "everyday" });
  const session = await db.session(value);
  if (session.kind !== "active") throw Error("Synthetic member unavailable");
  await db.save(session.learner.id, {
    instruction: "Private invented instruction",
    verification: "Private invented verification",
    complete: true,
  });
  return { token: value, id: session.learner.id };
}
async function fixture(via: AccessPath) {
  const owner = await member();
  const purpose = "Resolve synthetic support request";
  let reader = owner;
  let grantId: string | null = null;
  if (via !== "member") {
    const expires = new Date(Date.now() + 60_000);
    const admin = await access.provisionStaff(
      token(),
      "platform_admin",
      expires,
    );
    const value = token();
    reader = {
      token: value,
      id: await access.provisionStaff(
        value,
        via === "assignment" ? "coach" : "operator",
        expires,
      ),
    };
    grantId =
      via === "assignment"
        ? await access.grantAssignment(
            admin,
            reader.id,
            owner.id,
            "coach",
            purpose,
            expires,
          )
        : await access.grantSupport(
            admin,
            reader.id,
            owner.id,
            "operator",
            purpose,
            expires,
          );
  }
  return {
    owner,
    reader,
    grantId,
    purpose,
    read(target = access) {
      return target.readWorkspace(
        reader.token,
        owner.id,
        via === "support" ? purpose : undefined,
      );
    },
  };
}
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function controlled(pauseBeforeCommit = false) {
  const connected = latch(),
    reached = latch(),
    resume = latch();
  const state = { pid: 0 };
  const wrapped = {
    async connect() {
      const client = await pool.connect();
      state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      connected.release();
      return {
        async query(sql: string, values?: unknown[]) {
          if (pauseBeforeCommit && sql === "COMMIT") {
            reached.release();
            await resume.wait;
          }
          return client.query(sql, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  return { wrapped, connected, reached, resume, state };
}
async function blocked(waiter: number, blocker: number) {
  for (let count = 0; count < 200; count++) {
    const result = await pool.query(
      "SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked",
      [blocker, waiter],
    );
    if (result.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected real PostgreSQL lock wait was not observed");
}
async function redact(client: { query: Pool["query"] }, ownerId: string) {
  await client.query(
    "UPDATE exercises SET instruction=NULL,verification=NULL,withdrawn_at=clock_timestamp() WHERE workspace_id=$1",
    [ownerId],
  );
}

it.each(paths)(
  "%s reads return a withdrawn marker and preserve other owners, records and completion metadata",
  async (via) => {
    const f = await fixture(via);
    const other = await member();
    const before = await f.read();
    await pool.query(
      `INSERT INTO exercises(learner_id,workspace_id,lesson_id,lesson_version,instruction,verification)
    VALUES($1,$1,'another-private-lesson',1,'Keep this draft','Keep this check')`,
      [f.owner.id],
    );
    expect(
      await db.withdrawExercise(f.owner.token, LESSON.id, LESSON.version),
    ).toBe("withdrawn");
    const after = await f.read();
    expect(before.kind).toBe("allowed");
    expect(after.kind).toBe("allowed");
    if (before.kind !== "allowed" || after.kind !== "allowed")
      throw Error("Synthetic read denied");
    expect(after.records).toEqual(
      expect.arrayContaining([
        {
          ...before.records[0],
          instruction: null,
          verification: null,
          withdrawnAt: expect.any(Date),
        },
        expect.objectContaining({
          instruction: "Keep this draft",
          verification: "Keep this check",
          withdrawnAt: null,
        }),
      ]),
    );
    expect(JSON.stringify(after)).not.toMatch(
      /Private invented instruction|Private invented verification/,
    );
    expect(await access.readWorkspace(other.token, other.id)).toMatchObject({
      kind: "allowed",
      records: [{ instruction: "Private invented instruction" }],
    });
    expect(await access.readWorkspace(other.token, f.owner.id)).toEqual({
      kind: "denied",
    });
    if (via === "support")
      expect(
        await access.readWorkspace(f.reader.token, f.owner.id, "wrong purpose"),
      ).toEqual({ kind: "denied" });
    const events = (
      await pool.query(
        "SELECT grant_type,grant_id FROM authorization_audit WHERE workspace_id=$1 AND action='workspace_read'",
        [f.owner.id],
      )
    ).rows;
    expect(events).toEqual(
      via === "member"
        ? []
        : Array(2).fill({ grant_type: via, grant_id: f.grantId }),
    );
  },
);

it.each(paths)(
  "%s read waits for withdrawal-first and returns no pre-withdrawal text",
  async (via) => {
    const f = await fixture(via);
    const writer = controlled(true);
    const writing = store(writer.wrapped).withdrawExercise(
      f.owner.token,
      LESSON.id,
      LESSON.version,
    );
    const reading = controlled();
    let pending: ReturnType<typeof f.read> | undefined;
    try {
      await writer.reached.wait;
      pending = f.read(authorizationStore(reading.wrapped));
      await reading.connected.wait;
      await blocked(reading.state.pid, writer.state.pid);
      writer.resume.release();
      expect(await writing).toBe("withdrawn");
      expect(await pending).toMatchObject({
        kind: "allowed",
        records: [
          {
            instruction: null,
            verification: null,
            withdrawnAt: expect.any(Date),
          },
        ],
      });
    } finally {
      writer.resume.release();
      await Promise.allSettled([writing, ...(pending ? [pending] : [])]);
    }
  },
);

it.each(paths)(
  "%s read-first forms its result before withdrawal can commit",
  async (via) => {
    const f = await fixture(via);
    const reading = controlled(true);
    const pending = f.read(authorizationStore(reading.wrapped));
    const writer = controlled();
    let writing: Promise<unknown> | undefined;
    try {
      await reading.reached.wait;
      writing = store(writer.wrapped).withdrawExercise(
        f.owner.token,
        LESSON.id,
        LESSON.version,
      );
      await writer.connected.wait;
      await blocked(writer.state.pid, reading.state.pid);
      reading.resume.release();
      expect(await pending).toMatchObject({
        kind: "allowed",
        records: [
          { instruction: "Private invented instruction", withdrawnAt: null },
        ],
      });
      expect(await writing).toBe("withdrawn");
      expect(await f.read()).toMatchObject({
        kind: "allowed",
        records: [
          {
            instruction: null,
            verification: null,
            withdrawnAt: expect.any(Date),
          },
        ],
      });
    } finally {
      reading.resume.release();
      await Promise.allSettled([pending, ...(writing ? [writing] : [])]);
    }
  },
);

it("a row-lock wait refreshes text even when a concurrent redaction does not lock the workspace", async () => {
  const f = await fixture("assignment");
  const writer = await pool.connect();
  const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid as number;
  const reading = controlled();
  let pending: ReturnType<typeof f.read> | undefined;
  try {
    await writer.query("BEGIN");
    await redact(writer, f.owner.id);
    pending = f.read(authorizationStore(reading.wrapped));
    await reading.connected.wait;
    await blocked(reading.state.pid, pid);
    await writer.query("COMMIT");
    expect(await pending).toMatchObject({
      kind: "allowed",
      records: [
        {
          instruction: null,
          verification: null,
          withdrawnAt: expect.any(Date),
        },
      ],
    });
  } finally {
    await writer.query("ROLLBACK");
    await pending;
    writer.release();
  }
});

it.each(["principal", "grant"])(
  "expiration of the %s during a lock wait denies content and rolls back its read audit",
  async (expiry) => {
    const f = await fixture("support");
    const expires = new Date(Date.now() + 500);
    if (expiry === "principal")
      await pool.query("UPDATE principals SET expires_at=$2 WHERE id=$1", [
        f.reader.id,
        expires,
      ]);
    else
      await pool.query(
        "UPDATE support_access_grants SET expires_at=$2 WHERE id=$1",
        [f.grantId, expires],
      );
    const writer = await pool.connect();
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    const reading = controlled();
    let pending: ReturnType<typeof f.read> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        f.owner.id,
      ]);
      pending = f.read(authorizationStore(reading.wrapped));
      await reading.connected.wait;
      await blocked(reading.state.pid, pid);
      await pool.query(
        "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM $1::timestamptz-clock_timestamp())))",
        [expires],
      );
      await writer.query("COMMIT");
      expect(await pending).toEqual({ kind: "denied" });
      expect(
        (
          await pool.query(
            "SELECT id FROM authorization_audit WHERE action='workspace_read'",
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await writer.query("ROLLBACK");
      await pending;
      writer.release();
    }
  },
);

it("audit failure returns no content and releases all privacy locks for recovery", async () => {
  const f = await fixture("assignment");
  try {
    await pool.query(
      "CREATE FUNCTION reject_workspace_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$",
    );
    await pool.query(
      "CREATE TRIGGER reject_workspace_read BEFORE INSERT ON authorization_audit FOR EACH ROW EXECUTE FUNCTION reject_workspace_read()",
    );
    await expect(f.read()).rejects.toThrow("Synthetic audit failure");
    expect(
      (
        await pool.query(
          "SELECT id FROM authorization_audit WHERE action='workspace_read'",
        )
      ).rows,
    ).toEqual([]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM principals WHERE id=$1 FOR UPDATE NOWAIT",
        [f.reader.id],
      );
      await client.query(
        "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE NOWAIT",
        [f.owner.id],
      );
      await client.query(
        "SELECT lesson_id FROM exercises WHERE workspace_id=$1 FOR UPDATE NOWAIT",
        [f.owner.id],
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  } finally {
    await pool.query(
      "DROP TRIGGER IF EXISTS reject_workspace_read ON authorization_audit",
    );
    await pool.query("DROP FUNCTION IF EXISTS reject_workspace_read()");
  }
  expect(await f.read()).toMatchObject({ kind: "allowed" });
});
