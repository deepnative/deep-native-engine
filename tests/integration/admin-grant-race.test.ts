import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  authorizationStore,
  type AuthorizationStore,
} from "../../src/authorization.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const access = authorizationStore(pool);
const kinds = ["assignment", "support", "evidence_review"] as const;
type Kind = (typeof kinds)[number];
const operations = kinds.flatMap((kind) =>
  (["create", "revoke"] as const).map((action) => ({ kind, action })),
);
const tables = {
  assignment: "assignment_grants",
  support: "support_access_grants",
  evidence_review: "reviewer_evidence_grants",
};

beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, cohorts CASCADE");
});
afterAll(async () => pool.end());

async function fixture(kind: Kind, action: "create" | "revoke") {
  const token = randomBytes(32).toString("hex");
  const db = store(pool);
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw new Error("Member fixture denied");
  const workspace = session.learner.id;
  const expires = new Date(Date.now() + 3_600_000);
  const admin = await access.provisionStaff(
    randomBytes(32).toString("hex"),
    "platform_admin",
    expires,
  );
  const staff = await access.provisionStaff(
    randomBytes(32).toString("hex"),
    kind === "support" ? "operator" : "reviewer",
    expires,
  );
  const purpose = "Private synthetic grant purpose";
  let assignment = "";
  const submission = randomUUID();
  if (kind === "evidence_review") {
    assignment = await access.grantAssignment(
      admin,
      staff,
      workspace,
      "reviewer",
      purpose,
      expires,
    );
    const evidence = randomUUID();
    await pool.query(
      `INSERT INTO evidence_objects(
        id,workspace_id,owner_principal_id,original_name,media_type,
        byte_size,sha256,storage_key,quarantine_state,private_review_allowed,
        community_publication_allowed,rights_attested_at
      ) VALUES($1,$2,$2,'private.txt','text/plain',1,$3,$4,'clean',true,false,CURRENT_TIMESTAMP)`,
      [evidence, workspace, "a".repeat(64), randomUUID()],
    );
    await pool.query(
      "INSERT INTO evidence_review_submissions(id,evidence_id,submitted_by) VALUES($1,$2,$3)",
      [submission, evidence, workspace],
    );
  }
  const create = (auth: AuthorizationStore, actor = admin) =>
    kind === "assignment"
      ? auth.grantAssignment(
          actor,
          staff,
          workspace,
          "reviewer",
          purpose,
          expires,
        )
      : kind === "support"
        ? auth.grantSupport(
            actor,
            staff,
            workspace,
            "operator",
            purpose,
            expires,
          )
        : auth.grantEvidenceReview(
            actor,
            staff,
            assignment,
            submission,
            purpose,
            expires,
          );
  const target = action === "revoke" ? await create(access) : null;
  const run = (auth: AuthorizationStore, actor = admin) => {
    if (target === null) return create(auth, actor);
    return kind === "assignment"
      ? auth.revokeAssignment(actor, target)
      : kind === "support"
        ? auth.revokeSupport(actor, target)
        : auth.revokeEvidenceReview(actor, target);
  };
  const state = async () => ({
    grants: (
      await pool.query(`SELECT id,revoked_at FROM ${tables[kind]} ORDER BY id`)
    ).rows,
    events: (
      await pool.query(
        "SELECT * FROM authorization_audit WHERE grant_type=$1 ORDER BY id",
        [kind],
      )
    ).rows,
  });
  return { admin, staff, workspace, purpose, target, run, state };
}

async function connection() {
  const client = await pool.connect();
  await client.query("SET statement_timeout='5s'");
  const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid as number;
  const auth = authorizationStore({
    query: client.query.bind(client),
  } as unknown as Pool);
  return { client, pid, auth };
}

function observed(operation: Promise<string | boolean>) {
  let settled = false;
  const result = operation.then(
    (value) => {
      settled = true;
      return { value, error: null };
    },
    (error: Error) => {
      settled = true;
      return { value: null, error: error.message };
    },
  );
  return { result, settled: () => settled };
}

async function blocked(
  blocker: number,
  waiter: number,
  settled: () => boolean,
) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const result = await pool.query(
      "SELECT $1=ANY(pg_blocking_pids($2)) AS blocked",
      [blocker, waiter],
    );
    if (result.rows[0].blocked) return true;
    if (settled()) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    "Expected database blocker was not observed within 2 seconds",
  );
}

it.each(operations)(
  "administrator revocation-first denies $kind $action without mutation or audit",
  async ({ kind, action }) => {
    const f = await fixture(kind, action);
    const before = await f.state();
    const revoker = await connection();
    const mutation = await connection();
    let pending: ReturnType<typeof observed> | undefined;
    try {
      await revoker.client.query("BEGIN");
      await revoker.client.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [f.admin],
      );
      pending = observed(f.run(mutation.auth));
      const waited = await blocked(revoker.pid, mutation.pid, pending.settled);
      await revoker.client.query("COMMIT");
      const outcome = await pending.result;
      expect({ waited, outcome, persisted: await f.state() }).toEqual({
        waited: true,
        outcome:
          action === "create"
            ? { value: null, error: "Privileged grant denied." }
            : { value: false, error: null },
        persisted: before,
      });
    } finally {
      await revoker.client.query("ROLLBACK");
      await pending?.result;
      revoker.client.release();
      mutation.client.release();
    }
  },
);

async function success(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: Kind,
  action: "create" | "revoke",
  before: Awaited<ReturnType<typeof f.state>>,
  outcome: Awaited<ReturnType<typeof observed>["result"]>,
) {
  expect(outcome).toEqual({
    value: action === "create" ? expect.any(String) : true,
    error: null,
  });
  const after = await f.state();
  const id = f.target ?? outcome.value;
  expect(after.grants).toEqual([
    { id, revoked_at: action === "create" ? null : expect.any(Date) },
  ]);
  expect(after.events).toEqual([
    ...before.events,
    {
      id: expect.any(String),
      actor_id: f.admin,
      staff_id: f.staff,
      workspace_id: f.workspace,
      grant_type: kind,
      grant_id: id,
      action: action === "create" ? "grant_created" : "grant_revoked",
      occurred_at: expect.any(Date),
      evidence_id: null,
      assignment_grant_id: null,
    },
  ]);
  expect(JSON.stringify(after.events)).not.toContain(f.purpose);
}

it.each(operations)(
  "administrator revocation rollback allows waiting $kind $action",
  async ({ kind, action }) => {
    const f = await fixture(kind, action);
    const before = await f.state();
    const revoker = await connection();
    const mutation = await connection();
    let pending: ReturnType<typeof observed> | undefined;
    try {
      await revoker.client.query("BEGIN");
      await revoker.client.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [f.admin],
      );
      pending = observed(f.run(mutation.auth));
      expect(await blocked(revoker.pid, mutation.pid, pending.settled)).toBe(
        true,
      );
      expect(await f.state()).toEqual(before);
      await revoker.client.query("ROLLBACK");
      await success(f, kind, action, before, await pending.result);
    } finally {
      await revoker.client.query("ROLLBACK");
      await pending?.result;
      revoker.client.release();
      mutation.client.release();
    }
  },
);

it.each(
  operations.flatMap((operation) =>
    (["COMMIT", "ROLLBACK"] as const).map((end) => ({ ...operation, end })),
  ),
)(
  "administrator waits for mutation-first $kind $action $end including audit",
  async ({ kind, action, end }) => {
    const f = await fixture(kind, action);
    const before = await f.state();
    const mutation = await connection();
    const revoker = await connection();
    let revoking: Promise<unknown> | undefined;
    try {
      await mutation.client.query("BEGIN");
      const outcome = await observed(f.run(mutation.auth)).result;
      expect(outcome.error).toBeNull();
      expect(outcome.value).toBeTruthy();
      expect(await f.state()).toEqual(before);
      await revoker.client.query("BEGIN");
      let settled = false;
      revoking = revoker.client
        .query(
          "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [f.admin],
        )
        .finally(() => {
          settled = true;
        });
      expect(await blocked(mutation.pid, revoker.pid, () => settled)).toBe(
        true,
      );
      expect(
        (
          await pool.query("SELECT revoked_at FROM principals WHERE id=$1", [
            f.admin,
          ])
        ).rows[0].revoked_at,
      ).toBeNull();
      await mutation.client.query(end);
      await revoking;
      await revoker.client.query("COMMIT");
      if (end === "COMMIT") await success(f, kind, action, before, outcome);
      else expect(await f.state()).toEqual(before);
      const persisted = await f.state();
      expect(await observed(f.run(mutation.auth)).result).toEqual(
        action === "create"
          ? { value: null, error: "Privileged grant denied." }
          : { value: false, error: null },
      );
      expect(await f.state()).toEqual(persisted);
    } finally {
      await mutation.client.query("ROLLBACK");
      await revoking;
      await revoker.client.query("ROLLBACK");
      mutation.client.release();
      revoker.client.release();
    }
  },
);

it.each(kinds)(
  "concurrent duplicate %s revocations produce one mutation and one audit",
  async (kind) => {
    const f = await fixture(kind, "revoke");
    const before = await f.state();
    const first = await connection();
    const second = await connection();
    let pending: ReturnType<typeof observed> | undefined;
    try {
      await first.client.query("BEGIN");
      expect(await f.run(first.auth)).toBe(true);
      pending = observed(f.run(second.auth));
      expect(await blocked(first.pid, second.pid, pending.settled)).toBe(true);
      await first.client.query("COMMIT");
      expect(await pending.result).toEqual({ value: false, error: null });
      expect(await f.run(access)).toBe(false);
      await success(f, kind, "revoke", before, { value: true, error: null });
    } finally {
      await first.client.query("ROLLBACK");
      await pending?.result;
      first.client.release();
      second.client.release();
    }
  },
);

it.each(
  operations.flatMap((operation) =>
    (["audit", "mutation"] as const).map((failure) => ({
      ...operation,
      failure,
    })),
  ),
)(
  "$kind $action $failure failure rolls back, releases locks and recovers",
  async ({ kind, action, failure }) => {
    const f = await fixture(kind, action);
    const before = await f.state();
    const mutation = await connection();
    const revoker = await connection();
    const table = failure === "audit" ? "authorization_audit" : tables[kind];
    try {
      await pool.query(
        `CREATE FUNCTION fail_admin_grant_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic grant failure'; END $$`,
      );
      await pool.query(
        `CREATE TRIGGER fail_admin_grant_test BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_admin_grant_test()`,
      );
      expect(await observed(f.run(mutation.auth)).result).toEqual({
        value: null,
        error: "Synthetic grant failure",
      });
      expect(await f.state()).toEqual(before);
      // An independent principal update proves failed statement
      // locks were released; restore authorization by rolling this update back.
      await revoker.client.query("BEGIN");
      await revoker.client.query("SET LOCAL lock_timeout='500ms'");
      await revoker.client.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [f.admin],
      );
      await revoker.client.query("ROLLBACK");
    } finally {
      await revoker.client.query("ROLLBACK");
      await pool.query(
        `DROP TRIGGER IF EXISTS fail_admin_grant_test ON ${table}`,
      );
      await pool.query("DROP FUNCTION IF EXISTS fail_admin_grant_test()");
      mutation.client.release();
      revoker.client.release();
    }
    await success(
      f,
      kind,
      action,
      before,
      await observed(f.run(access)).result,
    );
  },
);

it.each(operations)(
  "$kind $action lock timeout leaves no mutation and permits recovery",
  async ({ kind, action }) => {
    const f = await fixture(kind, action);
    const before = await f.state();
    const revoker = await connection();
    const mutation = await connection();
    try {
      await revoker.client.query("BEGIN");
      await revoker.client.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [f.admin],
      );
      await mutation.client.query("SET lock_timeout='50ms'");
      await expect(f.run(mutation.auth)).rejects.toMatchObject({
        code: "55P03",
      });
      expect(await f.state()).toEqual(before);
      await revoker.client.query("ROLLBACK");
      await success(
        f,
        kind,
        action,
        before,
        await observed(f.run(mutation.auth)).result,
      );
    } finally {
      await revoker.client.query("ROLLBACK");
      await mutation.client.query("RESET lock_timeout");
      revoker.client.release();
      mutation.client.release();
    }
  },
);

it.each(operations)(
  "$kind $action denies member, wrong roles, revoked, expired and absent administrator",
  async ({ kind, action }) => {
    const f = await fixture(kind, action);
    const before = await f.state();
    const wrongRoles = [f.workspace, randomUUID()];
    for (const role of [
      "coach",
      "reviewer",
      "editor",
      "moderator",
      "operator",
    ] as const)
      wrongRoles.push(
        await access.provisionStaff(
          randomBytes(32).toString("hex"),
          role,
          new Date(Date.now() + 3_600_000),
        ),
      );
    const deny = async (actor: string) => {
      expect(await observed(f.run(access, actor)).result).toEqual(
        action === "create"
          ? { value: null, error: "Privileged grant denied." }
          : { value: false, error: null },
      );
      expect(await f.state()).toEqual(before);
    };
    for (const actor of wrongRoles) await deny(actor);
    await pool.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [f.admin],
    );
    await deny(f.admin);
    await pool.query(
      "UPDATE principals SET revoked_at=NULL,expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
      [f.admin],
    );
    await deny(f.admin);
  },
);
