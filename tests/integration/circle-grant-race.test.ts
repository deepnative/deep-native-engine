import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { circleGrantAdminStore } from "../../src/circle-grant-admin.ts";
import { circleDiscussionStore } from "../../src/circle-discussion.ts";
import { hash, migrate } from "../../src/store.ts";
import type { CircleGrantResult } from "../../src/circle-grant-values.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  auth = authorizationStore(pool),
  circle = "everyday-ai";
const subject = (source = pool) =>
  circleGrantAdminStore(source, "invented-race", {
    mode: "test",
    writes: true,
    discussion: true,
  });
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(() => pool.end());
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { release, wait };
}
function value<T>(result: CircleGrantResult<T>) {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Missing current invented result");
  return result.value;
}
async function fixture() {
  const admin = randomBytes(32).toString("hex"),
    target = randomBytes(32).toString("hex"),
    expiry = new Date(Date.now() + 3600000);
  const adminId = await auth.provisionStaff(admin, "platform_admin", expiry),
    staffId = await auth.provisionStaff(target, "moderator", expiry);
  return {
    admin,
    target,
    adminId,
    staffId,
    input: {
      staffId,
      circleId: circle,
      idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() + 1800000),
    },
    scope: { staffId, circleId: circle },
  };
}
async function blockedBy(pid: number) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (
      (
        await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
          [pid],
        )
      ).rowCount
    )
      return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Expected actual PostgreSQL blocking relationship");
}
async function stats(staffId: string) {
  return (
    await pool.query(
      "SELECT (SELECT count(*)::int FROM preview_circle_moderator_grants WHERE staff_id=$1) grants,(SELECT count(*)::int FROM preview_circle_grant_audit WHERE staff_id=$1 AND action='created') created",
      [staffId],
    )
  ).rows[0];
}
function pausedCommit() {
  const entered = barrier(),
    resume = barrier();
  let pid = 0;
  const proxy = {
    connect: async () => {
      const client = await pool.connect();
      pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      return {
        query: (async (sql: string, values?: unknown[]) => {
          if (sql === "COMMIT") {
            entered.release();
            await resume.wait;
          }
          return client.query(sql, values);
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  return { proxy, entered, resume, pid: () => pid };
}
const mutations = [
  {
    name: "actor hash",
    who: "adminId",
    table: "principals",
    sql: "UPDATE principals SET token_hash=$2 WHERE id=$1",
    replacement: true,
  },
  {
    name: "actor role",
    who: "adminId",
    table: "staff_profiles",
    sql: "UPDATE staff_profiles SET role='coach' WHERE principal_id=$1",
  },
  {
    name: "actor revocation",
    who: "adminId",
    table: "principals",
    sql: "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
  },
  {
    name: "actor expiry",
    who: "adminId",
    table: "principals",
    sql: "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
  },
  {
    name: "actor deletion",
    who: "adminId",
    table: "principals",
    sql: "DELETE FROM principals WHERE id=$1",
  },
  {
    name: "target role",
    who: "staffId",
    table: "staff_profiles",
    sql: "UPDATE staff_profiles SET role='coach' WHERE principal_id=$1",
  },
  {
    name: "target revocation",
    who: "staffId",
    table: "principals",
    sql: "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
  },
  {
    name: "target expiry",
    who: "staffId",
    table: "principals",
    sql: "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
  },
  {
    name: "target deletion",
    who: "staffId",
    table: "principals",
    sql: "DELETE FROM principals WHERE id=$1",
  },
] as const;
it.each(mutations)(
  "CIRADM-05 $name wins actual row-lock race and prevents grant/audit creation",
  async (mutation) => {
    const f = await fixture(),
      holder = await pool.connect(),
      replacement = randomBytes(32).toString("hex");
    let action: ReturnType<ReturnType<typeof subject>["create"]> | undefined;
    try {
      await holder.query("BEGIN");
      const id = f[mutation.who];
      await holder.query(
        mutation.table === "principals"
          ? "SELECT id FROM principals WHERE id=$1 FOR UPDATE"
          : "SELECT principal_id FROM staff_profiles WHERE principal_id=$1 FOR UPDATE",
        [id],
      );
      const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      action = subject().create(f.admin, f.input);
      const settled = Promise.allSettled([action]);
      await blockedBy(pid);
      await holder.query(
        mutation.sql,
        "replacement" in mutation ? [id, hash(replacement)] : [id],
      );
      await holder.query("COMMIT");
      expect(await action).toEqual({ kind: "denied" });
      await settled;
      expect(await stats(f.staffId)).toEqual({ grants: 0, created: 0 });
      if (mutation.name === "actor hash")
        expect(
          value(await subject().create(replacement, f.input)),
        ).toMatchObject({ staffId: f.staffId, state: "current" });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      if (action) await action;
    }
  },
  10000,
);
it.each(mutations)(
  "CIRADM-05 grant transaction wins before $name and later structural state follows the committed change",
  async (mutation) => {
    const f = await fixture(),
      paused = pausedCommit(),
      holder = await pool.connect(),
      replacement = randomBytes(32).toString("hex");
    let mutationAction: Promise<unknown> | undefined;
    const creating = subject(paused.proxy).create(f.admin, f.input),
      observed = Promise.allSettled([creating]);
    try {
      await paused.entered.wait;
      mutationAction = holder.query(
        mutation.sql,
        "replacement" in mutation
          ? [f[mutation.who], hash(replacement)]
          : [f[mutation.who]],
      );
      const mutationObserved = Promise.allSettled([mutationAction]);
      await blockedBy(paused.pid());
      paused.resume.release();
      const created = value(await creating);
      await mutationObserved;
      await mutationAction;
      const reader = randomBytes(32).toString("hex");
      await auth.provisionStaff(
        reader,
        "platform_admin",
        new Date(Date.now() + 60000),
      );
      const result = value(
        await subject().inspect(reader, f.scope, {
          kind: "grant",
          value: created.grantId,
        }),
      );
      expect(result).toMatchObject({
        source: mutation.name === "target deletion" ? "absent" : "retained",
        state:
          mutation.name === "target deletion"
            ? "source-absent"
            : mutation.who === "staffId"
              ? "ineffective"
              : "current",
      });
      expect(await stats(f.staffId)).toEqual({
        grants: mutation.name === "target deletion" ? 0 : 1,
        created: 1,
      });
      expect(
        (
          await circleDiscussionStore(pool, "invented-race").moderationQueue(
            f.target,
            circle,
          )
        ).kind,
      ).toBe(mutation.who === "staffId" ? "denied" : "ready");
    } finally {
      paused.resume.release();
      await observed;
      if (mutationAction) await mutationAction;
      holder.release();
    }
  },
  10000,
);
const keyCases = (["everyday-ai", "professional-work"] as const).flatMap(
  (firstCircle) =>
    (["same", "other-key", "other-circle", "other-creator"] as const).map(
      (change) => ({ firstCircle, change }),
    ),
);
it.each(keyCases)(
  "CIRADM-04 $firstCircle winner against $change follower preserves global-key/creator identity and exact audit count",
  async ({ firstCircle, change }) => {
    const f = await fixture(),
      paused = pausedCommit();
    f.input.circleId = firstCircle;
    let otherAdmin = f.admin;
    if (change === "other-creator") {
      otherAdmin = randomBytes(32).toString("hex");
      await auth.provisionStaff(
        otherAdmin,
        "platform_admin",
        new Date(Date.now() + 3600000),
      );
    }
    const other = {
      ...f.input,
      ...(change === "other-key" ? { idempotencyKey: randomUUID() } : {}),
      ...(change === "other-circle"
        ? {
            circleId:
              firstCircle === "everyday-ai"
                ? "professional-work"
                : "everyday-ai",
          }
        : {}),
    };
    const first = subject(paused.proxy).create(f.admin, f.input),
      firstObserved = Promise.allSettled([first]);
    let second: ReturnType<ReturnType<typeof subject>["create"]> | undefined;
    try {
      await paused.entered.wait;
      second = subject().create(otherAdmin, other);
      const secondObserved = Promise.allSettled([second]);
      await blockedBy(paused.pid());
      paused.resume.release();
      const winner = value(await first),
        follower = await second;
      await secondObserved;
      if (change === "same") expect(value(follower)).toEqual(winner);
      else if (change === "other-key")
        expect(value(follower).grantId).not.toBe(winner.grantId);
      else expect(follower).toEqual({ kind: "conflict" });
      expect(await stats(f.staffId)).toEqual({
        grants: change === "other-key" ? 2 : 1,
        created: change === "other-key" ? 2 : 1,
      });
      const recovered = value(
        await subject().inspect(
          f.admin,
          { staffId: f.staffId, circleId: firstCircle },
          { kind: "key", value: f.input.idempotencyKey },
        ),
      );
      expect(recovered).toEqual(winner);
      if (change === "other-creator")
        expect(
          value(
            await subject().inspect(
              otherAdmin,
              { staffId: f.staffId, circleId: firstCircle },
              { kind: "key", value: f.input.idempotencyKey },
            ),
          ),
        ).toBeNull();
    } finally {
      paused.resume.release();
      await firstObserved;
      if (second) await second;
    }
  },
  10000,
);
it("CIRADM-03 two exact revocations serialize against the same retained grant with one immutable revocation event", async () => {
  const f = await fixture(),
    grant = value(await subject().create(f.admin, f.input)),
    paused = pausedCommit();
  const first = subject(paused.proxy).revoke(f.admin, f.scope, grant.grantId),
    observed = Promise.allSettled([first]);
  let second: ReturnType<ReturnType<typeof subject>["revoke"]> | undefined;
  try {
    await paused.entered.wait;
    second = subject().revoke(f.admin, f.scope, grant.grantId);
    const otherObserved = Promise.allSettled([second]);
    await blockedBy(paused.pid());
    paused.resume.release();
    expect(value(await second)).toEqual(value(await first));
    await otherObserved;
    expect(
      (
        await pool.query(
          "SELECT action FROM preview_circle_grant_audit WHERE grant_id=$1 ORDER BY id",
          [grant.grantId],
        )
      ).rows,
    ).toEqual([{ action: "created" }, { action: "revoked" }]);
  } finally {
    paused.resume.release();
    await observed;
    if (second) await second;
  }
}, 10000);

it.each(["change-first", "grant-first"] as const)(
  "CIRADM-05 target credential replacement %s preserves the exact target grant only for the current credential",
  async (order) => {
    const f = await fixture(),
      replacement = randomBytes(32).toString("hex"),
      holder = await pool.connect(),
      paused = pausedCommit();
    let creating: ReturnType<ReturnType<typeof subject>["create"]> | undefined,
      changing: Promise<unknown> | undefined;
    try {
      if (order === "change-first") {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
          f.staffId,
        ]);
        const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0]
          .pid;
        creating = subject().create(f.admin, f.input);
        await blockedBy(pid);
        await holder.query("UPDATE principals SET token_hash=$1 WHERE id=$2", [
          hash(replacement),
          f.staffId,
        ]);
        await holder.query("COMMIT");
      } else {
        creating = subject(paused.proxy).create(f.admin, f.input);
        await paused.entered.wait;
        changing = holder.query(
          "UPDATE principals SET token_hash=$1 WHERE id=$2",
          [hash(replacement), f.staffId],
        );
        await blockedBy(paused.pid());
        paused.resume.release();
      }
      const created = value(await creating);
      if (changing) await changing;
      expect(created).toMatchObject({ staffId: f.staffId, state: "current" });
      const moderation = circleDiscussionStore(pool, "invented-race");
      expect((await moderation.moderationQueue(f.target, circle)).kind).toBe(
        "denied",
      );
      expect((await moderation.moderationQueue(replacement, circle)).kind).toBe(
        "ready",
      );
      expect(await stats(f.staffId)).toEqual({ grants: 1, created: 1 });
    } finally {
      paused.resume.release();
      await holder.query("ROLLBACK");
      if (creating) await creating;
      if (changing) await changing;
      holder.release();
    }
  },
  10000,
);
it.each(["create-first", "revoke-first"] as const)(
  "CIRADM-03/06 explicit self-target overlapping create and exact revoke in $0 order preserve the other authority",
  async (order) => {
    const f = await fixture();
    f.input.staffId = f.adminId;
    f.scope.staffId = f.adminId;
    const existing = value(await subject().create(f.admin, f.input)),
      input = { ...f.input, idempotencyKey: randomUUID() },
      paused = pausedCommit();
    const first =
        order === "create-first"
          ? subject(paused.proxy).create(f.admin, input)
          : subject(paused.proxy).revoke(f.admin, f.scope, existing.grantId),
      observed = Promise.allSettled([first]);
    let second: ReturnType<ReturnType<typeof subject>["revoke"]> | undefined;
    try {
      await paused.entered.wait;
      second =
        order === "create-first"
          ? subject().revoke(f.admin, f.scope, existing.grantId)
          : subject().create(f.admin, input);
      const otherObserved = Promise.allSettled([second]);
      await blockedBy(paused.pid());
      paused.resume.release();
      value(await first);
      value(await second);
      await otherObserved;
      expect(
        value(
          await subject().inspect(f.admin, f.scope, {
            kind: "grant",
            value: existing.grantId,
          }),
        ),
      ).toMatchObject({ state: "revoked" });
      expect(
        value(
          await subject().inspect(f.admin, f.scope, {
            kind: "key",
            value: input.idempotencyKey,
          }),
        ),
      ).toMatchObject({ state: "current" });
      expect(
        (
          await circleDiscussionStore(pool, "invented-race").moderationQueue(
            f.admin,
            circle,
          )
        ).kind,
      ).toBe("ready");
      expect(await stats(f.adminId)).toEqual({ grants: 2, created: 2 });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM preview_circle_grant_audit WHERE grant_id=$1 AND action='revoked'",
            [existing.grantId],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      paused.resume.release();
      await observed;
      if (second) await second;
    }
  },
  10000,
);
