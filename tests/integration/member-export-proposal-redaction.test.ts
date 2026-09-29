import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { authorizationStore } from "../../src/authorization.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { proposalStore } from "../../src/proposals.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const members = store(pool);
const proposals = proposalStore(pool);
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

function pausedAfterProposalRead() {
  const proposalRead = gate();
  const continueExport = gate();
  const state = { pid: 0 };
  const controlledPool = {
    async connect() {
      const client = await pool.connect();
      state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (sql.includes("FROM member_proposals WHERE member_id=$1")) {
            proposalRead.release();
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
    proposalRead,
    continueExport,
    state,
  };
}

function observableWriter() {
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
  return { writerPool, connected, state };
}

async function waitForBlocking(
  writerPid: number,
  exportPid: number,
  finished: () => boolean,
) {
  const until = performance.now() + 3000;
  while (performance.now() < until) {
    if (finished()) return "finished";
    const result = await pool.query(
      "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
      [exportPid, writerPid],
    );
    if (result.rows[0].blocked) return "blocked";
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected proposal writer blocking was not observed");
}

beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, cohorts CASCADE");
});
afterAll(async () => pool.end());

it.each(["draft", "submitted", "quarantined"] as const)(
  "does not export private %s proposal text after authorized withdrawal commits",
  async (initialState) => {
    const ownerToken = token();
    await members.create(ownerToken, {
      background: "explorer",
      goal: "everyday",
    });
    const session = await members.session(ownerToken);
    if (session.kind !== "active")
      throw new Error("Synthetic member setup failed");
    const value = {
      title: "Invented withdrawn proposal title",
      body: "Invented withdrawn proposal body",
      sources: "Invented withdrawn proposal sources",
    };
    const proposalId = await proposals.createDraft(ownerToken, value, true, {
      id: "WF-001",
      version: 1,
    });
    expect(proposalId).toBeTruthy();
    if (initialState !== "draft") {
      expect(await proposals.submit(ownerToken, proposalId!, true, 1)).toBe(
        "submitted",
      );
    }
    if (initialState === "quarantined") {
      const moderatorToken = token();
      await authorizationStore(pool).provisionStaff(
        moderatorToken,
        "moderator",
        new Date(Date.now() + 60_000),
      );
      expect(
        await proposals.moderate(moderatorToken, proposalId!, "quarantine"),
      ).toBe(true);
    }
    const controlled = pausedAfterOwnerLookup();
    const order: string[] = [];
    const reading = controlled.exported.exportOwned(ownerToken);
    try {
      await controlled.snapshotFormed.wait;
      expect(controlled.state.snapshot).not.toBe("");
      order.push("owner export snapshot formed");
      expect(await proposals.withdraw(ownerToken, proposalId!)).toBe(true);
      order.push("proposal withdrawal committed");
      const retained = (
        await pool.query(
          "SELECT state,title,body,sources,workflow_id FROM member_proposals WHERE id=$1",
          [proposalId],
        )
      ).rows[0] as Record<string, unknown>;
      expect(retained).toMatchObject({
        state: "withdrawn",
        title: null,
        body: null,
        sources: null,
        workflow_id: null,
      });
      controlled.continueExport.release();
      const result = await reading;
      order.push("owner export returned");
      expect(order).toEqual([
        "owner export snapshot formed",
        "proposal withdrawal committed",
        "owner export returned",
      ]);
      const returnedBytes = JSON.stringify(result);
      expect(
        [value.title, value.body, value.sources, "WF-001"].some((privateText) =>
          returnedBytes.includes(privateText),
        ),
      ).toBe(false);
      const fresh = await memberExportStore(pool).exportOwned(ownerToken);
      expect(fresh).toMatchObject({
        kind: "ready",
        payload: {
          records: { proposals: [{ id: proposalId, state: "withdrawn" }] },
        },
      });
      expect(JSON.stringify(fresh).includes(value.body)).toBe(false);
    } finally {
      controlled.continueExport.release();
      await Promise.allSettled([reading]);
    }
  },
  15_000,
);

it.each(["withdraw", "reject"] as const)(
  "finishes an export that read proposal text before %s commits, then exports only redacted state",
  async (action) => {
    const ownerToken = token();
    await members.create(ownerToken, {
      background: "explorer",
      goal: "everyday",
    });
    const value = {
      title: `Invented export-first ${action} title`,
      body: `Invented export-first ${action} body`,
      sources: `Invented export-first ${action} sources`,
    };
    const proposalId = await proposals.createDraft(ownerToken, value, true, {
      id: "WF-001",
      version: 1,
    });
    expect(proposalId).toBeTruthy();
    let moderatorToken = "";
    if (action === "reject") {
      expect(await proposals.submit(ownerToken, proposalId!, true, 1)).toBe(
        "submitted",
      );
      moderatorToken = token();
      await authorizationStore(pool).provisionStaff(
        moderatorToken,
        "moderator",
        new Date(Date.now() + 60_000),
      );
    }
    const controlled = pausedAfterProposalRead();
    const reading = controlled.exported.exportOwned(ownerToken);
    const writer = observableWriter();
    let finished = false;
    let writing: Promise<boolean> | undefined;
    try {
      await controlled.proposalRead.wait;
      writing = (
        action === "withdraw"
          ? proposalStore(writer.writerPool).withdraw(ownerToken, proposalId!)
          : proposalStore(writer.writerPool).moderate(
              moderatorToken,
              proposalId!,
              "reject",
            )
      ).then((result) => {
        finished = true;
        return result;
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
      expect(JSON.stringify(earlier).includes(value.body)).toBe(true);
      expect(await writing).toBe(true);
      const fresh = await memberExportStore(pool).exportOwned(ownerToken);
      expect(fresh).toMatchObject({
        kind: "ready",
        payload: {
          records: {
            proposals: [
              {
                id: proposalId,
                state: action === "withdraw" ? "withdrawn" : "rejected",
                title: null,
                body: null,
                sources: null,
                workflowId: null,
              },
            ],
          },
        },
      });
      expect(JSON.stringify(fresh).includes(value.body)).toBe(false);
    } finally {
      controlled.continueExport.release();
      await Promise.allSettled([reading, ...(writing ? [writing] : [])]);
    }
  },
  15_000,
);

it("keeps stable primary-key page order when creation dates are reversed", async () => {
  const ownerToken = token();
  await members.create(ownerToken, {
    background: "explorer",
    goal: "everyday",
  });
  const session = await members.session(ownerToken);
  if (session.kind !== "active")
    throw new Error("Synthetic member setup failed");
  const earlierId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const laterId = "00000000-0000-4000-8000-000000000001";
  for (const [id, title, createdAt] of [
    [earlierId, "Invented earlier private proposal", "2026-09-28T10:00:00Z"],
    [laterId, "Invented later private proposal", "2026-09-28T11:00:00Z"],
  ]) {
    await pool.query(
      `INSERT INTO member_proposals
       (id,member_id,title,body,sources,sample_attested_at,created_at)
       VALUES($1,$2,$3,'Invented private body','Invented private source',
         clock_timestamp(),$4)`,
      [id, session.learner.id, title, createdAt],
    );
  }
  const controlled = pausedAfterProposalRead();
  const reading = controlled.exported.exportOwned(ownerToken);
  const writer = observableWriter();
  let finished = false;
  let writing: Promise<boolean> | undefined;
  try {
    await controlled.proposalRead.wait;
    writing = proposalStore(writer.writerPool)
      .withdraw(ownerToken, laterId)
      .then((result) => {
        finished = true;
        return result;
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
    expect(earlier).toMatchObject({
      kind: "ready",
      payload: {
        records: { proposals: [{ id: laterId }, { id: earlierId }] },
      },
    });
    expect(await writing).toBe(true);
    const fresh = await memberExportStore(pool).exportOwned(ownerToken);
    expect(fresh).toMatchObject({
      kind: "ready",
      payload: {
        records: {
          proposals: [
            { id: laterId, state: "withdrawn", title: null, body: null },
            { id: earlierId, title: "Invented earlier private proposal" },
          ],
        },
      },
    });
  } finally {
    controlled.continueExport.release();
    await Promise.allSettled([reading, ...(writing ? [writing] : [])]);
  }
}, 15_000);

it.each(["submitted", "quarantined"] as const)(
  "does not export private %s proposal text after moderator rejection commits",
  async (initialState) => {
    const ownerToken = token();
    await members.create(ownerToken, {
      background: "explorer",
      goal: "everyday",
    });
    const value = {
      title: "Invented rejected proposal title",
      body: "Invented rejected proposal body",
      sources: "Invented rejected proposal sources",
    };
    const proposalId = await proposals.createDraft(ownerToken, value, true, {
      id: "WF-001",
      version: 1,
    });
    expect(proposalId).toBeTruthy();
    expect(await proposals.submit(ownerToken, proposalId!, true, 1)).toBe(
      "submitted",
    );
    const moderatorToken = token();
    await authorizationStore(pool).provisionStaff(
      moderatorToken,
      "moderator",
      new Date(Date.now() + 60_000),
    );
    if (initialState === "quarantined") {
      expect(
        await proposals.moderate(moderatorToken, proposalId!, "quarantine"),
      ).toBe(true);
    }
    const controlled = pausedAfterOwnerLookup();
    const order: string[] = [];
    const reading = controlled.exported.exportOwned(ownerToken);
    try {
      await controlled.snapshotFormed.wait;
      expect(controlled.state.snapshot).not.toBe("");
      order.push("owner export snapshot formed");
      expect(
        await proposals.moderate(moderatorToken, proposalId!, "reject"),
      ).toBe(true);
      order.push("moderator rejection committed");
      const retained = (
        await pool.query(
          "SELECT state,title,body,sources,workflow_id FROM member_proposals WHERE id=$1",
          [proposalId],
        )
      ).rows[0] as Record<string, unknown>;
      expect(retained).toMatchObject({
        state: "rejected",
        title: null,
        body: null,
        sources: null,
        workflow_id: null,
      });
      const rejectionAudit = await pool.query(
        `SELECT action,old_state,new_state FROM proposal_audit
       WHERE proposal_id=$1 AND action='proposal_rejected'`,
        [proposalId],
      );
      expect(rejectionAudit.rows).toEqual([
        {
          action: "proposal_rejected",
          old_state: initialState,
          new_state: "rejected",
        },
      ]);
      controlled.continueExport.release();
      const result = await reading;
      order.push("owner export returned");
      expect(order).toEqual([
        "owner export snapshot formed",
        "moderator rejection committed",
        "owner export returned",
      ]);
      const returnedBytes = JSON.stringify(result);
      expect(
        [value.title, value.body, value.sources, "WF-001"].some((privateText) =>
          returnedBytes.includes(privateText),
        ),
      ).toBe(false);
      const fresh = await memberExportStore(pool).exportOwned(ownerToken);
      expect(fresh).toMatchObject({
        kind: "ready",
        payload: {
          records: { proposals: [{ id: proposalId, state: "rejected" }] },
        },
      });
      expect(JSON.stringify(fresh).includes(value.body)).toBe(false);
    } finally {
      controlled.continueExport.release();
      await Promise.allSettled([reading]);
    }
  },
  15_000,
);

it("returns no private export after proposal-row lock timeout and releases owner locks", async () => {
  const ownerToken = token();
  await members.create(ownerToken, {
    background: "explorer",
    goal: "everyday",
  });
  const session = await members.session(ownerToken);
  if (session.kind !== "active")
    throw new Error("Synthetic member setup failed");
  const ownerId = session.learner.id;
  const value = {
    title: "Invented locked proposal title",
    body: "Invented locked proposal body",
    sources: "Invented locked proposal sources",
  };
  const proposalId = await proposals.createDraft(ownerToken, value, true);
  expect(proposalId).toBeTruthy();
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
    await blocker.query("UPDATE member_proposals SET body=body WHERE id=$1", [
      proposalId,
    ]);
    reading = memberExportStore(observablePool)
      .exportOwned(ownerToken)
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
    expect(JSON.stringify(result).includes(value.body)).toBe(false);

    const probe = await pool.connect();
    try {
      await probe.query("BEGIN");
      await probe.query("SET LOCAL lock_timeout='1s'");
      expect(
        (
          await probe.query(
            "SELECT id FROM principals WHERE id=$1 FOR UPDATE",
            [ownerId],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await probe.query(
            "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
            [ownerId],
          )
        ).rowCount,
      ).toBe(1);
      await probe.query("COMMIT");
    } finally {
      await probe.query("ROLLBACK");
      probe.release();
    }
    await blocker.query("ROLLBACK");
    const fresh = await memberExportStore(pool).exportOwned(ownerToken);
    expect(fresh).toMatchObject({
      kind: "ready",
      payload: {
        records: {
          proposals: [{ id: proposalId, title: value.title, body: value.body }],
        },
      },
    });
  } finally {
    await blocker.query("ROLLBACK");
    if (reading) await Promise.allSettled([reading]);
    blocker.release();
  }
}, 15_000);
