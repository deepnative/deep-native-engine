import { beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { migrate, store, hash, type Learner } from "../../src/store.ts";
import {
  deterministicRegistry,
  type AdapterRegistry,
} from "../../src/adapters.ts";
import { enqueueAdapterJob, jobStore, runAdapterJob } from "../../src/jobs.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  db = store(pool);
const input = {
  instruction: "Use the provided sample to make a plan.",
  verification: "Compare the plan with the original details.",
  complete: true,
};
beforeAll(async () => {
  await migrate(pool);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, learners CASCADE");
});
afterAll(async () => {
  await pool.end();
});
async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  expect(session.kind).toBe("active");
  return {
    token,
    learner: (session as { kind: "active"; learner: Learner }).learner,
  };
}
it("persists drafts and completions across independent database connections and migrations", async () => {
  const { learner, token } = await member();
  await db.save(learner.id, { ...input, complete: false });
  const reopened = testPool();
  try {
    expect(await store(reopened).progress(learner.id)).toMatchObject({
      instruction: input.instruction,
      completed_at: null,
    });
    await db.save(learner.id, input);
    expect(
      (await store(reopened).progress(learner.id))?.completed_at,
    ).toBeInstanceOf(Date);
    expect(
      (await pool.query("SELECT token_hash FROM learners")).rows[0].token_hash,
    ).toBe(hash(token));
    await migrate(pool);
    expect((await db.progress(learner.id))?.instruction).toBe(
      input.instruction,
    );
  } finally {
    await reopened.end();
  }
});
it("makes duplicate onboarding and simultaneous completion idempotent without cross-member writes", async () => {
  const { learner, token } = await member();
  await Promise.all([
    db.create(token, { background: "technical", goal: "build" }),
    db.create(token, { background: "professional", goal: "work" }),
  ]);
  expect(
    (await pool.query("SELECT count(*) FROM learners")).rows[0].count,
  ).toBe("1");
  const alternative = {
    instruction: "Alternative useful instruction with details.",
    verification: "Alternative way of checking the result.",
    complete: true,
  };
  await Promise.all([
    db.save(learner.id, input),
    db.save(learner.id, alternative),
  ]);
  const saved = await db.progress(learner.id);
  expect([input.instruction, alternative.instruction]).toContain(
    saved?.instruction,
  );
  expect(saved?.verification).toBe(
    saved?.instruction === input.instruction
      ? input.verification
      : alternative.verification,
  );
  await db.save(learner.id, { ...alternative, complete: false });
  await db.save(learner.id, alternative);
  expect(await db.progress(learner.id)).toEqual(saved);
  expect(
    (await pool.query("SELECT count(*) FROM exercises")).rows[0].count,
  ).toBe("1");
  const other = await member();
  expect(await db.progress(other.learner.id)).toBeUndefined();
});
it("keeps concurrent draft/completion coherent and complete", async () => {
  const { learner } = await member();
  await Promise.all([
    db.save(learner.id, {
      instruction: "unfinished",
      verification: "draft",
      complete: false,
    }),
    db.save(learner.id, input),
  ]);
  expect(await db.progress(learner.id)).toMatchObject({
    instruction: input.instruction,
    verification: input.verification,
    completed_at: expect.any(Date),
  });
});
it("enforces expiry and deletion including cascaded exercise records", async () => {
  const { learner, token } = await member();
  await db.save(learner.id, input);
  await pool.query(
    "UPDATE learners SET expires_at=CURRENT_TIMESTAMP WHERE id=$1",
    [learner.id],
  );
  expect(await db.session(token)).toEqual({ kind: "expired" });
  await db.remove(learner.id);
  expect(await db.session(token)).toEqual({ kind: "new" });
  expect(
    (await pool.query("SELECT count(*) FROM exercises")).rows[0].count,
  ).toBe("0");
});
it("enforces relational constraints and parameterizes hostile content", async () => {
  const { learner } = await member();
  await expect(
    pool.query("UPDATE learners SET background='admin' WHERE id=$1", [
      learner.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    db.save(randomBytes(16).toString("hex"), input),
  ).rejects.toThrow();
  await expect(
    db.save(learner.id, { ...input, instruction: "a".repeat(2001) }),
  ).rejects.toMatchObject({ code: "23514" });
  const hostile = "'; DROP TABLE learners;-- <script>alert(1)</script>";
  await db.save(learner.id, { ...input, instruction: hostile });
  expect((await db.progress(learner.id))?.instruction).toBe(hostile);
  expect(
    (await pool.query("SELECT count(*) FROM learners")).rows[0].count,
  ).toBe("1");
});

it("makes job enqueue idempotent across connections and rejects changed requests", async () => {
  const jobs = jobStore(pool),
    registry = deterministicRegistry({}, "test"),
    input = { template: "welcome" };
  const created = await enqueueAdapterJob(
    jobs,
    registry,
    "email",
    "send",
    input,
    "welcome-email",
  );
  const reopened = testPool();
  try {
    const duplicate = await enqueueAdapterJob(
      jobStore(reopened),
      registry,
      "email",
      "send",
      input,
      "welcome-email",
    );
    expect(duplicate.id).toBe(created.id);
    await expect(
      enqueueAdapterJob(
        jobStore(reopened),
        registry,
        "email",
        "send",
        { template: "changed" },
        "welcome-email",
      ),
    ).rejects.toThrow("another request");
    expect(
      (await reopened.query("SELECT count(*) FROM adapter_jobs")).rows[0].count,
    ).toBe("1");
  } finally {
    await reopened.end();
  }
});

it("finds the committed winner after a simultaneous first enqueue conflict", async () => {
  const fingerprint = "a".repeat(64),
    winnerId = randomUUID(),
    blocker = await pool.connect(),
    contender = await pool.connect();
  let transactionOpen = false;
  let competing: ReturnType<ReturnType<typeof jobStore>["enqueue"]> | undefined;
  try {
    await blocker.query("BEGIN");
    transactionOpen = true;
    const blockerPid = (
        await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid,
      contenderPid = (
        await contender.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
    await blocker.query(
      `INSERT INTO adapter_jobs(
         id,adapter,mode,operation,idempotency_key,request_fingerprint,max_attempts
       ) VALUES($1,'ai','test','summarize','simultaneous-first',$2,3)`,
      [winnerId, fingerprint],
    );
    competing = jobStore(contender as unknown as typeof pool).enqueue(
      "ai",
      "test",
      "summarize",
      "simultaneous-first",
      fingerprint,
    );
    let observedBlockedInsert = false;
    for (let check = 0; check < 100; check += 1) {
      const blocked = (
        await pool.query<{ blocked: boolean }>(
          "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
          [blockerPid, contenderPid],
        )
      ).rows[0]!.blocked;
      if (blocked) {
        observedBlockedInsert = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(observedBlockedInsert).toBe(true);
    await blocker.query("COMMIT");
    transactionOpen = false;
    await expect(competing).resolves.toMatchObject({ id: winnerId });
  } finally {
    if (transactionOpen) await blocker.query("ROLLBACK");
    await competing?.catch(() => undefined);
    blocker.release();
    contender.release();
  }
});

it("gives one concurrent worker the active adapter attempt", async () => {
  let executions = 0;
  const registry: AdapterRegistry = {
    mode: "test",
    adapter(kind) {
      return {
        kind,
        mode: "test",
        async execute() {
          executions += 1;
          return {
            kind,
            mode: "test",
            state: "simulated",
            reference: "test_once",
            message: "simulated once",
          };
        },
      };
    },
  };
  const input = { event: "lesson-opened" };
  const created = await enqueueAdapterJob(
    jobStore(pool),
    registry,
    "analytics",
    "record",
    input,
    "lesson-opened",
  );
  const [first, second] = await Promise.all([
    runAdapterJob(jobStore(pool), registry, created.id, input),
    runAdapterJob(jobStore(pool), registry, created.id, input),
  ]);
  expect(executions).toBe(1);
  expect([first.executed, second.executed].sort()).toEqual([false, true]);
  expect(await jobStore(pool).find(created.id)).toMatchObject({
    status: "succeeded",
    attempts: 1,
    safeError: null,
  });
});

it("persists retries across connections and stops invoking at exhaustion", async () => {
  let executions = 0;
  const registry: AdapterRegistry = {
    mode: "test",
    adapter(kind) {
      return {
        kind,
        mode: "test",
        async execute() {
          executions += 1;
          throw new Error("api_key=private-secret");
        },
      };
    },
  };
  const input = { template: "welcome" };
  const created = await enqueueAdapterJob(
    jobStore(pool),
    registry,
    "email",
    "send",
    input,
    "failing-email",
    3,
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reopened = testPool();
    try {
      await runAdapterJob(jobStore(reopened), registry, created.id, input);
    } finally {
      await reopened.end();
    }
  }
  const stopped = await runAdapterJob(
    jobStore(pool),
    registry,
    created.id,
    input,
  );
  expect(stopped.executed).toBe(false);
  expect(executions).toBe(3);
  expect(stopped.job).toMatchObject({
    status: "exhausted",
    attempts: 3,
    retryable: false,
    safeError: "provider_unavailable",
  });
  expect(
    JSON.stringify((await pool.query("SELECT * FROM adapter_jobs")).rows),
  ).not.toContain("private-secret");
});

it("recovers an expired lease after a crash but does not steal an active lease", async () => {
  let executions = 0;
  const input = { object: "lesson" };
  const registry: AdapterRegistry = {
    mode: "test",
    adapter(kind) {
      return {
        kind,
        mode: "test",
        async execute() {
          executions += 1;
          return {
            kind,
            mode: "test",
            state: "simulated",
            reference: "test_recovered",
            message: "simulated recovery",
          };
        },
      };
    },
  };
  const jobs = jobStore(pool);
  const created = await enqueueAdapterJob(
    jobs,
    registry,
    "storage",
    "store",
    input,
    "stored-lesson",
  );
  expect(await jobs.claim(created.id)).toMatchObject({
    status: "running",
    attempts: 1,
  });
  expect(
    (await runAdapterJob(jobs, registry, created.id, input)).executed,
  ).toBe(false);
  expect(executions).toBe(0);
  await pool.query(
    "UPDATE adapter_jobs SET lease_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1",
    [created.id],
  );
  const recovered = await runAdapterJob(jobs, registry, created.id, input);
  expect(recovered).toMatchObject({
    executed: true,
    job: { status: "succeeded", attempts: 2 },
  });
  expect(executions).toBe(1);
});

it("keeps terminal states when a late worker reports out of order", async () => {
  const jobs = jobStore(pool),
    registry = deterministicRegistry({}, "test"),
    successInput = { event: "complete" };
  const success = await enqueueAdapterJob(
    jobs,
    registry,
    "analytics",
    "record",
    successInput,
    "terminal-success",
    1,
  );
  const successAttempt = await jobs.claim(success.id);
  expect(successAttempt).toBeDefined();
  await jobs.succeed(success.id, successAttempt!.attemptToken);
  expect(
    await jobs.fail(
      success.id,
      successAttempt!.attemptToken,
      new Error("late failure"),
    ),
  ).toMatchObject({ status: "succeeded" });

  const failed = await enqueueAdapterJob(
    jobs,
    registry,
    "analytics",
    "record",
    { event: "fail" },
    "terminal-failure",
    1,
  );
  const failedAttempt = await jobs.claim(failed.id);
  expect(failedAttempt).toBeDefined();
  await jobs.fail(
    failed.id,
    failedAttempt!.attemptToken,
    new Error("provider failed"),
  );
  expect(
    await jobs.succeed(failed.id, failedAttempt!.attemptToken),
  ).toMatchObject({ status: "exhausted" });
});
