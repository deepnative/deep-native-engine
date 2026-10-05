import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { proposalStore } from "../../src/proposals.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool),
  auth = authorizationStore(pool),
  proposals = proposalStore(pool);
const value = {
  title: "Invented contribution",
  body: "Original sample only",
  sources: "Invented rights notes",
};
const feedback = "  Clarify the invented example.\n";
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(async () => pool.end());
async function fixture() {
  const owner = randomBytes(32).toString("hex"),
    moderator = randomBytes(32).toString("hex");
  await db.create(owner, { background: "explorer", goal: "everyday" });
  const session = await db.session(owner);
  if (session.kind !== "active") throw Error("Expected synthetic owner");
  const actorId = await auth.provisionStaff(
    moderator,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  const id = (await proposals.createDraft(owner, value, true))!;
  expect(await proposals.submit(owner, id, true, 1)).toBe("submitted");
  return { owner, moderator, memberId: session.learner.id, actorId, id };
}
it("returns one owner-only feedback decision and requires an edit plus fresh exact-revision rights", async () => {
  const f = await fixture();
  expect(
    await proposals.requestChanges(f.moderator, f.id, {
      expectedRevision: 1,
      feedback,
    }),
  ).toBe("requested");
  expect(await proposals.preview(f.owner, f.id)).toMatchObject({
    state: "changes_requested",
    revision: 1,
    feedback: {
      text: feedback,
      reviewedRevision: 1,
      requestedAt: expect.any(Date),
    },
    rightsAttestedRevision: null,
    rightsAttestedAt: null,
  });
  expect(await proposals.moderationQueue(f.moderator)).toEqual([]);
  expect(await proposals.preview(f.moderator, f.id)).toBeNull();
  expect(await proposals.submit(f.owner, f.id, true, 1)).toBe("conflict");
  expect(
    await proposals.editDraft(
      f.owner,
      f.id,
      { ...value, body: "Revised invented sample" },
      1,
    ),
  ).toBe("saved");
  expect(await proposals.submit(f.owner, f.id, false, 2)).toBe("denied");
  expect(await proposals.submit(f.owner, f.id, true, 2)).toBe("submitted");
  expect(await proposals.preview(f.owner, f.id)).toMatchObject({
    state: "submitted",
    revision: 2,
    rightsAttestedRevision: 2,
    rightsAttestedAt: expect.any(Date),
    feedback: { text: feedback, reviewedRevision: 1 },
  });
  const queue = await proposals.moderationQueue(f.moderator);
  expect(queue).toMatchObject([
    { id: f.id, revision: 2, body: "Revised invented sample" },
  ]);
  expect(JSON.stringify(queue)).not.toContain(feedback.trim());
  expect(queue![0]).not.toHaveProperty("feedback");
});

const request = (
  target: typeof proposals,
  f: Awaited<ReturnType<typeof fixture>>,
  expectedRevision = 1,
  text = feedback,
) =>
  target.requestChanges(f.moderator, f.id, {
    expectedRevision,
    feedback: text,
  });
async function decisions(id: string) {
  return (
    await pool.query(
      "SELECT * FROM proposal_audit WHERE proposal_id=$1 ORDER BY id",
      [id],
    )
  ).rows;
}
async function saved(id: string) {
  return (await pool.query("SELECT * FROM member_proposals WHERE id=$1", [id]))
    .rows[0];
}
async function resubmit(f: Awaited<ReturnType<typeof fixture>>) {
  expect(
    await proposals.editDraft(
      f.owner,
      f.id,
      { ...value, body: "Corrected invented sample" },
      1,
    ),
  ).toBe("saved");
  expect(await proposals.submit(f.owner, f.id, true, 2)).toBe("submitted");
}
it("acknowledges only the same actor, revision and exact feedback before any later edit", async () => {
  const f = await fixture();
  expect(await request(proposals, f)).toBe("requested");
  const first = await saved(f.id),
    history = await decisions(f.id);
  expect(await request(proposals, f)).toBe("replayed");
  expect(await request(proposals, f, 1, feedback.trim())).toBe("conflict");
  expect(await request(proposals, f, 2)).toBe("conflict");
  const other = randomBytes(32).toString("hex");
  await auth.provisionStaff(
    other,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  expect(
    await proposals.requestChanges(other, f.id, {
      expectedRevision: 1,
      feedback,
    }),
  ).toBe("conflict");
  expect(await saved(f.id)).toEqual(first);
  expect(await decisions(f.id)).toEqual(history);
  await resubmit(f);
  const submitted = await saved(f.id);
  expect(await proposals.submit(f.owner, f.id, true, 2)).toBe("replayed");
  expect(await proposals.submit(f.owner, f.id, true, 1)).toBe("conflict");
  expect(await proposals.submit(f.owner, f.id, false, 2)).toBe("denied");
  expect(await request(proposals, f)).toBe("conflict");
  expect(await saved(f.id)).toEqual(submitted);
  expect(await decisions(f.id)).toEqual(history);
  expect(await request(proposals, f, 2, "A new invented correction")).toBe(
    "requested",
  );
  expect(await proposals.preview(f.owner, f.id)).toMatchObject({
    revision: 2,
    feedback: { text: "A new invented correction", reviewedRevision: 2 },
    rightsAttestedAt: null,
    rightsAttestedRevision: null,
  });
  const events = await decisions(f.id);
  expect(events.map((e) => [e.action, e.reviewed_revision])).toEqual([
    ["proposal_changes_requested", 1],
    ["proposal_changes_requested", 2],
  ]);
  expect(JSON.stringify(events)).not.toContain("correction");
  expect(JSON.stringify(events)).not.toContain(feedback.trim());
  expect(Object.keys(events[0]).sort()).toEqual(
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
      "reviewed_revision",
    ].sort(),
  );
});
it.each(["quarantine", "reject", "withdraw"] as const)(
  "never replays or revives feedback after %s",
  async (action) => {
    const f = await fixture();
    await request(proposals, f);
    await resubmit(f);
    if (action === "withdraw")
      expect(await proposals.withdraw(f.owner, f.id)).toBe(true);
    else expect(await proposals.moderate(f.moderator, f.id, action)).toBe(true);
    const before = await saved(f.id),
      events = await decisions(f.id);
    expect(await request(proposals, f, 2)).toBe("conflict");
    expect(await proposals.submit(f.owner, f.id, true, 2)).toBe("denied");
    expect(await proposals.editDraft(f.owner, f.id, value, 2)).toBe("denied");
    expect(await saved(f.id)).toEqual(before);
    expect(await decisions(f.id)).toEqual(events);
    const preview = await proposals.preview(f.owner, f.id);
    expect(preview?.feedback).toEqual(
      action === "quarantine"
        ? { text: feedback, reviewedRevision: 1, requestedAt: expect.any(Date) }
        : null,
    );
    if (action !== "quarantine")
      expect(before).toMatchObject({
        title: null,
        body: null,
        sources: null,
        change_feedback: null,
        change_feedback_revision: null,
        changes_requested_at: null,
        workflow_id: null,
        workflow_version: null,
      });
  },
);
it("keeps legacy consent unknown and restores declarative guards on migration rerun", async () => {
  const f = await fixture();
  await pool.query(
    "UPDATE member_proposals SET rights_attested_revision=NULL WHERE id=$1",
    [f.id],
  );
  const before = await saved(f.id);
  const migration = await readFile(
    new URL("../../migrations/051-proposal-feedback.sql", import.meta.url),
    "utf8",
  );
  await pool.query(
    "ALTER TABLE member_proposals DROP CONSTRAINT member_proposals_feedback_check",
  );
  await pool.query(migration);
  await pool.query(migration);
  expect(await saved(f.id)).toEqual(before);
  expect(await decisions(f.id)).toEqual([]);
  expect(await proposals.submit(f.owner, f.id, true, 1)).toBe("denied");
  expect(await request(proposals, f)).toBe("requested");
  await expect(
    pool.query(
      "UPDATE member_proposals SET state='submitted',rights_attested_at=clock_timestamp(),rights_attested_revision=revision WHERE id=$1",
      [f.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    pool.query("UPDATE member_proposals SET change_feedback=$2 WHERE id=$1", [
      f.id,
      "😀".repeat(501),
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await resubmit(f);
  expect((await saved(f.id)).rights_attested_revision).toBe(2);
});
it("denies nonowners, unavailable workspaces and nonmoderators without disclosing feedback", async () => {
  const f = await fixture(),
    other = await fixture();
  await request(proposals, f);
  for (const token of [other.owner, f.moderator, "unknown"]) {
    expect(await proposals.preview(token, f.id)).toBeNull();
    expect(await proposals.editDraft(token, f.id, value, 1)).toBe("denied");
  }
  for (const role of ["operator", "reviewer", "coach", "editor"] as const) {
    const token = randomBytes(32).toString("hex");
    await auth.provisionStaff(token, role, new Date(Date.now() + 3600000));
    expect(
      await proposals.requestChanges(token, f.id, {
        expectedRevision: 1,
        feedback,
      }),
    ).toBe("denied");
  }
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
    [f.memberId],
  );
  expect(await proposals.preview(f.owner, f.id)).toBeNull();
  expect(await request(proposals, f)).toBe("conflict");
  await pool.query("DELETE FROM workspaces WHERE owner_principal_id=$1", [
    f.memberId,
  ]);
  expect(await proposals.preview(f.owner, f.id)).toBeNull();
  expect(await decisions(f.id)).toEqual([]);
});
it("reads or withdraws an obsolete workflow return but never edits or resubmits it", async () => {
  const f = await fixture();
  let version: number | null = 1;
  const target = proposalStore(pool, async () =>
    version === null ? null : ({ version } as never),
  );
  const id = (await target.createDraft(f.owner, value, true, {
    id: "WF-001",
    version: 1,
  }))!;
  await target.submit(f.owner, id, true, 1);
  await target.requestChanges(f.moderator, id, {
    expectedRevision: 1,
    feedback,
  });
  for (version of [2, null]) {
    expect(await target.preview(f.owner, id)).toMatchObject({
      workflowId: "WF-001",
      workflowVersion: 1,
      feedback: { text: feedback },
    });
    expect(await target.editDraft(f.owner, id, value, 1)).toBe("denied");
    expect(await target.submit(f.owner, id, true, 1)).toBe("denied");
  }
  expect(await target.withdraw(f.owner, id)).toBe(true);
  expect(await target.preview(f.owner, id)).toMatchObject({
    workflowId: null,
    workflowVersion: null,
    feedback: null,
  });
});
it("retains only immutable content-free events until the actual member is deleted", async () => {
  const f = await fixture();
  await request(proposals, f);
  const before = await decisions(f.id);
  await expect(
    pool.query(
      "UPDATE proposal_audit SET reviewed_revision=2 WHERE proposal_id=$1",
      [f.id],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("DELETE FROM proposal_audit WHERE proposal_id=$1", [f.id]),
  ).rejects.toThrow("immutable");
  expect(await proposals.withdraw(f.owner, f.id)).toBe(true);
  expect(await decisions(f.id)).toEqual(before);
  await db.remove(f.memberId);
  expect(await saved(f.id)).toBeUndefined();
  expect(await decisions(f.id)).toEqual([]);
  expect(await proposals.preview(f.owner, f.id)).toBeNull();
});

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function controlled(
  options: {
    pause?: string;
    failure?: string;
    after?: boolean;
    rollbackFails?: boolean;
  } = {},
) {
  const entered = gate(),
    resume = gate(),
    connected = gate(),
    state = { pid: 0, discarded: false };
  let once = false;
  const target = proposalStore({
    async connect() {
      const client = await pool.connect();
      state.pid = (
        await client.query("SELECT pg_backend_pid() pid")
      ).rows[0].pid;
      connected.release();
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql === "ROLLBACK" && options.rollbackFails)
            throw Error("Synthetic rollback failure");
          const fail = sql === options.failure;
          if (fail && !options.after)
            throw Error("Synthetic unconfirmed transaction");
          const result = await client.query(sql, values);
          if (fail) throw Error("Synthetic unconfirmed transaction");
          if (!once && options.pause && sql.startsWith(options.pause)) {
            once = true;
            entered.release();
            await resume.wait;
          }
          return result;
        },
        release(error?: Error) {
          state.discarded = Boolean(error);
          client.release(error);
        },
      };
    },
  } as unknown as Pool);
  return { target, entered, resume, connected, state };
}
async function blocked(pid: number, by: number) {
  for (let i = 0; i < 200; i++) {
    if (
      (
        await pool.query(
          "SELECT $1::int=ANY(pg_blocking_pids($2::int)) blocked",
          [by, pid],
        )
      ).rows[0].blocked
    )
      return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Expected actual PostgreSQL blocker");
}
async function expired(at: Date) {
  for (let i = 0; i < 200; i++) {
    if (
      (
        await pool.query("SELECT clock_timestamp()>=$1::timestamptz expired", [
          at,
        ])
      ).rows[0].expired
    )
      return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Expected database expiry");
}
it.each(["request", "withdraw", "quarantine", "reject", "delete"] as const)(
  "serializes request changes before competing %s",
  async (action) => {
    const f = await fixture(),
      first = controlled({ pause: "UPDATE member_proposals" }),
      second = controlled();
    const requesting = request(first.target, f);
    await first.entered.wait;
    let losing: Promise<unknown>;
    if (action === "delete") losing = db.remove(f.memberId);
    else
      losing =
        action === "request"
          ? request(second.target, f)
          : action === "withdraw"
            ? second.target.withdraw(f.owner, f.id)
            : second.target.moderate(f.moderator, f.id, action);
    try {
      if (action === "delete") {
        // A real principal DELETE is blocked by the request's retained SHARE lock.
        for (let i = 0; i < 200; i++) {
          const rows = (
            await pool.query(
              "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
              [first.state.pid],
            )
          ).rows;
          if (rows.length) break;
          if (i === 199) throw Error("Expected member deletion wait");
          await new Promise((r) => setTimeout(r, 5));
        }
      } else {
        await second.connected.wait;
        await blocked(second.state.pid, first.state.pid);
      }
      first.resume.release();
      expect(await requesting).toBe("requested");
      expect(await losing).toBe(
        action === "request"
          ? "replayed"
          : action === "withdraw"
            ? true
            : action === "delete"
              ? undefined
              : false,
      );
      if (action === "delete") expect(await saved(f.id)).toBeUndefined();
      else
        expect(
          (await decisions(f.id)).filter(
            (e) => e.action === "proposal_changes_requested",
          ),
        ).toHaveLength(1);
    } finally {
      first.resume.release();
      await Promise.allSettled([requesting, losing]);
    }
  },
);
it.each(["withdraw", "quarantine", "reject"] as const)(
  "denies a request after a winning %s commits",
  async (action) => {
    const f = await fixture(),
      first = controlled({ pause: "UPDATE member_proposals" }),
      second = controlled();
    const winning =
      action === "withdraw"
        ? first.target.withdraw(f.owner, f.id)
        : first.target.moderate(f.moderator, f.id, action);
    await first.entered.wait;
    const losing = request(second.target, f);
    try {
      await second.connected.wait;
      await blocked(second.state.pid, first.state.pid);
      first.resume.release();
      expect(await winning).toBe(true);
      expect(await losing).toBe("conflict");
      expect(
        (await decisions(f.id)).some(
          (e) => e.action === "proposal_changes_requested",
        ),
      ).toBe(false);
    } finally {
      first.resume.release();
      await Promise.allSettled([winning, losing]);
    }
  },
);
it("makes a competing moderator's different decision conflict after the actual row wait", async () => {
  const f = await fixture(),
    other = randomBytes(32).toString("hex");
  await auth.provisionStaff(
    other,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const first = controlled({ pause: "UPDATE member_proposals" }),
    second = controlled(),
    winning = request(first.target, f);
  await first.entered.wait;
  const losing = second.target.requestChanges(other, f.id, {
    expectedRevision: 1,
    feedback: "Different correction",
  });
  try {
    await second.connected.wait;
    await blocked(second.state.pid, first.state.pid);
    first.resume.release();
    expect(await winning).toBe("requested");
    expect(await losing).toBe("conflict");
    expect((await saved(f.id)).change_feedback).toBe(feedback);
    expect(await decisions(f.id)).toHaveLength(1);
  } finally {
    first.resume.release();
    await Promise.allSettled([winning, losing]);
  }
});
it.each(["edit", "submit"] as const)(
  "serializes returned edit/resubmit with %s first",
  async (action) => {
    const f = await fixture();
    await request(proposals, f);
    await proposals.editDraft(f.owner, f.id, value, 1);
    const first = controlled({ pause: "UPDATE member_proposals" }),
      second = controlled();
    const winning =
      action === "edit"
        ? first.target.editDraft(
            f.owner,
            f.id,
            { ...value, body: "A later correction" },
            2,
          )
        : first.target.submit(f.owner, f.id, true, 2);
    await first.entered.wait;
    const losing =
      action === "edit"
        ? second.target.submit(f.owner, f.id, true, 2)
        : second.target.editDraft(
            f.owner,
            f.id,
            { ...value, body: "A later correction" },
            2,
          );
    try {
      await second.connected.wait;
      await blocked(second.state.pid, first.state.pid);
      first.resume.release();
      expect(await winning).toBe(action === "edit" ? "saved" : "submitted");
      expect(await losing).toBe(action === "edit" ? "conflict" : "denied");
      expect(await saved(f.id)).toMatchObject(
        action === "edit"
          ? {
              revision: 3,
              state: "changes_requested",
              rights_attested_revision: null,
            }
          : { revision: 2, state: "submitted", rights_attested_revision: 2 },
      );
    } finally {
      first.resume.release();
      await Promise.allSettled([winning, losing]);
    }
  },
);
it.each(["revocation", "role", "expiry", "workspace", "deletion"] as const)(
  "reauthorizes changes after a winning %s lock wait",
  async (change) => {
    const f = await fixture(),
      writer = await pool.connect(),
      waiting = controlled();
    let pending: Promise<unknown> | undefined;
    try {
      await writer.query("BEGIN");
      const pid = (await writer.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      if (change === "revocation")
        await writer.query(
          "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [f.actorId],
        );
      if (change === "expiry")
        await writer.query(
          "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1",
          [f.actorId],
        );
      if (change === "role")
        await writer.query(
          "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
          [f.actorId],
        );
      if (change === "workspace")
        await writer.query(
          "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
          [f.memberId],
        );
      if (change === "deletion")
        await writer.query("DELETE FROM principals WHERE id=$1", [f.memberId]);
      pending = request(waiting.target, f);
      await waiting.connected.wait;
      await blocked(waiting.state.pid, pid);
      await writer.query("COMMIT");
      expect(await pending).toBe(
        change === "workspace" || change === "deletion" ? "conflict" : "denied",
      );
      expect(await decisions(f.id)).toEqual([]);
      if (change !== "deletion")
        expect(await saved(f.id)).toMatchObject({
          state: "submitted",
          change_feedback: null,
          rights_attested_revision: 1,
        });
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await pending;
    }
  },
);
it.each(["proposal", "profile", "audit"] as const)(
  "rolls back feedback and its event after staff expiry at the %s boundary",
  async (boundary) => {
    const f = await fixture(),
      waiting = controlled(
        boundary === "audit" ? { pause: "INSERT INTO proposal_audit" } : {},
      ),
      writer = await pool.connect();
    let pending: Promise<unknown> | undefined;
    const deadline = (
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+INTERVAL '700 milliseconds' WHERE id=$1 RETURNING expires_at",
        [f.actorId],
      )
    ).rows[0].expires_at as Date;
    try {
      if (boundary !== "audit") {
        await writer.query("BEGIN");
        const pid = (await writer.query("SELECT pg_backend_pid() pid")).rows[0]
          .pid;
        await writer.query(
          boundary === "profile"
            ? "SELECT principal_id FROM staff_profiles WHERE principal_id=$1 FOR UPDATE"
            : "SELECT id FROM member_proposals WHERE id=$1 FOR UPDATE",
          [boundary === "profile" ? f.actorId : f.id],
        );
        pending = request(waiting.target, f);
        await waiting.connected.wait;
        await blocked(waiting.state.pid, pid);
      } else {
        pending = request(waiting.target, f);
        await waiting.entered.wait;
      }
      await expired(deadline);
      await writer.query("COMMIT");
      waiting.resume.release();
      expect(await pending).toBe("denied");
      expect(await decisions(f.id)).toEqual([]);
      expect(await saved(f.id)).toMatchObject({
        state: "submitted",
        change_feedback: null,
        rights_attested_revision: 1,
      });
    } finally {
      waiting.resume.release();
      await writer.query("ROLLBACK");
      writer.release();
      await pending;
    }
  },
);
it("withholds owner feedback after expiry while its real proposal read waits", async () => {
  const f = await fixture();
  await request(proposals, f);
  const writer = await pool.connect(),
    reading = controlled();
  let pending: ReturnType<typeof proposals.preview> | undefined;
  const deadline = (
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+INTERVAL '700 milliseconds' WHERE id=$1 RETURNING expires_at",
      [f.memberId],
    )
  ).rows[0].expires_at as Date;
  try {
    await writer.query("BEGIN");
    const pid = (await writer.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await writer.query(
      "SELECT id FROM member_proposals WHERE id=$1 FOR UPDATE",
      [f.id],
    );
    pending = reading.target.preview(f.owner, f.id);
    await reading.connected.wait;
    await blocked(reading.state.pid, pid);
    await expired(deadline);
    await writer.query("COMMIT");
    expect(await pending).toBeNull();
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
    await pending;
  }
});
it.each(["immediate", "commit"] as const)(
  "atomically rolls back request and decision on %s audit failure",
  async (stage) => {
    const f = await fixture(),
      before = await saved(f.id);
    try {
      await pool.query(
        "CREATE FUNCTION reject_changes_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='proposal_changes_requested' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$",
      );
      await pool.query(
        stage === "immediate"
          ? "CREATE TRIGGER reject_changes_test BEFORE INSERT ON proposal_audit FOR EACH ROW EXECUTE FUNCTION reject_changes_test()"
          : "CREATE CONSTRAINT TRIGGER reject_changes_test AFTER INSERT ON proposal_audit DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_changes_test()",
      );
      await expect(request(proposals, f)).rejects.toThrow(
        "Proposal operation unconfirmed",
      );
      expect(await saved(f.id)).toEqual(before);
      expect(await decisions(f.id)).toEqual([]);
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS reject_changes_test ON proposal_audit",
      );
      await pool.query("DROP FUNCTION IF EXISTS reject_changes_test()");
    }
    expect(await request(proposals, f)).toBe("requested");
  },
);
it.each(["request", "submit"] as const)(
  "recovers an uncertain committed %s only through exact authorized replay",
  async (action) => {
    const f = await fixture();
    if (action === "submit") {
      await request(proposals, f);
      await proposals.editDraft(f.owner, f.id, value, 1);
    }
    const uncertain = controlled({ failure: "COMMIT", after: true });
    await expect(
      action === "request"
        ? request(uncertain.target, f)
        : uncertain.target.submit(f.owner, f.id, true, 2),
    ).rejects.toThrow("Proposal operation unconfirmed");
    expect(uncertain.state.discarded).toBe(true);
    const current = await saved(f.id),
      history = await decisions(f.id);
    expect(
      await (action === "request"
        ? request(proposals, f)
        : proposals.submit(f.owner, f.id, true, 2)),
    ).toBe("replayed");
    expect(await saved(f.id)).toEqual(current);
    expect(await decisions(f.id)).toEqual(history);
    await pool.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [action === "request" ? f.actorId : f.memberId],
    );
    expect(
      await (action === "request"
        ? request(proposals, f)
        : proposals.submit(f.owner, f.id, true, 2)),
    ).toBe("denied");
  },
);
it("discards a connection with a failed rollback and retains no uncommitted feedback", async () => {
  const f = await fixture(),
    before = await saved(f.id),
    uncertain = controlled({ failure: "COMMIT", rollbackFails: true });
  await expect(request(uncertain.target, f)).rejects.toThrow(
    "Proposal operation unconfirmed",
  );
  expect(uncertain.state.discarded).toBe(true);
  expect(await saved(f.id)).toEqual(before);
  expect(await decisions(f.id)).toEqual([]);
  expect(await request(proposals, f)).toBe("requested");
});
it.each(["before", "after"] as const)(
  "returns no owner feedback when COMMIT fails %s acknowledgment",
  async (when) => {
    const f = await fixture();
    await request(proposals, f);
    const reading = controlled({ failure: "COMMIT", after: when === "after" });
    expect(await reading.target.preview(f.owner, f.id)).toBeNull();
    expect(reading.state.discarded).toBe(true);
    expect(await proposals.preview(f.owner, f.id)).toMatchObject({
      feedback: { text: feedback },
    });
  },
);
