import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, expect, it } from "vitest";
import { migrate, store, hash } from "../../src/store.ts";
import { profileEdit } from "../../src/validation.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { administratorEntry } from "../../src/administrator-entry.ts";
import { testPool } from "../support/database.ts";
import { readdir } from "node:fs/promises";
const pool = testPool();
afterAll(() => pool.end());

it("NAME02/03/04 preserves legacy rows and work, names the same account, exports privately and erases it", async () => {
  for (const file of (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql") && f < "087-")
    .sort())
    await pool.query(await readFile(`migrations/${file}`, "utf8"));
  const token = randomBytes(32).toString("hex"),
    id = randomUUID();
  await pool.query(
    "INSERT INTO principals(id,token_hash,kind,expires_at) VALUES($1,$2,'member',clock_timestamp()+interval '1 day')",
    [id, hash(token)],
  );
  await pool.query(
    "INSERT INTO learners(id,token_hash,background,goal,expires_at) VALUES($1,$2,'explorer','everyday',clock_timestamp()+interval '1 day')",
    [id, hash(token)],
  );
  await pool.query(
    "INSERT INTO workspaces(id,owner_principal_id) VALUES($1,$1)",
    [id],
  );
  const old = (
    await pool.query(
      "SELECT to_jsonb(l)-'display_name' row FROM learners l WHERE id=$1",
      [id],
    )
  ).rows[0].row;
  await migrate(pool);
  const after = (
    await pool.query(
      "SELECT to_jsonb(l)-'display_name' row,display_name FROM learners l WHERE id=$1",
      [id],
    )
  ).rows[0];
  expect(after).toEqual({ row: old, display_name: null });
  expect(
    (await pool.query("SELECT version FROM schema_migrations WHERE version=87"))
      .rows,
  ).toEqual([{ version: 87 }]);
  const db = store(pool);
  const session = await db.session(token, "account");
  expect(session.kind).toBe("active");
  if (session.kind !== "active") throw Error("Legacy account lost access");
  expect(session.learner).toMatchObject({ id, displayName: null });
  await db.save(token, {
    revision: 0,
    instruction: "Private original practice",
    verification: "Private check",
    complete: false,
  });
  const work = (
    await pool.query(
      "SELECT to_jsonb(e) row FROM exercises e WHERE learner_id=$1",
      [id],
    )
  ).rows;
  await pool.query(
    "INSERT INTO billing_profiles(owner_id,name,email,revision) VALUES($1,'Invoice recipient','recipient@example.invalid',1)",
    [id],
  );
  const recipient = (
    await pool.query("SELECT * FROM billing_profiles WHERE owner_id=$1", [id])
  ).rows;
  const profile = profileEdit({
    display_name: "李明 <Sam>",
    background: "explorer",
    goal: "everyday",
  }).input!;
  expect(await db.updateProfile(token, profile)).toBe(true);
  expect((await db.session(token)).kind).toBe("active");
  expect(
    (
      await pool.query(
        "SELECT to_jsonb(e) row FROM exercises e WHERE learner_id=$1",
        [id],
      )
    ).rows,
  ).toEqual(work);
  expect(
    (await pool.query("SELECT * FROM billing_profiles WHERE owner_id=$1", [id]))
      .rows,
  ).toEqual(recipient);
  const other = randomBytes(32).toString("hex");
  await db.create(other, profile);
  expect(
    await db.updateProfile("f".repeat(64), {
      ...profile,
      displayName: "Forged",
    }),
  ).toBe(false);
  expect(
    (await pool.query("SELECT display_name FROM learners WHERE id=$1", [id]))
      .rows[0].display_name,
  ).toBe(profile.displayName);
  const exported = await memberExportStore(pool).exportOwned(token);
  expect(exported.kind).toBe("ready");
  if (exported.kind !== "ready") throw Error("Own export unavailable");
  expect(exported.payload.profile).toMatchObject({
    id,
    displayName: profile.displayName,
  });
  const administrator = randomBytes(32).toString("hex");
  await db.create(administrator, {
    ...profile,
    displayName: "Invented administrator",
  });
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
  expect(await email.requestAttach(administrator, "tom@deepnative.io")).toBe(
    "sent",
  );
  expect(
    (
      await email.consume(
        new URL(link).searchParams.get("code")!,
        administrator,
      )
    ).kind,
  ).toBe("attached");
  const entry = administratorEntry(pool),
    entered = await entry.enter(administrator);
  expect(entered.kind).toBe("ready");
  if (entered.kind !== "ready" || !entered.credential)
    throw Error("Invented administrator unavailable");
  const listed = await entry.console!(entered.credential);
  expect(listed.kind).toBe("ready");
  if (listed.kind !== "ready") throw Error("Directory unavailable");
  expect(listed.value.members.find((m) => m.id === id)).toEqual({
    id,
    displayName: profile.displayName,
    background: "explorer",
    goal: "everyday",
  });
  expect(JSON.stringify(listed)).not.toContain("Private original practice");
  expect(JSON.stringify(listed)).not.toContain("tom@deepnative.io");
  await db.remove(id);
  expect(
    (await pool.query("SELECT id FROM learners WHERE id=$1", [id])).rows,
  ).toEqual([]);
  expect(
    (
      await pool.query("SELECT id FROM learners WHERE display_name=$1", [
        profile.displayName,
      ])
    ).rowCount,
  ).toBe(1);
});
