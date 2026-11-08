import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { availabilityStore } from "../../src/availability.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { memberSlotHolds } from "../../src/slot-holds.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

// #40 EXPCOV: Download my records reads every kind of record that goes with
// the account, or the record is on the reviewed "not exported" list.
const pool = testPool(),
  members = store(pool),
  access = authorizationStore(pool),
  exporter = memberExportStore(pool),
  slots = availabilityStore(pool),
  ledger = syntheticLedger(pool),
  holds = memberSlotHolds(pool);
const COVERAGE = new URL(
  "../../assets/docs/MEMBER-EXPORT-COVERAGE.md",
  import.meta.url,
);
// The export's queries live in these files; comments don't count as reading.
const EXPORT_SOURCES = [
  "../../src/member-export.ts",
  "../../src/assignment-evidence-values.ts",
].map((path) => new URL(path, import.meta.url));

beforeAll(() => migrate(pool));
beforeEach(() =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(() => pool.end());

// The same reach as the deletion guard (member-erasure-coverage.test.ts):
// everything removed with an account through ON DELETE CASCADE chains.
const ERASED = `WITH RECURSIVE erased(rel) AS (
  SELECT 'principals'::regclass
  UNION
  SELECT c.conrelid::regclass FROM pg_constraint c JOIN erased e ON c.confrelid=e.rel
  WHERE c.contype='f' AND c.confdeltype='c')
  SELECT rel::text AS name FROM erased ORDER BY 1`;

async function exportReads() {
  const words = new Set<string>();
  for (const url of EXPORT_SOURCES) {
    const text = (await readFile(url, "utf8")).replace(/\/\/.*$/gm, "");
    for (const word of text.match(/[a-z_][a-z0-9_]*/g) ?? []) words.add(word);
  }
  return words;
}

async function notExported() {
  const text = await readFile(COVERAGE, "utf8");
  const parts = text.split("\n## Member records not in Download my records\n");
  if (parts.length !== 2) throw Error("Missing the not-exported section");
  return [
    ...parts[1]!.split("\n## ")[0]!.matchAll(/^\| `([a-z0-9_]+)` +\|/gm),
  ].map((m) => m[1]!);
}

/** Each member table neither exported nor listed, and each stale listing. */
async function uncovered(db: Pool | PoolClient) {
  const [reads, listed] = [await exportReads(), await notExported()];
  const owned = (await db.query<{ name: string }>(ERASED)).rows.map(
    (r) => r.name,
  );
  const problems: string[] = [];
  for (const name of owned)
    if (!reads.has(name) && !listed.includes(name))
      problems.push(
        `Table ${name} goes with the account but Download my records doesn't read it and MEMBER-EXPORT-COVERAGE.md doesn't list it`,
      );
  for (const name of listed) {
    if (!owned.includes(name))
      problems.push(
        `Table ${name} is in MEMBER-EXPORT-COVERAGE.md but no longer goes with the account`,
      );
    else if (reads.has(name))
      problems.push(
        `Table ${name} is in MEMBER-EXPORT-COVERAGE.md but Download my records now reads it`,
      );
  }
  if (new Set(listed).size !== listed.length)
    problems.push("MEMBER-EXPORT-COVERAGE.md repeats a table");
  return problems;
}

it("EXPCOV-01 every member table is read by Download my records or on the reviewed not-exported list", async () => {
  expect(await uncovered(pool)).toEqual([]);
  // The guard covers the whole account, not only a few sections.
  const owned = (await pool.query(ERASED)).rowCount!;
  expect(owned).toBeGreaterThan(100);
  expect((await notExported()).length).toBeLessThan(owned / 2);
});

it("EXPCOV-02 a new member table that is neither exported nor listed is named by the guard", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "CREATE TABLE export_probe_owned(member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE, note text)",
    );
    expect(await uncovered(client)).toEqual([
      "Table export_probe_owned goes with the account but Download my records doesn't read it and MEMBER-EXPORT-COVERAGE.md doesn't list it",
    ]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member missing");
  const id = session.learner.id;
  const workspace = (
    await pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE owner_principal_id=$1",
      [id],
    )
  ).rows[0]!.id;
  return { token, id, workspace };
}

async function records(token: string) {
  const all: Record<string, Record<string, unknown>[]> = {};
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await exporter.exportOwned(token, cursor);
    if (result.kind !== "ready") throw Error(`Export ${result.kind}`);
    for (const [name, rows] of Object.entries(result.payload.records))
      (all[name] ??= []).push(...rows);
    if (result.payload.page.complete)
      return { version: result.payload.version, all };
    cursor = result.payload.page.nextCursor!;
  }
  throw Error("Export never completed");
}

async function staff(role: "coach" | "operator" | "platform_admin") {
  const token = randomBytes(32).toString("hex");
  const id = await access.provisionStaff(
    token,
    role,
    new Date(Date.now() + 10 * 86_400_000),
  );
  return { token, id };
}

/** An invented coaching slot open for sample holds (member-slot-holds.test.ts). */
async function slot() {
  const [admin, operator, coach, backup] = [
    await staff("platform_admin"),
    await staff("operator"),
    await staff("coach"),
    await staff("coach"),
  ];
  const startsAt = new Date(Date.now() + 3 * 86_400_000);
  const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
  const registryId = randomUUID();
  await pool.query(
    `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,
      starts_at,ends_at,loaded_cost_cents,capacity_minutes,backup_staff_id,
      qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
     VALUES ($1,$2,'coach','education','coaching',$3,$4,12000,60,$5,
       'synthetic qualification','synthetic agreement','synthetic conflict review',$6,$7),
       ($8,$5,'coach','education','coaching',$3,$4,12000,60,$2,
       'synthetic qualification','synthetic agreement','synthetic conflict review',$6,$7)`,
    [
      registryId,
      coach.id,
      new Date(Date.now() - 3600_000),
      new Date(endsAt.getTime() + 3600_000),
      backup.id,
      admin.id,
      new Date(Date.now() - 60_000),
      randomUUID(),
    ],
  );
  const id = await slots.create(operator.token, registryId, startsAt, endsAt);
  if (!id) throw Error("Invented slot missing");
  return { id, operator: operator.id, coach: coach.id, registryId };
}

async function heldBy(person: { id: string; token: string }, slotId: string) {
  const grantId = await ledger.grant(
    person.id,
    "coach_minutes",
    60,
    `expcov-${randomUUID()}`,
    {
      startsAt: new Date(Date.now() - 3600_000).toISOString(),
      expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    },
  );
  const requestId = randomUUID();
  await holds.request(person.token, slotId, grantId, requestId);
  return { grantId, requestId };
}

it("EXPCOV-03 a member's held and withdrawn sample sessions are in Download my records, and another member's aren't", async () => {
  const [owner, other] = [await member(), await member()];
  const [first, second] = [await slot(), await slot()];
  const kept = await heldBy(owner, first.id);
  const withdrawn = await heldBy(owner, second.id);
  await holds.withdraw(owner.token, withdrawn.requestId);
  const theirs = await heldBy(other, (await slot()).id);
  const { version, all } = await records(owner.token);
  expect(version).toBe("local-member-records-v42");
  const rows = all.sampleHolds!;
  expect(rows.map((row) => row.id).sort()).toEqual(
    [kept.requestId, withdrawn.requestId].sort(),
  );
  expect(rows.find((row) => row.id === kept.requestId)).toEqual({
    id: kept.requestId,
    slotId: first.id,
    grantId: kept.grantId,
    domain: "education",
    serviceType: "coaching",
    startsAt: expect.any(Date),
    endsAt: expect.any(Date),
    state: "held",
    heldAt: expect.any(Date),
    expiresAt: expect.any(Date),
    releasedAt: null,
    expiredAt: null,
    label: "SAMPLE HOLD · NOT A BOOKING",
  });
  expect(rows.find((row) => row.id === withdrawn.requestId)).toMatchObject({
    state: "released",
    releasedAt: expect.any(Date),
  });
  const text = JSON.stringify(all);
  expect(text).not.toContain(theirs.requestId);
  for (const id of [first.operator, first.coach, first.registryId])
    expect(JSON.stringify(rows)).not.toContain(id);
});

it("EXPCOV-04 a simulated assessment result on the member's work is in Download my records without the reviewer", async () => {
  const [owner, other] = [await member(), await member()];
  const reviewer = await access.provisionStaff(
    randomBytes(32).toString("hex"),
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  await pool.query(
    `INSERT INTO content_versions(id,version,kind,origin,title,body,owner,sources,rights)
     VALUES('ZEX-001',1,'assignment','curated','Invented export task','Synthetic only','Test editor','Original','Test rights')
     ON CONFLICT(id,version) DO NOTHING`,
  );
  const [mine, theirs] = [randomUUID(), randomUUID()];
  for (const [id, learner, result] of [
    [mine, owner.id, "Invented simulated result for the owner"],
    [theirs, other.id, "Invented simulated result for someone else"],
  ])
    await pool.query(
      `INSERT INTO content_assessments(id,member_id,content_id,content_version,rubric_version,reviewer_id,result)
       VALUES($1,$2,'ZEX-001',1,1,$3,$4)`,
      [id, learner, reviewer, result],
    );
  const { all } = await records(owner.token);
  expect(all.contentAssessments).toEqual([
    {
      id: mine,
      contentId: "ZEX-001",
      contentVersion: 1,
      rubricVersion: 1,
      mode: "simulated",
      result: "Invented simulated result for the owner",
      label: "SIMULATED · NOT A QUALIFIED ASSESSMENT",
      assessedAt: expect.any(Date),
    },
  ]);
  const text = JSON.stringify(all);
  expect(text).not.toContain(reviewer);
  expect(text).not.toContain(theirs);
  expect(text).not.toContain("someone else");
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

it("EXPCOV-05 the member's own coach assignments are in Download my records without the coach's or assigner's identity", async () => {
  const [owner, other] = [await member(), await member()];
  const [coach, assigner] = [
    sha(`invented.coach.${randomUUID()}@example.test`),
    randomUUID(),
  ];
  await pool.query(
    "INSERT INTO account_roles(email_hash,role) VALUES($1,'coach') ON CONFLICT DO NOTHING",
    [coach],
  );
  for (const learner of [owner.id, other.id])
    await pool.query(
      "INSERT INTO coach_assignments(learner_id,coach_email_hash,assigned_by) VALUES($1,$2,$3)",
      [learner, coach, assigner],
    );
  const { version, all } = await records(owner.token);
  expect(version).toBe("local-member-records-v42");
  expect(all.coachAssignments).toEqual([
    { role: "coach", assignedAt: expect.any(Date) },
  ]);
  const text = JSON.stringify(all);
  for (const hidden of [coach, assigner, other.id])
    expect(text).not.toContain(hidden);
});

it("EXPCOV-06 hand-recorded test payment observations about the member are in Download my records, labelled unverified, without staff", async () => {
  const [owner, other] = [await member(), await member()];
  const actor = randomUUID();
  const rows = [
    [randomUUID(), owner.id, "SYN-EXPCOV-OWNER", 1234],
    [randomUUID(), other.id, "SYN-EXPCOV-OTHER", 4321],
  ] as const;
  for (const [id, learner, reference, cents] of rows)
    await pool.query(
      `INSERT INTO synthetic_manual_observations(id,member_id,actor_id,idempotency_key,evidence_reference,amount_cents,request_fingerprint)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, learner, actor, randomUUID(), reference, cents, sha(reference)],
    );
  const { all } = await records(owner.token);
  expect(all.manualPaymentObservations).toEqual([
    {
      id: rows[0][0],
      reference: "SYN-EXPCOV-OWNER",
      amountCents: 1234,
      status: "unverified_manual",
      label: "TEST RECORD · NOT A PAYMENT",
      recordedAt: expect.any(Date),
    },
  ]);
  const text = JSON.stringify(all);
  for (const hidden of [actor, "SYN-EXPCOV-OTHER", rows[1][0]])
    expect(text).not.toContain(hidden);
});
