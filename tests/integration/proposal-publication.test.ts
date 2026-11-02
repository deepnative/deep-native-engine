import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { proposalStore } from "../../src/proposals.ts";
import {
  publicationStore,
  DISPLAY_PERMISSION,
  type PublicationInstruction,
  type PublicationResult,
} from "../../src/proposal-publication.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  db = store(pool),
  auth = authorizationStore(pool);
const proposals = proposalStore(pool, undefined, { ordinaryEnabled: true }),
  publications = publicationStore(pool, { enabled: true });
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
afterAll(async () => pool.end());
const value = {
  title: "Invented member method",
  body: "Original invented text\r\nwith two source checks.",
  sources: "Original fixture text only.",
};
function ready<T>(result: PublicationResult<T>): T {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error(result.kind);
  return result.value;
}
async function fixture() {
  const owner = randomBytes(32).toString("hex"),
    peer = randomBytes(32).toString("hex"),
    moderator = randomBytes(32).toString("hex");
  await db.create(owner, { background: "explorer", goal: "everyday" });
  await db.create(peer, { background: "professional", goal: "work" });
  const member = await db.session(owner);
  if (member.kind !== "active") throw Error("Member fixture absent");
  const actorId = await auth.provisionStaff(
    moderator,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  const id = (await proposals.createDraft(owner, value, false))!;
  expect(id).toBeTruthy();
  expect(await proposals.submit(owner, id, true, 1)).toBe("submitted");
  const instruction: PublicationInstruction = {
    operationId: randomUUID(),
    proposalId: id,
    revision: 1,
    attribution: "Invented pseudonym",
    audience: "members",
    permissionVersion: DISPLAY_PERMISSION,
    confirmed: true,
  };
  return {
    owner,
    peer,
    moderator,
    memberId: member.learner.id,
    actorId,
    id,
    instruction,
  };
}
it("keeps ordinary intake and acceptance private; publishes only the accepted exact owner-selected revision", async () => {
  const f = await fixture();
  expect(await proposals.preview(f.owner, f.id)).toMatchObject({
    origin: "member",
    state: "submitted",
    revision: 1,
  });
  expect(ready(await publications.list(f.peer))).toEqual([]);
  expect(await publications.publish(f.owner, f.instruction)).toEqual({
    kind: "conflict",
  });
  const accepted = ready(await publications.accept(f.moderator, f.id, 1, true));
  expect(accepted).toMatchObject({
    state: "accepted",
    attribution: null,
    operationId: null,
  });
  expect(ready(await publications.list(f.peer))).toEqual([]);
  expect(await publications.publish(f.peer, f.instruction)).toEqual({
    kind: "denied",
  });
  const shared = ready(await publications.publish(f.owner, f.instruction));
  expect(shared).toMatchObject({
    state: "published",
    attribution: f.instruction.attribution,
  });
  const read = ready(await publications.detail(f.peer, shared.id));
  expect(read.source.body).toBe(value.body);
  expect(read.source.origin).toBe("member");
  expect(ready(await publications.publish(f.owner, f.instruction))).toEqual(
    shared,
  );
  expect(
    await publications.publish(f.owner, {
      ...f.instruction,
      attribution: "Changed attribution",
    }),
  ).toEqual({ kind: "conflict" });
  expect(await publications.inspect(f.peer, f.instruction.operationId)).toEqual(
    { kind: "denied" },
  );
  expect(
    ready(await publications.inspect(f.owner, f.instruction.operationId)),
  ).toEqual(shared);
  expect(
    (await pool.query("SELECT count(*)::int n FROM proposal_publications"))
      .rows[0].n,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM content_versions WHERE origin='member-proposal'",
      )
    ).rows[0].n,
  ).toBe(0);
});
it.each([
  "withdraw",
  "quarantine",
  "reject",
  "request-changes",
  "delete",
] as const)(
  "withdraws shared attribution and future reads after actual source %s",
  async (action) => {
    const f = await fixture();
    ready(await publications.accept(f.moderator, f.id, 1, true));
    const shared = ready(await publications.publish(f.owner, f.instruction));
    if (action === "withdraw")
      expect(await proposals.withdraw(f.owner, f.id)).toBe(true);
    else if (action === "delete") await db.remove(f.memberId);
    else if (action === "request-changes")
      expect(
        await proposals.requestChanges(f.moderator, f.id, {
          expectedRevision: 1,
          feedback: "Please revise this original example.",
        }),
      ).toBe("requested");
    else expect(await proposals.moderate(f.moderator, f.id, action)).toBe(true);
    expect(await publications.detail(f.peer, shared.id)).toEqual({
      kind: "denied",
    });
    expect(ready(await publications.list(f.peer))).toEqual([]);
    if (action === "delete") {
      expect(
        (await pool.query("SELECT count(*)::int n FROM proposal_publications"))
          .rows[0].n,
      ).toBe(0);
      expect(await publications.publish(f.owner, f.instruction)).toEqual({
        kind: "denied",
      });
    } else {
      expect(
        ready(await publications.inspect(f.owner, f.instruction.operationId)),
      ).toMatchObject({ state: "withdrawn", attribution: null });
      expect(
        ready(await publications.publish(f.owner, f.instruction)),
      ).toMatchObject({ state: "withdrawn", attribution: null });
    }
    if (action === "request-changes") {
      expect(
        await proposals.editDraft(
          f.owner,
          f.id,
          { ...value, body: "Corrected invented original." },
          1,
        ),
      ).toBe("saved");
      expect(await proposals.submit(f.owner, f.id, true, 2)).toBe("submitted");
      expect(
        await publications.publish(f.owner, {
          ...f.instruction,
          operationId: randomUUID(),
          revision: 2,
        }),
      ).toEqual({ kind: "conflict" });
      ready(await publications.accept(f.moderator, f.id, 2, true));
      const newer = ready(
        await publications.publish(f.owner, {
          ...f.instruction,
          operationId: randomUUID(),
          revision: 2,
        }),
      );
      expect(
        ready(await publications.detail(f.peer, newer.id)).source.body,
      ).toBe("Corrected invented original.");
      expect(await publications.detail(f.peer, shared.id)).toEqual({
        kind: "denied",
      });
    }
  },
);
it("keeps the private original and export while withdrawing only display; no feature-off or new-key resurrection", async () => {
  const f = await fixture();
  ready(await publications.accept(f.moderator, f.id, 1, true));
  const shared = ready(await publications.publish(f.owner, f.instruction));
  const off = publicationStore(pool, { enabled: false });
  expect(await off.accept(f.moderator, f.id, 1, true)).toEqual({
    kind: "disabled",
  });
  expect(ready(await off.inspect(f.owner, f.instruction.operationId))).toEqual(
    shared,
  );
  expect(ready(await off.withdraw(f.owner, f.id, 1))).toMatchObject({
    state: "withdrawn",
    attribution: null,
  });
  expect((await proposals.preview(f.owner, f.id))?.body).toBe(value.body);
  expect(ready(await off.publish(f.owner, f.instruction))).toMatchObject({
    state: "withdrawn",
    attribution: null,
  });
  expect(
    await publications.publish(f.owner, {
      ...f.instruction,
      operationId: randomUUID(),
    }),
  ).toEqual({ kind: "conflict" });
  const exported = await memberExportStore(pool).exportOwned(f.owner);
  expect(exported.kind).toBe("ready");
  if (exported.kind !== "ready") throw Error("Export failed");
  expect(exported.payload.version).toBe("local-member-records-v29");
  expect(exported.payload.records.proposalPublications).toEqual([
    expect.objectContaining({
      id: shared.id,
      state: "withdrawn",
      attribution: null,
      revision: 1,
    }),
  ]);
  expect(JSON.stringify(exported.payload)).not.toContain(f.actorId);
  expect(JSON.stringify(exported.payload)).not.toContain(
    f.instruction.operationId,
  );
});
it("keeps legacy synthetic consent distinct and refuses acceptance without exact current rights", async () => {
  const f = await fixture();
  const legacy = proposalStore(pool);
  expect(await legacy.createDraft(f.owner, value, false)).toBeNull();
  const id = (await legacy.createDraft(f.owner, value, true))!;
  await legacy.submit(f.owner, id, true, 1);
  expect(ready(await publications.owner(f.owner, id)).source.origin).toBe(
    "sample",
  );
  await pool.query(
    "UPDATE member_proposals SET rights_attested_revision=NULL WHERE id=$1",
    [id],
  );
  expect(await publications.accept(f.moderator, id, 1, true)).toEqual({
    kind: "conflict",
  });
  const reviewer = randomBytes(32).toString("hex");
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 3600000),
  );
  expect(await publications.accept(reviewer, f.id, 1, true)).toEqual({
    kind: "denied",
  });
  expect(await publications.accept(f.moderator, f.id, 2, true)).toEqual({
    kind: "conflict",
  });
  expect(await publications.owner(f.peer, f.id)).toEqual({ kind: "denied" });
});
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { release, wait };
}
function controlled(
  options: { lostCommit?: boolean; failCommit?: boolean } = {},
) {
  const connected = gate(),
    state = { pid: 0, rollback: false, discarded: false };
  const wrapped = {
    async connect() {
      const client = await pool.connect();
      state.pid = (
        await client.query("SELECT pg_backend_pid() pid")
      ).rows[0].pid;
      connected.release();
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql === "ROLLBACK") state.rollback = true;
          if (sql === "COMMIT" && options.failCommit)
            throw Error("Test commit failure");
          const r = await client.query(sql, values);
          if (sql === "COMMIT" && options.lostCommit)
            throw Error("Test lost committed response");
          return r;
        },
        release(error?: Error) {
          state.discarded = !!error;
          client.release(error);
        },
      };
    },
  } as unknown as Pool;
  return {
    target: publicationStore(wrapped, { enabled: true }),
    connected,
    state,
  };
}
async function blocked(pid: number, by: number) {
  for (let n = 0; n < 200; n++) {
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
  throw Error("Expected real PostgreSQL blocker");
}
it.each(["accept", "publish", "withdraw"] as const)(
  "recovers actual lost-COMMIT %s through current inspection without duplicate or resurrection",
  async (action) => {
    const f = await fixture();
    if (action !== "accept")
      ready(await publications.accept(f.moderator, f.id, 1, true));
    if (action === "withdraw")
      ready(await publications.publish(f.owner, f.instruction));
    const c = controlled({ lostCommit: true });
    const result =
      action === "accept"
        ? await c.target.accept(f.moderator, f.id, 1, true)
        : action === "publish"
          ? await c.target.publish(f.owner, f.instruction)
          : await c.target.withdraw(f.owner, f.id, 1);
    expect(result).toEqual({ kind: "unavailable" });
    expect(c.state).toMatchObject({ rollback: false, discarded: true });
    const current = ready(await publications.owner(f.owner, f.id));
    expect(current.receipt?.state).toBe(
      action === "accept"
        ? "accepted"
        : action === "publish"
          ? "published"
          : "withdrawn",
    );
    if (action === "accept")
      ready(await publications.accept(f.moderator, f.id, 1, true));
    else
      expect(ready(await publications.publish(f.owner, f.instruction))).toEqual(
        current.receipt,
      );
    expect(
      (await pool.query("SELECT count(*)::int n FROM proposal_publications"))
        .rows[0].n,
    ).toBe(1);
  },
);
it("rolls back deferred publication failure and permits explicit recovery with the same request", async () => {
  const f = await fixture();
  ready(await publications.accept(f.moderator, f.id, 1, true));
  try {
    await pool.query(
      "CREATE FUNCTION test_reject_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='published' THEN RAISE EXCEPTION 'test publication failure'; END IF; RETURN NEW; END $$",
    );
    await pool.query(
      "CREATE CONSTRAINT TRIGGER test_reject_publication AFTER UPDATE ON proposal_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_reject_publication()",
    );
    expect(await publications.publish(f.owner, f.instruction)).toEqual({
      kind: "unavailable",
    });
    expect(
      ready(await publications.inspect(f.owner, f.instruction.operationId)),
    ).toBeNull();
    expect(ready(await publications.owner(f.owner, f.id)).receipt?.state).toBe(
      "accepted",
    );
  } finally {
    await pool.query(
      "DROP TRIGGER IF EXISTS test_reject_publication ON proposal_publications",
    );
    await pool.query("DROP FUNCTION IF EXISTS test_reject_publication()");
  }
  ready(await publications.publish(f.owner, f.instruction));
});
it("withholds a publication read after actual source lock wait crosses the reader's database expiry", async () => {
  const f = await fixture();
  ready(await publications.accept(f.moderator, f.id, 1, true));
  const published = ready(await publications.publish(f.owner, f.instruction));
  const peer = await db.session(f.peer);
  if (peer.kind !== "active") throw Error("Peer absent");
  const expires = (
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '650 milliseconds' WHERE id=$1 RETURNING expires_at",
      [peer.learner.id],
    )
  ).rows[0].expires_at;
  const blocker = await pool.connect(),
    c = controlled();
  let pending: ReturnType<typeof publications.detail> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM member_proposals WHERE id=$1 FOR UPDATE",
      [f.id],
    );
    const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0]
      .pid;
    pending = c.target.detail(f.peer, published.id);
    await c.connected.wait;
    await blocked(c.state.pid, pid);
    await blocker.query(
      "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))+.03))",
      [expires],
    );
    await blocker.query("COMMIT");
    expect(await pending).toEqual({ kind: "denied" });
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await pending;
  }
});
it("rechecks source withdrawal committed during a genuine publication row wait", async () => {
  const f = await fixture();
  ready(await publications.accept(f.moderator, f.id, 1, true));
  const blocker = await pool.connect(),
    c = controlled();
  let pending: ReturnType<typeof publications.publish> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM member_proposals WHERE id=$1 FOR UPDATE",
      [f.id],
    );
    const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0]
      .pid;
    pending = c.target.publish(f.owner, f.instruction);
    await c.connected.wait;
    await blocked(c.state.pid, pid);
    await blocker.query(
      "UPDATE member_proposals SET state='withdrawn',title=NULL,body=NULL,sources=NULL,withdrawn_at=clock_timestamp() WHERE id=$1",
      [f.id],
    );
    await blocker.query("COMMIT");
    expect(await pending).toEqual({ kind: "conflict" });
    expect(ready(await publications.list(f.peer))).toEqual([]);
    expect(
      ready(await publications.owner(f.owner, f.id)).receipt,
    ).toMatchObject({
      state: "withdrawn",
      attribution: null,
      operationId: null,
    });
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await pending;
  }
});
it.each(["revoke", "remove-role"] as const)(
  "denies editorial acceptance after current staff %s commits during an actual authority lock wait",
  async (action) => {
    const f = await fixture();
    const blocker = await pool.connect(),
      c = controlled();
    let pending: ReturnType<typeof publications.accept> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        action === "revoke"
          ? "SELECT id FROM principals WHERE id=$1 FOR UPDATE"
          : "SELECT principal_id FROM staff_profiles WHERE principal_id=$1 FOR UPDATE",
        [f.actorId],
      );
      const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      pending = c.target.accept(f.moderator, f.id, 1, true);
      await c.connected.wait;
      await blocked(c.state.pid, pid);
      await blocker.query(
        action === "revoke"
          ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
          : "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1",
        [f.actorId],
      );
      await blocker.query("COMMIT");
      expect(await pending).toEqual({ kind: "denied" });
      expect(ready(await publications.owner(f.owner, f.id)).receipt).toBeNull();
      expect(ready(await publications.list(f.peer))).toEqual([]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pending;
    }
  },
);
