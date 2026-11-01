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
    expect(+r.expires).toBeLessThanOrEqual(Date.now() + 8 * 3600000);
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
