import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { attemptStore } from "../../src/attempts.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const attempts = attemptStore(pool);
const response = "An invented private answer retained before the lock wait.";
const operations = [
  "start-new",
  "start-existing",
  "save",
  "submit",
  "revise",
] as const;
type Operation = (typeof operations)[number];

beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => pool.end());

async function fixture(operation: Operation) {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw new Error("Missing synthetic member");
  const owner = session.learner.id;
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  const auth = authorizationStore(pool);
  await auth.provisionStaff(
    editor,
    "editor",
    new Date(Date.now() + 86_400_000),
  );
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  const catalog = catalogStore(pool);
  const draft: DraftContent = {
    id: "SYN-957",
    version: 1,
    kind: "assignment",
    origin: "curated",
    title: "Invented expiry assignment",
    body: "Use only invented details.",
    owner: "Synthetic editor",
    sources: "Original invented brief",
    rights: "Owned sample",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, draft.id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, draft.id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, draft.id, 1)).toBe(true);
  expect(await db.chooseAssignment(owner, draft.id, 1)).toBe(true);
  let id = "";
  if (operation !== "start-new") {
    id = (await attempts.start(token))!;
    expect(await attempts.save(token, id, 1, response)).toBe(true);
    if (operation === "revise")
      expect(await attempts.submit(token, id, 2)).toBe(true);
  }
  const act = (credential = token) => {
    if (operation === "start-new" || operation === "start-existing")
      return attempts.start(credential);
    if (operation === "save")
      return attempts.save(
        credential,
        id,
        2,
        "A late invented replacement that must never persist.",
      );
    if (operation === "submit") return attempts.submit(credential, id, 2);
    return attempts.revise(credential, id);
  };
  const retained = async () => ({
    attempts: (
      await pool.query(
        "SELECT * FROM assignment_attempts WHERE member_id=$1 ORDER BY id",
        [owner],
      )
    ).rows,
    snapshots: (
      await pool.query(
        "SELECT s.* FROM assignment_submission_snapshots s JOIN assignment_attempts a ON a.id=s.attempt_id WHERE a.member_id=$1 ORDER BY s.sequence",
        [owner],
      )
    ).rows,
  });
  return { token, owner, id, act, retained };
}

async function lockedMutation(
  operation: Operation,
  lock: "write" | "principal" | "workspace" | "snapshot",
  expire: boolean,
) {
  const item = await fixture(operation);
  const before = await item.retained();
  if (expire)
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
      [item.owner],
    );
  const holder = await pool.connect();
  let pending: Promise<string | boolean | null> | undefined;
  const triggerTable =
    lock === "snapshot"
      ? "assignment_submission_snapshots"
      : "assignment_attempts";
  const trigger =
    lock === "snapshot" || (lock === "write" && operation === "start-new");
  try {
    await holder.query("BEGIN");
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    if (trigger) {
      await holder.query("SELECT pg_advisory_xact_lock(7530,1)");
      await pool.query(`CREATE FUNCTION test_wait_attempt_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(7530,1); RETURN NEW; END $$`);
      await pool.query(
        `CREATE TRIGGER test_wait_attempt_insert BEFORE INSERT ON ${triggerTable} FOR EACH ROW EXECUTE FUNCTION test_wait_attempt_insert()`,
      );
    } else if (lock === "principal") {
      await holder.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
        item.owner,
      ]);
    } else if (lock === "workspace") {
      await holder.query(
        "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
        [item.owner],
      );
    } else {
      await holder.query(
        "SELECT id FROM assignment_attempts WHERE id=$1 FOR UPDATE",
        [item.id],
      );
    }
    pending = item.act();
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              `SELECT 1 FROM pg_stat_activity waiter CROSS JOIN principals p
       WHERE p.id=$2 AND waiter.state='active' AND waiter.wait_event_type='Lock'
         AND $1::integer=ANY(pg_blocking_pids(waiter.pid))
         AND waiter.xact_start<p.expires_at AND (NOT $3::boolean OR p.expires_at<=clock_timestamp())`,
              [pid, item.owner, expire],
            )
          ).rowCount,
        { timeout: 4_000, interval: 20 },
      )
      .toBe(1);
    await holder.query("COMMIT");
    const result = await pending;
    if (expire) {
      expect.soft(result).toBe(operation.startsWith("start") ? null : false);
      expect(await item.retained()).toEqual(before);
    } else {
      expect(result).toBe(operation === "start-existing" ? item.id : true);
      const after = await item.retained();
      if (operation === "save") {
        expect(after.attempts[0]).toMatchObject({
          revision: 3,
          response: "A late invented replacement that must never persist.",
        });
        expect(after.snapshots).toEqual(before.snapshots);
      } else expect(after).toEqual(before);
    }
  } finally {
    await holder.query("ROLLBACK");
    await Promise.allSettled(pending ? [pending] : []);
    holder.release();
    if (trigger) {
      await pool.query(
        `DROP TRIGGER IF EXISTS test_wait_attempt_insert ON ${triggerTable}`,
      );
      await pool.query("DROP FUNCTION IF EXISTS test_wait_attempt_insert()");
    }
  }
}

it.each(operations)(
  "rejects %s when its write lock is released after session expiry",
  async (operation) => {
    await lockedMutation(operation, "write", true);
  },
  10_000,
);

it.each(["principal", "workspace"] as const)(
  "rejects a save after expiry during the %s authorization lock wait",
  async (lock) => {
    await lockedMutation("save", lock, true);
  },
  10_000,
);

it("rolls back both submission state and snapshot after expiry during snapshot insertion", async () => {
  await lockedMutation("submit", "snapshot", true);
}, 10_000);

it.each(["save", "start-existing"] as const)(
  "preserves a valid owner's %s after an observed write wait",
  async (operation) => {
    await lockedMutation(operation, "write", false);
  },
);

it.each(
  operations.flatMap((operation) =>
    ["revoked", "deleting", "outsider"].map((reason) => ({
      operation,
      reason,
    })),
  ),
)(
  "denies $operation for $reason without changing retained attempts or snapshots",
  async ({ operation, reason }) => {
    const item = await fixture(operation);
    const before = await item.retained();
    if (reason === "revoked")
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [item.owner],
      );
    if (reason === "deleting")
      await pool.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [item.owner],
      );
    let outsider: string | undefined;
    if (reason === "outsider") {
      outsider = randomBytes(32).toString("hex");
      await db.create(outsider, { background: "professional", goal: "work" });
    }
    expect(await item.act(outsider)).toBe(
      operation.startsWith("start") ? null : false,
    );
    expect(await item.retained()).toEqual(before);
  },
);
