import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { attemptStore } from "../../src/attempts.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { activityItems } from "../../src/progress.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const members = store(pool);
const attempts = attemptStore(pool);
const token = () => randomBytes(32).toString("hex");

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

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

function pausedAfterAttemptRead(splitReply = false) {
  const attemptRead = gate();
  const continueExport = gate();
  const secondReply = gate();
  const state = { pid: 0 };
  const controlledPool = {
    async connect() {
      const client = await pool.connect();
      state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (sql.includes("FROM assignment_attempts WHERE member_id=$1")) {
            attemptRead.release();
            if (splitReply) {
              // Keep each reply within the export's five-second driver bound,
              // while retaining its locks across the writer's five-second wait.
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  continueExport.wait,
                  new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, 2500);
                  }),
                ]);
              } finally {
                clearTimeout(timer);
              }
            } else await continueExport.wait;
          }
          if (
            splitReply &&
            sql.startsWith("SELECT a.id") &&
            sql.includes("FROM assignment_attempts a")
          ) {
            secondReply.release();
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
    attemptRead,
    continueExport,
    secondReply,
    state,
  };
}

function observableRemoval() {
  const connected = gate();
  const state = { pid: 0 };
  const writerPool = {
    async connect() {
      const client = await pool.connect();
      state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      connected.release();
      return client;
    },
  } as unknown as Pool;
  return { attempts: attemptStore(writerPool), connected, state };
}

async function waitForBlocking(
  waitingPid: number,
  blockerPid: number,
  finished: () => boolean,
) {
  const until = performance.now() + 3000;
  while (performance.now() < until) {
    if (finished()) return "finished";
    const result = await pool.query(
      "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
      [blockerPid, waitingPid],
    );
    if (result.rows[0].blocked) return "blocked";
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected assignment-attempt lock wait was not observed");
}

beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => pool.end());

async function fixture() {
  const ownerToken = token();
  await members.create(ownerToken, {
    background: "explorer",
    goal: "everyday",
  });
  const session = await members.session(ownerToken);
  if (session.kind !== "active")
    throw new Error("Synthetic owner setup failed");
  const ownerId = session.learner.id;
  const editorToken = token();
  const reviewerToken = token();
  const auth = authorizationStore(pool);
  const expiry = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editorToken, "editor", expiry);
  await auth.provisionStaff(reviewerToken, "reviewer", expiry);
  const content: DraftContent = {
    id: "SYN-960",
    version: 1,
    kind: "assignment",
    origin: "curated",
    title: "Invented private export assignment",
    body: "Only invented answers.",
    owner: "Synthetic editor",
    sources: "Invented source",
    rights: "Owned sample",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites: "None",
    rubric: "Compare with the invented source.",
    rubricVersion: 1,
  };
  const catalog = catalogStore(pool);
  expect(await catalog.createDraft(editorToken, content)).toBe(true);
  expect(await catalog.submit(editorToken, content.id, 1)).toBe(true);
  expect(await catalog.approve(reviewerToken, content.id, 1, true)).toBe(true);
  expect(await catalog.publish(editorToken, content.id, 1)).toBe(true);
  expect(await members.chooseAssignment(ownerId, content.id, 1)).toBe(true);
  const attemptId = await attempts.start(ownerToken);
  expect(attemptId).toBeTruthy();
  const first = "Invented first private submission with source comparison.";
  const second =
    "Invented second private submission with revised source comparison.";
  const draft = "Invented current private draft after two submissions.";
  expect(await attempts.save(ownerToken, attemptId!, 1, first)).toBe(true);
  expect(await attempts.submit(ownerToken, attemptId!, 2)).toBe(true);
  expect(await attempts.revise(ownerToken, attemptId!)).toBe(true);
  let detail = await attempts.detail(ownerToken, attemptId!);
  expect(detail).toBeTruthy();
  expect(
    await attempts.save(ownerToken, attemptId!, detail!.revision, second),
  ).toBe(true);
  expect(
    await attempts.submit(ownerToken, attemptId!, detail!.revision + 1),
  ).toBe(true);
  expect(await attempts.revise(ownerToken, attemptId!)).toBe(true);
  detail = await attempts.detail(ownerToken, attemptId!);
  expect(detail).toBeTruthy();
  expect(
    await attempts.save(ownerToken, attemptId!, detail!.revision, draft),
  ).toBe(true);
  expect(
    (await attempts.detail(ownerToken, attemptId!))?.submissions,
  ).toMatchObject([
    { sequence: 1, response: first },
    { sequence: 2, response: second },
  ]);
  return {
    ownerToken,
    ownerId,
    editorToken,
    attemptId: attemptId!,
    first,
    second,
    draft,
  };
}

it("lists only owned submission metadata and keeps each exact version after direction change and retirement", async () => {
  const f = await fixture();
  const outsiderToken = token();
  await members.create(outsiderToken, {
    background: "professional",
    goal: "work",
  });
  const owned = (await attempts.list(f.ownerToken))!;
  expect(owned).toHaveLength(1);
  expect(owned[0]?.submissionHistory).toMatchObject([
    { sequence: 1, submittedAt: expect.any(String) },
    { sequence: 2, submittedAt: expect.any(String) },
  ]);
  expect(Object.keys(owned[0]!.submissionHistory![0]!)).toEqual([
    "sequence",
    "submittedAt",
  ]);
  expect("submissions" in owned[0]!).toBe(false);
  expect("response" in owned[0]!).toBe(false);
  const initial = activityItems(undefined, [], owned);
  expect(initial.map((item) => item.state)).toEqual([
    "Submission 1 · submitted locally; no qualified review",
    "Submission 2 · submitted locally; no qualified review",
    "Current revision draft saved",
  ]);
  expect(initial.map((item) => item.href)).toEqual([
    `/assignments/attempts/${f.attemptId}?version=1&submission=1#submission-1`,
    `/assignments/attempts/${f.attemptId}?version=1&submission=2#submission-2`,
    `/assignments/attempts/${f.attemptId}`,
  ]);
  expect(await attempts.list(outsiderToken)).toEqual([]);
  expect(await attempts.detail(outsiderToken, f.attemptId)).toBeNull();
  await pool.query("UPDATE learners SET goal='work' WHERE id=$1", [f.ownerId]);
  expect(await catalogStore(pool).retire(f.editorToken, "SYN-960")).toBe(true);
  const retained = (await attempts.list(f.ownerToken))!;
  expect(
    activityItems(undefined, [], retained).map((item) => item.state),
  ).toEqual(initial.map((item) => item.state));
  expect(retained[0]?.currentPublished).toBe(false);
  expect(retained[0]?.contentVersion).toBe(1);
  expect(await attempts.remove(f.ownerToken, f.attemptId)).toBe(true);
  expect(await attempts.list(f.ownerToken)).toEqual([]);
});

it("does not return a partial progress list when snapshot metadata cannot be read", async () => {
  const f = await fixture();
  const failed = attemptStore({
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (sql: string, values?: unknown[]) => {
          if (sql.includes('AS "submissionHistory"'))
            throw new Error("Synthetic PostgreSQL read fault");
          return client.query(sql, values);
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool);
  await expect(failed.list(f.ownerToken)).rejects.toThrow(
    "Assignment attempt operation unconfirmed",
  );
  expect(await attempts.list(f.ownerToken)).toHaveLength(1);
});

it("does not export any attempt or submission text after owner deletes the series", async () => {
  const f = await fixture();
  const controlled = pausedAfterOwnerLookup();
  const order: string[] = [];
  const reading = controlled.exported.exportOwned(f.ownerToken);
  try {
    await controlled.snapshotFormed.wait;
    expect(controlled.state.snapshot).not.toBe("");
    order.push("owner export snapshot formed");
    expect(await attempts.remove(f.ownerToken, f.attemptId)).toBe(true);
    order.push("attempt series deletion committed");
    const retained = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM assignment_attempts WHERE id=$1) AS attempts,
         (SELECT count(*)::integer FROM assignment_submission_snapshots WHERE attempt_id=$1) AS submissions`,
      [f.attemptId],
    );
    expect(retained.rows[0]).toEqual({ attempts: 0, submissions: 0 });
    controlled.continueExport.release();
    const result = await reading;
    order.push("owner export returned");
    expect(order).toEqual([
      "owner export snapshot formed",
      "attempt series deletion committed",
      "owner export returned",
    ]);
    const returnedBytes = JSON.stringify(result);
    expect(
      [f.first, f.second, f.draft].some((response) =>
        returnedBytes.includes(response),
      ),
    ).toBe(false);
    const fresh = await memberExportStore(pool).exportOwned(f.ownerToken);
    expect(fresh).toMatchObject({
      kind: "ready",
      payload: {
        records: { assignmentAttempts: [], assignmentSubmissions: [] },
      },
    });
  } finally {
    controlled.continueExport.release();
    await Promise.allSettled([reading]);
  }
}, 15_000);

it("lets an export holding the attempt finish before owner deletion commits", async () => {
  const f = await fixture();
  const controlled = pausedAfterAttemptRead();
  const reading = controlled.exported.exportOwned(f.ownerToken);
  const writer = observableRemoval();
  let finished = false;
  let writing: Promise<boolean> | undefined;
  try {
    await controlled.attemptRead.wait;
    writing = writer.attempts
      .remove(f.ownerToken, f.attemptId)
      .then((value) => {
        finished = true;
        return value;
      });
    await writer.connected.wait;
    expect(
      await waitForBlocking(
        writer.state.pid,
        controlled.state.pid,
        () => finished,
      ),
    ).toBe("blocked");
    controlled.continueExport.release();
    const earlier = await reading;
    expect(earlier.kind).toBe("ready");
    const earlierBytes = JSON.stringify(earlier);
    expect(
      [f.first, f.second, f.draft].every((value) =>
        earlierBytes.includes(value),
      ),
    ).toBe(true);
    expect(await writing).toBe(true);
    const fresh = await memberExportStore(pool).exportOwned(f.ownerToken);
    expect(fresh).toMatchObject({
      kind: "ready",
      payload: {
        records: { assignmentAttempts: [], assignmentSubmissions: [] },
      },
    });
  } finally {
    controlled.continueExport.release();
    await Promise.allSettled([reading, ...(writing ? [writing] : [])]);
  }
}, 15_000);

it("denies other members, staff and expired owner deletion without losing private snapshots", async () => {
  const f = await fixture();
  const outsiderToken = token();
  await members.create(outsiderToken, {
    background: "professional",
    goal: "work",
  });
  const staffToken = token();
  await authorizationStore(pool).provisionStaff(
    staffToken,
    "reviewer",
    new Date(Date.now() + 60_000),
  );
  expect(await attempts.remove(outsiderToken, f.attemptId)).toBe(false);
  expect(await attempts.remove(staffToken, f.attemptId)).toBe(false);
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
    [f.ownerId],
  );
  expect(await attempts.remove(f.ownerToken, f.attemptId)).toBe(false);
  const retained = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM assignment_attempts WHERE id=$1) AS attempts,
       (SELECT count(*)::integer FROM assignment_submission_snapshots WHERE attempt_id=$1) AS submissions`,
    [f.attemptId],
  );
  expect(retained.rows[0]).toEqual({ attempts: 1, submissions: 2 });
}, 15_000);

it("does not acknowledge deletion when owner expiry passes during an export lock wait", async () => {
  const f = await fixture();
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+INTERVAL '2 seconds' WHERE id=$1",
    [f.ownerId],
  );
  const controlled = pausedAfterAttemptRead();
  const reading = controlled.exported.exportOwned(f.ownerToken);
  const writer = observableRemoval();
  let finished = false;
  let writing: Promise<boolean> | undefined;
  try {
    await controlled.attemptRead.wait;
    writing = writer.attempts
      .remove(f.ownerToken, f.attemptId)
      .then((value) => {
        finished = true;
        return value;
      });
    await writer.connected.wait;
    expect(
      await waitForBlocking(
        writer.state.pid,
        controlled.state.pid,
        () => finished,
      ),
    ).toBe("blocked");
    const deadline = performance.now() + 3000;
    let expired = false;
    while (performance.now() < deadline) {
      expired = (
        await pool.query(
          "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
          [f.ownerId],
        )
      ).rows[0].expired as boolean;
      if (expired) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(expired).toBe(true);
    controlled.continueExport.release();
    expect((await reading).kind).toBe("denied");
    expect(await writing).toBe(false);
    const retained = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM assignment_attempts WHERE id=$1) AS attempts,
         (SELECT count(*)::integer FROM assignment_submission_snapshots WHERE attempt_id=$1) AS submissions`,
      [f.attemptId],
    );
    expect(retained.rows[0]).toEqual({ attempts: 1, submissions: 2 });
  } finally {
    controlled.continueExport.release();
    await Promise.allSettled([reading, ...(writing ? [writing] : [])]);
  }
}, 15_000);

it.each(["revoked", "deleting-workspace"] as const)(
  "denies %s owner attempt deletion without losing submission history",
  async (state) => {
    const f = await fixture();
    if (state === "revoked") {
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [f.ownerId],
      );
    } else {
      await pool.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [f.ownerId],
      );
    }
    expect(await attempts.remove(f.ownerToken, f.attemptId)).toBe(false);
    const retained = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM assignment_attempts WHERE id=$1) AS attempts,
         (SELECT count(*)::integer FROM assignment_submission_snapshots WHERE attempt_id=$1) AS submissions`,
      [f.attemptId],
    );
    expect(retained.rows[0]).toEqual({ attempts: 1, submissions: 2 });
  },
  15_000,
);

it("does not acknowledge a deletion that times out behind an export, then recovers", async () => {
  const f = await fixture();
  const controlled = pausedAfterAttemptRead(true);
  const reading = controlled.exported.exportOwned(f.ownerToken);
  const writer = observableRemoval();
  let finished = false;
  let writing: Promise<{ value?: boolean; error?: unknown }> | undefined;
  try {
    await controlled.attemptRead.wait;
    writing = writer.attempts.remove(f.ownerToken, f.attemptId).then(
      (value) => {
        finished = true;
        return { value };
      },
      (error: unknown) => {
        finished = true;
        return { error };
      },
    );
    await writer.connected.wait;
    expect(
      await waitForBlocking(
        writer.state.pid,
        controlled.state.pid,
        () => finished,
      ),
    ).toBe("blocked");
    await controlled.secondReply.wait;
    expect(
      await waitForBlocking(
        writer.state.pid,
        controlled.state.pid,
        () => finished,
      ),
    ).toBe("blocked");
    const outcome = await writing;
    expect(outcome.value).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toBe(
      "Assignment attempt operation unconfirmed",
    );
    const retained = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM assignment_attempts WHERE id=$1) AS attempts,
         (SELECT count(*)::integer FROM assignment_submission_snapshots WHERE attempt_id=$1) AS submissions`,
      [f.attemptId],
    );
    expect(retained.rows[0]).toEqual({ attempts: 1, submissions: 2 });
    controlled.continueExport.release();
    const earlier = await reading;
    expect(earlier.kind).toBe("ready");
    expect(await attempts.remove(f.ownerToken, f.attemptId)).toBe(true);
    const fresh = await memberExportStore(pool).exportOwned(f.ownerToken);
    expect(fresh).toMatchObject({
      kind: "ready",
      payload: {
        records: { assignmentAttempts: [], assignmentSubmissions: [] },
      },
    });
  } finally {
    controlled.continueExport.release();
    await Promise.allSettled([reading, ...(writing ? [writing] : [])]);
  }
}, 15_000);

it("fails closed on attempt-row lock timeout and releases owner locks", async () => {
  const f = await fixture();
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
      "UPDATE assignment_attempts SET response=response WHERE id=$1",
      [f.attemptId],
    );
    reading = memberExportStore(observablePool)
      .exportOwned(f.ownerToken)
      .then((result) => {
        finished = true;
        return result;
      });
    await connected.wait;
    expect(
      await waitForBlocking(state.exportPid, blockerPid, () => finished),
    ).toBe("blocked");
    const result = await reading;
    expect(result.kind).toBe("unavailable");
    expect(
      [f.first, f.second, f.draft].some((response) =>
        JSON.stringify(result).includes(response),
      ),
    ).toBe(false);
    const probe = await pool.connect();
    try {
      await probe.query("BEGIN");
      await probe.query("SET LOCAL lock_timeout='1s'");
      expect(
        (
          await probe.query(
            "SELECT id FROM principals WHERE id=$1 FOR UPDATE",
            [f.ownerId],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await probe.query(
            "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
            [f.ownerId],
          )
        ).rowCount,
      ).toBe(1);
      await probe.query("COMMIT");
    } finally {
      await probe.query("ROLLBACK");
      probe.release();
    }
    await blocker.query("ROLLBACK");
    const fresh = await memberExportStore(pool).exportOwned(f.ownerToken);
    expect(fresh).toMatchObject({
      kind: "ready",
      payload: {
        records: {
          assignmentAttempts: [{ id: f.attemptId, response: f.draft }],
          assignmentSubmissions: [
            { attemptId: f.attemptId, sequence: 1, response: f.first },
            { attemptId: f.attemptId, sequence: 2, response: f.second },
          ],
        },
      },
    });
  } finally {
    await blocker.query("ROLLBACK");
    if (reading) await Promise.allSettled([reading]);
    blocker.release();
  }
}, 15_000);

async function submissionContinuation() {
  const f = await fixture();
  await pool.query(
    `INSERT INTO exercises(learner_id,workspace_id,lesson_id,lesson_version,instruction,verification)
    SELECT $1,$1,'synthetic-page-'||n,1,'Invented instruction','Invented check' FROM generate_series(1,97) AS n`,
    [f.ownerId],
  );
  const secret = randomBytes(32);
  const first = await memberExportStore(pool, secret).exportOwned(f.ownerToken);
  if (first.kind !== "ready" || !first.payload.page.nextCursor)
    throw Error("Synthetic continuation unavailable");
  expect(first.payload.records.assignmentSubmissions).toHaveLength(1);
  return { ...f, secret, cursor: first.payload.page.nextCursor };
}
function continuationParentReader(secret: Buffer, pause: boolean) {
  const parentLocked = gate(),
    resume = gate(),
    connected = gate();
  const state = { pid: 0 };
  const wrapper = {
    connect: async () => {
      const client = await pool.connect();
      state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      connected.release();
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (pause && sql.startsWith("SELECT a.id")) {
            parentLocked.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  return {
    exported: memberExportStore(wrapper, secret),
    parentLocked,
    resume,
    connected,
    state,
  };
}
it("resumed submission export waits on a deleting parent without holding child locks first", async () => {
  const f = await submissionContinuation();
  const writer = await pool.connect();
  const reader = continuationParentReader(f.secret, false);
  let reading: ReturnType<typeof reader.exported.exportOwned> | undefined;
  let finished = false;
  try {
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    await writer.query("BEGIN");
    await writer.query("SET LOCAL lock_timeout='1s'");
    await writer.query(
      "SELECT id FROM assignment_attempts WHERE id=$1 FOR UPDATE",
      [f.attemptId],
    );
    reading = reader.exported
      .exportOwned(f.ownerToken, f.cursor)
      .then((value) => {
        finished = true;
        return value;
      });
    await reader.connected.wait;
    expect(await waitForBlocking(reader.state.pid, pid, () => finished)).toBe(
      "blocked",
    );
    // This cascade must complete while the reader waits; a child-first reader
    // would deadlock or make the writer hit the actual one-second lock bound.
    await writer.query("DELETE FROM assignment_attempts WHERE id=$1", [
      f.attemptId,
    ]);
    await writer.query("COMMIT");
    expect(await reading).toEqual({ kind: "unavailable" });
    expect(
      await memberExportStore(pool, f.secret).exportOwned(
        f.ownerToken,
        f.cursor,
      ),
    ).toMatchObject({
      kind: "ready",
      payload: { records: { assignmentSubmissions: [] } },
    });
  } finally {
    await writer.query("ROLLBACK");
    await Promise.allSettled(reading ? [reading] : []);
    writer.release();
  }
}, 15000);
it("resumed submission export locks parents before reading and completes before competing deletion", async () => {
  const f = await submissionContinuation();
  const reader = continuationParentReader(f.secret, true);
  const writer = observableRemoval();
  const reading = reader.exported.exportOwned(f.ownerToken, f.cursor);
  let writing: Promise<boolean> | undefined;
  let finished = false;
  try {
    await reader.parentLocked.wait;
    writing = writer.attempts
      .remove(f.ownerToken, f.attemptId)
      .then((value) => {
        finished = true;
        return value;
      });
    await writer.connected.wait;
    expect(
      await waitForBlocking(writer.state.pid, reader.state.pid, () => finished),
    ).toBe("blocked");
    reader.resume.release();
    expect(await reading).toMatchObject({
      kind: "ready",
      payload: {
        records: {
          assignmentSubmissions: [
            { attemptId: f.attemptId, sequence: 2, response: f.second },
          ],
        },
        page: { complete: true },
      },
    });
    expect(await writing).toBe(true);
  } finally {
    reader.resume.release();
    await Promise.allSettled([reading, ...(writing ? [writing] : [])]);
  }
}, 15000);
