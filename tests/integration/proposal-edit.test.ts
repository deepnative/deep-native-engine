import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { authorizationStore } from "../../src/authorization.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { randomBytes } from "node:crypto";
import { proposalStore } from "../../src/proposals.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const proposals = proposalStore(pool);
const original = {
  title: "Original private title",
  body: "Original invented body",
  sources: "Original invented sources",
};
const corrected = {
  title: "Corrected private title",
  body: "Corrected invented body",
  sources: "Corrected invented sources",
};
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, cohorts CASCADE");
});
afterAll(async () => pool.end());
async function fixture() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw Error("Synthetic setup failed");
  const id = (await proposals.createDraft(token, original, true))!;
  return { token, memberId: session.learner.id, id };
}
it("corrects the same private draft and rejects duplicate or stale edits", async () => {
  const f = await fixture();
  expect(await proposals.preview(f.token, f.id)).toMatchObject({
    ...original,
    revision: 1,
    state: "draft",
  });
  expect(await proposals.editDraft(f.token, f.id, corrected, 1)).toBe("saved");
  expect(await proposals.preview(f.token, f.id)).toMatchObject({
    ...corrected,
    revision: 2,
    state: "draft",
  });
  expect(await proposals.editDraft(f.token, f.id, original, 1)).toBe(
    "conflict",
  );
  expect(await proposals.preview(f.token, f.id)).toMatchObject({
    ...corrected,
    revision: 2,
  });
});

it("exports only current revision, keeps unsent drafts out of moderation, then submits and redacts", async () => {
  const f = await fixture();
  const staff = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    staff,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  expect(await proposals.moderationQueue(staff)).toEqual([]);
  expect(await proposals.editDraft(f.token, f.id, corrected, 1)).toBe("saved");
  const exported = await memberExportStore(pool).exportOwned(f.token);
  expect(exported).toMatchObject({
    kind: "ready",
    payload: {
      version: "local-member-records-v23",
      records: {
        proposals: [{ id: f.id, ...corrected, revision: 2, state: "draft" }],
      },
    },
  });
  expect(JSON.stringify(exported)).not.toContain(original.body);
  expect(await proposals.submit(f.token, f.id, true, 1)).toBe("conflict");
  expect(await proposals.moderationQueue(staff)).toEqual([]);
  expect(await proposals.submit(f.token, f.id, true, 2)).toBe("submitted");
  expect(await proposals.moderationQueue(staff)).toMatchObject([
    { ...corrected, revision: 2 },
  ]);
  expect(await proposals.editDraft(f.token, f.id, original, 2)).toBe("denied");
  expect(await proposals.withdraw(f.token, f.id)).toBe(true);
  expect(await proposals.editDraft(f.token, f.id, original, 2)).toBe("denied");
  const redacted = await memberExportStore(pool).exportOwned(f.token);
  expect(redacted).toMatchObject({
    payload: {
      records: {
        proposals: [
          { id: f.id, title: null, body: null, sources: null, revision: 2 },
        ],
      },
    },
  });
  expect(JSON.stringify(redacted)).not.toContain(corrected.body);
  await db.remove(f.memberId);
  expect(
    (await pool.query("SELECT * FROM member_proposals WHERE id=$1", [f.id]))
      .rows,
  ).toEqual([]);
});

it("denies other members, staff, forged IDs, revoked sessions and deleting workspaces", async () => {
  const f = await fixture(),
    other = await fixture();
  const staff = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    staff,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  for (const token of [other.token, staff, "forged"]) {
    expect(await proposals.editDraft(token, f.id, corrected, 1)).toBe("denied");
    expect(await proposals.submit(token, f.id, true, 1)).toBe("denied");
  }
  expect(await proposals.editDraft(f.token, "invalid-id", corrected, 1)).toBe(
    "denied",
  );
  expect(
    await proposals.editDraft(
      f.token,
      f.id,
      { ...corrected, body: "NUL\0text" },
      1,
    ),
  ).toBe("invalid");
  expect(
    await proposals.editDraft(
      f.token,
      f.id,
      { ...corrected, sources: "x".repeat(1001) },
      1,
    ),
  ).toBe("invalid");
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
    [f.memberId],
  );
  expect(await proposals.editDraft(f.token, f.id, corrected, 1)).toBe("denied");
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [other.memberId],
  );
  expect(await proposals.editDraft(other.token, other.id, corrected, 1)).toBe(
    "denied",
  );
  expect(
    (
      await pool.query(
        "SELECT body,revision FROM member_proposals WHERE id=$1",
        [f.id],
      )
    ).rows,
  ).toEqual([{ body: original.body, revision: 1 }]);
});

it("preserves immutable owner and reference and denies stale or retired workflow edits/submits", async () => {
  const f = await fixture();
  let current: number | null = 1;
  const target = proposalStore(pool, async () =>
    current === null ? null : ({ version: current } as never),
  );
  const id = (await target.createDraft(f.token, original, true, {
    id: "WF-001",
    version: 1,
  }))!;
  expect(
    await target.editDraft(
      f.token,
      id,
      {
        ...corrected,
        member_id: "forged",
        workflowId: "WF-002",
        workflowVersion: 9,
        state: "submitted",
      } as typeof corrected,
      1,
    ),
  ).toBe("saved");
  expect(
    (
      await pool.query(
        "SELECT member_id,workflow_id,workflow_version,state,revision FROM member_proposals WHERE id=$1",
        [id],
      )
    ).rows,
  ).toEqual([
    {
      member_id: f.memberId,
      workflow_id: "WF-001",
      workflow_version: 1,
      state: "draft",
      revision: 2,
    },
  ]);
  for (const retired of [2, null]) {
    current = retired;
    expect(await target.editDraft(f.token, id, original, 2)).toBe("denied");
    expect(await target.submit(f.token, id, true, 2)).toBe("denied");
    expect(await target.preview(f.token, id)).toMatchObject({
      ...corrected,
      revision: 2,
    });
  }
  expect(await target.withdraw(f.token, id)).toBe(true);
});

it("handles the maximum revision without overflow and migration reruns without resetting it", async () => {
  const f = await fixture();
  await pool.query(
    "UPDATE member_proposals SET revision=2147483647 WHERE id=$1",
    [f.id],
  );
  await migrate(pool);
  expect(await proposals.editDraft(f.token, f.id, corrected, 2147483647)).toBe(
    "conflict",
  );
  expect(await proposals.preview(f.token, f.id)).toMatchObject({
    ...original,
    revision: 2147483647,
  });
  expect(await proposals.submit(f.token, f.id, true, 2147483647)).toBe(
    "submitted",
  );
  await expect(
    pool.query("UPDATE member_proposals SET revision=0 WHERE id=$1", [f.id]),
  ).rejects.toThrow();
});

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
  throw Error("Expected proposal lock wait was not observed");
}
function pausedMutation() {
  const entered = gate(),
    resume = gate(),
    backend = { pid: 0 };
  const target = proposalStore({
    async connect() {
      const client = await pool.connect();
      backend.pid = (
        await client.query("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (sql.startsWith("UPDATE member_proposals")) {
            entered.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool);
  return { target, entered, resume, backend };
}
function act(
  target: typeof proposals,
  f: Awaited<ReturnType<typeof fixture>>,
  action: "edit" | "submit" | "withdraw",
) {
  return action === "edit"
    ? target.editDraft(f.token, f.id, corrected, 1)
    : action === "submit"
      ? target.submit(f.token, f.id, true, 1)
      : target.withdraw(f.token, f.id);
}
it.each([
  ["edit", "edit", "conflict"],
  ["edit", "submit", "conflict"],
  ["submit", "edit", "denied"],
  ["edit", "withdraw", true],
  ["withdraw", "edit", "denied"],
] as const)(
  "serializes %s before %s with a visible PostgreSQL lock wait",
  async (first, second, expected) => {
    const f = await fixture(),
      paused = pausedMutation();
    const winning = act(paused.target, f, first);
    let losing: ReturnType<typeof act> | undefined;
    try {
      await Promise.race([
        paused.entered.wait,
        winning.then(() => {
          throw Error("Mutation missed pause");
        }),
      ]);
      losing = act(proposals, f, second);
      await waitForBlocked(paused.backend.pid);
      paused.resume.release();
      expect(await winning).toBe(
        first === "edit" ? "saved" : first === "submit" ? "submitted" : true,
      );
      expect(await losing).toBe(expected);
      const row = await proposals.preview(f.token, f.id);
      if (first === "withdraw" || second === "withdraw")
        expect(row).toMatchObject({
          state: "withdrawn",
          title: null,
          body: null,
          sources: null,
        });
      else
        expect(row).toMatchObject(
          first === "edit"
            ? { ...corrected, state: "draft", revision: 2 }
            : { ...original, state: "submitted", revision: 1 },
        );
    } finally {
      paused.resume.release();
      await Promise.allSettled([winning, ...(losing ? [losing] : [])]);
    }
  },
);

const finalChanges = ["revocation", "deletion", "deletion marker"] as const;
async function finalChange(
  client: PoolClient,
  f: Awaited<ReturnType<typeof fixture>>,
  change: (typeof finalChanges)[number],
) {
  if (change === "revocation")
    return client.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [f.memberId],
    );
  if (change === "deletion")
    return client.query("DELETE FROM principals WHERE id=$1", [f.memberId]);
  return client.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
    [f.memberId],
  );
}
it.each(finalChanges)(
  "a winning %s prevents a late edit and submit",
  async (change) => {
    const f = await fixture(),
      blocker = await pool.connect();
    let editing: ReturnType<typeof proposals.editDraft> | undefined;
    let submitting: ReturnType<typeof proposals.submit> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      await finalChange(blocker, f, change);
      editing = proposals.editDraft(f.token, f.id, corrected, 1);
      submitting = proposals.submit(f.token, f.id, true, 1);
      await waitForBlocked(pid);
      await blocker.query("COMMIT");
      expect(await editing).toBe("denied");
      expect(await submitting).toBe("denied");
      const rows = (
        await pool.query(
          "SELECT body,revision FROM member_proposals WHERE id=$1",
          [f.id],
        )
      ).rows;
      expect(rows).toEqual(
        change === "deletion" ? [] : [{ body: original.body, revision: 1 }],
      );
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled([
        ...(editing ? [editing] : []),
        ...(submitting ? [submitting] : []),
      ]);
    }
  },
);
it.each(finalChanges)(
  "edit commits before a waiting %s, after which further writes are denied",
  async (change) => {
    const f = await fixture(),
      paused = pausedMutation(),
      competitor = await pool.connect();
    const editing = paused.target.editDraft(f.token, f.id, corrected, 1);
    let pending: Promise<unknown> | undefined;
    try {
      await Promise.race([
        paused.entered.wait,
        editing.then(() => {
          throw Error("Edit missed pause");
        }),
      ]);
      await competitor.query("BEGIN");
      pending = finalChange(competitor, f, change);
      await waitForBlocked(paused.backend.pid);
      paused.resume.release();
      expect(await editing).toBe("saved");
      await pending;
      expect(
        (
          await pool.query(
            "SELECT body,revision FROM member_proposals WHERE id=$1",
            [f.id],
          )
        ).rows,
      ).toEqual([{ body: corrected.body, revision: 2 }]);
      await competitor.query("COMMIT");
      expect(await proposals.editDraft(f.token, f.id, original, 2)).toBe(
        "denied",
      );
      if (change === "deletion")
        expect(
          (
            await pool.query("SELECT id FROM member_proposals WHERE id=$1", [
              f.id,
            ])
          ).rows,
        ).toEqual([]);
    } finally {
      paused.resume.release();
      await editing;
      await pending;
      await competitor.query("ROLLBACK");
      competitor.release();
    }
  },
);

it.each(["immediate", "commit"] as const)(
  "rolls back text and revision after %s database failure, then permits recovery",
  async (stage) => {
    const f = await fixture();
    try {
      await pool.query(
        "CREATE FUNCTION fail_proposal_edit_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic proposal mutation failure'; END $$",
      );
      await pool.query(
        stage === "immediate"
          ? "CREATE TRIGGER fail_proposal_edit_test BEFORE UPDATE ON member_proposals FOR EACH ROW EXECUTE FUNCTION fail_proposal_edit_test()"
          : "CREATE CONSTRAINT TRIGGER fail_proposal_edit_test AFTER UPDATE ON member_proposals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_proposal_edit_test()",
      );
      await expect(
        proposals.editDraft(f.token, f.id, corrected, 1),
      ).rejects.toThrow("Proposal operation unconfirmed");
      await expect(proposals.submit(f.token, f.id, true, 1)).rejects.toThrow(
        "Proposal operation unconfirmed",
      );
      expect(await proposals.preview(f.token, f.id)).toMatchObject({
        ...original,
        revision: 1,
        state: "draft",
        submittedAt: null,
      });
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS fail_proposal_edit_test ON member_proposals",
      );
      await pool.query("DROP FUNCTION IF EXISTS fail_proposal_edit_test()");
    }
    expect(await proposals.editDraft(f.token, f.id, corrected, 1)).toBe(
      "saved",
    );
  },
);
it("rolls back a completed write when the session expires before commit", async () => {
  const f = await fixture();
  const deadline = (
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+INTERVAL '1 second' WHERE id=$1 RETURNING expires_at",
      [f.memberId],
    )
  ).rows[0].expires_at;
  const paused = pausedMutation();
  const editing = paused.target.editDraft(f.token, f.id, corrected, 1);
  try {
    await Promise.race([
      paused.entered.wait,
      editing.then(() => {
        throw Error("Edit missed pause");
      }),
    ]);
    const until = performance.now() + 5000;
    let expired = false;
    while (performance.now() < until) {
      expired = (
        await pool.query(
          "SELECT clock_timestamp()>=$1::timestamptz AS expired",
          [deadline],
        )
      ).rows[0].expired;
      if (expired) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(expired).toBe(true);
    paused.resume.release();
    expect(await editing).toBe("denied");
    expect(
      (
        await pool.query(
          "SELECT body,revision FROM member_proposals WHERE id=$1",
          [f.id],
        )
      ).rows,
    ).toEqual([{ body: original.body, revision: 1 }]);
  } finally {
    paused.resume.release();
    await editing;
  }
});

it("backfills existing drafts at revision 1 and never resets later edits on migration rerun", async () => {
  const f = await fixture();
  await pool.query("ALTER TABLE member_proposals DROP COLUMN revision");
  await migrate(pool);
  expect(await proposals.preview(f.token, f.id)).toMatchObject({
    ...original,
    revision: 1,
  });
  expect(await proposals.editDraft(f.token, f.id, corrected, 1)).toBe("saved");
  await migrate(pool);
  expect(await proposals.preview(f.token, f.id)).toMatchObject({
    ...corrected,
    revision: 2,
  });
  expect(
    (await pool.query("SELECT version FROM schema_migrations WHERE version=41"))
      .rows,
  ).toEqual([{ version: 41 }]);
});

it("times out a blocked save without changes, releases its transaction, and permits recovery", async () => {
  const f = await fixture(),
    blocker = await pool.connect();
  let pending: ReturnType<typeof proposals.editDraft> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM member_proposals WHERE id=$1 FOR UPDATE",
      [f.id],
    );
    pending = proposals.editDraft(f.token, f.id, corrected, 1);
    // A bounded adapter failure must not expose the database error or report success.
    await expect(pending).rejects.toThrow("Proposal operation unconfirmed");
    await blocker.query("ROLLBACK");
    expect(await proposals.preview(f.token, f.id)).toMatchObject({
      ...original,
      revision: 1,
    });
    expect(await proposals.editDraft(f.token, f.id, corrected, 1)).toBe(
      "saved",
    );
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    if (pending) await Promise.allSettled([pending]);
  }
}, 10000);

it.each(["quarantine", "reject"] as const)(
  "never edits or resurrects a proposal after moderation %s",
  async (action) => {
    const f = await fixture();
    const staff = randomBytes(32).toString("hex");
    await authorizationStore(pool).provisionStaff(
      staff,
      "moderator",
      new Date(Date.now() + 3600000),
    );
    expect(await proposals.submit(f.token, f.id, true, 1)).toBe("submitted");
    expect(await proposals.moderate(staff, f.id, action)).toBe(true);
    expect(await proposals.editDraft(f.token, f.id, corrected, 1)).toBe(
      "denied",
    );
    expect(await proposals.submit(f.token, f.id, true, 1)).toBe("denied");
    expect(await proposals.preview(f.token, f.id)).toMatchObject(
      action === "reject"
        ? { state: "rejected", body: null, revision: 1 }
        : { state: "quarantined", body: original.body, revision: 1 },
    );
  },
);
