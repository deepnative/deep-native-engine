import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

// #40 ERASE: deleting an account leaves only reviewed, documented records.
const pool = testPool(),
  members = store(pool);
const RETENTION = new URL(
  "../../assets/docs/MEMBER-DELETION-RETENTION.md",
  import.meta.url,
);

beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(() => pool.end());

// Rows go with the account only through ON DELETE CASCADE chains that start
// at principals. Every other table keeps its rows when an account is deleted.
const ERASED = `WITH RECURSIVE erased(rel) AS (
  SELECT 'principals'::regclass
  UNION
  SELECT c.conrelid::regclass FROM pg_constraint c JOIN erased e ON c.confrelid=e.rel
  WHERE c.contype='f' AND c.confdeltype='c')`;
const KEPT_TABLES = `${ERASED}
  SELECT t.relname AS name FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname=current_schema() AND t.relkind IN ('r','p') AND t.oid NOT IN (SELECT rel FROM erased)
  ORDER BY 1`;
// A column named for a member or workspace must be removed with the account
// through a cascading key, or be reviewed.
const MEMBER_COLUMNS = [
  "member_id",
  "learner_id",
  "owner_id",
  "owner_principal_id",
  "workspace_id",
  "principal_id",
];
const MEMBER_LINKS = `${ERASED}
  SELECT t.relname||'.'||a.attname AS name
  FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname=current_schema() AND t.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
   AND a.attname=ANY($1::text[])
   AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype='f' AND c.confdeltype='c'
    AND c.conrelid=a.attrelid AND a.attnum=ANY(c.conkey) AND c.confrelid IN (SELECT rel FROM erased))
  ORDER BY 1`;

async function reviewed() {
  const text = await readFile(RETENTION, "utf8");
  const section = (heading: string) => {
    const parts = text.split(`\n## ${heading}\n`);
    if (parts.length !== 2) throw Error(`Missing section: ${heading}`);
    return parts[1]!.split("\n## ")[0]!;
  };
  const names = (body: string) =>
    [...body.matchAll(/^\| `([a-z0-9_.]+)` \|/gm)].map((m) => m[1]!);
  return {
    tables: names(section("Tables kept when an account is deleted")),
    links: names(section("Member links in kept rows")),
  };
}

/** Each table or member link the retention list doesn't account for. */
async function unreviewed(db: Pool | PoolClient) {
  const listed = await reviewed();
  const actual = {
    tables: (await db.query<{ name: string }>(KEPT_TABLES)).rows.map(
      (r) => r.name,
    ),
    links: (
      await db.query<{ name: string }>(MEMBER_LINKS, [MEMBER_COLUMNS])
    ).rows.map((r) => r.name),
  };
  const problems: string[] = [];
  for (const kind of ["tables", "links"] as const) {
    const noun = kind === "tables" ? "Table" : "Column";
    for (const name of actual[kind])
      if (!listed[kind].includes(name))
        problems.push(
          `${noun} ${name} is kept when an account is deleted but isn't in MEMBER-DELETION-RETENTION.md`,
        );
    for (const name of listed[kind])
      if (!actual[kind].includes(name))
        problems.push(
          `${noun} ${name} is in MEMBER-DELETION-RETENTION.md but is no longer kept`,
        );
    if (new Set(listed[kind]).size !== listed[kind].length)
      problems.push(`MEMBER-DELETION-RETENTION.md repeats a ${kind} entry`);
  }
  return problems;
}

it("ERASE-01/05 every table and member link kept after deletion is on the reviewed retention list", async () => {
  expect(await unreviewed(pool)).toEqual([]);
  const listed = await reviewed();
  // The guard is only as good as its reach: most member tables cascade.
  expect(listed.tables.length).toBeGreaterThan(20);
  expect(listed.links).toContain("billing_change_events.member_id");
});

it("ERASE-02 a new unreviewed table or member column is named by the guard", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "CREATE TABLE erase_probe_kept(member_id uuid REFERENCES principals(id) ON DELETE SET NULL, note text)",
    );
    await client.query(
      "CREATE TABLE erase_probe_loose(workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE, member_id uuid)",
    );
    const problems = await unreviewed(client);
    expect(problems).toEqual([
      "Table erase_probe_kept is kept when an account is deleted but isn't in MEMBER-DELETION-RETENTION.md",
      "Column erase_probe_kept.member_id is kept when an account is deleted but isn't in MEMBER-DELETION-RETENTION.md",
      "Column erase_probe_loose.member_id is kept when an account is deleted but isn't in MEMBER-DELETION-RETENTION.md",
    ]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function member(name: string) {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member missing");
  const id = session.learner.id;
  await pool.query("UPDATE learners SET display_name=$2 WHERE id=$1", [
    id,
    name,
  ]);
  const workspace = (
    await pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE owner_principal_id=$1",
      [id],
    )
  ).rows[0]!.id;
  const email = sha(`${name.toLowerCase().replaceAll(" ", ".")}@example.test`);
  await pool.query(
    "INSERT INTO member_email_identities(email_hash,principal_id,verified_at) VALUES($1,$2,clock_timestamp())",
    [email, id],
  );
  return { id, workspace, email, name };
}

/** Every table, column and value that still holds one of `needles`. */
async function leftovers(needles: string[]) {
  const columns = await pool.query<{ table: string; column: string }>(
    `SELECT c.table_name AS table, c.column_name AS column
     FROM information_schema.columns c JOIN information_schema.tables t
      ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
     WHERE c.table_schema=current_schema()
      AND c.data_type IN ('uuid','text','jsonb','json','ARRAY','character varying')
     ORDER BY 1,2`,
  );
  const found: string[] = [];
  for (const { table, column } of columns.rows) {
    const rows = await pool.query<{ value: string }>(
      `SELECT "${column}"::text AS value FROM "${table}" WHERE "${column}"::text LIKE ANY($1::text[])`,
      [needles.map((n) => `%${n}%`)],
    );
    for (const row of rows.rows)
      found.push(
        `${table}.${column}=${needles.find((n) => row.value.includes(n))}`,
      );
  }
  return found.sort();
}

it("ERASE-03/04 after deletion only the listed records still refer to the member, and none holds their name or private text", async () => {
  const gone = await member("Invented Erasure Learner"),
    kept = await member("Invented Remaining Learner"),
    staff = randomUUID(),
    coach = sha("invented.coach@example.test");
  const note = `Invented private workflow note ${randomUUID()}`;
  // Staff changes to the member's coaches and billing (CHANGELOG, #734).
  await pool.query(
    `INSERT INTO account_role_events(actor_id,action,email_hash,learner_id) VALUES($1,'assigned',$2,$3),($1,'assigned',$2,$4)`,
    [staff, coach, gone.id, kept.id],
  );
  await pool.query(
    `INSERT INTO billing_change_events(actor_id,action,member_id,amount_cents) VALUES($1,'plan_offered',$2,1000),($1,'plan_offered',$3,1000)`,
    [staff, gone.id, kept.id],
  );
  // An administrator looked the member up by email, and sign-in protection
  // counted a refused password for the address.
  await pool.query(
    "INSERT INTO administrator_email_lookups(staff_id,email_hash) VALUES($1,$2)",
    [staff, gone.email],
  );
  await pool.query(
    "INSERT INTO member_password_failures(email_hash) VALUES($1)",
    [gone.email],
  );
  // The member's own workflow review request: its operation key stays
  // reserved, with every link to the member cleared.
  const operation = randomUUID();
  await pool.query(
    `INSERT INTO workflow_review_operations(operation_id,actor_id,workspace_id,kind,instruction,receipt_id)
     VALUES($1,$2,$3,'request',$4::jsonb,$5)`,
    [
      operation,
      gone.id,
      gone.workspace,
      JSON.stringify({ memberId: gone.id, note }),
      randomUUID(),
    ],
  );

  await members.remove(gone.id);

  expect(
    await leftovers([gone.id, gone.workspace, gone.email, gone.name, note]),
  ).toEqual([
    `account_role_events.learner_id=${gone.id}`,
    `administrator_email_lookups.email_hash=${gone.email}`,
    `billing_change_events.member_id=${gone.id}`,
    `member_password_failures.email_hash=${gone.email}`,
  ]);
  expect(
    (
      await pool.query(
        "SELECT actor_id,workspace_id,kind,instruction,receipt_id FROM workflow_review_operations WHERE operation_id=$1",
        [operation],
      )
    ).rows,
  ).toEqual([
    {
      actor_id: null,
      workspace_id: null,
      kind: null,
      instruction: null,
      receipt_id: null,
    },
  ]);
  // The other member keeps everything.
  expect(
    await leftovers([kept.id, kept.workspace, kept.email, kept.name]),
  ).toEqual(
    expect.arrayContaining([
      `learners.display_name=${kept.name}`,
      `member_email_identities.email_hash=${kept.email}`,
      `principals.id=${kept.id}`,
      `workspaces.id=${kept.workspace}`,
    ]),
  );
});

it("ERASE-04 each listed member link says what stays and what is cleared", async () => {
  const text = await readFile(RETENTION, "utf8");
  const links = text
    .split("\n## Member links in kept rows\n")[1]!
    .split("\n## ")[0]!;
  for (const row of links.matchAll(/^\| `([a-z0-9_.]+)` \| ([^|]+) \|/gm))
    expect(row[2]!.trim(), row[1]).toMatch(/^(Kept|Cleared)\b/);
});
