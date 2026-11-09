import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import {
  memberEmailAccess,
  normalizedEmail,
  emailHash,
} from "../../src/member-email-access.ts";
import { hash, migrate, store } from "../../src/store.ts";
import { memberExportStore } from "../../src/member-export.ts";

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
  await members.save(owner.token, {
    revision: 0,
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

it("EMAIL-DIAG-01 logs one content-free outcome for each request and hides provider detail", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const owner = await member();
    const other = await member();
    const address = "diagnosed@example.com";
    await access.requestSignIn(address);
    expect(await access.requestAttach(owner.token, "not an address")).toBe(
      "unavailable",
    );
    expect(await access.requestAttach("0".repeat(64), address)).toBe(
      "unavailable",
    );
    expect(await access.requestAttach(owner.token, address)).toBe("sent");
    expect(await access.requestAttach(owner.token, address)).toBe(
      "unavailable",
    );
    await access.consume(
      new URL(sent.at(-1)!.link).searchParams.get("code")!,
      owner.token,
    );
    expect(await access.requestAttach(other.token, address)).toBe(
      "unavailable",
    );
    const outcomes = () =>
      info.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(outcomes()).toEqual(
      [
        ["sign_in", "not_bound"],
        ["attach", "invalid_address"],
        ["attach", "member_unavailable"],
        ["attach", "sent"],
        ["attach", "pending"],
        ["attach", "already_bound"],
      ].map(([purpose, outcome]) => ({
        event: "member_email_request",
        purpose,
        outcome,
      })),
    );

    const limited = await member();
    for (let index = 0; index < 5; index++) {
      expect(
        await access.requestAttach(limited.token, `l${index}@example.com`),
      ).toBe("sent");
    }
    expect(await access.requestAttach(limited.token, "l5@example.com")).toBe(
      "unavailable",
    );
    expect(outcomes().at(-1)).toEqual({
      event: "member_email_request",
      purpose: "attach",
      outcome: "rate_limited",
    });

    const failing = await member();
    for (const [thrown, expected] of [
      [
        Object.assign(new TypeError("private failed@example.com detail"), {
          code: "EmailDroppedAllRecipientsSuppressed",
        }),
        {
          errorName: "TypeError",
          errorCode: "EmailDroppedAllRecipientsSuppressed",
        },
      ],
      [
        Object.assign(new Error("private"), {
          code: "has spaces and failed@example.com",
        }),
        { errorName: "Error" },
      ],
      ["a private string failure", {}],
      [Object.assign(new Error("private"), { name: "not one word" }), {}],
    ] as const) {
      const quiet = memberEmailAccess(
        pool,
        {
          async send() {
            throw thrown;
          },
        },
        "https://engine.deepnative.io",
      );
      expect(
        await quiet.requestAttach(failing.token, "failed@example.com"),
      ).toBe("unavailable");
      expect(JSON.parse(String(error.mock.calls.at(-1)![0]))).toEqual({
        event: "member_email_request",
        purpose: "attach",
        outcome: "send_failed",
        ...expected,
      });
      await pool.query("DELETE FROM member_email_links WHERE principal_id=$1", [
        failing.id,
      ]);
    }
    const written = JSON.stringify([info.mock.calls, error.mock.calls]);
    for (const secret of [
      "@example.com",
      "private",
      owner.id,
      failing.id,
      owner.token,
    ])
      expect(written).not.toContain(secret);
    expect(written).not.toMatch(/[a-f0-9]{64}/);
  } finally {
    info.mockRestore();
    error.mockRestore();
  }
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
  await members.save(owner.token, {
    revision: 0,
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

it("NAV-03 deliberately signs out without an email provider and preserves saved records", async () => {
  const owner = await member(),
    other = await member();
  await members.save(owner.token, {
    revision: 0,
    instruction: "Keep my private plan",
    verification: "Invented evidence",
    complete: false,
  });
  expect(await access.signOut(owner.token)).toBe("recovery_required");
  expect((await members.session(owner.token)).kind).toBe("active");
  expect(await access.signOut(owner.token, true)).toBe("signed_out");
  expect((await members.session(owner.token)).kind).not.toBe("active");
  expect(await members.progress(owner.id)).toMatchObject({
    instruction: "Keep my private plan",
  });
  expect((await members.session(other.token)).kind).toBe("active");
  expect(sent).toHaveLength(0);
});

describe("no-account notice (#665)", () => {
  const notices: { address: string; link: string }[] = [];
  let failNotice = false;
  const noticing = memberEmailAccess(
    pool,
    {
      ...sender,
      async sendNoAccount(address: string, link: string) {
        if (failNotice) throw Error("Private provider failure");
        notices.push({ address, link });
      },
    },
    "https://engine.deepnative.io",
  );
  beforeEach(async () => {
    notices.length = 0;
    failNotice = false;
    await pool.query(
      "TRUNCATE member_email_notices, member_email_notice_visitors",
    );
  });
  const visitor = (key: string) => ({ key, scope: "public" as const });
  const outcomes = (info: { mock: { calls: unknown[][] } }) =>
    info.mock.calls.map((call) => JSON.parse(String(call[0])).outcome);

  it("NOTICE-RETAIN-01 deletes notices older than 30 days when a new notice is recorded", async () => {
    await noticing.requestSignIn("old@example.com");
    await noticing.requestSignIn("recent@example.com");
    await pool.query(
      "UPDATE member_email_notices SET created_at=clock_timestamp()-INTERVAL '31 days' WHERE email_hash=$1",
      [emailHash("old@example.com")],
    );
    await pool.query(
      "UPDATE member_email_notices SET created_at=clock_timestamp()-INTERVAL '29 days' WHERE email_hash=$1",
      [emailHash("recent@example.com")],
    );
    await noticing.requestSignIn("new@example.com");
    const kept = await pool.query<{ email_hash: string }>(
      "SELECT email_hash FROM member_email_notices",
    );
    expect(kept.rows.map((row) => row.email_hash).sort()).toEqual(
      ["recent@example.com", "new@example.com"].map(emailHash).sort(),
    );
  });

  it("NOACCOUNT-01 tells an unused address how to start, and sends linked addresses their link", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await noticing.requestSignIn("  New.Person@Example.com ");
      expect(notices).toEqual([
        {
          address: "new.person@example.com",
          link: "https://engine.deepnative.io/",
        },
      ]);
      expect(sent).toHaveLength(0);
      expect(
        (await pool.query("SELECT 1 FROM member_email_links")).rowCount,
      ).toBe(0);
      const owner = await member();
      expect(
        await noticing.requestAttach(owner.token, "kept@example.com"),
      ).toBe("sent");
      await noticing.consume(code(), owner.token);
      await noticing.requestSignIn("kept@example.com");
      expect(sent).toHaveLength(2);
      expect(notices).toHaveLength(1);
      expect(outcomes(info)).toEqual(["no_account_notice", "sent", "sent"]);
    } finally {
      info.mockRestore();
    }
  });

  it("NOACCOUNT-02 limits notices per address and site-wide", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await noticing.requestSignIn("repeat@example.com");
      await noticing.requestSignIn("repeat@example.com");
      expect(notices).toHaveLength(1);
      expect(outcomes(info)).toEqual([
        "no_account_notice",
        "no_account_limited",
      ]);
      await pool.query(
        "UPDATE member_email_notices SET created_at=clock_timestamp()-INTERVAL '61 minutes'",
      );
      await noticing.requestSignIn("repeat@example.com");
      expect(notices).toHaveLength(2);
      for (let index = 0; index < 25; index++)
        await noticing.requestSignIn(
          `flood${index}@example.com`,
          visitor(`198.51.100.${index}`),
        );
      // 20 per hour in all: the repeat plus 19 others. The expired first
      // notice no longer counts.
      expect(notices).toHaveLength(21);
      expect(outcomes(info).at(-1)).toBe("no_account_limited");
    } finally {
      info.mockRestore();
    }
  });

  it("NOTICE-VISITOR-01/02 limits one visitor to three notices an hour without blocking others", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      for (let index = 0; index < 5; index++)
        await noticing.requestSignIn(
          `stranger${index}@example.com`,
          visitor("203.0.113.9"),
        );
      expect(notices).toHaveLength(3);
      expect(outcomes(info)).toEqual([
        "no_account_notice",
        "no_account_notice",
        "no_account_notice",
        "no_account_visitor_limited",
        "no_account_visitor_limited",
      ]);
      await noticing.requestSignIn(
        "stranger9@example.com",
        visitor("203.0.113.10"),
      );
      expect(notices).toHaveLength(4);
    } finally {
      info.mockRestore();
    }
  });

  it("NOTICE-VISITOR-01 allows a visitor more notices after the hour", async () => {
    for (let index = 0; index < 4; index++)
      await noticing.requestSignIn(
        `later${index}@example.com`,
        visitor("203.0.113.9"),
      );
    expect(notices).toHaveLength(3);
    await pool.query(
      "UPDATE member_email_notice_visitors SET created_at=clock_timestamp()-INTERVAL '61 minutes'",
    );
    await noticing.requestSignIn("later9@example.com", visitor("203.0.113.9"));
    expect(notices).toHaveLength(4);
  });

  it("NOTICE-VISITOR-04 stores only a keyed hash, unlinked to the inbox, and deletes it after the hour", async () => {
    await noticing.requestSignIn("kept@example.com", visitor("203.0.113.9"));
    await noticing.requestSignIn("old@example.com", visitor("203.0.113.10"));
    await pool.query(
      `UPDATE member_email_notice_visitors SET created_at=clock_timestamp()-INTERVAL '61 minutes'
       WHERE id=(SELECT max(id) FROM member_email_notice_visitors)`,
    );
    const stored = await pool.query<{ visitor_hash: string }>(
      "SELECT visitor_hash FROM member_email_notice_visitors ORDER BY id",
    );
    const [first] = stored.rows.map((row) => row.visitor_hash);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(emailHash("203.0.113.9"));
    expect(JSON.stringify(stored.rows)).not.toContain("203.0.113");
    expect(
      (
        await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='member_email_notice_visitors' ORDER BY ordinal_position",
        )
      ).rows.map((row) => row.column_name),
    ).toEqual(["id", "visitor_hash", "created_at"]);

    // A refused request still clears what has aged out.
    await pool.query("TRUNCATE member_email_notices");
    await pool.query(
      "INSERT INTO member_email_notices(email_hash) SELECT $1 FROM generate_series(1,20)",
      [emailHash("full@example.com")],
    );
    await noticing.requestSignIn("late@example.com", visitor("203.0.113.11"));
    const left = await pool.query<{ visitor_hash: string }>(
      "SELECT visitor_hash FROM member_email_notice_visitors",
    );
    expect(left.rows.map((row) => row.visitor_hash)).toEqual([first]);

    // Another process has its own key, so the same address hashes differently.
    await pool.query(
      "TRUNCATE member_email_notices, member_email_notice_visitors",
    );
    const restarted = memberEmailAccess(
      pool,
      { ...sender, async sendNoAccount() {} },
      "https://engine.deepnative.io",
    );
    await restarted.requestSignIn("again@example.com", visitor("203.0.113.9"));
    expect(
      (
        await pool.query(
          "SELECT visitor_hash FROM member_email_notice_visitors",
        )
      ).rows[0].visitor_hash,
    ).not.toBe(first);
  });

  it("NOTICE-VISITOR-05 does not count a notice that failed to send", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      failNotice = true;
      for (let index = 0; index < 4; index++)
        await noticing.requestSignIn(
          `failing${index}@example.com`,
          visitor("203.0.113.9"),
        );
      expect(
        (await pool.query("SELECT 1 FROM member_email_notice_visitors"))
          .rowCount,
      ).toBe(0);
      failNotice = false;
      await noticing.requestSignIn("works@example.com", visitor("203.0.113.9"));
      expect(notices).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  it("NOTICE-VISITOR-06 counts requests without a known visitor as one", async () => {
    for (let index = 0; index < 5; index++)
      await noticing.requestSignIn(`nobody${index}@example.com`);
    expect(notices).toHaveLength(3);
  });

  it("NOTICE-VISITOR-07 still sends a linked address its sign-in link at the limit", async () => {
    const owner = await member();
    await noticing.requestAttach(owner.token, "linked@example.com");
    await noticing.consume(code(), owner.token);
    sent.length = 0;
    for (let index = 0; index < 4; index++)
      await noticing.requestSignIn(
        `limit${index}@example.com`,
        visitor("203.0.113.9"),
      );
    await noticing.requestSignIn("linked@example.com", visitor("203.0.113.9"));
    expect(notices).toHaveLength(3);
    expect(sent.map((message) => message.address)).toEqual([
      "linked@example.com",
    ]);
  });

  it("NOTICE-VISITOR-10 logs the kind of address, never the address or its hash", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await noticing.requestSignIn(
        "scope1@example.com",
        visitor("203.0.113.9"),
      );
      await noticing.requestSignIn("scope2@example.com", {
        key: "10.0.0.4",
        scope: "private",
      });
      await noticing.requestSignIn("scope3@example.com");
      for (let index = 0; index < 3; index++)
        await noticing.requestSignIn(
          `scope1${index}@example.com`,
          visitor("203.0.113.9"),
        );
      const lines = info.mock.calls.map((call) => String(call[0]));
      expect(lines.slice(0, 3).map((line) => JSON.parse(line))).toEqual(
        ["public", "private", "unknown"].map((visitorScope) => ({
          event: "member_email_request",
          purpose: "sign_in",
          outcome: "no_account_notice",
          visitorScope,
        })),
      );
      expect(JSON.parse(lines.at(-1)!)).toEqual({
        event: "member_email_request",
        purpose: "sign_in",
        outcome: "no_account_visitor_limited",
        visitorScope: "public",
      });
      const stored = await pool.query<{ visitor_hash: string }>(
        "SELECT visitor_hash FROM member_email_notice_visitors",
      );
      for (const line of lines) {
        expect(line).not.toContain("203.0.113");
        expect(line).not.toContain("10.0.0.4");
        for (const { visitor_hash } of stored.rows)
          expect(line).not.toContain(visitor_hash);
      }
    } finally {
      info.mockRestore();
    }
  });

  it("NOACCOUNT-02 frees the limit after a failed notice and logs the failure", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      failNotice = true;
      await noticing.requestSignIn("failed@example.com");
      expect(JSON.parse(String(error.mock.calls[0]![0]))).toEqual({
        event: "member_email_request",
        purpose: "sign_in",
        outcome: "send_failed",
        errorName: "Error",
      });
      failNotice = false;
      await noticing.requestSignIn("failed@example.com");
      expect(notices).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  it("NOACCOUNT-01 keeps the old silent behaviour for a sender without notices", async () => {
    await access.requestSignIn("silent@example.com");
    expect(sent).toHaveLength(0);
    expect(
      (await pool.query("SELECT 1 FROM member_email_notices")).rowCount,
    ).toBe(0);
  });
});

const addresses = async (
  table: "member_email_links" | "member_email_identities",
  id: string,
) =>
  (
    await pool.query<{ address: string | null }>(
      table === "member_email_links"
        ? "SELECT address FROM member_email_links WHERE principal_id=$1 ORDER BY created_at"
        : "SELECT address FROM member_email_identities WHERE principal_id=$1",
      [id],
    )
  ).rows.map((row) => row.address);

it("SIGNEMAIL-01 keeps a verified address readable on the member's own identity and drops it from the used link", async () => {
  const m = await member();
  expect(await access.requestAttach(m.token, " Member@Example.COM ")).toBe(
    "sent",
  );
  // The waiting link holds the address only until it is used.
  expect(await addresses("member_email_links", m.id)).toEqual([
    "member@example.com",
  ]);
  expect((await access.consume(code(), m.token)).kind).toBe("attached");
  expect(await addresses("member_email_identities", m.id)).toEqual([
    "member@example.com",
  ]);
  expect(await addresses("member_email_links", m.id)).toEqual([null]);
  // The fingerprint is unchanged, and the next sign-in still works.
  expect(
    (
      await pool.query(
        "SELECT email_hash FROM member_email_identities WHERE principal_id=$1",
        [m.id],
      )
    ).rows,
  ).toEqual([{ email_hash: emailHash("member@example.com") }]);
  // The member's own records include the address.
  const records: Record<string, unknown[]> = {};
  let cursor: string | undefined;
  do {
    const r = await memberExportStore(pool).exportOwned(m.token, cursor);
    if (r.kind !== "ready") throw Error("Export unavailable");
    for (const [key, rows] of Object.entries(r.payload.records))
      records[key] = [...(records[key] ?? []), ...rows];
    cursor = r.payload.page.nextCursor ?? undefined;
  } while (cursor);
  expect(records.signInEmail).toEqual([
    { address: "member@example.com", verifiedAt: expect.any(Date) },
  ]);
  await access.requestSignIn("member@example.com");
  expect((await access.consume(code())).kind).toBe("signed_in");
});

it("SIGNEMAIL-02 fills an existing member's address at their next email sign-in, including a verified sign-up claim", async () => {
  const m = await member();
  await pool.query(
    "INSERT INTO member_email_identities(email_hash,principal_id) VALUES($1,$2)",
    [emailHash("old@example.com"), m.id],
  );
  expect(await addresses("member_email_identities", m.id)).toEqual([null]);
  await access.requestSignIn("OLD@example.com");
  const signedIn = await access.consume(code());
  expect(signedIn.kind).toBe("signed_in");
  expect((await members.session(signedIn.token!)).kind).toBe("active");
  expect(await addresses("member_email_identities", m.id)).toEqual([
    "old@example.com",
  ]);
  expect(await addresses("member_email_links", m.id)).toEqual([null]);
  const claimed = await member();
  await pool.query(
    "INSERT INTO member_login_emails(email_hash,principal_id) VALUES($1,$2)",
    [emailHash("claim@example.com"), claimed.id],
  );
  await access.requestSignIn("claim@example.com");
  expect((await access.consume(code())).kind).toBe("signed_in");
  expect(await addresses("member_email_identities", claimed.id)).toEqual([
    "claim@example.com",
  ]);
});

it("SIGNEMAIL-03 clears an expired unused link's address at later email activity, and removes the address with the account", async () => {
  const m = await member();
  await access.requestAttach(m.token, "late@example.com");
  await pool.query(
    "UPDATE member_email_links SET expires_at=created_at+INTERVAL '1 microsecond' WHERE principal_id=$1",
    [m.id],
  );
  await access.requestSignIn("nobody-here@example.com");
  expect(await addresses("member_email_links", m.id)).toEqual([null]);
  const kept = await member();
  await access.requestAttach(kept.token, "kept@example.com");
  await access.consume(code(), kept.token);
  await members.remove(kept.id);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM member_email_identities WHERE address='kept@example.com'",
      )
    ).rowCount,
  ).toBe(0);
});

it("SIGNEMAIL-04 never writes the readable address to logs", async () => {
  const lines: unknown[] = [];
  const spies = (["info", "log", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args) => {
      lines.push(args);
    }),
  );
  try {
    const m = await member();
    await access.requestAttach(m.token, "quiet@example.com");
    await access.consume(code(), m.token);
    await access.requestSignIn("quiet@example.com");
    await access.consume(code());
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  expect(JSON.stringify(lines)).not.toContain("quiet@example.com");
});

it("SIGNEMAIL-02 a link sent before #796 still signs in and leaves the address as it was", async () => {
  const m = await member();
  await pool.query(
    "INSERT INTO member_email_identities(email_hash,principal_id) VALUES($1,$2)",
    [emailHash("before@example.com"), m.id],
  );
  await access.requestSignIn("before@example.com");
  await pool.query(
    "UPDATE member_email_links SET address=NULL WHERE principal_id=$1",
    [m.id],
  );
  expect((await access.consume(code())).kind).toBe("signed_in");
  expect(await addresses("member_email_identities", m.id)).toEqual([null]);
  // A held address that does not match the proven fingerprint is never kept.
  await access.requestSignIn("before@example.com");
  await pool.query(
    "UPDATE member_email_links SET address='other@example.com' WHERE principal_id=$1 AND consumed_at IS NULL",
    [m.id],
  );
  expect((await access.consume(code())).kind).toBe("signed_in");
  expect(await addresses("member_email_identities", m.id)).toEqual([null]);
});
