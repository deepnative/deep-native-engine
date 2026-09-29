import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { memberExportStore } from "../../src/member-export.ts";
import { migrate, store } from "../../src/store.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const feedback = workflowFeedbackStore(pool);
const token = () => randomBytes(32).toString("hex");

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(async () => pool.end());

function pausedAfterOwnerLookup() {
  const snapshotFormed = gate();
  const continueExport = gate();
  const state = { snapshot: "" };
  const controlledPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (
            sql.includes("FROM principals p JOIN learners l") &&
            result.rows[0]
          ) {
            state.snapshot = (
              await client.query("SELECT pg_current_snapshot()::text AS snap")
            ).rows[0].snap as string;
            snapshotFormed.release();
            await continueExport.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  return {
    exported: memberExportStore(controlledPool),
    snapshotFormed,
    continueExport,
    state,
  };
}

it("does not export a feedback note withdrawn after the export snapshot forms", async () => {
  const ownerToken = token();
  await db.create(ownerToken, { background: "explorer", goal: "everyday" });
  const session = await db.session(ownerToken);
  expect(session.kind).toBe("active");
  const ownerId = session.kind === "active" ? session.learner.id : "";
  const privateNote = "Invented feedback for withdrawal-first export race";
  expect(await feedback.save(ownerToken, "WF-001", 1, privateNote, 0)).toBe(
    true,
  );

  const controlled = pausedAfterOwnerLookup();
  const order: string[] = [];
  const reading = controlled.exported.exportOwned(ownerToken);
  try {
    await controlled.snapshotFormed.wait;
    expect(controlled.state.snapshot).not.toBe("");
    order.push("owner export snapshot formed");
    expect(await feedback.withdraw(ownerToken, "WF-001", 1, 1)).toBe(true);
    order.push("feedback withdrawal committed");
    expect(await feedback.list(ownerToken)).toEqual([]);
    expect(
      (
        await pool.query("SELECT 1 FROM workflow_feedback WHERE member_id=$1", [
          ownerId,
        ])
      ).rowCount,
    ).toBe(0);
    controlled.continueExport.release();
    const result = await reading;
    order.push("owner export returned");
    expect(order).toEqual([
      "owner export snapshot formed",
      "feedback withdrawal committed",
      "owner export returned",
    ]);
    expect(JSON.stringify(result)).not.toContain(privateNote);
    const fresh = await memberExportStore(pool).exportOwned(ownerToken);
    expect(fresh.kind).toBe("ready");
    expect(JSON.stringify(fresh)).not.toContain(privateNote);
  } finally {
    controlled.continueExport.release();
    await Promise.allSettled([reading]);
  }
}, 15_000);

it("fails closed on a stale export snapshot when withdrawn feedback is saved again", async () => {
  const ownerToken = token();
  await db.create(ownerToken, { background: "explorer", goal: "everyday" });
  const oldNote = "Invented withdrawn workflow feedback";
  const newNote = "Invented newly saved workflow feedback";
  expect(await feedback.save(ownerToken, "WF-001", 1, oldNote, 0)).toBe(true);
  const controlled = pausedAfterOwnerLookup();
  const reading = controlled.exported.exportOwned(ownerToken);
  try {
    await controlled.snapshotFormed.wait;
    expect(controlled.state.snapshot).not.toBe("");
    expect(await feedback.withdraw(ownerToken, "WF-001", 1, 1)).toBe(true);
    expect(await feedback.save(ownerToken, "WF-001", 1, newNote, 0)).toBe(true);
    expect(await feedback.list(ownerToken)).toMatchObject([
      { note: newNote, revision: 1 },
    ]);
    controlled.continueExport.release();
    const stale = await reading;
    expect(stale.kind).toBe("unavailable");
    expect(JSON.stringify(stale)).not.toContain(oldNote);
    expect(JSON.stringify(stale)).not.toContain(newNote);
    const fresh = await memberExportStore(pool).exportOwned(ownerToken);
    expect(fresh.kind).toBe("ready");
    expect(JSON.stringify(fresh)).not.toContain(oldNote);
    expect(JSON.stringify(fresh)).toContain(newNote);
  } finally {
    controlled.continueExport.release();
    await Promise.allSettled([reading]);
  }
}, 15_000);

function pausedAfterFeedbackRead() {
  const feedbackRead = gate();
  const continueExport = gate();
  const state = { pid: 0 };
  const controlledPool = {
    async connect() {
      const client = await pool.connect();
      state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (sql.includes("FROM workflow_feedback WHERE member_id=$1")) {
            feedbackRead.release();
            await continueExport.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  return {
    exported: memberExportStore(controlledPool),
    feedbackRead,
    continueExport,
    state,
  };
}

function observableWriter() {
  const connected = gate();
  const state = { pid: 0 };
  const connect = async () => {
    const client = await pool.connect();
    state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    connected.release();
    return client;
  };
  const writerPool = {
    connect,
    async query(sql: string, values?: unknown[]) {
      const client = await connect();
      try {
        return await client.query(sql, values);
      } finally {
        client.release();
      }
    },
  } as unknown as Pool;
  return { feedback: workflowFeedbackStore(writerPool), connected, state };
}

async function writerState(
  writerPid: number,
  readerPid: number,
  finished: () => boolean,
) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (finished()) return "finished";
    const blocked = await pool.query(
      "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
      [readerPid, writerPid],
    );
    if (blocked.rows[0].blocked) return "blocked";
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Feedback withdrawal neither blocked nor completed");
}

it("lets an export holding the feedback note finish before withdrawal commits", async () => {
  const ownerToken = token();
  await db.create(ownerToken, { background: "professional", goal: "work" });
  const privateNote = "Invented feedback for export-first race";
  expect(await feedback.save(ownerToken, "WF-001", 1, privateNote, 0)).toBe(
    true,
  );
  const controlled = pausedAfterFeedbackRead();
  const reading = controlled.exported.exportOwned(ownerToken);
  let writing: Promise<boolean> | undefined;
  try {
    await controlled.feedbackRead.wait;
    const writer = observableWriter();
    let finished = false;
    writing = writer.feedback
      .withdraw(ownerToken, "WF-001", 1, 1)
      .then((result) => {
        finished = true;
        return result;
      });
    await writer.connected.wait;
    expect(
      await writerState(writer.state.pid, controlled.state.pid, () => finished),
    ).toBe("blocked");
    controlled.continueExport.release();
    const earlier = await reading;
    expect(earlier.kind).toBe("ready");
    expect(JSON.stringify(earlier)).toContain(privateNote);
    expect(await writing).toBe(true);
    const later = await memberExportStore(pool).exportOwned(ownerToken);
    expect(later.kind).toBe("ready");
    expect(JSON.stringify(later)).not.toContain(privateNote);
  } finally {
    controlled.continueExport.release();
    await Promise.allSettled([reading, ...(writing ? [writing] : [])]);
  }
}, 15_000);

it("does not falsely accept a feedback withdrawal whose session expires while blocked", async () => {
  const ownerToken = token();
  await db.create(ownerToken, { background: "technical", goal: "work" });
  const session = await db.session(ownerToken);
  expect(session.kind).toBe("active");
  const ownerId = session.kind === "active" ? session.learner.id : "";
  expect(
    await feedback.save(
      ownerToken,
      "WF-001",
      1,
      "Invented note preserved on expired withdrawal",
      0,
    ),
  ).toBe(true);
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+INTERVAL '2 seconds' WHERE id=$1",
    [ownerId],
  );
  const controlled = pausedAfterFeedbackRead();
  const reading = controlled.exported.exportOwned(ownerToken);
  let writing: Promise<boolean> | undefined;
  try {
    await controlled.feedbackRead.wait;
    const writer = observableWriter();
    let finished = false;
    writing = writer.feedback
      .withdraw(ownerToken, "WF-001", 1, 1)
      .then((result) => {
        finished = true;
        return result;
      });
    await writer.connected.wait;
    expect(
      await writerState(writer.state.pid, controlled.state.pid, () => finished),
    ).toBe("blocked");
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const expiry = await pool.query(
        "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
        [ownerId],
      );
      if (expiry.rows[0].expired) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const expiry = await pool.query(
      "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
      [ownerId],
    );
    expect(expiry.rows[0].expired).toBe(true);
    controlled.continueExport.release();
    expect((await reading).kind).toBe("denied");
    expect(await writing).toBe(false);
    // Pre-start denial is covered separately in workflow-feedback.test.ts;
    // this assertion also confirms the observed wait did not change it.
    expect(await feedback.withdraw(ownerToken, "WF-001", 1, 1)).toBe(false);
    const retained = await pool.query(
      "SELECT note FROM workflow_feedback WHERE member_id=$1",
      [ownerId],
    );
    expect(retained.rows).toMatchObject([
      { note: "Invented note preserved on expired withdrawal" },
    ]);
  } finally {
    controlled.continueExport.release();
    await Promise.allSettled([reading, ...(writing ? [writing] : [])]);
  }
}, 15_000);

it("returns no private export after feedback lock timeout and releases owner locks", async () => {
  const ownerToken = token();
  await db.create(ownerToken, { background: "explorer", goal: "everyday" });
  const session = await db.session(ownerToken);
  expect(session.kind).toBe("active");
  const ownerId = session.kind === "active" ? session.learner.id : "";
  const privateNote = "Invented feedback for lock timeout";
  expect(await feedback.save(ownerToken, "WF-001", 1, privateNote, 0)).toBe(
    true,
  );
  const blocker = await pool.connect();
  const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
    .rows[0].pid as number;
  const connected = gate();
  const state = { exportPid: 0 };
  const observablePool = {
    async connect() {
      const client = await pool.connect();
      state.exportPid = (await client.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      connected.release();
      return client;
    },
  } as unknown as Pool;
  let reading:
    ReturnType<ReturnType<typeof memberExportStore>["exportOwned"]> | undefined;
  let finished = false;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "UPDATE workflow_feedback SET note=note WHERE member_id=$1 AND workflow_id='WF-001' AND workflow_version=1",
      [ownerId],
    );
    reading = memberExportStore(observablePool)
      .exportOwned(ownerToken)
      .then((result) => {
        finished = true;
        return result;
      });
    await connected.wait;
    expect(await writerState(state.exportPid, blockerPid, () => finished)).toBe(
      "blocked",
    );
    const result = await reading;
    expect(result.kind).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain(privateNote);

    const probe = await pool.connect();
    try {
      await probe.query("BEGIN");
      await probe.query("SET LOCAL lock_timeout='1s'");
      expect(
        (
          await probe.query(
            "SELECT id FROM principals WHERE id=$1 FOR UPDATE",
            [ownerId],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await probe.query(
            "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
            [ownerId],
          )
        ).rowCount,
      ).toBe(1);
      await probe.query("COMMIT");
    } finally {
      await probe.query("ROLLBACK");
      probe.release();
    }
    await blocker.query("ROLLBACK");
    const fresh = await memberExportStore(pool).exportOwned(ownerToken);
    expect(fresh.kind).toBe("ready");
    expect(JSON.stringify(fresh)).toContain(privateNote);
  } finally {
    await blocker.query("ROLLBACK");
    if (reading) await Promise.allSettled([reading]);
    blocker.release();
  }
}, 15_000);

it.each([
  { label: "DELETE response", rollbackFails: false },
  { label: "DELETE response and ROLLBACK transport", rollbackFails: true },
])(
  "fails closed on uncertain $label and recovers the pool",
  async ({ rollbackFails }) => {
    const ownerToken = token();
    await db.create(ownerToken, {
      background: "explorer",
      goal: "everyday",
    });
    const session = await db.session(ownerToken);
    expect(session.kind).toBe("active");
    const ownerId = session.kind === "active" ? session.learner.id : "";
    const privateNote = "Invented feedback retained after failed withdrawal";
    expect(await feedback.save(ownerToken, "WF-001", 1, privateNote, 0)).toBe(
      true,
    );

    let deleteAttempted = false;
    let releaseHadError = false;
    let released = false;
    let backendPid = 0;
    const faultPool = {
      async connect() {
        const client = await pool.connect();
        backendPid = (await client.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid as number;
        return {
          async query(sql: string, values?: unknown[]) {
            if (sql.startsWith("DELETE FROM workflow_feedback")) {
              // The DELETE reached PostgreSQL, but its response was lost.
              await client.query(sql, values);
              deleteAttempted = true;
              throw new Error("Simulated withdrawal transport failure");
            }
            if (rollbackFails && sql === "ROLLBACK")
              throw new Error("Simulated rollback transport failure");
            return client.query(sql, values);
          },
          release(error?: Error) {
            released = true;
            releaseHadError = error instanceof Error;
            client.release(error);
          },
        };
      },
    } as unknown as Pool;

    expect(
      await workflowFeedbackStore(faultPool).withdraw(
        ownerToken,
        "WF-001",
        1,
        1,
      ),
    ).toBe(false);
    expect(deleteAttempted).toBe(true);
    expect(released).toBe(true);
    expect(releaseHadError).toBe(rollbackFails);

    if (rollbackFails) {
      const deadline = performance.now() + 3000;
      let active = true;
      while (active && performance.now() < deadline) {
        active =
          (
            await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [
              backendPid,
            ])
          ).rowCount === 1;
        if (active) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(active).toBe(false);
    }
    expect(await feedback.list(ownerToken)).toMatchObject([
      { note: privateNote, revision: 1 },
    ]);

    const probe = await pool.connect();
    try {
      await probe.query("BEGIN");
      await probe.query("SET LOCAL lock_timeout='1s'");
      expect(
        (
          await probe.query(
            "SELECT id FROM principals WHERE id=$1 FOR UPDATE",
            [ownerId],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await probe.query(
            "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
            [ownerId],
          )
        ).rowCount,
      ).toBe(1);
      await probe.query("COMMIT");
    } finally {
      await probe.query("ROLLBACK");
      probe.release();
    }
    expect(await feedback.withdraw(ownerToken, "WF-001", 1, 1)).toBe(true);
    expect(await feedback.list(ownerToken)).toEqual([]);
  },
  15_000,
);
