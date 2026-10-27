import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import {
  memberEmailAccess,
  normalizedEmail,
} from "../../src/member-email-access.ts";
import { hash, migrate, store } from "../../src/store.ts";

const root = new URL(
  process.env.DNE_DATABASE_URL ??
    "postgresql://dne:local-preview-only@127.0.0.1:54329/dne_dev",
);
const name = `dne_test_${randomBytes(16).toString("hex")}`;
const admin = new Pool({
  connectionString: root.toString(),
  connectionTimeoutMillis: 3000,
});
const scoped = new URL(root);
scoped.pathname = `/${name}`;
const pool = new Pool({
  connectionString: scoped.toString(),
  connectionTimeoutMillis: 3000,
});
const members = store(pool);
const sent: { address: string; link: string }[] = [];
let failSend = false;
const sender = {
  async send(address: string, link: string) {
    if (failSend) throw Error("Private provider failure");
    sent.push({ address, link });
  },
};
const access = memberEmailAccess(pool, sender, "https://engine.deepnative.io");

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  await migrate(pool);
});
beforeEach(async () => {
  sent.length = 0;
  failSend = false;
  await pool.query("TRUNCATE principals CASCADE");
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
});

async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Member fixture unavailable");
  return { token, id: session.learner.id };
}
function code() {
  return new URL(sent.at(-1)!.link).searchParams.get("code")!;
}

it("normalizes one bounded address without retaining its original case", () => {
  expect(normalizedEmail("  MEMBER@Example.COM ")).toBe("member@example.com");
  expect(normalizedEmail("not-an-email")).toBeNull();
  expect(normalizedEmail(`${"a".repeat(65)}@example.com`)).toBeNull();
  expect(normalizedEmail(`${"a".repeat(240)}@example.com`)).toBeNull();
});

it("links by proof of email possession and signs in the same saved member without merging workspaces", async () => {
  const owner = await member();
  const other = await member();
  await members.save(owner.id, {
    instruction: "Invented plan",
    verification: "Check invented result",
    complete: true,
  });
  expect(await access.requestAttach(owner.token, " MEMBER@example.com ")).toBe(
    "sent",
  );
  expect(sent[0]?.address).toBe("member@example.com");
  expect(
    await pool.query("SELECT 1 FROM member_email_identities"),
  ).toHaveProperty("rowCount", 0);
  const attachCode = code();
  expect(await access.consume(attachCode)).toEqual({ kind: "attached" });
  expect(await access.consume(attachCode)).toEqual({ kind: "unavailable" });
  expect(await access.requestAttach(other.token, "member@example.com")).toBe(
    "unavailable",
  );
  expect(await access.requestAttach(owner.token, "another@example.com")).toBe(
    "unavailable",
  );
  await access.requestSignIn("MEMBER@example.com");
  const result = await access.consume(code());
  expect(result.kind).toBe("signed_in");
  if (result.kind !== "signed_in") throw Error("Sign in unavailable");
  expect(await members.session(result.token!)).toMatchObject({
    kind: "active",
    learner: { id: owner.id },
  });
  expect((await members.session(owner.token)).kind).not.toBe("active");
  expect(await members.progress(owner.id)).toMatchObject({
    instruction: "Invented plan",
  });
  expect((await members.session(other.token)).kind).toBe("active");
});

it("keeps an email link available when another active member tries to confirm it", async () => {
  const owner = await member();
  const other = await member();
  expect(await access.requestAttach(owner.token, "owner@example.com")).toBe(
    "sent",
  );
  const attachCode = code();
  expect(await access.consume(attachCode, other.token)).toEqual({
    kind: "unavailable",
  });
  expect(
    (await pool.query("SELECT 1 FROM member_email_identities")).rowCount,
  ).toBe(0);
  expect(await access.consume(attachCode, owner.token)).toEqual({
    kind: "attached",
  });

  await access.requestSignIn("owner@example.com");
  const signInCode = code();
  expect(await access.consume(signInCode, other.token)).toEqual({
    kind: "unavailable",
  });
  const returned = await access.consume(signInCode, "f".repeat(64));
  expect(returned.kind).toBe("signed_in");
  expect((await members.session(returned.token!)).kind).toBe("active");
  expect((await members.session(other.token)).kind).toBe("active");
});

it("EMAIL-ACCESS-04 preserves the first link and sends once for concurrent duplicate requests", async () => {
  const owner = await member();
  const attempts = await Promise.all(
    Array.from({ length: 6 }, () =>
      access.requestAttach(owner.token, "member@example.com"),
    ),
  );
  expect(attempts.filter((result) => result === "sent")).toHaveLength(1);
  expect(sent).toHaveLength(1);
  expect(await access.consume(code(), owner.token)).toEqual({
    kind: "attached",
  });
  await Promise.all(
    Array.from({ length: 6 }, () => access.requestSignIn("member@example.com")),
  );
  expect(sent).toHaveLength(2);
  expect((await access.consume(code())).kind).toBe("signed_in");
});

it("EMAIL-ACCESS-04 replaces a changed address or expired sign-in link without reviving old links", async () => {
  const owner = await member();
  expect(await access.requestAttach(owner.token, "first@example.com")).toBe(
    "sent",
  );
  const firstAttach = code();
  expect(await access.requestAttach(owner.token, "second@example.com")).toBe(
    "sent",
  );
  const secondAttach = code();
  expect(await access.consume(firstAttach, owner.token)).toEqual({
    kind: "unavailable",
  });
  expect(await access.consume(secondAttach, owner.token)).toEqual({
    kind: "attached",
  });

  await access.requestSignIn("second@example.com");
  const firstSignIn = code();
  await pool.query(
    "UPDATE member_email_links SET created_at=clock_timestamp()-INTERVAL '20 minutes', expires_at=clock_timestamp()-INTERVAL '5 minutes' WHERE token_hash=$1",
    [hash(firstSignIn)],
  );
  await access.requestSignIn("second@example.com");
  const secondSignIn = code();
  expect(await access.consume(firstSignIn)).toEqual({ kind: "unavailable" });
  expect((await access.consume(secondSignIn)).kind).toBe("signed_in");
});

it("does not disclose unknown addresses or issue a link for an invalid, expired or deleted member", async () => {
  const owner = await member();
  expect(await access.requestAttach("f".repeat(64), "member@example.com")).toBe(
    "unavailable",
  );
  expect(await access.requestAttach(owner.token, "bad address")).toBe(
    "unavailable",
  );
  await access.requestSignIn("unknown@example.com");
  await access.requestSignIn("bad address");
  expect(sent).toHaveLength(0);
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [owner.id],
  );
  expect(await access.requestAttach(owner.token, "member@example.com")).toBe(
    "unavailable",
  );
  await pool.query("UPDATE principals SET revoked_at=NULL WHERE id=$1", [
    owner.id,
  ]);
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
    [owner.id],
  );
  expect(await access.requestAttach(owner.token, "member@example.com")).toBe(
    "unavailable",
  );
});

it("limits outgoing links and invalidates failed sends and expired links", async () => {
  const owner = await member();
  failSend = true;
  expect(await access.requestAttach(owner.token, "member@example.com")).toBe(
    "unavailable",
  );
  expect(
    (
      await pool.query(
        "SELECT 1 FROM member_email_links WHERE consumed_at IS NOT NULL",
      )
    ).rowCount,
  ).toBe(1);
  failSend = false;
  for (let i = 0; i < 4; i++) {
    await pool.query(
      "UPDATE member_email_links SET created_at=clock_timestamp()-INTERVAL '20 minutes', expires_at=clock_timestamp()-INTERVAL '5 minutes'",
    );
    expect(await access.requestAttach(owner.token, "member@example.com")).toBe(
      "sent",
    );
  }
  await pool.query(
    "UPDATE member_email_links SET created_at=clock_timestamp()-INTERVAL '20 minutes', expires_at=clock_timestamp()-INTERVAL '5 minutes'",
  );
  expect(await access.requestAttach(owner.token, "member@example.com")).toBe(
    "unavailable",
  );
  const expired = code();
  await pool.query(
    "UPDATE member_email_links SET created_at=clock_timestamp()-INTERVAL '20 minutes', expires_at=clock_timestamp()-INTERVAL '5 minutes' WHERE token_hash=$1",
    [hash(expired)],
  );
  expect(await access.consume(expired)).toEqual({ kind: "unavailable" });
  expect(await access.consume("bad")).toEqual({ kind: "unavailable" });
  expect(await access.consume("f".repeat(64))).toEqual({ kind: "unavailable" });
});

it("rejects a sign-in link after its identity or principal is removed", async () => {
  const owner = await member();
  await access.requestAttach(owner.token, "member@example.com");
  const first = code();
  await pool.query(
    "INSERT INTO member_email_identities(email_hash,principal_id) SELECT email_hash,principal_id FROM member_email_links WHERE token_hash=$1",
    [hash(first)],
  );
  expect(await access.consume(first)).toEqual({ kind: "unavailable" });
  await access.requestSignIn("member@example.com");
  const second = code();
  await pool.query(
    "DELETE FROM member_email_identities WHERE principal_id=$1",
    [owner.id],
  );
  expect(await access.consume(second)).toEqual({ kind: "unavailable" });
  await pool.query(
    "INSERT INTO member_email_identities(email_hash,principal_id) SELECT email_hash,principal_id FROM member_email_links WHERE token_hash=$1",
    [hash(first)],
  );
  await access.requestSignIn("member@example.com");
  const third = code();
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [owner.id],
  );
  const priorMessages = sent.length;
  await access.requestSignIn("member@example.com");
  expect(sent).toHaveLength(priorMessages);
  expect(await access.consume(third)).toEqual({ kind: "unavailable" });
});

it("rolls back a failed database read and releases its client", async () => {
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM principals")) throw Error("read failed");
    return { rows: [], rowCount: 0 };
  });
  const broken = {
    connect: async () => ({ query, release }),
  } as unknown as Pool;
  const trial = memberEmailAccess(
    broken,
    sender,
    "https://engine.deepnative.io",
  );
  await expect(
    trial.requestAttach("a".repeat(64), "member@example.com"),
  ).rejects.toThrow("read failed");
  expect(query).toHaveBeenCalledWith("ROLLBACK");
  expect(release).toHaveBeenCalledOnce();
});

it("releases a transaction client when rollback itself fails", async () => {
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (sql === "ROLLBACK") throw Error("rollback failed");
    if (sql.includes("FROM principals")) throw Error("read failed");
    return { rows: [], rowCount: 0 };
  });
  const broken = {
    connect: async () => ({ query, release }),
  } as unknown as Pool;
  const trial = memberEmailAccess(
    broken,
    sender,
    "https://engine.deepnative.io",
  );
  await expect(
    trial.requestAttach("a".repeat(64), "member@example.com"),
  ).rejects.toThrow("read failed");
  expect(release).toHaveBeenCalledOnce();
});

it("EMAIL-ACCESS-05A/05C/05D reports only an active owner's binding and fails closed after deletion or expiry", async () => {
  const owner = await member(),
    other = await member();
  expect(await access.ownedStatus(owner.token)).toBe("unlinked");
  await access.requestAttach(owner.token, "owned-status@example.com");
  await access.consume(code(), owner.token);
  expect(await access.ownedStatus(owner.token)).toBe("linked");
  expect(await access.ownedStatus(other.token)).toBe("unlinked");
  expect(await access.ownedStatus("unknown")).toBe("unavailable");
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [owner.id],
  );
  expect(await access.ownedStatus(owner.token)).toBe("unavailable");
  await members.remove(other.id);
  expect(await access.ownedStatus(other.token)).toBe("unavailable");
});

it("EMAIL-ACCESS-05D returns unavailable after an ownership read failure without exposing its private details", async () => {
  const broken = {
    query: vi.fn().mockRejectedValue(new Error("private database identity")),
  } as unknown as Pool;
  const trial = memberEmailAccess(
    broken,
    sender,
    "https://engine.deepnative.io",
  );
  expect(await trial.ownedStatus("a".repeat(64))).toBe("unavailable");
  expect(sent).toHaveLength(0);
});

it("MOUT-01/02 invalidates both copies of the current bearer while preserving same-account recovery and saved work", async () => {
  const owner = await member(),
    other = await member();
  await members.save(owner.id, {
    instruction: "Synthetic saved plan",
    verification: "Synthetic checks",
    complete: true,
  });
  await access.requestAttach(owner.token, "signout@example.com");
  await access.consume(code(), owner.token);
  await access.requestSignIn("signout@example.com");
  const pending = code();
  const before = (
    await pool.query("SELECT id,expires_at FROM principals WHERE id=$1", [
      owner.id,
    ])
  ).rows[0];
  const workspace = (
    await pool.query("SELECT id FROM workspaces WHERE owner_principal_id=$1", [
      owner.id,
    ])
  ).rows[0];
  const sends = sent.length;
  expect(await access.signOut(owner.token)).toBe("signed_out");
  expect(await access.signOut(owner.token)).toBe("unavailable");
  expect(sent).toHaveLength(sends);
  expect((await members.session(owner.token)).kind).not.toBe("active");
  const hashes = (
    await pool.query(
      "SELECT p.token_hash,p.revoked_at,p.expires_at,l.token_hash AS learner_hash FROM principals p JOIN learners l ON l.id=p.id WHERE p.id=$1",
      [owner.id],
    )
  ).rows[0];
  expect(hashes.token_hash).toBe(hashes.learner_hash);
  expect(hashes.token_hash).not.toBe(hash(owner.token));
  expect(hashes.revoked_at).toBeNull();
  expect(hashes.expires_at).toEqual(before.expires_at);
  const returned = await access.consume(pending);
  expect(returned.kind).toBe("signed_in");
  expect(await members.session(returned.token!)).toMatchObject({
    kind: "active",
    learner: { id: owner.id },
  });
  expect(
    (
      await pool.query(
        "SELECT id FROM workspaces WHERE owner_principal_id=$1",
        [owner.id],
      )
    ).rows[0],
  ).toEqual(workspace);
  expect(await members.progress(owner.id)).toMatchObject({
    instruction: "Synthetic saved plan",
  });
  expect((await members.session(other.token)).kind).toBe("active");
  expect((await members.session(owner.token)).kind).not.toBe("active");
});

it("MOUT-03 requires a verified identity, not a pending link, before invalidating access", async () => {
  const owner = await member();
  expect(await access.signOut(owner.token)).toBe("recovery_required");
  await access.requestAttach(owner.token, "pending@example.com");
  expect(await access.signOut(owner.token)).toBe("recovery_required");
  expect((await members.session(owner.token)).kind).toBe("active");
});

it.each(["expired", "revoked", "staff", "deleting", "deleted"])(
  "MOUT-04 refuses %s authority without touching another member",
  async (state) => {
    const owner = await member(),
      other = await member();
    await access.requestAttach(owner.token, "denied@example.com");
    await access.consume(code(), owner.token);
    if (state === "expired")
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [owner.id],
      );
    if (state === "revoked")
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [owner.id],
      );
    if (state === "staff") {
      await members.remove(owner.id);
      await pool.query(
        "INSERT INTO principals(id,kind,token_hash,expires_at) VALUES($1,'staff',$2,clock_timestamp()+interval '1 day')",
        [owner.id, hash(owner.token)],
      );
    }
    if (state === "deleting")
      await pool.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [owner.id],
      );
    if (state === "deleted") await members.remove(owner.id);
    expect(await access.signOut(owner.token)).toBe("unavailable");
    expect((await members.session(other.token)).kind).toBe("active");
    expect(
      (
        await pool.query("SELECT token_hash FROM principals WHERE id=$1", [
          owner.id,
        ])
      ).rows[0]?.token_hash,
    ).toBe(state === "deleted" ? undefined : hash(owner.token));
  },
);

it("MOUT-04 rechecks expiry after dependent locking before changing either bearer", async () => {
  const owner = await member();
  await access.requestAttach(owner.token, "expiry@example.com");
  await access.consume(code(), owner.token);
  const boundary = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (
            sql.includes("member_email_identities") &&
            sql.includes("FOR UPDATE")
          ) {
            await client.query(
              "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
              [owner.id],
            );
          }
          return result;
        },
        release: (error?: Error) => client.release(error),
      };
    },
  } as unknown as Pool;
  expect(
    await memberEmailAccess(
      boundary,
      sender,
      "https://engine.deepnative.io",
    ).signOut(owner.token),
  ).toBe("unavailable");
  expect(
    (
      await pool.query("SELECT token_hash FROM principals WHERE id=$1", [
        owner.id,
      ])
    ).rows[0].token_hash,
  ).toBe(hash(owner.token));
});

it.each(["write", "commit"])(
  "MOUT-06 reports uncertain %s failure without replay and preserves inspectable native state",
  async (failure) => {
    const owner = await member();
    await access.requestAttach(owner.token, "failure@example.com");
    await access.consume(code(), owner.token);
    let commits = 0;
    let releases = 0;
    let discarded = false;
    const boundary = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            if (failure === "write" && sql.startsWith("UPDATE learners"))
              throw Error("synthetic write failure");
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              commits++;
              throw Error("synthetic acknowledgement loss");
            }
            return result;
          },
          release(error?: Error) {
            releases++;
            discarded = Boolean(error);
            client.release(error);
          },
        };
      },
    } as unknown as Pool;
    await expect(
      memberEmailAccess(
        boundary,
        sender,
        "https://engine.deepnative.io",
      ).signOut(owner.token),
    ).rejects.toThrow("synthetic");
    expect(commits).toBe(failure === "commit" ? 1 : 0);
    expect(releases).toBe(1);
    expect(discarded).toBe(failure === "commit");
    expect((await members.session(owner.token)).kind === "active").toBe(
      failure === "write",
    );
    await access.requestSignIn("failure@example.com");
    const returned = await access.consume(code());
    expect(await members.session(returned.token!)).toMatchObject({
      kind: "active",
      learner: { id: owner.id },
    });
  },
);
