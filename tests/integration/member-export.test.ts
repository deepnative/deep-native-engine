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
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { deterministicRegistry } from "../../src/adapters.ts";
import { jobStore, requestFingerprint } from "../../src/jobs.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const exported = memberExportStore(pool);
const token = () => randomBytes(32).toString("hex");
const ready = async (value: string) => {
  const result = await exported.exportOwned(value);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Owner export unavailable");
  return result.payload;
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

async function receiptFixture(owner: Awaited<ReturnType<typeof member>>) {
  const objects = fileObjectStorage(storageRoot);
  const evidence = evidenceStore(pool, objects, "synthetic-export-receipt");
  const local = localAiConsentStore(
    pool,
    objects,
    deterministicRegistry({}, "test"),
  );
  const uploaded = await evidence.upload(owner.token, {
    name: "Private synthetic source.txt",
    mediaType: "text/plain",
    data: Buffer.from("Private source content excluded from permission export"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (uploaded.kind !== "created") throw Error("Synthetic upload failed");
  await evidence.transitionQuarantine(uploaded.id, "clean");
  const granted = await local.grant(owner.token, uploaded.id);
  if (granted.kind !== "granted") throw Error("Synthetic permission failed");
  return {
    evidence,
    local,
    evidenceId: uploaded.id,
    receiptId: granted.receiptId,
  };
}

it("exports a withdrawn completed exercise as a text-free retained completion marker", async () => {
  const owner = await member();
  const other = await member();
  expect(
    await db.save(owner.id, {
      instruction: "Invented private starter instruction",
      verification: "Invented private starter verification",
      complete: true,
    }),
  ).toBe("saved");
  const before = await ready(owner.token);
  expect(JSON.stringify(before)).toContain(
    "Invented private starter instruction",
  );
  expect(await db.withdrawExercise(owner.token, "clear-instructions", 1)).toBe(
    "withdrawn",
  );
  const after = await ready(owner.token);
  expect(after.version).toBe("local-member-records-v16");
  expect(after.records).toMatchObject({
    exercises: [
      {
        lessonId: "clear-instructions",
        lessonVersion: 1,
        instruction: null,
        verification: null,
        completedAt: expect.any(Date),
        state: "withdrawn",
        withdrawnAt: expect.any(Date),
      },
    ],
  });
  expect(JSON.stringify(after)).not.toContain(
    "Invented private starter instruction",
  );
  expect(JSON.stringify(after)).not.toContain(
    "Invented private starter verification",
  );
  expect((await ready(other.token)).records).toMatchObject({ exercises: [] });
  await db.remove(owner.id);
  expect((await exported.exportOwned(owner.token)).kind).toBe("denied");
  expect(
    (
      await pool.query("SELECT count(*) FROM exercises WHERE learner_id=$1", [
        owner.id,
      ])
    ).rows[0].count,
  ).toBe("0");
});

it("exports each retained local permission receipt once with safe owned job linkage", async () => {
  const owner = await member(),
    other = await member();
  const own = await receiptFixture(owner);
  expect(await own.local.grant(owner.token, own.evidenceId)).toEqual({
    kind: "granted",
    receiptId: own.receiptId,
  });
  const pending = await own.local.enqueue(
    owner.token,
    own.receiptId,
    "private-export-idempotency-key",
  );
  expect(pending.kind).toBe("queued");
  expect(
    await own.local.enqueue(
      owner.token,
      own.receiptId,
      "private-export-idempotency-key",
    ),
  ).toEqual(pending);
  const generic = await jobStore(pool).enqueueForMember(
    owner.token,
    "email",
    "test",
    "notify",
    "private-generic-key",
    requestFingerprint("private-fingerprint"),
  );
  const snapshot = await ready(owner.token);
  expect(snapshot.records).toMatchObject({
    localAiReceipts: [
      {
        id: own.receiptId,
        evidenceId: own.evidenceId,
        revisionNumber: 1,
        purpose: "evidence-summary-local-v1",
        statementVersion: "local-simulation-v1",
        grantedAt: expect.any(Date),
        withdrawnAt: null,
      },
    ],
    adapterJobs: expect.arrayContaining([
      expect.objectContaining({
        id: pending.kind === "queued" ? pending.jobId : "",
        localAiReceiptId: own.receiptId,
      }),
      expect.objectContaining({ id: generic.id, localAiReceiptId: null }),
    ]),
  });
  const records = snapshot.records as unknown as {
    localAiReceipts: Record<string, unknown>[];
    adapterJobs: Record<string, unknown>[];
  };
  expect(records.localAiReceipts).toHaveLength(1);
  expect(Object.keys(records.localAiReceipts[0]!).sort()).toEqual(
    [
      "id",
      "evidenceId",
      "revisionNumber",
      "purpose",
      "statementVersion",
      "grantedAt",
      "withdrawnAt",
    ].sort(),
  );
  expect(Object.keys(records.adapterJobs[0]!).sort()).toEqual(
    [
      "id",
      "adapter",
      "mode",
      "status",
      "attempts",
      "maxAttempts",
      "safeError",
      "createdAt",
      "updatedAt",
      "localAiReceiptId",
    ].sort(),
  );
  expect(await ready(owner.token)).toEqual(snapshot);
  expect((await ready(other.token)).records).toMatchObject({
    localAiReceipts: [],
    adapterJobs: [],
  });
  expect(JSON.stringify(snapshot)).not.toMatch(
    /Private source|private-export-idempotency|private-generic-key|source_digest|storage_key|request_fingerprint|attempt_token/,
  );
  expect(await own.local.withdraw(owner.token, own.receiptId)).toBe(true);
  const withdrawn = await ready(owner.token);
  expect(withdrawn.records).toMatchObject({
    localAiReceipts: [{ id: own.receiptId, withdrawnAt: expect.any(Date) }],
  });
  expect(await own.local.withdraw(owner.token, own.receiptId)).toBe(true);
  expect(await ready(owner.token)).toEqual(withdrawn);
  const replacement = await own.local.grant(owner.token, own.evidenceId);
  expect(replacement.kind).toBe("granted");
  if (replacement.kind !== "granted") throw Error("Synthetic regrant failed");
  expect(replacement.receiptId).not.toBe(own.receiptId);
  const regranted = await ready(owner.token);
  expect(regranted.records.localAiReceipts).toHaveLength(2);
  expect(regranted.records).toMatchObject({
    localAiReceipts: expect.arrayContaining([
      expect.objectContaining({
        id: own.receiptId,
        withdrawnAt: expect.any(Date),
      }),
      expect.objectContaining({ id: replacement.receiptId, withdrawnAt: null }),
    ]),
  });
});

it("never links an owned job to another member's receipt", async () => {
  const owner = await member(),
    other = await member();
  const foreign = await receiptFixture(other);
  const pending = await foreign.local.enqueue(
    other.token,
    foreign.receiptId,
    "synthetic-mismatched-owner",
  );
  if (pending.kind !== "queued") throw Error("Synthetic job failed");
  // The receipt FK does not enforce equal ownership; defend at export even
  // against inconsistent rows that cannot be created through the member API.
  await pool.query("UPDATE adapter_jobs SET member_id=$1 WHERE id=$2", [
    owner.id,
    pending.jobId,
  ]);
  const snapshot = await ready(owner.token);
  expect(snapshot.records).toMatchObject({
    localAiReceipts: [],
    adapterJobs: [{ id: pending.jobId, localAiReceiptId: null }],
  });
  expect(JSON.stringify(snapshot)).not.toContain(foreign.receiptId);
  expect((await ready(other.token)).records).toMatchObject({
    localAiReceipts: [{ id: foreign.receiptId }],
    adapterJobs: [],
  });
});

it("denies staff-only access while retained owner permission history exists", async () => {
  const owner = await member();
  const own = await receiptFixture(owner);
  const staff = token();
  await authorizationStore(pool).provisionStaff(
    staff,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  expect(await exported.exportOwned(staff)).toEqual({ kind: "denied" });
  expect((await ready(owner.token)).records).toMatchObject({
    localAiReceipts: [{ id: own.receiptId }],
  });
});

it("retains retired source permission history until source deletion cascades receipts and jobs", async () => {
  const owner = await member();
  const own = await receiptFixture(owner);
  expect(
    (await own.local.enqueue(owner.token, own.receiptId, "retired-source-job"))
      .kind,
  ).toBe("queued");
  expect(await own.evidence.submitForReview(owner.token, own.evidenceId)).toBe(
    true,
  );
  const revised = await own.evidence.upload(owner.token, {
    name: "Revision.txt",
    mediaType: "text/plain",
    data: Buffer.from("Private replacement source"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
    revisesId: own.evidenceId,
  });
  if (revised.kind !== "created") throw Error("Synthetic revision failed");
  await own.evidence.transitionQuarantine(revised.id, "clean");
  const permission = await own.local.grant(owner.token, revised.id);
  if (permission.kind !== "granted")
    throw Error("Synthetic revision grant failed");
  const retired = await ready(owner.token);
  expect(retired.records.localAiReceipts).toHaveLength(2);
  expect(retired.records).toMatchObject({
    localAiReceipts: expect.arrayContaining([
      expect.objectContaining({
        id: own.receiptId,
        evidenceId: own.evidenceId,
        revisionNumber: 1,
        withdrawnAt: expect.any(Date),
      }),
      expect.objectContaining({
        id: permission.receiptId,
        evidenceId: revised.id,
        revisionNumber: 2,
        withdrawnAt: null,
      }),
    ]),
  });
  expect(await own.local.grant(owner.token, own.evidenceId)).toEqual({
    kind: "denied",
  });
  expect(await own.evidence.remove(owner.token, revised.id)).toBe(true);
  expect((await ready(owner.token)).records).toMatchObject({
    localAiReceipts: [{ id: own.receiptId, withdrawnAt: expect.any(Date) }],
  });
  expect(await own.evidence.remove(owner.token, own.evidenceId)).toBe(true);
  expect((await ready(owner.token)).records).toMatchObject({
    localAiReceipts: [],
    adapterJobs: [],
  });
});

it("counts retained receipts at the aggregate record boundary and fails closed on receipt query errors", async () => {
  const owner = await member();
  const own = await receiptFixture(owner);
  await own.local.withdraw(owner.token, own.receiptId);
  await pool.query(
    `INSERT INTO local_ai_receipts(id,member_id,workspace_id,evidence_id,revision_number,source_digest,purpose,statement_version,granted_at,withdrawn_at)
    SELECT gen_random_uuid(),member_id,workspace_id,evidence_id,revision_number,source_digest,purpose,statement_version,granted_at,withdrawn_at
    FROM local_ai_receipts CROSS JOIN generate_series(1,$2) WHERE id=$1`,
    [own.receiptId, MAX_MEMBER_EXPORT_RECORDS - 1],
  );
  expect(
    (
      (await ready(owner.token)).records as unknown as {
        localAiReceipts: unknown[];
      }
    ).localAiReceipts,
  ).toHaveLength(MAX_MEMBER_EXPORT_RECORDS);
  const generic = await jobStore(pool).enqueueForMember(
    owner.token,
    "email",
    "test",
    "notify",
    "boundary-job",
    requestFingerprint("synthetic"),
  );
  expect(await exported.exportOwned(owner.token)).toMatchObject({
    kind: "ready",
    payload: { page: { complete: false, recordCount: 100 } },
  });
  await assertAuthorizationUnlocked(owner.id);
  await pool.query("DELETE FROM adapter_jobs WHERE id=$1", [generic.id]);
  const broken = {
    async connect() {
      const client = await pool.connect();
      return {
        query(sql: string, values?: unknown[]) {
          return sql.includes("FROM local_ai_receipts")
            ? client.query(
                "SELECT synthetic_missing_receipt_column FROM local_ai_receipts",
              )
            : client.query(sql, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  expect(await memberExportStore(broken).exportOwned(owner.token)).toEqual({
    kind: "unavailable",
  });
  await assertAuthorizationUnlocked(owner.id);
  expect(
    (
      (await ready(owner.token)).records as unknown as {
        localAiReceipts: unknown[];
      }
    ).localAiReceipts,
  ).toHaveLength(MAX_MEMBER_EXPORT_RECORDS);
});

it("keeps receipt withdrawal and linked job status in one repeatable snapshot", async () => {
  const owner = await member();
  const own = await receiptFixture(owner);
  expect(
    (await own.local.enqueue(owner.token, own.receiptId, "snapshot-job")).kind,
  ).toBe("queued");
  const controlled = controlledExport();
  const reading = controlled.exported.exportOwned(owner.token);
  try {
    await controlled.authorized.wait;
    expect(await own.local.withdraw(owner.token, own.receiptId)).toBe(true);
    controlled.resume.release();
    expect(await reading).toMatchObject({
      kind: "ready",
      payload: {
        records: {
          localAiReceipts: [{ id: own.receiptId, withdrawnAt: null }],
          adapterJobs: [{ localAiReceiptId: own.receiptId, status: "pending" }],
        },
      },
    });
    expect((await ready(owner.token)).records).toMatchObject({
      localAiReceipts: [{ id: own.receiptId, withdrawnAt: expect.any(Date) }],
      adapterJobs: [{ localAiReceiptId: own.receiptId, status: "exhausted" }],
    });
  } finally {
    controlled.resume.release();
    await Promise.allSettled([reading]);
  }
});

it("serializes an export formed first before completed-exercise withdrawal", async () => {
  const owner = await member();
  await db.save(owner.id, {
    instruction: "Invented export-first starter instruction",
    verification: "Invented export-first starter check",
    complete: true,
  });
  const controlled = controlledExport();
  const reading = controlled.exported.exportOwned(owner.token);
  const writerConnected = gate();
  let writerPid = 0;
  const writerPool = {
    async connect() {
      const client = await pool.connect();
      writerPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      writerConnected.release();
      return client;
    },
  } as unknown as Pool;
  let writing: Promise<string> | undefined;
  let finished = false;
  try {
    await controlled.authorized.wait;
    writing = store(writerPool)
      .withdrawExercise(owner.token, "clear-instructions", 1)
      .then((value) => {
        finished = true;
        return value;
      });
    await writerConnected.wait;
    expect(
      await waitForOperation(writerPid, controlled.state.pid, () => finished),
    ).toBe("blocked");
    controlled.resume.release();
    const earlier = await reading;
    expect(earlier.kind).toBe("ready");
    expect(JSON.stringify(earlier)).toContain(
      "Invented export-first starter instruction",
    );
    expect(await writing).toBe("withdrawn");
    const after = await ready(owner.token);
    expect(JSON.stringify(after)).not.toContain(
      "Invented export-first starter instruction",
    );
    expect(after.records).toMatchObject({
      exercises: [{ state: "withdrawn", instruction: null }],
    });
  } finally {
    controlled.resume.release();
    await Promise.allSettled([reading, ...(writing ? [writing] : [])]);
  }
}, 15_000);

it("fails closed when an exercise withdrawal commits before an in-flight export locks its row", async () => {
  const owner = await member();
  await db.save(owner.id, {
    instruction: "Invented withdrawal-first starter instruction",
    verification: "Invented withdrawal-first starter check",
    complete: true,
  });
  const mutator = await pool.connect();
  const controlled = controlledExport();
  controlled.resume.release();
  let reading: ReturnType<typeof exported.exportOwned> | undefined;
  let finished = false;
  try {
    const writerPid = (await mutator.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid as number;
    await mutator.query("BEGIN");
    await mutator.query(
      "UPDATE exercises SET instruction=NULL,verification=NULL,withdrawn_at=clock_timestamp() WHERE learner_id=$1 AND lesson_id='clear-instructions' AND lesson_version=1",
      [owner.id],
    );
    reading = controlled.exported.exportOwned(owner.token).then((result) => {
      finished = true;
      return result;
    });
    await controlled.connected.wait;
    expect(
      await waitForOperation(controlled.state.pid, writerPid, () => finished),
    ).toBe("blocked");
    await mutator.query("COMMIT");
    const result = await reading;
    expect(JSON.stringify(result)).not.toContain(
      "Invented withdrawal-first starter instruction",
    );
    expect(result.kind).toBe("unavailable");
    expect((await ready(owner.token)).records).toMatchObject({
      exercises: [
        { state: "withdrawn", instruction: null, verification: null },
      ],
    });
  } finally {
    await mutator.query("ROLLBACK");
    await Promise.allSettled(reading ? [reading] : []);
    mutator.release();
  }
}, 15_000);

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
    await receiptFixture(owner);
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
    const receipt = await receiptFixture(owner);
    await receipt.local.enqueue(
      owner.token,
      receipt.receiptId,
      "export-deletion-race",
    );
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
            localAiReceipts: [{ id: receipt.receiptId }],
            adapterJobs: [{ localAiReceiptId: receipt.receiptId }],
          },
        },
      });
      await changing;
      expect(exportStateAtMutation).toBe("committed");
      if (action === "account deletion") {
        expect(
          (
            await pool.query(
              "SELECT id FROM local_ai_receipts WHERE member_id=$1",
              [owner.id],
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await pool.query("SELECT id FROM adapter_jobs WHERE member_id=$1", [
              owner.id,
            ])
          ).rows,
        ).toEqual([]);
      }
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
  await receiptFixture(owner);
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
    version: "local-member-records-v16",
    profile: { id: a.id, background: "explorer" },
    records: {
      milestones: [{ milestoneTitle: "Invented milestone" }],
    },
  });
  expect(
    (own.records as unknown as { proposals: { body: string | null }[] })
      .proposals,
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
    (after.records as unknown as { proposals: { body: string | null }[] })
      .proposals,
  ).toHaveLength(2);
  expect(
    (after.records as unknown as { proposals: { body: string | null }[] })
      .proposals,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ body: null })]));
  expect(JSON.stringify(after)).not.toContain("Invented proposal text");
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [a.id],
  );
  expect(await exported.exportOwned(a.token)).toEqual({ kind: "denied" });
});

it("returns explicitly incomplete bounded pages at record and byte limits", async () => {
  const a = await member();
  for (let i = 0; i <= MAX_MEMBER_EXPORT_RECORDS; i++) {
    await pool.query(
      `INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at)
       VALUES($1,$2,$3,'Invented sample','Original',CURRENT_TIMESTAMP)`,
      [randomUUID(), a.id, `Idea ${i}`],
    );
  }
  expect(await exported.exportOwned(a.token)).toMatchObject({
    kind: "ready",
    payload: { page: { complete: false, nextCursor: expect.any(String) } },
  });
  await assertAuthorizationUnlocked(a.id);
  await pool.query("DELETE FROM member_proposals WHERE member_id=$1", [a.id]);
  for (let i = 0; i < 70; i++) {
    await pool.query(
      `INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at)
       VALUES($1,$2,$3,$4,'Original',CURRENT_TIMESTAMP)`,
      [randomUUID(), a.id, `Idea ${i}`, `${i}${"x".repeat(3990)}`],
    );
  }
  expect(await exported.exportOwned(a.token)).toMatchObject({
    kind: "ready",
    payload: { page: { complete: false, nextCursor: expect.any(String) } },
  });
  await assertAuthorizationUnlocked(a.id);
  await pool.query("DELETE FROM member_proposals WHERE member_id=$1", [a.id]);
  expect(await exported.exportOwned(a.token)).toMatchObject({
    kind: "ready",
    payload: { records: { proposals: [] } },
  });
});

it("withholds stale milestone text changed after a repeatable-read snapshot", async () => {
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
  expect(result).toEqual({ kind: "unavailable" });
  expect(JSON.stringify(result)).not.toContain("Original milestone");
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
