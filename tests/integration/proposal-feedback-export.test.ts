import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate, store, hash } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { proposalStore } from "../../src/proposals.ts";
import {
  memberExportStore,
  MAX_MEMBER_EXPORT_BYTES,
  MAX_MEMBER_EXPORT_RECORDS,
} from "../../src/member-export.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const proposals = proposalStore(pool);
const exported = memberExportStore(pool);
const invented = {
  title: "Invented private contribution",
  body: "Invented current proposal text",
  sources: "Original invented sample",
};
const firstFeedback = "Clarify the invented example without private records.";
const secondFeedback = "Explain the corrected invented example more clearly.";
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals, cohorts CASCADE"));
afterAll(async () => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw Error("Synthetic member unavailable");
  return { token, id: session.learner.id };
}
async function fixture() {
  const owner = await member();
  const staffToken = randomBytes(32).toString("hex");
  const staffId = await authorizationStore(pool).provisionStaff(
    staffToken,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  const id = await proposals.createDraft(owner.token, invented, true);
  if (!id) throw Error("Synthetic proposal unavailable");
  expect(await proposals.submit(owner.token, id, true, 1)).toBe("submitted");
  expect(
    await proposals.requestChanges(staffToken, id, {
      expectedRevision: 1,
      feedback: firstFeedback,
    }),
  ).toBe("requested");
  return { owner, staffToken, staffId, id };
}
async function snapshot(token: string, cursor?: string) {
  const result = await exported.exportOwned(token, cursor);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Owned export unavailable");
  return result.payload;
}
async function resubmit(f: Awaited<ReturnType<typeof fixture>>) {
  expect(
    await proposals.editDraft(
      f.owner.token,
      f.id,
      { ...invented, body: "Corrected invented proposal text" },
      1,
    ),
  ).toBe("saved");
  expect(await proposals.submit(f.owner.token, f.id, true, 2)).toBe(
    "submitted",
  );
}
it("exports current owner feedback and exact fresh rights without staff or audit identities", async () => {
  const f = await fixture();
  const returned = await snapshot(f.owner.token);
  expect(returned.version).toBe("local-member-records-v17");
  expect(returned.records.proposals).toMatchObject([
    {
      id: f.id,
      state: "changes_requested",
      revision: 1,
      rightsAttestedRevision: null,
      rightsAttestedAt: null,
      feedback: {
        text: firstFeedback,
        reviewedRevision: 1,
        requestedAt: expect.any(String),
      },
    },
  ]);
  const row = returned.records.proposals![0]!;
  expect(Object.keys(row).sort()).toEqual(
    [
      "id",
      "title",
      "body",
      "sources",
      "state",
      "revision",
      "workflowId",
      "workflowVersion",
      "createdAt",
      "submittedAt",
      "withdrawnAt",
      "rightsAttestedRevision",
      "rightsAttestedAt",
      "feedback",
    ].sort(),
  );
  expect(Object.keys(row.feedback as object).sort()).toEqual(
    ["text", "reviewedRevision", "requestedAt"].sort(),
  );
  expect(
    Number.isFinite(
      Date.parse((row.feedback as { requestedAt: string }).requestedAt),
    ),
  ).toBe(true);
  const bytes = JSON.stringify(returned);
  expect(bytes).not.toContain(f.staffId);
  expect(bytes).not.toContain(f.staffToken);
  expect(bytes).not.toMatch(/moderated_by|actor_id|actor_role|proposal_audit/);
  const other = await member();
  expect((await snapshot(other.token)).records.proposals).toEqual([]);
  expect(await exported.exportOwned(f.staffToken)).toEqual({ kind: "denied" });
  await resubmit(f);
  const submitted = await snapshot(f.owner.token);
  expect(submitted.records.proposals).toMatchObject([
    {
      id: f.id,
      state: "submitted",
      revision: 2,
      rightsAttestedRevision: 2,
      rightsAttestedAt: expect.any(Date),
      feedback: { text: firstFeedback, reviewedRevision: 1 },
      body: "Corrected invented proposal text",
    },
  ]);
  expect(JSON.stringify(submitted)).not.toContain(invented.body);
  expect(
    await proposals.requestChanges(f.staffToken, f.id, {
      expectedRevision: 2,
      feedback: secondFeedback,
    }),
  ).toBe("requested");
  const replaced = await snapshot(f.owner.token);
  expect(replaced.records.proposals).toMatchObject([
    {
      state: "changes_requested",
      revision: 2,
      rightsAttestedRevision: null,
      rightsAttestedAt: null,
      feedback: { text: secondFeedback, reviewedRevision: 2 },
    },
  ]);
  expect(JSON.stringify(replaced)).not.toContain(firstFeedback);
  expect(replaced.records.proposals).toHaveLength(1);
});
it.each(["withdraw", "reject"] as const)(
  "redacts %s feedback and text from retained export markers",
  async (action) => {
    const f = await fixture();
    await resubmit(f);
    expect(await proposals.moderate(f.staffToken, f.id, "quarantine")).toBe(
      true,
    );
    expect((await snapshot(f.owner.token)).records.proposals).toMatchObject([
      {
        state: "quarantined",
        feedback: { text: firstFeedback, reviewedRevision: 1 },
      },
    ]);
    if (action === "withdraw")
      expect(await proposals.withdraw(f.owner.token, f.id)).toBe(true);
    else
      expect(await proposals.moderate(f.staffToken, f.id, "reject")).toBe(true);
    const result = await snapshot(f.owner.token);
    expect(result.records.proposals).toMatchObject([
      {
        id: f.id,
        state: action === "withdraw" ? "withdrawn" : "rejected",
        title: null,
        body: null,
        sources: null,
        workflowId: null,
        workflowVersion: null,
        feedback: null,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(firstFeedback);
    expect(JSON.stringify(result)).not.toContain(
      "Corrected invented proposal text",
    );
  },
);
it("preserves historically unknown exact consent and removes feedback with account deletion", async () => {
  const f = await fixture();
  await resubmit(f);
  const legacy = await proposals.createDraft(f.owner.token, invented, true);
  expect(await proposals.submit(f.owner.token, legacy!, true, 1)).toBe(
    "submitted",
  );
  await pool.query(
    "UPDATE member_proposals SET rights_attested_revision=NULL WHERE id=$1",
    [legacy],
  );
  const before = await snapshot(f.owner.token);
  expect(before.records.proposals).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: legacy,
        rightsAttestedRevision: null,
        rightsAttestedAt: expect.any(Date),
        feedback: null,
      }),
      expect.objectContaining({
        id: f.id,
        feedback: expect.objectContaining({ text: firstFeedback }),
      }),
    ]),
  );
  await db.remove(f.owner.id);
  expect(await exported.exportOwned(f.owner.token)).toEqual({ kind: "denied" });
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM member_proposals WHERE member_id=$1",
        [f.owner.id],
      )
    ).rows[0].count,
  ).toBe("0");
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM proposal_audit WHERE member_id=$1",
        [f.owner.id],
      )
    ).rows[0].count,
  ).toBe("0");
});
it.each(["revoked", "expired", "deleting"] as const)(
  "denies %s owners before disclosing retained feedback",
  async (reason) => {
    const f = await fixture();
    if (reason === "deleting")
      await pool.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [f.owner.id],
      );
    else
      await pool.query(
        reason === "expired"
          ? "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1"
          : "UPDATE principals SET revoked_at=clock_timestamp() WHERE token_hash=$1",
        [hash(f.owner.token)],
      );
    expect(await exported.exportOwned(f.owner.token)).toEqual({
      kind: "denied",
    });
  },
);
it("pages maximum Unicode feedback without increasing record or byte limits or retaining duplicates", async () => {
  const f = await fixture();
  // Delete fixture parents through the supported workspace/audit cascade.
  await db.remove(f.owner.id);
  const owner = await member();
  const ids = Array.from({ length: 105 }, () => randomUUID());
  for (const id of ids)
    await pool.query(
      `INSERT INTO member_proposals(id,member_id,title,body,sources,state,sample_attested_at,
      submitted_at,revision,change_feedback,change_feedback_revision,changes_requested_at,
      moderated_by,moderated_at)
      VALUES($1,$2,$3,$4,$5,'changes_requested',clock_timestamp(),clock_timestamp(),2,$6,1,
        clock_timestamp(),$7,clock_timestamp())`,
      [
        id,
        owner.id,
        "学".repeat(160),
        "练".repeat(4000),
        "例".repeat(1000),
        "改".repeat(1000),
        f.staffId,
      ],
    );
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await snapshot(owner.token, cursor);
    expect(page.page.recordCount).toBeLessThanOrEqual(
      MAX_MEMBER_EXPORT_RECORDS,
    );
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      MAX_MEMBER_EXPORT_BYTES,
    );
    expect(page.version).toBe("local-member-records-v17");
    for (const row of page.records.proposals!) {
      seen.push(row.id as string);
      expect(row.feedback).toMatchObject({
        text: "改".repeat(1000),
        reviewedRevision: 1,
      });
    }
    cursor = page.page.nextCursor ?? undefined;
    pages++;
    expect(pages).toBeLessThan(20);
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  expect(seen).toHaveLength(ids.length);
  expect(new Set(seen).size).toBe(ids.length);
  expect(seen.sort()).toEqual(ids.sort());
});
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function within(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Expected synthetic lock checkpoint missing")),
          1500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function controlledPool(pause: "export-row" | "commit" | "none") {
  const connected = gate(),
    paused = gate(),
    resume = gate();
  const state = { pid: 0, intercepted: false };
  const wrapped = {
    async connect() {
      const client = await pool.connect();
      state.pid = (
        await client.query("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      connected.release();
      return {
        async query(sql: string, values?: unknown[]) {
          if (pause === "commit" && sql === "COMMIT" && !state.intercepted) {
            state.intercepted = true;
            paused.release();
            await resume.wait;
          }
          const result = await client.query(sql, values);
          if (
            pause === "export-row" &&
            sql.includes("FROM member_proposals WHERE") &&
            sql.includes("FOR SHARE") &&
            !state.intercepted
          ) {
            state.intercepted = true;
            paused.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  return { pool: wrapped, state, connected, paused, resume };
}
async function blockedBy(blocker: number, waiting: number) {
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    const result = await pool.query(
      "SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked",
      [blocker, waiting],
    );
    if (result.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Synthetic proposal lock ordering not observed");
}
it("finishes a locked export before withdrawal and redacts feedback on the next page", async () => {
  const f = await fixture();
  const reader = controlledPool("export-row"),
    writer = controlledPool("none");
  const reading = memberExportStore(reader.pool).exportOwned(f.owner.token);
  let writing: Promise<boolean> | undefined;
  try {
    await within(reader.paused.wait);
    writing = proposalStore(writer.pool).withdraw(f.owner.token, f.id);
    await within(writer.connected.wait);
    await blockedBy(reader.state.pid, writer.state.pid);
    reader.resume.release();
    expect(await reading).toMatchObject({
      kind: "ready",
      payload: {
        records: { proposals: [{ feedback: { text: firstFeedback } }] },
      },
    });
    expect(await writing).toBe(true);
    expect((await snapshot(f.owner.token)).records.proposals).toMatchObject([
      { state: "withdrawn", feedback: null, body: null },
    ]);
  } finally {
    reader.resume.release();
    writer.resume.release();
    await Promise.allSettled([reading, ...(writing ? [writing] : [])]);
  }
});
it("returns no stale feedback when withdrawal commits ahead of a waiting repeatable export", async () => {
  const f = await fixture();
  const writer = controlledPool("commit"),
    reader = controlledPool("none");
  const writing = proposalStore(writer.pool).withdraw(f.owner.token, f.id);
  let reading:
    ReturnType<ReturnType<typeof memberExportStore>["exportOwned"]> | undefined;
  try {
    await within(writer.paused.wait);
    reading = memberExportStore(reader.pool).exportOwned(f.owner.token);
    await within(reader.connected.wait);
    await blockedBy(writer.state.pid, reader.state.pid);
    writer.resume.release();
    expect(await writing).toBe(true);
    expect(await reading).toEqual({ kind: "unavailable" });
    const current = await snapshot(f.owner.token);
    expect(current.records.proposals).toMatchObject([
      { state: "withdrawn", feedback: null, body: null },
    ]);
    expect(JSON.stringify(current)).not.toContain(firstFeedback);
  } finally {
    writer.resume.release();
    reader.resume.release();
    await Promise.allSettled([writing, ...(reading ? [reading] : [])]);
  }
});
