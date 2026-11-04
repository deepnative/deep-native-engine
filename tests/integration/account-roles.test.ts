import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { administratorEntry } from "../../src/administrator-entry.ts";
import { coachViewStore } from "../../src/coach-view.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { migrate, store, hash } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool),
  entry = administratorEntry(pool),
  coach = coachViewStore(pool);
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
  if (verify) {
    const code = new URL(link).searchParams.get("code")!;
    expect((await email.consume(code, token)).kind).toBe("attached");
  }
  return { token, id: session.learner.id };
}

it("ROLES-01/06 stores coach and admin for the two owners only; everyone else is a student", async () => {
  const seeded = await pool.query<{ role: string; count: number }>(
    "SELECT role,count(*)::integer AS count FROM account_roles GROUP BY role ORDER BY role",
  );
  expect(seeded.rows).toEqual([
    { role: "admin", count: 2 },
    { role: "coach", count: 2 },
  ]);
  for (const address of ["shi@deepnative.io", " TOM@deepnative.io "]) {
    const owner = await fixture(address);
    expect(await entry.accountRoles!(owner.token)).toEqual([
      "student",
      "coach",
      "admin",
    ]);
  }
  const learner = await fixture("member@example.test");
  expect(await entry.accountRoles!(learner.token)).toEqual(["student"]);
  // An unverified owner address grants nothing yet.
  const unverified = await fixture("tom@deepnative.io", false);
  expect(await entry.accountRoles!(unverified.token)).toEqual(["student"]);
  expect(await entry.accountRoles!("not-a-token")).toEqual([]);
  expect(await entry.accountRoles!("f".repeat(64))).toEqual([]);

  const owner = await fixture();
  await pool.query("UPDATE principals SET revoked_at=now() WHERE id=$1", [
    owner.id,
  ]);
  expect(await entry.accountRoles!(owner.token)).toEqual([]);
});

it("ROLES-06 administrator entry follows the stored admin role", async () => {
  const owner = await fixture("shi@deepnative.io");
  const shi = hash("shi@deepnative.io");
  const entered = await entry.enter(owner.token);
  if (entered.kind !== "ready" || !entered.credential) throw Error("No entry");
  expect((await entry.console!(entered.credential)).kind).toBe("ready");
  await pool.query(
    "DELETE FROM account_roles WHERE email_hash=$1 AND role='admin'",
    [shi],
  );
  try {
    expect(await entry.accountRoles!(owner.token)).toEqual([
      "student",
      "coach",
    ]);
    // The open session loses its authority as soon as the role is removed.
    expect((await entry.console!(entered.credential)).kind).toBe("denied");
    expect((await entry.status(owner.token)).kind).toBe("denied");
    expect((await entry.enter(owner.token)).kind).toBe("denied");
  } finally {
    await pool.query(
      "INSERT INTO account_roles(email_hash,role) VALUES($1,'admin') ON CONFLICT DO NOTHING",
      [shi],
    );
  }
  await entry.end(owner.token);
  expect((await entry.enter(owner.token)).kind).toBe("ready");
  // A role row can only name a known role for a well-formed email hash.
  await expect(
    pool.query(
      "INSERT INTO account_roles(email_hash,role) VALUES($1,'owner')",
      [shi],
    ),
  ).rejects.toThrow();
  await expect(
    pool.query(
      "INSERT INTO account_roles(email_hash,role) VALUES('shi@deepnative.io','coach')",
    ),
  ).rejects.toThrow();
});

it("ROLES-03/04 a coach reads each person's saved hours for a month; a student is refused", async () => {
  const owner = await fixture("tom@deepnative.io");
  const learner = await fixture("member@example.test");
  const today = (
    await pool.query<{ month: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS month",
    )
  ).rows[0]!.month;
  await pool.query(
    "UPDATE learners SET display_name='Invented Ada' WHERE id=$1",
    [learner.id],
  );
  await pool.query(
    `INSERT INTO coaching_months(owner_id,month,minutes,name,email,state,revision,submitted_revision)
     VALUES($1,$2,90,'Invented Ada','member@example.test','submitted',1,1)`,
    [learner.id, today],
  );
  const ready = await coach.summary(owner.token);
  expect(ready).toEqual({
    kind: "ready",
    value: {
      month: today,
      today,
      rows: [{ name: "Invented Ada", minutes: 90, status: "Submitted" }],
    },
  });
  expect(await coach.summary(learner.token)).toEqual({ kind: "denied" });
  expect(await coach.summary(owner.token, "2999-01")).toEqual({
    kind: "invalid",
  });
  const earlier = await coach.summary(owner.token, "2020-01");
  expect(earlier).toEqual({
    kind: "ready",
    value: { month: "2020-01", today, rows: [] },
  });
});
