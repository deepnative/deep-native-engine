import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore, type StaffRole } from "../../src/authorization.ts";
import { circleGrantAdminStore } from "../../src/circle-grant-admin.ts";
import { circleDiscussionStore } from "../../src/circle-discussion.ts";
import { migrate, store } from "../../src/store.ts";
import type {
  CircleGrantRecord,
  CircleGrantResult,
} from "../../src/circle-grant-values.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  auth = authorizationStore(pool),
  circle = "everyday-ai",
  secret = "invented-circle-grant-store-secret";
const grants = circleGrantAdminStore(pool, secret, {
  mode: "test",
  writes: true,
  discussion: true,
});
const discussion = circleDiscussionStore(pool, secret);
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
afterAll(async () => pool.end());
function value<T>(result: CircleGrantResult<T>): T {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready")
    throw Error("Invented grant fixture unavailable");
  expect(result.deadline).toBeGreaterThan(performance.now());
  return result.value;
}
async function staff(role: StaffRole = "moderator") {
  const token = randomBytes(32).toString("hex"),
    expiresAt = new Date(Date.now() + 3600000);
  const id = await auth.provisionStaff(token, role, expiresAt);
  return { id, token, expiresAt };
}
async function fixture() {
  const admin = await staff("platform_admin"),
    target = await staff();
  const input = {
    staffId: target.id,
    circleId: circle,
    idempotencyKey: randomUUID(),
    expiresAt: new Date(Date.now() + 1800000),
  };
  return {
    admin,
    target,
    input,
    scope: { staffId: target.id, circleId: circle },
  };
}
it("CIRADM-01/02 exact finite grant and creator key replay reuse migration055 with one content-free audit and no other authority", async () => {
  const f = await fixture();
  expect(value(await grants.reference(f.target.token))).toEqual({
    staffId: f.target.id,
    role: "moderator",
    expiresAt: f.target.expiresAt,
  });
  expect(
    value(await grants.check(f.admin.token, f.target.id, circle)),
  ).toMatchObject({
    staffId: f.target.id,
    circleId: circle,
    role: "moderator",
    creationEnabled: true,
  });
  expect((await discussion.moderationQueue(f.target.token, circle)).kind).toBe(
    "denied",
  );
  const before = (await pool.query<{ at: Date }>("SELECT clock_timestamp() at"))
    .rows[0]!.at;
  const created = value(await grants.create(f.admin.token, f.input));
  expect(created).toMatchObject({
    ...f.scope,
    source: "retained",
    role: "moderator",
    purpose: "circle-discussion-test-v1",
    createdBy: f.admin.id,
    expiresAt: f.input.expiresAt,
    state: "current",
    revokedAt: null,
  });
  expect(created.startsAt >= before).toBe(true);
  expect(value(await grants.create(f.admin.token, f.input))).toEqual(created);
  expect(
    value(
      await grants.inspect(f.admin.token, f.scope, {
        kind: "key",
        value: f.input.idempotencyKey,
      }),
    ),
  ).toEqual(created);
  expect(JSON.stringify(created)).not.toContain(f.input.idempotencyKey);
  expect(JSON.stringify(created)).not.toContain(f.target.token);
  expect((await discussion.moderationQueue(f.target.token, circle)).kind).toBe(
    "ready",
  );
  expect(
    (await discussion.moderationQueue(f.target.token, "professional-work"))
      .kind,
  ).toBe("denied");
  expect(
    (
      await grants.create(f.admin.token, {
        ...f.input,
        circleId: "professional-work",
      })
    ).kind,
  ).toBe("conflict");
  expect(
    (
      await grants.create(f.admin.token, {
        ...f.input,
        expiresAt: new Date(+f.input.expiresAt + 1000),
      })
    ).kind,
  ).toBe("conflict");
  const other = await staff("platform_admin");
  expect((await grants.create(other.token, f.input)).kind).toBe("conflict");
  expect(
    value(
      await grants.inspect(other.token, f.scope, {
        kind: "key",
        value: f.input.idempotencyKey,
      }),
    ),
  ).toBeNull();
  expect(
    value(
      await grants.inspect(other.token, f.scope, {
        kind: "grant",
        value: created.grantId,
      }),
    ),
  ).toEqual(created);
  expect(
    (
      await pool.query(
        "SELECT actor_id,staff_id,grant_id,circle_id,action FROM preview_circle_grant_audit WHERE grant_id=$1",
        [created.grantId],
      )
    ).rows,
  ).toEqual([
    {
      actor_id: f.admin.id,
      staff_id: f.target.id,
      grant_id: created.grantId,
      circle_id: circle,
      action: "created",
    },
  ]);
});
it("CIRADM-02 explicit self-target is server-derived and still requires its separate exact grant", async () => {
  const f = await fixture();
  const self = value(await grants.check(f.admin.token, "self", circle));
  expect(self.staffId).toBe(f.admin.id);
  expect(self.role).toBe("platform_admin");
  expect((await discussion.moderationQueue(f.admin.token, circle)).kind).toBe(
    "denied",
  );
  const grant = value(
    await grants.create(f.admin.token, { ...f.input, staffId: self.staffId }),
  );
  expect(grant.staffId).toBe(f.admin.id);
  expect((await discussion.moderationQueue(f.admin.token, circle)).kind).toBe(
    "ready",
  );
  expect(
    (await discussion.moderationQueue(f.admin.token, "professional-work")).kind,
  ).toBe("denied");
});
it("CIRADM-03/08 exact overlapping revocation is one-way and remains available while new grants/member writes are paused", async () => {
  const f = await fixture();
  const first = value(await grants.create(f.admin.token, f.input));
  const second = value(
    await grants.create(f.admin.token, {
      ...f.input,
      idempotencyKey: randomUUID(),
    }),
  );
  const paused = circleGrantAdminStore(pool, secret, {
    mode: "test",
    writes: false,
    discussion: false,
  });
  expect(value(await paused.admin(f.admin.token)).creationEnabled).toBe(false);
  expect(
    (
      await paused.create(f.admin.token, {
        ...f.input,
        idempotencyKey: randomUUID(),
      })
    ).kind,
  ).toBe("denied");
  const revoked = value(
    await paused.revoke(f.admin.token, f.scope, first.grantId),
  );
  expect(revoked.state).toBe("revoked");
  expect(
    value(await paused.revoke(f.admin.token, f.scope, first.grantId)),
  ).toEqual(revoked);
  expect(
    value(
      await paused.inspect(f.admin.token, f.scope, {
        kind: "key",
        value: f.input.idempotencyKey,
      }),
    ),
  ).toEqual(revoked);
  expect((await discussion.moderationQueue(f.target.token, circle)).kind).toBe(
    "ready",
  );
  value(await paused.revoke(f.admin.token, f.scope, second.grantId));
  expect((await discussion.moderationQueue(f.target.token, circle)).kind).toBe(
    "denied",
  );
  expect(value(await grants.create(f.admin.token, f.input)).state).toBe(
    "revoked",
  );
  expect((await discussion.moderationQueue(f.target.token, circle)).kind).toBe(
    "denied",
  );
  expect(
    (
      await pool.query(
        "SELECT grant_id,action FROM preview_circle_grant_audit WHERE grant_id=ANY($1::uuid[]) ORDER BY grant_id,id",
        [[first.grantId, second.grantId]],
      )
    ).rows,
  ).toHaveLength(4);
});
it("CIRADM-05/06 expired/revoked target is historical data rather than an artificial administrator read/revoke deadline", async () => {
  const f = await fixture(),
    created = value(await grants.create(f.admin.token, f.input));
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second',revoked_at=clock_timestamp() WHERE id=$1",
    [f.target.id],
  );
  expect((await grants.check(f.admin.token, f.target.id, circle)).kind).toBe(
    "denied",
  );
  expect(
    (
      await grants.create(f.admin.token, {
        ...f.input,
        idempotencyKey: randomUUID(),
      })
    ).kind,
  ).toBe("denied");
  expect(
    value(
      await grants.inspect(f.admin.token, f.scope, {
        kind: "grant",
        value: created.grantId,
      }),
    ),
  ).toMatchObject({ grantId: created.grantId, state: "ineffective" });
  expect(
    value(await grants.history(f.admin.token, f.scope)).items,
  ).toHaveLength(1);
  expect(
    value(await grants.revoke(f.admin.token, f.scope, created.grantId)).state,
  ).toBe("revoked");
  expect((await discussion.moderationQueue(f.target.token, circle)).kind).toBe(
    "denied",
  );
});
it.each(["operator", "reviewer", "coach", "editor"] as const)(
  "CIRADM-05 own reference and exact creation reject ineligible %s role",
  async (role) => {
    const f = await fixture(),
      ineligible = await staff(role);
    expect((await grants.reference(ineligible.token)).kind).toBe("denied");
    expect((await grants.admin(ineligible.token)).kind).toBe("denied");
    expect(
      (
        await grants.create(f.admin.token, {
          ...f.input,
          staffId: ineligible.id,
        })
      ).kind,
    ).toBe("denied");
    expect((await grants.create(ineligible.token, f.input)).kind).toBe(
      "denied",
    );
    expect(
      (await pool.query("SELECT id FROM preview_circle_moderator_grants"))
        .rowCount,
    ).toBe(0);
  },
);
it("CIRADM-05/08 malformed scope/window, target expiry ceiling and live mode create no grant or actor audit", async () => {
  const f = await fixture();
  for (const input of [
    { ...f.input, staffId: "bad" },
    { ...f.input, circleId: "foreign" },
    { ...f.input, idempotencyKey: "bad" },
    { ...f.input, expiresAt: new Date(NaN) },
    { ...f.input, expiresAt: new Date(0) },
    { ...f.input, expiresAt: new Date(+f.target.expiresAt + 1) },
  ])
    expect((await grants.create(f.admin.token, input)).kind).toBe("invalid");
  const live = circleGrantAdminStore(pool, secret, {
    mode: "live",
    writes: true,
    discussion: true,
  });
  expect((await live.create(f.admin.token, f.input)).kind).toBe("denied");
  expect((await live.reference(f.target.token)).kind).toBe("denied");
  expect(
    (await pool.query("SELECT id FROM preview_circle_moderator_grants"))
      .rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT id FROM preview_circle_grant_audit WHERE actor_id=$1",
        [f.admin.id],
      )
    ).rowCount,
  ).toBe(0);
});
it("CIRADM-06/07 125 populated legacy grants page exactly and survive target erasure only as truthful audit stubs", async () => {
  const f = await fixture(),
    ids = Array.from({ length: 125 }, () => randomUUID()),
    keys = Array.from({ length: 125 }, () => randomUUID());
  await pool.query(
    `INSERT INTO preview_circle_moderator_grants(id,staff_id,staff_role,circle_id,purpose,granted_by,idempotency_key,starts_at,expires_at,revoked_at)
    SELECT u.id,$3,'moderator',$4,'circle-discussion-test-v1',$5,u.key,
      clock_timestamp()+CASE WHEN n%3=0 THEN interval '10 minutes' ELSE interval '-1 hour' END,
      clock_timestamp()+CASE WHEN n%3=1 THEN interval '-30 minutes' ELSE interval '20 minutes' END,
      CASE WHEN n=1 THEN clock_timestamp() ELSE NULL END
    FROM unnest($1::uuid[],$2::uuid[]) WITH ORDINALITY AS u(id,key,n)`,
    [ids, keys, f.target.id, circle, f.admin.id],
  );
  await pool.query(
    "INSERT INTO preview_circle_grant_audit(actor_id,staff_id,grant_id,circle_id,action) SELECT granted_by,staff_id,id,circle_id,'created' FROM preview_circle_moderator_grants WHERE staff_id=$1",
    [f.target.id],
  );
  await pool.query(
    "INSERT INTO preview_circle_grant_audit(actor_id,staff_id,grant_id,circle_id,action) VALUES($1,$2,$3,$4,'revoked')",
    [f.admin.id, f.target.id, ids[0], circle],
  );
  const other = await staff();
  value(
    await grants.create(f.admin.token, {
      ...f.input,
      staffId: other.id,
      idempotencyKey: randomUUID(),
    }),
  );
  value(
    await grants.create(f.admin.token, {
      ...f.input,
      circleId: "professional-work",
      idempotencyKey: randomUUID(),
    }),
  );
  const first = value(await grants.history(f.admin.token, f.scope));
  expect(first.items).toHaveLength(20);
  expect(first.nextCursor).not.toBeNull();
  for (const scope of [
    { ...f.scope, staffId: other.id },
    { ...f.scope, circleId: "professional-work" },
  ])
    expect(
      (await grants.history(f.admin.token, scope, first.nextCursor!)).kind,
    ).toBe("invalid");
  const otherAdmin = await staff("platform_admin");
  expect(
    (await grants.history(otherAdmin.token, f.scope, first.nextCursor!)).kind,
  ).toBe("invalid");
  const collect = async () => {
    const records: CircleGrantRecord[] = [];
    let after: string | undefined;
    do {
      const page = value(await grants.history(f.admin.token, f.scope, after));
      expect(page.items.length).toBeLessThanOrEqual(20);
      records.push(...page.items);
      after = page.nextCursor ?? undefined;
    } while (after);
    return records;
  };
  const retained = await collect();
  expect(retained.map((row) => row.grantId)).toEqual(ids.slice().sort());
  expect(new Set(retained.map((row) => row.state))).toEqual(
    new Set(["current", "future", "expired", "revoked"]),
  );
  await pool.query("DELETE FROM principals WHERE id=$1", [f.target.id]);
  const absent = await collect();
  expect(absent.map((row) => row.grantId)).toEqual(ids.slice().sort());
  expect(
    absent.every(
      (row) => row.source === "absent" && row.state === "source-absent",
    ),
  ).toBe(true);
  expect(JSON.stringify(absent)).not.toContain("expiresAt");
  expect(JSON.stringify(absent)).not.toContain(keys[0]!);
  expect(absent.find((row) => row.grantId === ids[0])).toMatchObject({
    audit: [{ action: "created" }, { action: "revoked" }],
  });
  expect(
    value(
      await grants.inspect(f.admin.token, f.scope, {
        kind: "key",
        value: keys[0]!,
      }),
    ),
  ).toBeNull();
  expect(
    value(
      await grants.inspect(f.admin.token, f.scope, {
        kind: "grant",
        value: ids[0]!,
      }),
    ),
  ).toMatchObject({ source: "absent", grantId: ids[0] });
  expect(
    value(await grants.history(f.admin.token, f.scope, first.nextCursor!))
      .items[0]!.grantId,
  ).toBe(ids.slice().sort()[20]);
});
it("CIRADM-07 deleting a creator preserves grants to others but never preserves deleted actor access or changes member records", async () => {
  const f = await fixture(),
    observer = await staff("platform_admin");
  const memberToken = randomBytes(32).toString("hex"),
    members = store(pool);
  await members.create(memberToken, {
    background: "professional",
    goal: "work",
  });
  const member = await members.session(memberToken);
  if (member.kind !== "active") throw Error("Invented member missing");
  await members.save(member.learner.id, {
    instruction: "Invented private work",
    verification: "Compare the invented source",
    complete: true,
    goal: "work",
  });
  const before = (
    await pool.query("SELECT * FROM exercises WHERE learner_id=$1", [
      member.learner.id,
    ])
  ).rows;
  const created = value(await grants.create(f.admin.token, f.input));
  await pool.query("DELETE FROM principals WHERE id=$1", [f.admin.id]);
  expect(
    (
      await grants.inspect(f.admin.token, f.scope, {
        kind: "key",
        value: f.input.idempotencyKey,
      })
    ).kind,
  ).toBe("denied");
  expect(
    value(
      await grants.inspect(observer.token, f.scope, {
        kind: "grant",
        value: created.grantId,
      }),
    ),
  ).toMatchObject({
    source: "retained",
    createdBy: f.admin.id,
    state: "current",
  });
  expect((await discussion.moderationQueue(f.target.token, circle)).kind).toBe(
    "ready",
  );
  expect(
    (
      await pool.query("SELECT * FROM exercises WHERE learner_id=$1", [
        member.learner.id,
      ])
    ).rows,
  ).toEqual(before);
  await pool.query("DELETE FROM principals WHERE id=$1", [member.learner.id]);
  expect(
    value(
      await grants.inspect(observer.token, f.scope, {
        kind: "grant",
        value: created.grantId,
      }),
    ),
  ).toMatchObject({ source: "retained", state: "current" });
});
