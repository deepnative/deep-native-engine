import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { administratorEntry } from "../../src/administrator-entry.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { simpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { migrate, store, hash } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  entry = administratorEntry(pool);
const invoices = simpleInvoiceStore(pool, {
  sample: true,
  issuer: "Invented issuer",
  instructions: "Sample not payable",
});
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(() => pool.end());
async function fixture(address = "shi@deepnative.io", verify = true) {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("No invented member");
  let link = "";
  const email = memberEmailAccess(
    pool,
    {
      async send(_address, value) {
        link = value;
      },
    },
    "http://127.0.0.1:3000",
  );
  expect(await email.requestAttach(token, address)).toBe("sent");
  const code = new URL(link).searchParams.get("code")!;
  if (verify) expect((await email.consume(code, token)).kind).toBe("attached");
  return { token, id: session.learner.id, email, code };
}
it("ADMINONLY01/04 enters both exact normalized verified owner identities without losing learner work", async () => {
  for (const address of [" Shi@DeepNative.io ", "TOM@deepnative.io"]) {
    const f = await fixture(address);
    await members.save(f.token, {
      revision: 0,
      instruction: "Invented retained draft",
      verification: "Check the sample",
      complete: false,
    });
    expect((await invoices.adminOverview(f.token)).kind).toBe("denied");
    const r = await entry.enter(f.token);
    expect(r.kind).toBe("ready");
    if (r.kind !== "ready" || !r.credential || !r.expires)
      throw Error("No administration");
    // Authority is issued by PostgreSQL; the host and Docker VM clocks can differ.
    const serverNow = (
      await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now;
    expect(+r.expires).toBeLessThanOrEqual(+serverNow + 8 * 3600000);
    expect(await staffEntryStore(pool).admit(r.credential)).toMatchObject({
      kind: "ready",
      role: "platform_admin",
    });
    expect((await invoices.adminOverview(r.credential)).kind).toBe("ready");
    expect((await members.session(f.token)).kind).toBe("active");
    expect(await members.progress(f.id)).toMatchObject({
      instruction: "Invented retained draft",
    });
    expect(await entry.enter(f.token)).toEqual({ kind: "denied" });
    expect(await entry.end(f.token)).toEqual({ kind: "ready" });
    expect((await invoices.adminOverview(r.credential)).kind).toBe("denied");
    expect((await members.session(f.token)).kind).toBe("active");
  }
});
it("ADMINONLY02 refuses unverified, unrelated, alias and lookalike identities and expired or reused challenges", async () => {
  for (const address of [
    "shi@deepnative.io",
    "info@deepnative.io",
    "tom+alias@deepnative.io",
    "tom@deepnatlve.io",
  ]) {
    const f = await fixture(address, address !== "shi@deepnative.io");
    expect(await entry.enter(f.token)).toEqual({ kind: "denied" });
    if (address === "shi@deepnative.io") {
      await pool.query(
        "UPDATE member_email_links SET created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1",
        [hash(f.code)],
      );
      expect((await f.email.consume(f.code, f.token)).kind).toBe("unavailable");
      expect(await entry.enter(f.token)).toEqual({ kind: "denied" });
    }
  }
  expect(
    (await pool.query("SELECT 1 FROM administrator_sessions")).rowCount,
  ).toBe(0);
});
it("ADMINONLY03/04 denies legacy and signout-rotated credentials while retaining identities and learning", async () => {
  const legacy = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    legacy,
    "platform_admin",
    new Date(Date.now() + 60000),
  );
  expect((await staffEntryStore(pool).admit(legacy)).kind).toBe("denied");
  expect((await invoices.adminOverview(legacy)).kind).toBe("denied");
  const f = await fixture(),
    r = await entry.enter(f.token);
  if (r.kind !== "ready" || !r.credential) throw Error("No administration");
  expect(await f.email.signOut(f.token)).toBe("signed_out");
  expect((await staffEntryStore(pool).admit(r.credential)).kind).toBe("denied");
  expect(await entry.enter(f.token)).toEqual({ kind: "denied" });
  expect(
    (
      await pool.query(
        "SELECT 1 FROM member_email_identities WHERE principal_id=$1",
        [f.id],
      )
    ).rowCount,
  ).toBe(1);
});
it("ADMINONLY03 serializes direct administration against an in-flight revocation", async () => {
  const f = await fixture(),
    r = await entry.enter(f.token);
  if (r.kind !== "ready" || !r.credential) throw Error("No administration");
  const lock = await pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query(
      "UPDATE administrator_sessions SET revoked_at=clock_timestamp() WHERE member_id=$1",
      [f.id],
    );
    const locker = (
      await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    const pending = invoices.adminOverview(r.credential);
    await vi.waitFor(
      async () =>
        expect(
          (
            await pool.query<{ count: number }>(
              "SELECT count(*)::integer count FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))",
              [locker],
            )
          ).rows[0]!.count,
        ).toBeGreaterThan(0),
      { timeout: 2000 },
    );
    await lock.query("COMMIT");
    expect((await pending).kind).toBe("denied");
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
});
it("ADMINONLY05 an acknowledged database commit with lost transport never returns or reissues a credential", async () => {
  const f = await fixture();
  let commits = 0;
  const fault = {
    async connect() {
      const client = await pool.connect();
      return {
        query: async (sql: string, args?: unknown[]) => {
          const result = await client.query(sql, args);
          if (sql === "COMMIT") {
            commits++;
            throw Error("Invented acknowledgement lost");
          }
          return result;
        },
        release: (error?: Error) => client.release(error),
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  expect(await administratorEntry(fault).enter(f.token)).toEqual({
    kind: "unavailable",
  });
  expect(commits).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM administrator_sessions WHERE member_id=$1",
        [f.id],
      )
    ).rowCount,
  ).toBe(1);
  expect(await entry.enter(f.token)).toEqual({ kind: "denied" });
  expect(await entry.end(f.token)).toEqual({ kind: "ready" });
});

it("ADMINONLY02/03 denies direct legacy billing/grants and each revoked identity boundary", async () => {
  const f = await fixture();
  const auth = authorizationStore(pool),
    legacy = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 3600000);
  const legacyId = await auth.provisionStaff(legacy, "platform_admin", expiry);
  const coach = await auth.provisionStaff(
    randomBytes(32).toString("hex"),
    "coach",
    expiry,
  );
  await expect(
    auth.grantAssignment(
      legacyId,
      coach,
      f.id,
      "coach",
      "Invented purpose",
      expiry,
    ),
  ).rejects.toThrow("Privileged grant denied");
  expect(
    await invoices.propose(legacy, {
      ownerId: f.id,
      operationId: randomUUID(),
      courses: [{ id: "invented-course", version: 1, amountCents: 100 }],
      cadence: "one_time",
      startsOn: "2026-11-02",
      taxCents: 0,
    }),
  ).toEqual({ kind: "denied" });
  expect((await pool.query("SELECT 1 FROM assignment_grants")).rowCount).toBe(
    0,
  );
  expect(
    (await pool.query("SELECT 1 FROM simple_invoice_plans")).rowCount,
  ).toBe(0);
  const entered = await entry.enter(f.token);
  if (entered.kind !== "ready" || !entered.credential)
    throw Error("No administration");
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [f.id],
  );
  expect((await invoices.adminOverview(entered.credential)).kind).toBe(
    "denied",
  );
  await pool.query("UPDATE principals SET revoked_at=NULL WHERE id=$1", [f.id]);
  await pool.query(
    "DELETE FROM member_email_identities WHERE principal_id=$1",
    [f.id],
  );
  expect((await staffEntryStore(pool).admit(entered.credential)).kind).toBe(
    "denied",
  );
});

it("ADMINONLY03 ending administration serializes with a concurrent direct read without a lock cycle", async () => {
  const f = await fixture(),
    entered = await entry.enter(f.token);
  if (entered.kind !== "ready" || !entered.credential)
    throw Error("No administration");
  let reached!: () => void,
    resume!: () => void,
    endingPid = 0;
  const locked = new Promise<void>((resolve) => {
      reached = resolve;
    }),
    continueEnd = new Promise<void>((resolve) => {
      resume = resolve;
    });
  const errors: string[] = [];
  const scoped = {
    async connect() {
      const client = await pool.connect();
      endingPid = (
        await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
      return {
        query: async (sql: string, args?: unknown[]) => {
          try {
            const result = await client.query(sql, args);
            if (sql.startsWith("SELECT p.id")) {
              reached();
              await continueEnd;
            }
            return result;
          } catch (error) {
            errors.push((error as { code?: string }).code ?? "unknown");
            throw error;
          }
        },
        release: (error?: Error) => client.release(error),
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  const ending = administratorEntry(scoped).end(f.token);
  try {
    await locked;
    const reading = staffEntryStore(pool).admit(entered.credential);
    await vi.waitFor(
      async () =>
        expect(
          (
            await pool.query<{ count: number }>(
              "SELECT count(*)::integer count FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))",
              [endingPid],
            )
          ).rows[0]!.count,
        ).toBeGreaterThan(0),
      { timeout: 2000 },
    );
    resume();
    const [ended, read] = await Promise.all([ending, reading]);
    expect({
      ending: ended.kind,
      read: read.kind,
      deadlocks: errors.filter((code) => code === "40P01").length,
    }).toEqual({ ending: "ready", read: "denied", deadlocks: 0 });
  } finally {
    resume();
    await ending;
  }
});

it("ADMINCON01/02 selects only minimal exact-account enrollment and billing summaries without exposing writing", async () => {
  const f = await fixture();
  const entered = await entry.enter(f.token);
  if (entered.kind !== "ready" || !entered.credential)
    throw Error("No current admin");
  const otherToken = randomBytes(32).toString("hex");
  await members.create(otherToken, {
    background: "professional",
    goal: "work",
  });
  const other = await members.session(otherToken);
  if (other.kind !== "active") throw Error("No second learner");
  await members.save(otherToken, {
    revision: 0,
    instruction: "PRIVATE CONSOLE SENTINEL",
    verification: "Not administrator content",
    complete: false,
  });
  const before = (await pool.query("SELECT count(*)::int AS n FROM principals"))
    .rows[0];
  const list = await entry.console!(entered.credential);
  expect(list.kind).toBe("ready");
  const selected = await entry.console!(entered.credential, other.learner.id);
  expect(selected).toMatchObject({
    kind: "ready",
    value: {
      selected: {
        member: {
          id: other.learner.id,
          background: "professional",
          goal: "work",
        },
        plans: [],
        invoices: [],
        enrollments: [],
      },
    },
  });
  expect(JSON.stringify(selected)).not.toContain("PRIVATE CONSOLE SENTINEL");
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM principals")).rows[0],
  ).toEqual(before);
  expect(await entry.console!(entered.credential, randomUUID())).toEqual({
    kind: "not-found",
  });
  expect(
    await invoices.adminOverview(entered.credential, other.learner.id),
  ).toMatchObject({
    kind: "ready",
    value: { members: [{ id: other.learner.id }] },
  });
  expect((await invoices.adminOverview(entered.credential, "wrong")).kind).toBe(
    "invalid",
  );
});
async function learners(count: number, name = "Invented learner") {
  const ids: string[] = [];
  for (let index = 1; index <= count; index++) {
    const token = randomBytes(32).toString("hex");
    await members.create(token, { background: "professional", goal: "work" });
    const session = await members.session(token);
    if (session.kind !== "active") throw Error("No invented learner");
    await pool.query("UPDATE learners SET display_name=$2 WHERE id=$1", [
      session.learner.id,
      `${name} ${String(index).padStart(2, "0")}`,
    ]);
    ids.push(session.learner.id);
  }
  return ids;
}
async function consoleAdmin() {
  const f = await fixture();
  await pool.query("UPDATE learners SET display_name='Zed Owner' WHERE id=$1", [
    f.id,
  ]);
  const entered = await entry.enter(f.token);
  if (entered.kind !== "ready" || !entered.credential)
    throw Error("No current admin");
  return { ...f, credential: entered.credential };
}
async function view(
  credential: string,
  ownerId?: string,
  options?: { page?: number; search?: string },
) {
  const result = await entry.console!(credential, ownerId, options);
  if (result.kind !== "ready") throw Error(result.kind);
  return result.value;
}
it("ADMINTABLE-01/02 pages learners by name with a total, clamping out-of-range pages", async () => {
  const admin = await consoleAdmin();
  await learners(59);
  const unnamed = randomBytes(32).toString("hex");
  await members.create(unnamed, { background: "explorer", goal: "everyday" });
  const first = await view(admin.credential);
  expect(first.total).toBe(61);
  expect(first.page).toBe(1);
  expect(first.pageSize).toBe(25);
  expect(first.members).toHaveLength(25);
  expect(first.members[0]!.displayName).toBe("Invented learner 01");
  expect(first.members[24]!.displayName).toBe("Invented learner 25");
  expect(first.members[0]!.joined).toBeInstanceOf(Date);
  const last = await view(admin.credential, undefined, { page: 3 });
  expect(last.page).toBe(3);
  expect(last.members.map((m) => m.displayName)).toEqual([
    ...Array.from(
      { length: 9 },
      (_, index) => `Invented learner ${51 + index}`,
    ),
    "Zed Owner",
    null,
  ]);
  const beyond = await view(admin.credential, undefined, { page: 900 });
  expect(beyond.page).toBe(3);
  expect(beyond.members).toEqual(last.members);
});
it("ADMINTABLE-03 searches part of a name case-insensitively or an exact reference, literally", async () => {
  const admin = await consoleAdmin();
  const [firstAda] = await learners(30, "Ada Lovelace");
  await learners(2, "Grace_Hopper");
  await learners(1, "Graceful");
  const named = await view(admin.credential, undefined, {
    search: "  lovelace  ",
  });
  expect(named.total).toBe(30);
  expect(named.search).toBe("lovelace");
  expect(named.members).toHaveLength(25);
  const paged = await view(admin.credential, undefined, {
    search: "lovelace",
    page: 2,
  });
  expect(paged.members).toHaveLength(5);
  const reference = await view(admin.credential, undefined, {
    search: firstAda!.toUpperCase(),
  });
  expect(reference.members.map((m) => m.id)).toEqual([firstAda]);
  // A wildcard typed by an administrator is ordinary text.
  const literal = await view(admin.credential, undefined, { search: "Grace_" });
  expect(literal.total).toBe(2);
  for (const search of ["%", "\\", "nobody"]) {
    const none = await view(admin.credential, undefined, { search });
    expect(none.total).toBe(0);
    expect(none.page).toBe(1);
    expect(none.members).toEqual([]);
  }
});
it("ADMINTABLE-04 keeps the page and search when selecting a learner from another page", async () => {
  const admin = await consoleAdmin();
  const ids = await learners(30);
  const chosen = ids[27]!;
  const selected = await view(admin.credential, chosen, { page: 2 });
  expect(selected.selected?.member.id).toBe(chosen);
  expect(selected.page).toBe(2);
  expect(selected.total).toBe(31);
  expect(selected.members).toHaveLength(6);
  const outside = await view(admin.credential, ids[0]!, {
    search: "Zed",
  });
  expect(outside.selected?.member.id).toBe(ids[0]);
  expect(outside.members.map((m) => m.displayName)).toEqual(["Zed Owner"]);
  expect(await entry.console!(admin.credential, randomUUID())).toEqual({
    kind: "not-found",
  });
});
it("ADMINCON04 denies learner, unbound, revoked, malformed and expired console authority", async () => {
  const f = await fixture(),
    entered = await entry.enter(f.token);
  if (entered.kind !== "ready" || !entered.credential)
    throw Error("No current admin");
  expect(await entry.console!(f.token)).toEqual({ kind: "denied" });
  expect(await entry.console!(entered.credential, "not-an-id")).toEqual({
    kind: "denied",
  });
  expect(await entry.end(f.token)).toEqual({ kind: "ready" });
  expect(await entry.console!(entered.credential, f.id)).toEqual({
    kind: "denied",
  });
  const legacy = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    legacy,
    "platform_admin",
    new Date(Date.now() + 60000),
  );
  expect(await entry.console!(legacy)).toEqual({ kind: "denied" });
  const g = await fixture("tom@deepnative.io"),
    second = await entry.enter(g.token);
  if (second.kind !== "ready" || !second.credential)
    throw Error("No second admin");
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
    [hash(second.credential)],
  );
  expect(await entry.console!(second.credential)).toEqual({ kind: "denied" });
});
