import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import request from "supertest";
import { app } from "../../src/app.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { proposalStore } from "../../src/proposals.ts";
import { hash, migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
const db = store(pool);
const proposals = proposalStore(pool);
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, cohorts CASCADE");
});
afterAll(async () => pool.end());
it("audits private queue reads and quarantine/reject transitions", async () => {
  const memberToken = randomBytes(32).toString("hex");
  await db.create(memberToken, { background: "explorer", goal: "everyday" });
  const staffToken = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    staffToken,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const id = await proposals.createDraft(
      memberToken,
      {
        title: "Private synthetic title",
        body: "Private synthetic body",
        sources: "Private synthetic sources",
      },
      true,
    );
    expect(await proposals.submit(memberToken, id!, true)).toBe(true);
    ids.push(id!);
  }
  expect(await proposals.moderationQueue(staffToken)).toHaveLength(2);
  expect(await proposals.moderate(staffToken, ids[0]!, "quarantine")).toBe(
    true,
  );
  expect(await proposals.moderate(staffToken, ids[0]!, "reject")).toBe(true);
  const exists = (
    await pool.query("SELECT to_regclass('proposal_audit') AS relation")
  ).rows[0].relation;
  const events = exists
    ? (await pool.query("SELECT action FROM proposal_audit ORDER BY id")).rows
    : [];
  expect(events.map((row) => row.action)).toEqual([
    "proposal_read",
    "proposal_read",
    "proposal_quarantined",
    "proposal_rejected",
  ]);
});

async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member setup failed");
  return { token, id: session.learner.id };
}
async function fixture(role: "moderator" | "platform_admin" = "moderator") {
  const owner = await member();
  const token = randomBytes(32).toString("hex");
  const actor = await authorizationStore(pool).provisionStaff(
    token,
    role,
    new Date(Date.now() + 3600000),
  );
  const value = {
    title: "Private synthetic title",
    body: "Private synthetic body",
    sources: "https://synthetic.invalid/private-source",
  };
  const id = (await proposals.createDraft(owner.token, value, true, {
    id: "WF-001",
    version: 1,
  }))!;
  expect(id).toBeTruthy();
  expect(await proposals.submit(owner.token, id, true)).toBe(true);
  return { owner, token, actor, id, value };
}
async function events() {
  return (await pool.query("SELECT * FROM proposal_audit ORDER BY id")).rows;
}

it.each(["moderator", "platform_admin"] as const)(
  "records content-free current %s identity, actual owning workspace and all state transitions",
  async (role) => {
    const f = await fixture(role);
    const second = await member();
    const workspace = randomUUID();
    await pool.query(
      "UPDATE workspaces SET id=$1 WHERE owner_principal_id=$2",
      [workspace, second.id],
    );
    const secondId = (await proposals.createDraft(
      second.token,
      f.value,
      true,
    ))!;
    await proposals.submit(second.token, secondId, true);
    const queue = await proposals.moderationQueue(f.token);
    expect(queue?.map((row) => row.id)).toEqual([f.id, secondId]);
    expect(await proposals.moderate(f.token, f.id, "quarantine")).toBe(true);
    expect(await proposals.moderate(f.token, f.id, "quarantine")).toBe(false);
    expect(await proposals.moderate(f.token, f.id, "reject")).toBe(true);
    expect(await proposals.moderate(f.token, f.id, "reject")).toBe(false);
    expect(await proposals.moderate(f.token, secondId, "reject")).toBe(true);
    expect(await proposals.moderate(f.token, randomUUID(), "reject")).toBe(
      false,
    );
    expect(
      await proposals.moderate(f.token, secondId, "approve" as "reject"),
    ).toBe(false);
    const history = await events();
    expect(
      history.map((row) => [row.action, row.old_state, row.new_state]),
    ).toEqual([
      ["proposal_read", "submitted", "submitted"],
      ["proposal_read", "submitted", "submitted"],
      ["proposal_quarantined", "submitted", "quarantined"],
      ["proposal_rejected", "quarantined", "rejected"],
      ["proposal_rejected", "submitted", "rejected"],
    ]);
    for (const event of history) {
      expect(Object.keys(event).sort()).toEqual(
        [
          "id",
          "actor_id",
          "actor_role",
          "workspace_id",
          "member_id",
          "proposal_id",
          "action",
          "old_state",
          "new_state",
          "occurred_at",
        ].sort(),
      );
      expect(event).toMatchObject({
        actor_id: f.actor,
        actor_role: role,
        occurred_at: expect.any(Date),
      });
      expect(event).toMatchObject(
        event.proposal_id === f.id
          ? { member_id: f.owner.id, workspace_id: f.owner.id }
          : { member_id: second.id, workspace_id: workspace },
      );
    }
    for (const secret of [
      ...Object.values(f.value),
      "WF-001",
      f.token,
      hash(f.token),
    ])
      expect(JSON.stringify(history)).not.toContain(secret);
    expect(await proposals.preview(f.owner.token, f.id)).toMatchObject({
      state: "rejected",
      title: null,
      body: null,
      sources: null,
      workflowId: null,
      workflowVersion: null,
    });
    expect(await proposals.moderationQueue(f.token)).toEqual([]);
    expect(await events()).toEqual(history);
  },
);

it.each([
  "member",
  "coach",
  "reviewer",
  "editor",
  "operator",
  "forged",
  "revoked",
  "expired",
  "changed-role",
  "missing-profile",
] as const)(
  "denies %s without successful read or transition events",
  async (reason) => {
    const f = await fixture();
    let token = f.token;
    if (reason === "member") token = f.owner.token;
    else if (reason === "forged") token = randomBytes(32).toString("hex");
    else if (["coach", "reviewer", "editor", "operator"].includes(reason)) {
      token = randomBytes(32).toString("hex");
      await authorizationStore(pool).provisionStaff(
        token,
        reason as "coach",
        new Date(Date.now() + 3600000),
      );
    } else if (reason === "changed-role")
      await pool.query(
        "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
        [f.actor],
      );
    else if (reason === "missing-profile")
      await pool.query("DELETE FROM staff_profiles WHERE principal_id=$1", [
        f.actor,
      ]);
    else
      await pool.query(
        `UPDATE principals SET ${reason === "revoked" ? "revoked_at=clock_timestamp()" : "expires_at=clock_timestamp()"} WHERE id=$1`,
        [f.actor],
      );
    expect(await proposals.moderationQueue(token)).toBeNull();
    expect(await proposals.moderate(token, f.id, "reject")).toBe(false);
    expect(await events()).toEqual([]);
    expect(await proposals.preview(f.owner.token, f.id)).toMatchObject({
      state: "submitted",
      ...f.value,
    });
  },
);

it("caps a tied queue at 100 UUID-ordered rows and records each invocation separately", async () => {
  const f = await fixture();
  const ids = Array.from({ length: 100 }, () => randomUUID());
  await pool.query(
    `INSERT INTO member_proposals(id,member_id,title,body,sources,state,sample_attested_at,rights_attested_at,submitted_at)
 SELECT id,$2,'Synthetic title','Synthetic body','Synthetic source','submitted',clock_timestamp(),clock_timestamp(),'2026-09-01T00:00:00Z' FROM unnest($1::uuid[]) id`,
    [ids, f.owner.id],
  );
  await pool.query(
    "UPDATE member_proposals SET submitted_at='2026-09-01T00:00:00Z' WHERE id=$1",
    [f.id],
  );
  const expected = [...ids, f.id].sort().slice(0, 100);
  for (let invocation = 1; invocation <= 2; invocation++) {
    expect(
      (await proposals.moderationQueue(f.token))?.map((row) => row.id),
    ).toEqual(expected);
    expect(await events()).toHaveLength(100 * invocation);
  }
});

it.each(["insert", "commit"] as const)(
  "withholds multi-member text and rolls back moderation on %s audit failure",
  async (stage) => {
    const f = await fixture();
    const other = await member();
    const otherId = (await proposals.createDraft(other.token, f.value, true))!;
    await proposals.submit(other.token, otherId, true);
    try {
      await pool.query(
        `CREATE FUNCTION fail_proposal_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.proposal_id='${otherId}'::uuid OR NEW.action<>'proposal_read' THEN RAISE EXCEPTION 'Synthetic proposal audit failure'; END IF; RETURN NEW; END $$`,
      );
      await pool.query(
        stage === "insert"
          ? "CREATE TRIGGER fail_proposal_test_audit BEFORE INSERT ON proposal_audit FOR EACH ROW EXECUTE FUNCTION fail_proposal_test_audit()"
          : "CREATE CONSTRAINT TRIGGER fail_proposal_test_audit AFTER INSERT ON proposal_audit DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_proposal_test_audit()",
      );
      await expect(proposals.moderationQueue(f.token)).rejects.toThrow(
        "Synthetic proposal audit failure",
      );
      const origin = "http://127.0.0.1:3000";
      const server = app(db, {
        origin,
        secret: "synthetic-proposal-secret",
        proposals,
      }).listen(0);
      try {
        const agent = request.agent(server);
        const entry = await agent
          .get("/")
          .set("Host", "127.0.0.1:3000")
          .set("Cookie", `dne_preview=${f.token}`);
        const csrf = entry.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
        const read = await agent
          .get("/moderate/proposals")
          .set("Host", "127.0.0.1:3000")
          .set("Cookie", `dne_preview=${f.token}`)
          .expect(503);
        expect(read.text).toContain("We could not save or load that");
        for (const secret of [
          ...Object.values(f.value),
          f.token,
          "Synthetic proposal audit failure",
        ])
          expect(read.text).not.toContain(secret);
        const csrfDenied = await agent
          .post(`/moderate/proposals/${f.id}/reject`)
          .set("Host", "127.0.0.1:3000")
          .set("Origin", origin)
          .set("Cookie", `dne_preview=${f.token}`)
          .type("form")
          .send({ csrf: "wrong" });
        expect(csrfDenied.status).toBe(403);
        const write = await agent
          .post(`/moderate/proposals/${f.id}/reject`)
          .set("Host", "127.0.0.1:3000")
          .set("Origin", origin)
          .set("Cookie", `dne_preview=${f.token}`)
          .type("form")
          .send({ csrf })
          .expect(503);
        expect(write.text).toContain("We could not save or load that");
        expect(write.text).not.toContain(f.value.body);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      expect(await events()).toEqual([]);
      await expect(proposals.moderate(f.token, f.id, "reject")).rejects.toThrow(
        "Synthetic proposal audit failure",
      );
      expect(await events()).toEqual([]);
      expect(await proposals.preview(f.owner.token, f.id)).toMatchObject({
        state: "submitted",
        ...f.value,
        workflowId: "WF-001",
        workflowVersion: 1,
      });
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS fail_proposal_test_audit ON proposal_audit",
      );
      await pool.query("DROP FUNCTION IF EXISTS fail_proposal_test_audit()");
    }
    expect(await proposals.moderate(f.token, f.id, "reject")).toBe(true);
  },
);

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function waitForBlocked(blocker: number) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (
      (
        await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
          [blocker],
        )
      ).rowCount
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected database lock wait was not observed");
}
function pausedAuditPool(
  entered: ReturnType<typeof gate>,
  resume: ReturnType<typeof gate>,
  backend: { pid: number },
) {
  return {
    async connect() {
      const client = await pool.connect();
      backend.pid = (
        await client.query("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      return {
        query: async (statement: string, values?: unknown[]) => {
          if (statement.includes("INSERT INTO proposal_audit")) {
            entered.release();
            await resume.wait;
          }
          return client.query(statement, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
}
const races = [
  "revocation",
  "role change",
  "withdrawal",
  "deletion",
  "deletion marker",
] as const;
async function competingChange(
  client: PoolClient,
  f: Awaited<ReturnType<typeof fixture>>,
  change: (typeof races)[number],
) {
  if (change === "revocation")
    return client.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [f.actor],
    );
  if (change === "role change")
    return client.query(
      "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
      [f.actor],
    );
  if (change === "deletion")
    return client.query(
      "DELETE FROM principals WHERE id=$1 AND kind='member'",
      [f.owner.id],
    );
  if (change === "deletion marker")
    return client.query(
      "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
      [f.owner.id],
    );
  return client.query(
    "UPDATE member_proposals SET state='withdrawn',title=NULL,body=NULL,sources=NULL,workflow_id=NULL,workflow_version=NULL,withdrawn_at=clock_timestamp() WHERE id=$1 AND state IN ('draft','submitted','quarantined')",
    [f.id],
  );
}
function operation(
  target: ReturnType<typeof proposalStore>,
  f: Awaited<ReturnType<typeof fixture>>,
  kind: "read" | "reject",
) {
  return kind === "read"
    ? target.moderationQueue(f.token)
    : target.moderate(f.token, f.id, "reject");
}
for (const kind of ["read", "reject"] as const) {
  it.each(races)(
    `${kind} waits for a winning %s and returns no affected private text or success`,
    async (change) => {
      const f = await fixture();
      const blocker = await pool.connect();
      let pending: ReturnType<typeof operation> | undefined;
      try {
        await blocker.query("BEGIN");
        const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        await competingChange(blocker, f, change);
        pending = operation(proposals, f, kind);
        await waitForBlocked(pid);
        await blocker.query("COMMIT");
        const result = await pending;
        expect(result).toEqual(
          kind === "reject"
            ? false
            : change === "revocation" || change === "role change"
              ? null
              : [],
        );
        expect(await events()).toEqual([]);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await pending;
      }
    },
  );
  it.each(races)(
    `${kind} commits its event and result before a losing %s`,
    async (change) => {
      const f = await fixture();
      const entered = gate(),
        resume = gate(),
        backend = { pid: 0 };
      const target = proposalStore(pausedAuditPool(entered, resume, backend));
      const acting = operation(target, f, kind);
      const competitor = await pool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await Promise.race([
          entered.wait,
          acting.then(() => {
            throw new Error("Action finished before audit gate");
          }),
        ]);
        await competitor.query("BEGIN");
        pending = competingChange(competitor, f, change);
        await waitForBlocked(backend.pid);
        expect(await events()).toEqual([]);
        resume.release();
        const result = await acting;
        if (kind === "read")
          expect(result).toMatchObject([{ id: f.id, ...f.value }]);
        else expect(result).toBe(true);
        await pending;
        // The competing transaction is still uncommitted: successful audit is visible.
        expect((await events()).map((row) => row.action)).toEqual([
          kind === "read" ? "proposal_read" : "proposal_rejected",
        ]);
        await competitor.query("COMMIT");
        const history = await events();
        expect(history).toHaveLength(change === "deletion" ? 0 : 1);
        if (change !== "withdrawal" || kind === "read") {
          const later = await operation(proposals, f, kind);
          expect(later).toEqual(
            kind === "reject"
              ? false
              : change === "revocation" || change === "role change"
                ? null
                : [],
          );
        }
      } finally {
        resume.release();
        await acting;
        await pending;
        await competitor.query("ROLLBACK");
        competitor.release();
      }
    },
  );
}

it.each(["read", "reject"] as const)(
  "rolls back %s and its event when staff expires while audit work waits",
  async (kind) => {
    const f = await fixture();
    const deadline = (
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+INTERVAL '800 milliseconds' WHERE id=$1 RETURNING expires_at",
        [f.actor],
      )
    ).rows[0].expires_at;
    const entered = gate(),
      resume = gate(),
      backend = { pid: 0 };
    const acting = operation(
      proposalStore(pausedAuditPool(entered, resume, backend)),
      f,
      kind,
    );
    try {
      await Promise.race([
        entered.wait,
        acting.then(() => {
          throw new Error("Action finished before audit gate");
        }),
      ]);
      while (
        !(
          await pool.query(
            "SELECT clock_timestamp()>=$1::timestamptz AS expired",
            [deadline],
          )
        ).rows[0].expired
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      resume.release();
      expect(await acting).toEqual(kind === "read" ? null : false);
      expect(await events()).toEqual([]);
      expect(await proposals.preview(f.owner.token, f.id)).toMatchObject({
        state: "submitted",
        ...f.value,
      });
    } finally {
      resume.release();
      await acting;
    }
  },
);

it("serializes replayed competing decisions and preserves all accepted events", async () => {
  const f = await fixture();
  expect(
    (
      await Promise.all([
        proposals.moderate(f.token, f.id, "quarantine"),
        proposals.moderate(f.token, f.id, "quarantine"),
      ])
    ).sort(),
  ).toEqual([false, true]);
  expect(
    (
      await Promise.all([
        proposals.moderate(f.token, f.id, "reject"),
        proposals.moderate(f.token, f.id, "reject"),
      ])
    ).sort(),
  ).toEqual([false, true]);
  expect((await events()).map((row) => row.action)).toEqual([
    "proposal_quarantined",
    "proposal_rejected",
  ]);
});

it("retains immutable history through withdrawal and staff revocation, then deletes only the actual member workspace history", async () => {
  const f = await fixture();
  const other = await member();
  const otherId = (await proposals.createDraft(other.token, f.value, true))!;
  await proposals.submit(other.token, otherId, true);
  await proposals.moderationQueue(f.token);
  const history = await events();
  await expect(
    pool.query(
      "UPDATE proposal_audit SET actor_role='platform_admin' WHERE proposal_id=$1",
      [f.id],
    ),
  ).rejects.toThrow("Proposal event history is immutable");
  await expect(
    pool.query("DELETE FROM proposal_audit WHERE proposal_id=$1", [f.id]),
  ).rejects.toThrow("Proposal event history is immutable");
  await proposals.withdraw(f.owner.token, f.id);
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [f.actor],
  );
  expect(await events()).toEqual(history);
  await db.remove(f.owner.id);
  expect(await events()).toEqual(
    history.filter((row) => row.member_id === other.id),
  );
});

it("migration preserves existing staff/proposal history and creates no historical events", async () => {
  const f = await fixture();
  await pool.query(
    `INSERT INTO authorization_audit(actor_id,staff_id,workspace_id,grant_type,grant_id,action)
 VALUES($1,$1,$2,'assignment',$3,'grant_created')`,
    [f.actor, f.owner.id, randomUUID()],
  );
  const prior = (
    await pool.query("SELECT * FROM authorization_audit ORDER BY id")
  ).rows;
  const migration = await readFile(
    new URL(
      "../../migrations/038-proposal-moderation-audit.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await pool.query(migration);
  expect(await events()).toEqual([]);
  await proposals.moderationQueue(f.token);
  const history = await events();
  await pool.query(migration);
  expect(await events()).toEqual(history);
  expect(
    (await pool.query("SELECT * FROM authorization_audit ORDER BY id")).rows,
  ).toEqual(prior);
});

for (const kind of ["read", "reject"] as const) {
  it.each(["workspace", "proposal"] as const)(
    `${kind} rechecks staff expiry after a real %s lock wait`,
    async (boundary) => {
      const f = await fixture();
      const deadline = (
        await pool.query(
          "UPDATE principals SET expires_at=clock_timestamp()+INTERVAL '800 milliseconds' WHERE id=$1 RETURNING expires_at",
          [f.actor],
        )
      ).rows[0].expires_at;
      const blocker = await pool.connect();
      let acting: ReturnType<typeof operation> | undefined;
      try {
        await blocker.query("BEGIN");
        const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        await blocker.query(
          boundary === "workspace"
            ? "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE"
            : "SELECT id FROM member_proposals WHERE id=$1 FOR UPDATE",
          [boundary === "workspace" ? f.owner.id : f.id],
        );
        acting = operation(proposals, f, kind);
        await waitForBlocked(pid);
        while (
          !(
            await pool.query(
              "SELECT clock_timestamp()>=$1::timestamptz AS expired",
              [deadline],
            )
          ).rows[0].expired
        )
          await new Promise((resolve) => setTimeout(resolve, 5));
        await blocker.query("COMMIT");
        expect(await acting).toEqual(kind === "read" ? null : false);
        expect(await events()).toEqual([]);
        expect(await proposals.preview(f.owner.token, f.id)).toMatchObject({
          state: "submitted",
          ...f.value,
        });
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await acting;
      }
    },
  );
}

it("concurrent moderators read two members in one consistent lock order without lost or duplicate events", async () => {
  const f = await fixture();
  const other = await fixture("platform_admin");
  const entered = gate(),
    resume = gate(),
    backend = { pid: 0 };
  const first = proposalStore(
    pausedAuditPool(entered, resume, backend),
  ).moderationQueue(f.token);
  let second: ReturnType<typeof proposals.moderationQueue> | undefined;
  try {
    await Promise.race([
      entered.wait,
      first.then(() => {
        throw new Error("Read finished before audit gate");
      }),
    ]);
    second = proposals.moderationQueue(other.token);
    await waitForBlocked(backend.pid);
    resume.release();
    expect((await first)?.map((row) => row.id)).toEqual([f.id, other.id]);
    expect((await second)?.map((row) => row.id)).toEqual([f.id, other.id]);
    const history = await events();
    expect(history).toHaveLength(4);
    for (const actor of [f.actor, other.actor])
      expect(
        history
          .filter((row) => row.actor_id === actor)
          .map((row) => row.proposal_id),
      ).toEqual([f.id, other.id]);
  } finally {
    resume.release();
    await first;
    await second;
  }
});

it("withholds proposals whose actual owning workspace has been deleted", async () => {
  const f = await fixture();
  await proposals.moderationQueue(f.token);
  await pool.query("DELETE FROM workspaces WHERE owner_principal_id=$1", [
    f.owner.id,
  ]);
  expect(await proposals.moderationQueue(f.token)).toEqual([]);
  expect(await proposals.moderate(f.token, f.id, "reject")).toBe(false);
  expect(await events()).toEqual([]);
  expect(await proposals.preview(f.owner.token, f.id)).toMatchObject({
    state: "submitted",
    ...f.value,
  });
});

it.each(["deleting", "absent"] as const)(
  "does not let 100 proposals with an %s owning workspace starve eligible queue items",
  async (state) => {
    const f = await fixture();
    const old = await member();
    const ids = Array.from({ length: 100 }, () => randomUUID());
    await pool.query(
      `INSERT INTO member_proposals(id,member_id,title,body,sources,state,sample_attested_at,rights_attested_at,submitted_at)
 SELECT id,$2,'Old private synthetic title','Old private synthetic body','Old synthetic source','submitted',clock_timestamp(),clock_timestamp(),'2026-09-01T00:00:00Z' FROM unnest($1::uuid[]) id`,
      [ids, old.id],
    );
    if (state === "deleting")
      await pool.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [old.id],
      );
    else
      await pool.query("DELETE FROM workspaces WHERE owner_principal_id=$1", [
        old.id,
      ]);
    expect(
      (await proposals.moderationQueue(f.token))?.map((row) => row.id),
    ).toEqual([f.id]);
    expect((await events()).map((row) => row.proposal_id)).toEqual([f.id]);
  },
);
