import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { administratorEntry } from "../../src/administrator-entry.ts";
import { accountRoleAdmin } from "../../src/account-role-admin.ts";
import { coachViewStore } from "../../src/coach-view.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { migrate, store, hash } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool),
  entry = administratorEntry(pool),
  admin = accountRoleAdmin(pool),
  coach = coachViewStore(pool);
const SEEDED = ["shi@deepnative.io", "tom@deepnative.io"].map(hash);
// Each test starts from, and leaves behind, the seeded owners only.
async function reset() {
  await pool.query("TRUNCATE principals CASCADE");
  await pool.query("TRUNCATE account_role_events");
  await pool.query("DELETE FROM account_roles WHERE NOT email_hash=ANY($1)", [
    SEEDED,
  ]);
  await pool.query(
    `INSERT INTO account_roles(email_hash,role)
     SELECT h,r FROM unnest($1::text[]) h CROSS JOIN unnest(ARRAY['coach','admin']) r
     ON CONFLICT DO NOTHING`,
    [SEEDED],
  );
}
beforeAll(() => migrate(pool));
beforeEach(reset);
afterAll(async () => {
  await reset();
  await pool.end();
});

async function fixture(address: string, name?: string) {
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
  expect((await email.consume(code, token)).kind).toBe("attached");
  if (name)
    await pool.query("UPDATE learners SET display_name=$2 WHERE id=$1", [
      session.learner.id,
      name,
    ]);
  return { token, id: session.learner.id };
}
async function staff(address = "tom@deepnative.io", name = "Invented Tom") {
  const owner = await fixture(address, name);
  const entered = await entry.enter(owner.token);
  if (entered.kind !== "ready" || !entered.credential) throw Error("No entry");
  return { ...owner, credential: entered.credential };
}
const events = async () =>
  (
    await pool.query<{ action: string; role: string | null }>(
      "SELECT action,role FROM account_role_events ORDER BY id",
    )
  ).rows;

it("ROLEADMIN-01/02/05 lists role holders and grants roles to a typed email", async () => {
  const tom = await staff();
  const listed = await admin.roles(tom.credential);
  if (listed.kind !== "ready") throw Error(listed.kind);
  // Shi has not signed up here, so only the hash is known.
  expect(listed.value.holders).toEqual([
    {
      emailHash: hash("tom@deepnative.io"),
      roles: ["coach", "admin"],
      people: [{ id: tom.id, name: "Invented Tom" }],
      self: true,
    },
    {
      emailHash: hash("shi@deepnative.io"),
      roles: ["coach", "admin"],
      people: [],
      self: false,
    },
  ]);

  const ada = await fixture("ada@example.test", "Invented Ada");
  expect(
    await admin.grant(tom.credential, {
      email: "  Ada@Example.test ",
      roles: ["coach"],
    }),
  ).toEqual({ kind: "ready" });
  // Granting again is harmless and records nothing new.
  expect(
    await admin.grant(tom.credential, {
      email: "ada@example.test",
      roles: ["coach"],
    }),
  ).toEqual({ kind: "ready" });
  expect(await entry.accountRoles!(ada.token)).toEqual(["student", "coach"]);
  // A role can be granted before the person signs up.
  expect(
    await admin.grant(tom.credential, {
      email: "later@example.test",
      roles: ["coach", "admin"],
    }),
  ).toEqual({ kind: "ready" });
  expect(await events()).toEqual([
    { action: "granted", role: "coach" },
    { action: "granted", role: "coach" },
    { action: "granted", role: "admin" },
  ]);
  for (const input of [
    { email: "not an email", roles: ["coach"] as const },
    { email: "x@example.test", roles: [] as const },
  ])
    expect(
      await admin.grant(tom.credential, { ...input, roles: [...input.roles] }),
    ).toEqual({
      kind: "invalid",
    });

  // A student cannot read or change roles.
  const student = await fixture("member@example.test");
  expect((await admin.roles(student.token)).kind).toBe("denied");
  expect(
    (
      await admin.grant(student.token, {
        email: "ada@example.test",
        roles: ["admin"],
      })
    ).kind,
  ).toBe("denied");
  expect(await entry.accountRoles!(ada.token)).toEqual(["student", "coach"]);
});

it("ROLEADMIN-03/04 removes roles but never the acting administrator's own admin role", async () => {
  const tom = await staff();
  const tomHash = hash("tom@deepnative.io"),
    shiHash = hash("shi@deepnative.io");
  expect(
    await admin.remove(tom.credential, { emailHash: tomHash, role: "admin" }),
  ).toEqual({ kind: "self" });
  expect((await admin.roles(tom.credential)).kind).toBe("ready");
  // Removing one's own coach role is allowed.
  expect(
    await admin.remove(tom.credential, { emailHash: tomHash, role: "coach" }),
  ).toEqual({ kind: "ready" });
  expect(
    await admin.remove(tom.credential, { emailHash: shiHash, role: "admin" }),
  ).toEqual({ kind: "ready" });
  expect(
    await admin.remove(tom.credential, { emailHash: shiHash, role: "admin" }),
  ).toEqual({ kind: "not-found" });
  expect(
    await admin.remove(tom.credential, { emailHash: "nope", role: "admin" }),
  ).toEqual({ kind: "invalid" });
  expect(await events()).toEqual([
    { action: "removed", role: "coach" },
    { action: "removed", role: "admin" },
  ]);
  expect(
    (
      await pool.query(
        "SELECT role FROM account_roles WHERE email_hash=$1 ORDER BY role",
        [shiHash],
      )
    ).rows,
  ).toEqual([{ role: "coach" }]);
});

it("COACHLINK-01..04 an administrator assigns one coach per learner; each coach sees only theirs", async () => {
  const tom = await staff();
  const shi = await fixture("shi@deepnative.io", "Invented Shi");
  const ada = await fixture("ada@example.test", "Invented Ada");
  const bo = await fixture("bo@example.test", "Invented Bo");
  const month = (
    await pool.query<{ month: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS month",
    )
  ).rows[0]!.month;
  for (const [learner, minutes] of [
    [ada, 90],
    [bo, 30],
  ] as const)
    await pool.query(
      `INSERT INTO coaching_months(owner_id,month,minutes,name,email,state,revision)
       VALUES($1,$2,$3,'Invented','x@example.test','draft',1)`,
      [learner.id, month, minutes],
    );

  const choices = await admin.learnerCoach(tom.credential, ada.id);
  expect(choices).toEqual({
    kind: "ready",
    value: {
      coach: null,
      coaches: [
        { emailHash: hash("shi@deepnative.io"), label: "Invented Shi" },
        { emailHash: hash("tom@deepnative.io"), label: "Invented Tom" },
      ],
    },
  });
  // Nobody is assigned yet, so no coach sees anyone.
  const empty = await coach.summary(tom.token);
  expect(empty.kind === "ready" && empty.value.rows).toEqual([]);

  const shiHash = hash("shi@deepnative.io"),
    tomHash = hash("tom@deepnative.io");
  expect(
    await admin.assignCoach(tom.credential, {
      learnerId: ada.id,
      coach: shiHash,
    }),
  ).toEqual({ kind: "ready" });
  expect(
    await admin.assignCoach(tom.credential, {
      learnerId: bo.id,
      coach: tomHash,
    }),
  ).toEqual({ kind: "ready" });
  const rows = async (token: string) => {
    const r = await coach.summary(token);
    return r.kind === "ready" ? r.value.rows.map((row) => row.name) : r.kind;
  };
  expect(await rows(shi.token)).toEqual(["Invented Ada"]);
  expect(await rows(tom.token)).toEqual(["Invented Bo"]);
  // Reassigning replaces the coach.
  expect(
    await admin.assignCoach(tom.credential, {
      learnerId: ada.id,
      coach: tomHash,
    }),
  ).toEqual({ kind: "ready" });
  expect(await rows(shi.token)).toEqual([]);
  expect(await rows(tom.token)).toEqual(["Invented Ada", "Invented Bo"]);
  const assigned = await admin.learnerCoach(tom.credential, ada.id);
  expect(assigned.kind === "ready" && assigned.value.coach).toBe(tomHash);

  // Only coach-role holders and real learners can be linked.
  const learner = await fixture("member@example.test");
  expect(
    await admin.assignCoach(tom.credential, {
      learnerId: ada.id,
      coach: hash("member@example.test"),
    }),
  ).toEqual({ kind: "invalid" });
  expect(
    await admin.assignCoach(tom.credential, {
      learnerId: "00000000-0000-4000-8000-000000000000",
      coach: tomHash,
    }),
  ).toEqual({ kind: "not-found" });
  expect((await admin.learnerCoach(learner.token, ada.id)).kind).toBe("denied");

  // Clearing, then removing a coach role, drops that coach's learners.
  expect(
    await admin.assignCoach(tom.credential, { learnerId: bo.id, coach: null }),
  ).toEqual({ kind: "ready" });
  expect(
    await admin.assignCoach(tom.credential, { learnerId: bo.id, coach: null }),
  ).toEqual({ kind: "ready" });
  expect(
    await admin.remove(tom.credential, { emailHash: tomHash, role: "coach" }),
  ).toEqual({ kind: "ready" });
  expect((await pool.query("SELECT 1 FROM coach_assignments")).rowCount).toBe(
    0,
  );
  expect(await rows(tom.token)).toBe("denied");
  expect(await events()).toEqual([
    { action: "assigned", role: null },
    { action: "assigned", role: null },
    { action: "assigned", role: null },
    { action: "cleared", role: null },
    { action: "removed", role: "coach" },
  ]);
});
