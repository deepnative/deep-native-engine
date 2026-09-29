import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { authorizationStore } from "../../src/authorization.ts";
import { proposalStore } from "../../src/proposals.ts";
import { hash, migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const proposals = proposalStore(pool);
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals, cohorts CASCADE"));
afterAll(async () => pool.end());

const proposalId = (ordinal: number) =>
  `11111111-1111-1111-1111-${ordinal.toString(16).padStart(12, "0")}`;
const timestamp = "2026-09-01 00:00:00.123456+00";
async function seed(memberId: string, ids: string[], submittedAt = timestamp) {
  await pool.query(
    `INSERT INTO member_proposals
       (id,member_id,title,body,sources,state,sample_attested_at,rights_attested_at,submitted_at)
     SELECT id,$2,'Private synthetic page title','Private synthetic page body',
       'Invented source','submitted',$3,$3,$3 FROM unnest($1::uuid[]) id`,
    [ids, memberId, submittedAt],
  );
}
async function fixture(count: number) {
  const memberToken = randomBytes(32).toString("hex");
  await db.create(memberToken, { background: "explorer", goal: "everyday" });
  const session = await db.session(memberToken);
  if (session.kind !== "active") throw new Error("Synthetic setup failed");
  const staffToken = randomBytes(32).toString("hex");
  const staffId = await authorizationStore(pool).provisionStaff(
    staffToken,
    "moderator",
    new Date(Date.now() + 3_600_000),
  );
  const ids = Array.from({ length: count }, (_, index) =>
    proposalId((index + 1) * 2),
  );
  await seed(session.learner.id, ids);
  return {
    memberToken,
    memberId: session.learner.id,
    staffToken,
    staffId,
    ids,
  };
}
async function events() {
  return (
    await pool.query("SELECT proposal_id FROM proposal_audit ORDER BY id")
  ).rows.map((row) => row.proposal_id as string);
}

it.each([0, 100, 101, 201])(
  "traverses %i tied proposals in bounded UUID order and audits only returned rows",
  async (count) => {
    const f = await fixture(count);
    const seen: string[] = [];
    let cursor: string | undefined;
    const pageSizes: number[] = [];
    do {
      const page = await proposals.moderationPage(f.staffToken, cursor);
      expect(page).not.toBeNull();
      const ids = page!.items.map((row) => row.id);
      seen.push(...ids);
      pageSizes.push(ids.length);
      expect(ids.length).toBeLessThanOrEqual(100);
      expect(await events()).toEqual(seen);
      cursor = page!.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(f.ids);
    expect(pageSizes).toEqual(
      count === 0
        ? [0]
        : count === 100
          ? [100, 0]
          : count === 101
            ? [100, 1]
            : [100, 100, 1],
    );
    expect(
      (await pool.query("SELECT DISTINCT state FROM member_proposals")).rows,
    ).toEqual(count ? [{ state: "submitted" }] : []);
  },
);

it("preserves microsecond order across a deleted boundary and places new rows relative to that boundary", async () => {
  const f = await fixture(100);
  // This UUID sorts before the boundary but its exact timestamp sorts after it.
  const newerId = proposalId(1);
  await seed(f.memberId, [newerId], "2026-09-01 00:00:00.123457+00");
  const first = await proposals.moderationPage(f.staffToken);
  expect(first!.items.map((row) => row.id)).toEqual(f.ids);
  await pool.query("DELETE FROM member_proposals WHERE id=$1", [f.ids[99]]);
  const lateBefore = proposalId(199),
    lateAfter = proposalId(201);
  await seed(f.memberId, [lateBefore, lateAfter]);
  const second = await proposals.moderationPage(
    f.staffToken,
    first!.nextCursor,
  );
  expect(second!.items.map((row) => row.id)).toEqual([lateAfter, newerId]);
  expect(second!.nextCursor).toBeNull();
  // Replaying navigation is read-only and creates a fresh audit per returned row.
  expect(
    await proposals.moderationPage(f.staffToken, first!.nextCursor),
  ).toEqual(second);
  expect((await events()).slice(-4)).toEqual([
    lateAfter,
    newerId,
    lateAfter,
    newerId,
  ]);
  const restarted = await proposals.moderationPage(f.staffToken);
  expect(restarted!.items.map((row) => row.id)).toContain(lateBefore);
});

it("binds continuation to the current actor, session and store without auditing denied reads", async () => {
  const f = await fixture(101);
  const first = await proposals.moderationPage(f.staffToken);
  const cursor = first!.nextCursor!;
  const prior = await events();
  const otherStaff = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    otherStaff,
    "platform_admin",
    new Date(Date.now() + 3_600_000),
  );
  for (const token of [f.memberToken, otherStaff, "unknown"]) {
    expect(await proposals.moderationPage(token, cursor)).toBeNull();
  }
  for (const invalid of [
    null,
    [],
    {},
    "",
    "x".repeat(513),
    cursor.slice(0, -43) + "x".repeat(43),
  ]) {
    expect(await proposals.moderationPage(f.staffToken, invalid)).toBeNull();
  }
  expect(
    await proposalStore(pool).moderationPage(f.staffToken, cursor),
  ).toBeNull();
  const rotatedToken = randomBytes(32).toString("hex");
  await pool.query("UPDATE principals SET token_hash=$2 WHERE id=$1", [
    f.staffId,
    hash(rotatedToken),
  ]);
  expect(await proposals.moderationPage(f.staffToken, cursor)).toBeNull();
  expect(await proposals.moderationPage(rotatedToken, cursor)).toBeNull();
  expect(await events()).toEqual(prior);
  expect((await proposals.moderationPage(rotatedToken))!.items).toHaveLength(
    100,
  );
});

it.each(["revoked", "expired", "changed-role", "missing-profile"])(
  "reauthorizes a previously issued continuation after the staff session is %s",
  async (change) => {
    const f = await fixture(101);
    const first = await proposals.moderationPage(f.staffToken);
    const prior = await events();
    if (change === "changed-role") {
      await pool.query(
        "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
        [f.staffId],
      );
    } else if (change === "missing-profile") {
      await pool.query("DELETE FROM staff_profiles WHERE principal_id=$1", [
        f.staffId,
      ]);
    } else {
      await pool.query(
        `UPDATE principals SET ${change === "revoked" ? "revoked_at" : "expires_at"}=clock_timestamp() WHERE id=$1`,
        [f.staffId],
      );
    }
    expect(
      await proposals.moderationPage(f.staffToken, first!.nextCursor),
    ).toBeNull();
    expect(await events()).toEqual(prior);
  },
);

it.each(["insert", "commit"])(
  "returns no partial continuation page and rolls its audits back on %s failure",
  async (stage) => {
    const f = await fixture(103);
    const first = await proposals.moderationPage(f.staffToken);
    const prior = await events();
    try {
      await pool.query(
        `CREATE FUNCTION fail_page_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.proposal_id='${f.ids[102]}'::uuid THEN RAISE EXCEPTION 'Synthetic page audit failure'; END IF; RETURN NEW; END $$`,
      );
      await pool.query(
        stage === "insert"
          ? "CREATE TRIGGER fail_page_audit BEFORE INSERT ON proposal_audit FOR EACH ROW EXECUTE FUNCTION fail_page_audit()"
          : "CREATE CONSTRAINT TRIGGER fail_page_audit AFTER INSERT ON proposal_audit DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_page_audit()",
      );
      await expect(
        proposals.moderationPage(f.staffToken, first!.nextCursor),
      ).rejects.toThrow("Synthetic page audit failure");
      expect(await events()).toEqual(prior);
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS fail_page_audit ON proposal_audit",
      );
      await pool.query("DROP FUNCTION IF EXISTS fail_page_audit()");
    }
    expect(
      (await proposals.moderationPage(
        f.staffToken,
        first!.nextCursor,
      ))!.items.map((row) => row.id),
    ).toEqual(f.ids.slice(100));
  },
);

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

it("does not refill a withdrawn candidate and continues past the original boundary", async () => {
  const f = await fixture(201);
  const entered = gate(),
    resume = gate();
  let paused = false;
  const target = proposalStore({
    async connect() {
      const client = await pool.connect();
      return {
        async query(statement: string, values?: unknown[]) {
          const result = await client.query(statement, values);
          if (!paused && statement.startsWith("SELECT mp.id,mp.member_id")) {
            paused = true;
            entered.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool);
  const reading = target.moderationPage(f.staffToken);
  try {
    await Promise.race([
      entered.wait,
      reading.then(() => {
        throw new Error("Page finished before candidate gate");
      }),
    ]);
    expect(await proposals.withdraw(f.memberToken, f.ids[99]!)).toBe(true);
    const lateBeforeBoundary = proposalId(199);
    await seed(f.memberId, [lateBeforeBoundary]);
    resume.release();
    const first = await reading;
    expect(first!.items.map((row) => row.id)).toEqual(f.ids.slice(0, 99));
    expect(await events()).toEqual(f.ids.slice(0, 99));
    const second = await target.moderationPage(f.staffToken, first!.nextCursor);
    expect(second!.items.map((row) => row.id)).toEqual(f.ids.slice(100, 200));
    expect((await events()).slice(99)).toEqual(f.ids.slice(100, 200));
  } finally {
    resume.release();
    await reading;
  }
});

it.each(["withdrawal", "deletion", "expiry"] as const)(
  "withholds a continuation page after a winning %s without partial audit evidence",
  async (change) => {
    const f = await fixture(101);
    const entered = gate(),
      resume = gate();
    let enabled = false;
    const target = proposalStore({
      async connect() {
        const client = await pool.connect();
        return {
          async query(statement: string, values?: unknown[]) {
            const result = await client.query(statement, values);
            if (
              enabled &&
              (change === "expiry"
                ? statement.includes("INSERT INTO proposal_audit")
                : statement.startsWith("SELECT mp.id,mp.member_id"))
            ) {
              entered.release();
              await resume.wait;
            }
            return result;
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool);
    const first = await target.moderationPage(f.staffToken);
    const prior = await events();
    let deadline: Date | undefined;
    if (change === "expiry") {
      deadline = (
        await pool.query(
          "UPDATE principals SET expires_at=clock_timestamp()+INTERVAL '800 milliseconds' WHERE id=$1 RETURNING expires_at",
          [f.staffId],
        )
      ).rows[0].expires_at;
    }
    enabled = true;
    const reading = target.moderationPage(f.staffToken, first!.nextCursor);
    try {
      await Promise.race([
        entered.wait,
        reading.then(() => {
          throw new Error("Continuation finished before race gate");
        }),
      ]);
      if (change === "withdrawal") {
        expect(await proposals.withdraw(f.memberToken, f.ids[100]!)).toBe(true);
      } else if (change === "deletion") {
        await pool.query("DELETE FROM principals WHERE id=$1", [f.memberId]);
      } else {
        expect(await events()).toEqual(prior);
        while (
          !(
            await pool.query(
              "SELECT clock_timestamp()>=$1::timestamptz AS expired",
              [deadline],
            )
          ).rows[0].expired
        )
          await new Promise((resolve) => setTimeout(resolve, 5));
      }
      resume.release();
      expect(await reading).toEqual(
        change === "expiry" ? null : { items: [], nextCursor: null },
      );
      expect(await events()).toEqual(change === "deletion" ? [] : prior);
    } finally {
      resume.release();
      await reading;
    }
  },
);
