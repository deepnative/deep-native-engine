import { beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { migrate, store, hash, type Learner } from "../../src/store.ts";
import {
  deterministicRegistry,
  type AdapterRegistry,
} from "../../src/adapters.ts";
import { enqueueAdapterJob, jobStore, runAdapterJob } from "../../src/jobs.ts";
import { authorizationStore, type StaffRole } from "../../src/authorization.ts";
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
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
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
it("backfills and safely reruns authorization migration over populated learning data", async () => {
  const schema = `migration_${randomBytes(8).toString("hex")}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const initial = await readFile(
        new URL("../../migrations/001-learning.sql", import.meta.url),
        "utf8",
      ),
      authorization = await readFile(
        new URL(
          "../../migrations/003-workspace-authorization.sql",
          import.meta.url,
        ),
        "utf8",
      ),
      activeId = randomUUID(),
      expiredId = randomUUID(),
      activeToken = randomBytes(32).toString("hex"),
      expiredToken = randomBytes(32).toString("hex");
    await client.query(initial);
    await client.query(
      `INSERT INTO learners(id,token_hash,background,goal,expires_at)
       VALUES($1,$2,'explorer','everyday',CURRENT_TIMESTAMP+INTERVAL '1 day'),
             ($3,$4,'professional','work',CURRENT_TIMESTAMP-INTERVAL '1 day')`,
      [activeId, hash(activeToken), expiredId, hash(expiredToken)],
    );
    await client.query(
      `INSERT INTO exercises(
         learner_id,lesson_id,lesson_version,instruction,verification,completed_at
       ) VALUES
         ($1,'clear-instructions',1,'Completed work','Verified',CURRENT_TIMESTAMP),
         ($2,'clear-instructions',1,'Saved draft','Pending',NULL)`,
      [activeId, expiredId],
    );
    await client.query(authorization);
    await client.query(authorization);
    const migrated = store(client as unknown as Pool);
    await expect(migrated.session(activeToken)).resolves.toMatchObject({
      kind: "active",
      learner: { id: activeId },
    });
    await expect(migrated.session(expiredToken)).resolves.toEqual({
      kind: "expired",
    });
    await expect(migrated.progress(activeId)).resolves.toMatchObject({
      instruction: "Completed work",
      completed_at: expect.any(Date),
    });
    expect(
      (
        await client.query(
          "SELECT count(*) FROM exercises WHERE workspace_id=learner_id",
        )
      ).rows[0].count,
    ).toBe("2");
    expect(
      (await client.query("SELECT count(*) FROM workspaces")).rows[0].count,
    ).toBe("2");
    await client.query(
      "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
      [activeId],
    );
    await expect(migrated.session(activeToken)).resolves.toEqual({
      kind: "expired",
    });
  } finally {
    await client.query("RESET search_path");
    client.release();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
});
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
      (await pool.query("SELECT token_hash FROM principals")).rows[0]
        .token_hash,
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
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP WHERE id=$1",
    [learner.id],
  );
  expect(await db.session(token)).toEqual({ kind: "expired" });
  await db.remove(learner.id);
  expect(await db.session(token)).toEqual({ kind: "new" });
  expect(
    (await pool.query("SELECT count(*) FROM exercises")).rows[0].count,
  ).toBe("0");
});

async function staff(role: StaffRole) {
  const credential = randomBytes(32).toString("hex");
  return {
    token: credential,
    id: await authorizationStore(pool).provisionStaff(
      credential,
      role,
      new Date(Date.now() + 86_400_000),
    ),
  };
}

it("derives private workspace ownership and rejects cross-workspace references", async () => {
  const first = await member(),
    second = await member(),
    access = authorizationStore(pool);
  await db.save(first.learner.id, input);
  await expect(
    access.readWorkspace(first.token, first.learner.id),
  ).resolves.toMatchObject({
    kind: "allowed",
    via: "member",
    records: [{ instruction: input.instruction }],
  });
  await expect(
    access.readWorkspace(second.token, first.learner.id),
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    pool.query(
      `INSERT INTO exercises(
         learner_id,workspace_id,lesson_id,lesson_version,instruction,verification
       ) VALUES($1,$2,'cross-workspace',1,'private','check')`,
      [first.learner.id, second.learner.id],
    ),
  ).rejects.toMatchObject({ code: "23503" });
});

it("enforces assignment roles, expiry and revocation without role self-escalation", async () => {
  const owner = await member(),
    other = await member(),
    admin = await staff("platform_admin"),
    coach = await staff("coach"),
    reviewer = await staff("reviewer"),
    editor = await staff("editor"),
    moderator = await staff("moderator"),
    access = authorizationStore(pool),
    future = new Date(Date.now() + 60_000);
  await db.save(owner.learner.id, input);
  const coachGrant = await access.grantAssignment(
    admin.id,
    coach.id,
    owner.learner.id,
    "coach",
    "lesson coaching",
    future,
  );
  await access.grantAssignment(
    admin.id,
    reviewer.id,
    owner.learner.id,
    "reviewer",
    "lesson review",
    future,
  );
  await expect(
    access.readWorkspace(coach.token, owner.learner.id),
  ).resolves.toMatchObject({ kind: "allowed", via: "assignment" });
  await expect(
    access.readWorkspace(reviewer.token, owner.learner.id),
  ).resolves.toMatchObject({ kind: "allowed", via: "assignment" });
  await pool.query(
    `UPDATE assignment_grants
     SET starts_at=CURRENT_TIMESTAMP+INTERVAL '1 hour',
         expires_at=CURRENT_TIMESTAMP+INTERVAL '2 hours'
     WHERE staff_id=$1`,
    [reviewer.id],
  );
  await expect(
    access.readWorkspace(reviewer.token, owner.learner.id),
  ).resolves.toEqual({ kind: "denied" });
  await pool.query(
    `UPDATE assignment_grants
     SET starts_at=CURRENT_TIMESTAMP-INTERVAL '1 hour',
         expires_at=CURRENT_TIMESTAMP+INTERVAL '1 hour'
     WHERE staff_id=$1`,
    [reviewer.id],
  );
  for (const denied of [
    editor.token,
    moderator.token,
    admin.token,
    other.token,
  ])
    await expect(
      access.readWorkspace(denied, owner.learner.id),
    ).resolves.toEqual({ kind: "denied" });
  await pool.query(
    `UPDATE assignment_grants
     SET starts_at=CURRENT_TIMESTAMP-INTERVAL '2 hours',
         expires_at=CURRENT_TIMESTAMP-INTERVAL '1 hour'
     WHERE id=$1`,
    [coachGrant],
  );
  await expect(
    access.readWorkspace(coach.token, owner.learner.id),
  ).resolves.toEqual({ kind: "denied" });
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [reviewer.id],
  );
  await expect(
    access.readWorkspace(reviewer.token, owner.learner.id),
  ).resolves.toEqual({ kind: "denied" });
  const replacement = await access.grantAssignment(
    admin.id,
    coach.id,
    owner.learner.id,
    "coach",
    "replacement coaching",
    future,
  );
  expect(await access.revokeAssignment(admin.id, replacement)).toBe(true);
  expect(await access.revokeAssignment(admin.id, replacement)).toBe(false);
  await expect(
    access.readWorkspace(coach.token, owner.learner.id),
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    access.grantAssignment(
      owner.learner.id,
      coach.id,
      owner.learner.id,
      "coach",
      "self grant",
      future,
    ),
  ).rejects.toThrow("denied");
  await pool.query(
    "UPDATE learners SET background='technical',goal='build' WHERE id=$1",
    [owner.learner.id],
  );
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM staff_profiles WHERE principal_id=$1",
        [owner.learner.id],
      )
    ).rows[0].count,
  ).toBe("0");
});

it("requires purpose-bound support access and records every privileged read", async () => {
  const owner = await member(),
    admin = await staff("platform_admin"),
    operator = await staff("operator"),
    access = authorizationStore(pool),
    future = new Date(Date.now() + 60_000);
  await db.save(owner.learner.id, input);
  const supportGrant = await access.grantSupport(
    admin.id,
    operator.id,
    owner.learner.id,
    "operator",
    "resolve case 42",
    future,
  );
  await pool.query(
    `UPDATE support_access_grants
     SET starts_at=CURRENT_TIMESTAMP+INTERVAL '1 hour',
         expires_at=CURRENT_TIMESTAMP+INTERVAL '2 hours'
     WHERE id=$1`,
    [supportGrant],
  );
  await expect(
    access.readWorkspace(operator.token, owner.learner.id, "resolve case 42"),
  ).resolves.toEqual({ kind: "denied" });
  await pool.query(
    `UPDATE support_access_grants
     SET starts_at=CURRENT_TIMESTAMP-INTERVAL '1 hour',
         expires_at=CURRENT_TIMESTAMP+INTERVAL '1 hour'
     WHERE id=$1`,
    [supportGrant],
  );
  await expect(
    access.readWorkspace(operator.token, owner.learner.id),
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    access.readWorkspace(operator.token, owner.learner.id, "wrong purpose"),
  ).resolves.toEqual({ kind: "denied" });
  for (let read = 0; read < 2; read += 1)
    await expect(
      access.readWorkspace(operator.token, owner.learner.id, "resolve case 42"),
    ).resolves.toMatchObject({
      kind: "allowed",
      via: "support",
      purpose: "resolve case 42",
    });
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM authorization_audit WHERE support_access_id=$1 AND purpose=$2",
        [supportGrant, "resolve case 42"],
      )
    ).rows[0].count,
  ).toBe("2");
  await pool.query(
    `UPDATE support_access_grants
     SET starts_at=CURRENT_TIMESTAMP-INTERVAL '2 hours',
         expires_at=CURRENT_TIMESTAMP-INTERVAL '1 hour'
     WHERE id=$1`,
    [supportGrant],
  );
  await expect(
    access.readWorkspace(operator.token, owner.learner.id, "resolve case 42"),
  ).resolves.toEqual({ kind: "denied" });
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM authorization_audit WHERE support_access_id=$1",
        [supportGrant],
      )
    ).rows[0].count,
  ).toBe("2");
  await pool.query(
    `UPDATE support_access_grants
     SET starts_at=CURRENT_TIMESTAMP-INTERVAL '1 hour',
         expires_at=CURRENT_TIMESTAMP+INTERVAL '1 hour'
     WHERE id=$1`,
    [supportGrant],
  );
  await expect(
    access.readWorkspace(operator.token, owner.learner.id, "resolve case 42"),
  ).resolves.toMatchObject({ kind: "allowed", via: "support" });
  expect(await access.revokeSupport(admin.id, supportGrant)).toBe(true);
  await expect(
    access.readWorkspace(operator.token, owner.learner.id, "resolve case 42"),
  ).resolves.toEqual({ kind: "denied" });
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM authorization_audit WHERE support_access_id=$1",
        [supportGrant],
      )
    ).rows[0].count,
  ).toBe("3");
  await db.remove(owner.learner.id);
  expect(
    (await pool.query("SELECT count(*) FROM authorization_audit")).rows[0]
      .count,
  ).toBe("0");
});

it("limits cohort membership to its explicitly permitted shared content", async () => {
  const allowed = await member(),
    denied = await member(),
    staffReader = await staff("reviewer"),
    access = authorizationStore(pool);
  await pool.query("INSERT INTO cohorts(id) VALUES('group-a'),('group-b')");
  await pool.query(
    `INSERT INTO cohort_content(cohort_id,content_id,body)
     VALUES('group-a','guide','Group A guide'),('group-b','guide','Group B guide')`,
  );
  await pool.query(
    `INSERT INTO cohort_memberships(cohort_id,member_id,can_read_shared_content)
     VALUES('group-a',$1,true),('group-a',$2,false)`,
    [allowed.learner.id, denied.learner.id],
  );
  await expect(
    access.readCohort(allowed.token, "group-a", "guide"),
  ).resolves.toEqual({
    kind: "allowed",
    cohortId: "group-a",
    contentId: "guide",
    body: "Group A guide",
  });
  await pool.query(
    `UPDATE cohort_memberships
     SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 hour'
     WHERE cohort_id='group-a' AND member_id=$1`,
    [allowed.learner.id],
  );
  await expect(
    access.readCohort(allowed.token, "group-a", "guide"),
  ).resolves.toEqual({ kind: "denied" });
  await pool.query(
    `UPDATE cohort_memberships
     SET expires_at=NULL,revoked_at=CURRENT_TIMESTAMP
     WHERE cohort_id='group-a' AND member_id=$1`,
    [allowed.learner.id],
  );
  await expect(
    access.readCohort(allowed.token, "group-a", "guide"),
  ).resolves.toEqual({ kind: "denied" });
  for (const [credential, cohort] of [
    [allowed.token, "group-b"],
    [denied.token, "group-a"],
    [staffReader.token, "group-a"],
  ])
    await expect(
      access.readCohort(credential!, cohort!, "guide"),
    ).resolves.toEqual({ kind: "denied" });
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
