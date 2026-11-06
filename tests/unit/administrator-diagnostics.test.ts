import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { administratorDiagnostics } from "../../src/administrator-diagnostics.ts";
import { administratorEntry } from "../../src/administrator-entry.ts";
import { emailHash, memberEmailAccess } from "../../src/member-email-access.ts";
import { migrate, store } from "../../src/store.ts";

// A private database per file, like member-email-access.test.ts.
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
const members = store(pool),
  entry = administratorEntry(pool),
  diagnostics = administratorDiagnostics(pool);
let link = "";
const email = memberEmailAccess(
  pool,
  {
    async send(_address, value) {
      link = value;
    },
    async sendNoAccount() {},
  },
  "http://127.0.0.1:3000",
);
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
  await pool.query("TRUNCATE member_email_notices");
  await pool.query("TRUNCATE administrator_email_lookups");
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
});

async function member(address?: string, verify = true) {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("No invented member");
  if (address) {
    expect(await email.requestAttach(token, address)).toBe("sent");
    if (verify)
      expect(
        (await email.consume(new URL(link).searchParams.get("code")!, token))
          .kind,
      ).toBe("attached");
  }
  return { token, id: session.learner.id };
}
async function admin2() {
  const owner = await member("tom@deepnative.io");
  const entered = await entry.enter(owner.token);
  if (entered.kind !== "ready" || !entered.credential)
    throw Error("No administrator session");
  return entered.credential;
}

it("DIAG-01 shows an administrator whether an email is linked, verified and recently sent", async () => {
  const credential = await admin2();
  const linked = await member("learner@example.test");
  const pending = await member("pending@example.test", false);
  await email.requestSignIn("nobody@example.test");

  const verified = await diagnostics.email(
    credential,
    " Learner@Example.test ",
  );
  expect(verified).toMatchObject({
    kind: "ready",
    value: {
      address: "learner@example.test",
      verified: { accountId: linked.id },
      unverified: null,
      notices: [],
    },
  });
  if (verified.kind !== "ready") throw Error("unreachable");
  expect(verified.value.links.map((l) => [l.purpose, l.state])).toEqual([
    ["attach", "used"],
  ]);

  const open = await diagnostics.email(credential, "pending@example.test");
  if (open.kind !== "ready") throw Error("Lookup unavailable");
  expect(open.value.verified).toBeNull();
  expect(open.value.links.map((l) => [l.purpose, l.state])).toEqual([
    ["attach", "open"],
  ]);
  // A password sign-up keeps its email unverified until a link is used.
  await pool.query(
    "INSERT INTO member_login_emails(email_hash,principal_id) VALUES($1,$2)",
    [emailHash("signup@example.test"), pending.id],
  );
  const signup = await diagnostics.email(credential, "signup@example.test");
  if (signup.kind !== "ready") throw Error("Lookup unavailable");
  expect(signup.value.unverified).toMatchObject({ accountId: pending.id });
  expect(signup.value.verified).toBeNull();

  const none = await diagnostics.email(credential, "nobody@example.test");
  if (none.kind !== "ready") throw Error("Lookup unavailable");
  expect(none.value).toMatchObject({
    verified: null,
    unverified: null,
    links: [],
  });
  expect(none.value.notices).toHaveLength(1);

  expect(await diagnostics.email(credential, "not an email")).toEqual({
    kind: "invalid",
  });
});

it("DIAG-02 counts accounts, emails and the last day's email activity", async () => {
  const credential = await admin2();
  await member("a@example.test");
  await member("b@example.test", false);
  await email.requestSignIn("nobody@example.test");
  const site = await diagnostics.site(credential);
  if (site.kind !== "ready") throw Error("Site checks unavailable");
  expect(site.value).toMatchObject({
    accounts: 3,
    verifiedEmails: 2,
    unverifiedEmails: 0,
    day: { attach: 3, signIn: 0, used: 2, notices: 1 },
  });
  expect(site.value.latestMigration).toBeGreaterThanOrEqual(93);
});

it("DIAG-AUDIT-01/02 records each email lookup by hash and counts the last day's lookups", async () => {
  const credential = await admin2();
  const staff = await pool.query<{ id: string }>(
    "SELECT id FROM principals WHERE kind='staff'",
  );
  await diagnostics.email(credential, " Learner@Example.test ");
  await diagnostics.email(credential, "nobody@example.test");
  await diagnostics.email(credential, "not an email");
  await diagnostics.email("f".repeat(64), "learner@example.test");
  const records = await pool.query(
    "SELECT staff_id, email_hash FROM administrator_email_lookups ORDER BY id",
  );
  expect(records.rows).toEqual(
    ["learner@example.test", "nobody@example.test"].map((address) => ({
      staff_id: staff.rows[0]!.id,
      email_hash: emailHash(address),
    })),
  );
  expect(JSON.stringify(records.rows)).not.toContain("example.test");
  await pool.query(
    "UPDATE administrator_email_lookups SET occurred_at=clock_timestamp()-INTERVAL '25 hours' WHERE email_hash=$1",
    [emailHash("nobody@example.test")],
  );
  const site = await diagnostics.site(credential);
  if (site.kind !== "ready") throw Error("Site checks unavailable");
  expect(site.value.day.lookups).toBe(1);
  // Viewing site counts is not an email lookup.
  expect(
    (await pool.query("SELECT 1 FROM administrator_email_lookups")).rowCount,
  ).toBe(2);
});

it("DIAG-AUDIT-01 shows nothing when the lookup cannot be recorded", async () => {
  const credential = await admin2();
  await pool.query(
    "ALTER TABLE administrator_email_lookups RENAME TO lookups_hidden",
  );
  try {
    expect(await diagnostics.email(credential, "learner@example.test")).toEqual(
      { kind: "unavailable" },
    );
  } finally {
    await pool.query(
      "ALTER TABLE lookups_hidden RENAME TO administrator_email_lookups",
    );
  }
});

it("DIAG-03 refuses anyone without a current administrator session and writes nothing", async () => {
  const learner = await member("learner@example.test");
  const credential = await admin2();
  for (const bad of [learner.token, "f".repeat(64), "short"]) {
    expect(await diagnostics.site(bad)).toEqual({ kind: "denied" });
    expect(await diagnostics.email(bad, "learner@example.test")).toEqual({
      kind: "denied",
    });
  }
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE kind='staff'",
  );
  expect(await diagnostics.site(credential)).toEqual({ kind: "denied" });
  const before = await pool.query(
    "SELECT count(*)::int AS n FROM member_email_links",
  );
  expect(before.rows[0].n).toBe(2);
});

it("DIAG-03 reports unavailable when the database cannot be reached or read", async () => {
  const credential = await admin2();
  const unreachable = administratorDiagnostics({
    connect: () => Promise.reject(Error("private connection failure")),
  } as unknown as Pool);
  expect(await unreachable.site(credential)).toEqual({ kind: "unavailable" });
  let released = 0;
  const failing = administratorDiagnostics({
    connect: async () => ({
      query: async (sql: string) => {
        if (sql === "ROLLBACK") throw Error("private rollback failure");
        throw Error("private read failure");
      },
      release: () => released++,
    }),
  } as unknown as Pool);
  expect(await failing.site(credential)).toEqual({ kind: "unavailable" });
  expect(released).toBe(1);
  expect(await diagnostics.email("short", "learner@example.test")).toEqual({
    kind: "denied",
  });
  expect(await diagnostics.email("short", "not an email")).toEqual({
    kind: "denied",
  });
});

it("WAITWORK reads waiting work with a real administrator session, skipping retired workflow versions", async () => {
  const credential = await admin2();
  const empty = await diagnostics.work(credential);
  expect(empty).toMatchObject({
    kind: "ready",
    value: {
      support: { waiting: 0, assigned: 0, people: 0 },
      feedback: { waiting: 0, assigned: 0, people: 0 },
      workflow: { waiting: 0, assigned: 0, people: 0, references: [] },
      contributions: { waiting: 0, assigned: null, people: 1 },
    },
  });

  // Requests for the current (2) and a retired (1) version of one workflow.
  const owner = await member();
  const requests = [];
  for (const version of [2, 1]) {
    await pool.query(
      "INSERT INTO workflow_feedback(member_id,workflow_id,workflow_version,note) VALUES($1,'WF-001',$2,'Invented note')",
      [owner.id, version],
    );
    const id = randomUUID();
    await pool.query(
      `INSERT INTO workflow_review_requests(id,workspace_id,member_id,source_instance_id,workflow_id,workflow_version,source_revision,expires_at)
       SELECT $1,$2,$2,instance_id,'WF-001',$3,1,clock_timestamp()+INTERVAL '1 hour'
       FROM workflow_feedback WHERE member_id=$2 AND workflow_version=$3`,
      [id, owner.id, version],
    );
    requests.push(id);
  }
  const value = await diagnostics.work(credential);
  if (value.kind !== "ready") throw Error("Counts unavailable");
  expect(value.value.workflow).toMatchObject({
    waiting: 1,
    references: [requests[0]],
  });
  expect(await diagnostics.work("short")).toEqual({ kind: "denied" });
});
