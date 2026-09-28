import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { hash, migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const access = authorizationStore(pool);
let root = "";
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, cohorts CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne-evidence-audit-"));
});

it.each([
  "wrong workspace",
  "missing assignment",
  "future assignment",
  "expired assignment",
  "revoked assignment",
  "missing exact grant",
  "future exact grant",
  "expired exact grant",
  "revoked exact grant",
  "withdrawn consent",
  "withdrawn submission",
  "nonclean evidence",
  "missing evidence",
  "revoked principal",
  "expired principal",
] as const)(
  "evidence audit denies %s without successful access events",
  async (reason) => {
    const f = await fixture();
    const owned = await f.evidence.issueDownload(f.owner.token, f.id);
    if (owned.kind !== "issued") throw new Error("Owner link denied");
    if (reason === "wrong workspace") {
      const other = await member();
      await pool.query(
        "UPDATE assignment_grants SET workspace_id=$1 WHERE id=$2",
        [other.id, f.assignment],
      );
    } else if (
      reason.includes("assignment") ||
      reason.includes("exact grant")
    ) {
      const table = reason.includes("assignment")
        ? "assignment_grants"
        : "reviewer_evidence_grants";
      const id = reason.includes("assignment") ? f.assignment : f.exact;
      if (reason.startsWith("missing"))
        await pool.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
      else {
        const change = reason.startsWith("future")
          ? "starts_at=clock_timestamp()+INTERVAL '1 hour',expires_at=clock_timestamp()+INTERVAL '2 hours'"
          : reason.startsWith("expired")
            ? "starts_at=clock_timestamp()-INTERVAL '2 hours',expires_at=clock_timestamp()-INTERVAL '1 hour'"
            : "revoked_at=clock_timestamp()";
        await pool.query(`UPDATE ${table} SET ${change} WHERE id=$1`, [id]);
      }
    } else if (reason === "withdrawn consent")
      expect(await f.evidence.revokePrivateReview(f.owner.token, f.id)).toBe(
        true,
      );
    else if (reason === "withdrawn submission")
      await pool.query(
        "UPDATE evidence_review_submissions SET status='withdrawn' WHERE id=$1",
        [f.submission],
      );
    else if (reason === "nonclean evidence")
      await pool.query(
        "UPDATE evidence_objects SET quarantine_state='infected' WHERE id=$1",
        [f.id],
      );
    else if (reason === "missing evidence")
      expect(await f.evidence.remove(f.owner.token, f.id)).toBe(true);
    else
      await pool.query(
        `UPDATE principals SET ${reason === "revoked principal" ? "revoked_at=clock_timestamp()" : "expires_at=clock_timestamp()"} WHERE id=$1`,
        [f.staff],
      );
    expect(await f.evidence.issueDownload(f.token, f.id)).toEqual({
      kind: "denied",
    });
    expect(await f.evidence.download(f.token, f.id, owned.capability)).toEqual({
      kind: "denied",
    });
    expect(await events()).toEqual([]);
  },
);

it("evidence audit rejects invalid capabilities and withholds bytes on missing object or audit failure", async () => {
  const f = await fixture();
  let now = Date.now();
  const evidence = evidenceStore(
    pool,
    f.objects,
    "synthetic-audit-secret",
    () => now,
  );
  const owned = await evidence.issueDownload(f.owner.token, f.id);
  if (owned.kind !== "issued") throw new Error("Owner link denied");
  for (const [token, id, capability] of [
    ["bad", f.id, owned.capability],
    [f.token, randomUUID(), owned.capability],
    [f.token, f.id, "bad"],
    [f.token, f.id, owned.capability + "x"],
  ]) {
    expect(await evidence.download(token!, id!, capability!)).toEqual({
      kind: "denied",
    });
  }
  now += 300_001;
  expect(await evidence.download(f.token, f.id, owned.capability)).toEqual({
    kind: "denied",
  });
  now -= 300_001;
  const key = (
    await pool.query("SELECT storage_key FROM evidence_objects WHERE id=$1", [
      f.id,
    ])
  ).rows[0].storage_key as string;
  await f.objects.remove(key);
  await expect(
    evidence.download(f.token, f.id, owned.capability),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await events()).toEqual([]);
  await f.objects.put(key, f.bytes);
  try {
    await pool.query(
      `CREATE FUNCTION reject_evidence_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic evidence audit failure'; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER reject_evidence_test_audit BEFORE INSERT ON authorization_audit FOR EACH ROW EXECUTE FUNCTION reject_evidence_test_audit()`,
    );
    await expect(evidence.issueDownload(f.token, f.id)).rejects.toThrow(
      "Synthetic evidence audit failure",
    );
    await expect(
      evidence.download(f.token, f.id, owned.capability),
    ).rejects.toThrow("Synthetic evidence audit failure");
    expect(await events()).toEqual([]);
    expect(
      await evidence.download(f.owner.token, f.id, owned.capability),
    ).toMatchObject({ kind: "allowed", data: f.bytes });
  } finally {
    await pool.query(
      "DROP TRIGGER IF EXISTS reject_evidence_test_audit ON authorization_audit",
    );
    await pool.query("DROP FUNCTION IF EXISTS reject_evidence_test_audit()");
  }
  expect(
    await evidence.download(f.token, f.id, owned.capability),
  ).toMatchObject({ kind: "allowed", data: f.bytes });
  expect((await events()).map((event) => event.action)).toEqual([
    "evidence_bytes_loaded",
  ]);
});

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function waitForEntry(
  entered: ReturnType<typeof gate>,
  reading: Promise<unknown>,
) {
  await Promise.race([
    entered.wait,
    reading.then(() => {
      throw new Error("Access finished before the expected audit gate");
    }),
  ]);
}
function pausingPool(
  entered: ReturnType<typeof gate>,
  resume: ReturnType<typeof gate>,
) {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        query: (async (statement: string, values?: unknown[]) => {
          if (statement.includes("INSERT INTO authorization_audit")) {
            entered.release();
            await resume.wait;
          }
          return client.query(statement, values);
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
}
async function waitForBlocked(blocker: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
      [blocker],
    );
    if (rows.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected blocked database operation was not observed");
}

it.each(["principal", "assignment", "exact grant"] as const)(
  "evidence audit withholds bytes when the %s expires during an object read",
  async (boundary) => {
    const f = await fixture();
    const owned = await f.evidence.issueDownload(f.owner.token, f.id);
    if (owned.kind !== "issued") throw new Error("Owner link denied");
    const table =
      boundary === "principal"
        ? "principals"
        : boundary === "assignment"
          ? "assignment_grants"
          : "reviewer_evidence_grants";
    const id =
      boundary === "principal"
        ? f.staff
        : boundary === "assignment"
          ? f.assignment
          : f.exact;
    const deadline = (
      await pool.query(
        `UPDATE ${table} SET expires_at=clock_timestamp()+INTERVAL '5 seconds' WHERE id=$1 RETURNING expires_at`,
        [id],
      )
    ).rows[0].expires_at as Date;
    let loaded = false;
    const delayed = evidenceStore(
      pool,
      {
        ...f.objects,
        async get(key) {
          const bytes = await f.objects.get(key);
          loaded = true;
          const stopAt = performance.now() + 10_000;
          while (performance.now() < stopAt) {
            if (
              (
                await pool.query(
                  "SELECT clock_timestamp()>=$1::timestamptz AS expired",
                  [deadline],
                )
              ).rows[0].expired
            )
              return bytes;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          throw new Error(
            "Database expiry was not observed within the test deadline",
          );
        },
      },
      "synthetic-audit-secret",
    );
    expect(await delayed.download(f.token, f.id, owned.capability)).toEqual({
      kind: "denied",
    });
    expect(loaded).toBe(true);
    expect(await events()).toEqual([]);
  },
  15_000,
);

it("evidence audit rolls back an event if its capability expires while audit work waits", async () => {
  const f = await fixture();
  let now = Date.now();
  const ownerStore = evidenceStore(
    pool,
    f.objects,
    "synthetic-audit-secret",
    () => now,
  );
  const owned = await ownerStore.issueDownload(f.owner.token, f.id);
  if (owned.kind !== "issued") throw new Error("Owner link denied");
  const entered = gate(),
    resume = gate();
  const delayed = evidenceStore(
    pausingPool(entered, resume),
    f.objects,
    "synthetic-audit-secret",
    () => now,
  );
  const reading = delayed.download(f.token, f.id, owned.capability);
  try {
    await waitForEntry(entered, reading);
    now += 300_001;
    resume.release();
    expect(await reading).toEqual({ kind: "denied" });
    expect(await events()).toEqual([]);
  } finally {
    resume.release();
    await Promise.allSettled([reading]);
  }
});
const boundaries = [
  "assignment",
  "exact grant",
  "consent",
  "submission",
  "principal",
  "evidence deletion",
  "workspace deletion",
] as const;
function mutation(
  f: Awaited<ReturnType<typeof fixture>>,
  boundary: (typeof boundaries)[number],
) {
  switch (boundary) {
    case "assignment":
      return [
        "UPDATE assignment_grants SET revoked_at=clock_timestamp() WHERE id=$1",
        f.assignment,
      ];
    case "exact grant":
      return [
        "UPDATE reviewer_evidence_grants SET revoked_at=clock_timestamp() WHERE id=$1",
        f.exact,
      ];
    case "consent":
      return [
        "UPDATE evidence_objects SET private_review_allowed=false,private_review_revoked_at=clock_timestamp() WHERE id=$1",
        f.id,
      ];
    case "submission":
      return [
        "UPDATE evidence_review_submissions SET status='withdrawn' WHERE id=$1",
        f.submission,
      ];
    case "principal":
      return [
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        f.staff,
      ];
    case "evidence deletion":
      return [
        "UPDATE evidence_objects SET quarantine_state='deleting' WHERE id=$1",
        f.id,
      ];
    case "workspace deletion":
      return [
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
        f.owner.id,
      ];
  }
}
it.each(boundaries)(
  "evidence audit denies a read after %s wins the lock",
  async (boundary) => {
    const f = await fixture();
    const owned = await f.evidence.issueDownload(f.owner.token, f.id);
    if (owned.kind !== "issued") throw new Error("Owner link denied");
    const revoker = await pool.connect();
    let reading: ReturnType<typeof f.evidence.download> | undefined;
    try {
      await revoker.query("BEGIN");
      const pid = (await revoker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      const [sql, id] = mutation(f, boundary);
      await revoker.query(sql!, [id]);
      reading = f.evidence.download(f.token, f.id, owned.capability);
      await waitForBlocked(pid);
      await revoker.query("COMMIT");
      expect(await reading).toEqual({ kind: "denied" });
      expect(await f.evidence.issueDownload(f.token, f.id)).toEqual({
        kind: "denied",
      });
      expect(await events()).toEqual([]);
    } finally {
      await revoker.query("ROLLBACK");
      await Promise.allSettled(reading ? [reading] : []);
      revoker.release();
    }
  },
);

it.each(["link", "bytes"] as const)(
  "evidence audit commits a successful %s before competing revocations can finish",
  async (operation) => {
    for (const boundary of boundaries) {
      const f = await fixture();
      const owned = await f.evidence.issueDownload(f.owner.token, f.id);
      if (owned.kind !== "issued") throw new Error("Owner link denied");
      const entered = gate(),
        resume = gate();
      const scoped = evidenceStore(
        pausingPool(entered, resume),
        f.objects,
        "synthetic-audit-secret",
      );
      const reading =
        operation === "link"
          ? scoped.issueDownload(f.token, f.id)
          : scoped.download(f.token, f.id, owned.capability);
      const revoker = await pool.connect();
      let revoking: Promise<unknown> | undefined;
      try {
        await waitForEntry(entered, reading);
        const [sql, id] = mutation(f, boundary);
        const readerPid = (
          await pool.query(
            "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND query LIKE 'SELECT g.id,g.expires_at FROM reviewer_evidence_grants%'",
          )
        ).rows[0].pid as number;
        revoking = revoker.query(sql!, [id]);
        await waitForBlocked(readerPid);
        expect(
          (await events()).filter((event) => event.evidence_id === f.id),
        ).toEqual([]);
        resume.release();
        expect(await reading).toMatchObject({
          kind: operation === "link" ? "issued" : "allowed",
        });
        await revoking;
        const recorded = (await events()).filter(
          (event) => event.evidence_id === f.id,
        );
        expect(recorded.map((event) => event.action)).toEqual([
          operation === "link"
            ? "evidence_link_issued"
            : "evidence_bytes_loaded",
        ]);
        expect(
          await f.evidence.download(f.token, f.id, owned.capability),
        ).toEqual({ kind: "denied" });
      } finally {
        resume.release();
        await Promise.allSettled([reading, ...(revoking ? [revoking] : [])]);
        revoker.release();
      }
    }
  },
);

it("evidence audit keeps historical events immutable through evidence removal and isolates member deletion", async () => {
  const first = await fixture("coach"),
    other = await fixture("coach");
  for (const f of [first, other]) {
    const issued = await f.evidence.issueDownload(f.token, f.id);
    if (issued.kind !== "issued") throw new Error("Staff link denied");
    expect(
      await f.evidence.download(f.token, f.id, issued.capability),
    ).toMatchObject({ kind: "allowed" });
  }
  const prior = await events();
  expect(await access.revokeAssignment(first.admin, first.assignment)).toBe(
    true,
  );
  expect(await first.evidence.remove(first.owner.token, first.id)).toBe(true);
  await pool.query("DELETE FROM assignment_grants WHERE id=$1", [
    first.assignment,
  ]);
  expect(await events()).toEqual(prior);
  await expect(
    pool.query(
      "UPDATE authorization_audit SET evidence_id=$1 WHERE evidence_id=$2",
      [other.id, first.id],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("DELETE FROM authorization_audit WHERE evidence_id=$1", [
      first.id,
    ]),
  ).rejects.toThrow("immutable");
  await db.remove(first.owner.id);
  expect(await events()).toEqual(
    prior.filter((event) => event.workspace_id === other.owner.id),
  );
});

it("evidence audit migration preserves prior event IDs and times without historical access fabrication", async () => {
  const f = await fixture("coach");
  const previous = (
    await pool.query("SELECT * FROM authorization_audit ORDER BY id")
  ).rows;
  const migration = await readFile(
    new URL(
      "../../migrations/036-staff-evidence-access-audit.sql",
      import.meta.url,
    ),
    "utf8",
  );
  // Recreate the actual v35 shape, including its action constraint, before upgrade.
  await pool.query(
    "ALTER TABLE authorization_audit DROP CONSTRAINT authorization_audit_evidence_action_check, DROP COLUMN evidence_id, DROP COLUMN assignment_grant_id",
  );
  await pool.query(
    "ALTER TABLE authorization_audit DROP CONSTRAINT authorization_audit_action_check, ADD CONSTRAINT authorization_audit_action_check CHECK(action IN ('grant_created','grant_revoked','workspace_read','support_content_read'))",
  );
  await pool.query(migration);
  await pool.query(migration);
  expect(
    (await pool.query("SELECT * FROM authorization_audit ORDER BY id")).rows,
  ).toEqual(previous);
  expect(await events()).toEqual([]);
  expect(await f.evidence.issueDownload(f.token, f.id)).toMatchObject({
    kind: "issued",
  });
  const withAccess = (
    await pool.query("SELECT * FROM authorization_audit ORDER BY id")
  ).rows;
  await pool.query(migration);
  expect(
    (await pool.query("SELECT * FROM authorization_audit ORDER BY id")).rows,
  ).toEqual(withAccess);
});
afterEach(async () => rm(root, { recursive: true, force: true }));
afterAll(async () => pool.end());

async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw new Error("Member setup failed");
  return { token, id: session.learner.id };
}
async function fixture(role: "coach" | "reviewer" = "reviewer") {
  const owner = await member();
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 3_600_000);
  const admin = await access.provisionStaff(
    randomBytes(32).toString("hex"),
    "platform_admin",
    expires,
  );
  const staff = await access.provisionStaff(token, role, expires);
  const objects = fileObjectStorage(root);
  const evidence = evidenceStore(pool, objects, "synthetic-audit-secret");
  const bytes = Buffer.from(
    "Private synthetic source bytes excluded from audit",
  );
  const name = "private-audit-source.txt";
  const purpose = "Private synthetic purpose excluded from audit";
  const uploaded = await evidence.upload(owner.token, {
    name,
    mediaType: "text/plain",
    data: bytes,
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (uploaded.kind !== "created") throw new Error("Evidence setup failed");
  const id = uploaded.id;
  expect(await evidence.transitionQuarantine(id, "clean")).toBe(true);
  expect(await evidence.submitForReview(owner.token, id)).toBe(true);
  const submission = (
    await pool.query(
      "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
      [id],
    )
  ).rows[0].id as string;
  const assignment = await access.grantAssignment(
    admin,
    staff,
    owner.id,
    role,
    purpose,
    expires,
  );
  const exact =
    role === "reviewer"
      ? await access.grantEvidenceReview(
          admin,
          staff,
          assignment,
          submission,
          purpose,
          expires,
        )
      : null;
  return {
    owner,
    token,
    admin,
    staff,
    evidence,
    objects,
    bytes,
    name,
    purpose,
    id,
    submission,
    assignment,
    exact,
    expires,
    role,
  };
}
async function events() {
  return (
    await pool.query(
      "SELECT * FROM authorization_audit WHERE action IN ('evidence_link_issued','evidence_bytes_loaded') ORDER BY id",
    )
  ).rows;
}

it.each(["coach", "reviewer"] as const)(
  "evidence audit records one deterministic %s path for each successful link and byte read",
  async (role) => {
    const f = await fixture(role);
    const otherAssignment = await access.grantAssignment(
      f.admin,
      f.staff,
      f.owner.id,
      role,
      f.purpose,
      f.expires,
    );
    const paths = [{ assignment: f.assignment, exact: f.exact }];
    if (role === "reviewer") {
      paths.push({
        assignment: f.assignment,
        exact: await access.grantEvidenceReview(
          f.admin,
          f.staff,
          f.assignment,
          f.submission,
          f.purpose,
          f.expires,
        ),
      });
      paths.push({
        assignment: otherAssignment,
        exact: await access.grantEvidenceReview(
          f.admin,
          f.staff,
          otherAssignment,
          f.submission,
          f.purpose,
          f.expires,
        ),
      });
    } else paths.push({ assignment: otherAssignment, exact: null });
    paths.sort(
      (a, b) =>
        a.assignment.localeCompare(b.assignment) ||
        (a.exact ?? "").localeCompare(b.exact ?? ""),
    );
    const issued = await f.evidence.issueDownload(f.token, f.id);
    if (issued.kind !== "issued") throw new Error("Staff link denied");
    expect(await events()).toHaveLength(1);
    expect(
      await f.evidence.download(f.token, f.id, issued.capability),
    ).toMatchObject({ kind: "allowed", data: f.bytes });
    const recorded = await events();
    expect(recorded.map((row) => row.action)).toEqual([
      "evidence_link_issued",
      "evidence_bytes_loaded",
    ]);
    for (const event of recorded)
      expect(event).toEqual({
        id: expect.any(String),
        actor_id: f.staff,
        staff_id: f.staff,
        workspace_id: f.owner.id,
        grant_type: role === "reviewer" ? "evidence_review" : "assignment",
        grant_id: paths[0]!.exact ?? paths[0]!.assignment,
        assignment_grant_id: paths[0]!.assignment,
        evidence_id: f.id,
        action: expect.stringMatching(/^evidence_(link_issued|bytes_loaded)$/),
        occurred_at: expect.any(Date),
      });
    const storage = (
      await pool.query("SELECT storage_key FROM evidence_objects WHERE id=$1", [
        f.id,
      ])
    ).rows[0].storage_key;
    const serialized = JSON.stringify(recorded);
    for (const privateValue of [
      f.token,
      hash(f.token),
      f.owner.token,
      hash(f.owner.token),
      issued.capability,
      ...issued.capability.split("."),
      f.name,
      f.purpose,
      f.bytes.toString(),
      storage,
    ])
      expect(serialized).not.toContain(privateValue);
    const owned = await f.evidence.issueDownload(f.owner.token, f.id);
    if (owned.kind !== "issued") throw new Error("Owner link denied");
    expect(
      await f.evidence.download(f.owner.token, f.id, owned.capability),
    ).toMatchObject({ kind: "allowed", data: f.bytes });
    expect(await events()).toEqual(recorded);
  },
);
