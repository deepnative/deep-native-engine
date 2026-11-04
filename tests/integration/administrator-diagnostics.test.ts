import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { administratorDiagnostics } from "../../src/administrator-diagnostics.ts";
import { administratorEntry } from "../../src/administrator-entry.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool),
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
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
  await pool.query("TRUNCATE member_email_notices");
});
afterAll(() => pool.end());

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
async function admin() {
  const owner = await member("tom@deepnative.io");
  const entered = await entry.enter(owner.token);
  if (entered.kind !== "ready" || !entered.credential)
    throw Error("No administrator session");
  return entered.credential;
}

it("DIAG-01 shows an administrator whether an email is linked, verified and recently sent", async () => {
  const credential = await admin();
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
  expect(pending.id).toBeTruthy();

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
  const credential = await admin();
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

it("DIAG-03 refuses anyone without a current administrator session and writes nothing", async () => {
  const learner = await member("learner@example.test");
  const credential = await admin();
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
