import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate, store } from "../../src/store.ts";
import { practiceSessionStore } from "../../src/practice-sessions.ts";
import {
  memberExportStore,
  MAX_MEMBER_EXPORT_BYTES,
  MAX_MEMBER_EXPORT_RECORDS,
} from "../../src/member-export.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  db = store(pool);
const exportSecret = Buffer.alloc(32, 42);
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals, cohorts CASCADE"));
afterAll(async () => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const owner = await db.session(token);
  if (owner.kind !== "active") throw Error("Synthetic owner missing");
  return { token, id: owner.learner.id };
}
async function fixture(count = 21) {
  const owner = await member(),
    other = await member();
  await pool.query(`INSERT INTO content_versions(id,version,kind,origin,title,body,owner,sources,rights)
    VALUES('SYN-958',1,'lesson','curated','Invented conversation source','Original invented text','Synthetic editor','Original','Owned sample') ON CONFLICT DO NOTHING`);
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const id = randomUUID();
    ids.push(id);
    await pool.query(
      `INSERT INTO private_practice_sessions(id,member_id,content_id,content_version,goal_at_start,prompt_version)
      VALUES($1,$2,'SYN-958',1,'everyday',$3)`,
      [id, owner.id, `retained-template-${n}`],
    );
    await pool.query(
      `INSERT INTO private_practice_exchanges(session_id,sequence,response,comparison,source_excerpt)
      SELECT $1,g,$2,$3,$4 FROM generate_series(1,15) g`,
      [id, "样".repeat(1000), "比".repeat(4000), "原".repeat(600)],
    );
  }
  const otherId = randomUUID();
  await pool.query(
    `INSERT INTO private_practice_sessions(id,member_id,content_id,content_version,goal_at_start,prompt_version)
    VALUES($1,$2,'SYN-958',1,'everyday','retained-other')`,
    [otherId, other.id],
  );
  await pool.query(
    `INSERT INTO private_practice_exchanges(session_id,sequence,response,comparison,source_excerpt)
    VALUES($1,1,'Other private sample','Other comparison','Original invented text')`,
    [otherId],
  );
  return { owner, other, ids, otherId };
}
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function observedPool(pause: (sql: string) => boolean) {
  const reached = gate(),
    resume = gate(),
    state = { pid: 0 };
  const controlled = {
    connect: async () => {
      const client = await pool.connect();
      state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (pause(sql)) {
            reached.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  return { controlled, reached, resume, state };
}
async function blocked(waiting: number, blocker: number) {
  const end = performance.now() + 3000;
  while (performance.now() < end) {
    if (
      (
        await pool.query(
          "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
          [blocker, waiting],
        )
      ).rows[0].blocked
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected owned practice privacy lock was not observed");
}
async function continuationFixture() {
  const value = await fixture();
  const exporter = memberExportStore(pool, exportSecret);
  const first = await exporter.exportOwned(value.owner.token);
  if (first.kind !== "ready" || !first.payload.page.nextCursor)
    throw Error("Missing bounded export continuation");
  const cursor = first.payload.page.nextCursor;
  const fields = JSON.parse(
    Buffer.from(cursor.split(".")[0]!, "base64url").toString(),
  ) as [number, number, (string | number)[], number, number];
  expect(fields[1]).toBe(18);
  const next = (
    await pool.query(
      `SELECT session_id FROM private_practice_exchanges WHERE jsonb_build_array(session_id,sequence)>$1::jsonb AND session_id=ANY($2::uuid[]) ORDER BY session_id,sequence LIMIT 1`,
      [JSON.stringify(fields[2]), value.ids],
    )
  ).rows[0];
  if (!next) throw Error("Missing next private pair");
  return { ...value, exporter, cursor, target: next.session_id as string };
}
it("traverses every retained pair in bounded UTF-8 pages without exposing another owner", async () => {
  const { owner, other, ids } = await fixture();
  const exporter = memberExportStore(pool, exportSecret);
  let cursor: string | undefined,
    pages = 0;
  const sessions: Record<string, unknown>[] = [],
    pairs: Record<string, unknown>[] = [];
  do {
    const page = await exporter.exportOwned(owner.token, cursor);
    expect(page.kind).toBe("ready");
    if (page.kind !== "ready") throw Error("Export unavailable");
    expect(page.payload.version).toBe("local-member-records-v20");
    expect(Buffer.byteLength(JSON.stringify(page.payload))).toBeLessThanOrEqual(
      MAX_MEMBER_EXPORT_BYTES,
    );
    expect(page.payload.page.recordCount).toBeLessThanOrEqual(
      MAX_MEMBER_EXPORT_RECORDS,
    );
    expect(JSON.stringify(page.payload)).not.toContain("Other private sample");
    sessions.push(...page.payload.records.practiceSessions!);
    pairs.push(...page.payload.records.practiceExchanges!);
    cursor = page.payload.page.nextCursor ?? undefined;
    pages++;
    expect(pages).toBeLessThan(100);
  } while (cursor);
  expect(pages).toBeGreaterThan(2);
  expect(sessions).toHaveLength(ids.length);
  expect(pairs).toHaveLength(ids.length * 15);
  expect(
    new Set(pairs.map((p) => `${String(p.sessionId)}:${String(p.sequence)}`))
      .size,
  ).toBe(ids.length * 15);
  for (const id of ids)
    expect(
      pairs.filter((p) => p.sessionId === id).map((p) => p.sequence),
    ).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  const ownOther = await exporter.exportOwned(other.token);
  expect(ownOther).toMatchObject({
    kind: "ready",
    payload: {
      records: { practiceExchanges: [{ response: "Other private sample" }] },
    },
  });
});
it("keeps withdrawn slots as text-free metadata and binds continuation to its authenticated owner", async () => {
  const { owner, other, ids } = await fixture(1);
  const practice = practiceSessionStore(pool);
  expect(await practice.withdraw(owner.token, ids[0]!)).toBe("withdrawn");
  expect(await practice.withdraw(owner.token, ids[0]!)).toBe(
    "already-withdrawn",
  );
  const exporter = memberExportStore(pool, exportSecret),
    result = await exporter.exportOwned(owner.token);
  expect(result).toMatchObject({
    kind: "ready",
    payload: {
      records: {
        practiceSessions: [
          { state: "withdrawn", withdrawnAt: expect.any(Date) },
        ],
        practiceExchanges: [],
      },
    },
  });
  expect(JSON.stringify(result)).not.toContain("样");
  expect(JSON.stringify(result)).not.toContain("比");
  expect(JSON.stringify(result)).not.toContain("原");
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM private_practice_exchanges WHERE session_id=$1",
        [ids[0]],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(await practice.withdraw(other.token, ids[0]!)).toBe("unavailable");
  const continuation = await continuationFixture();
  expect(
    await continuation.exporter.exportOwned(
      continuation.other.token,
      continuation.cursor,
    ),
  ).toEqual({ kind: "denied" });
});
it("withdrawal that wins before a child-section continuation prevents response disclosure", async () => {
  const { owner, exporter, cursor, target } = await continuationFixture();
  const writer = observedPool((sql) =>
    sql.startsWith("DELETE FROM private_practice_exchanges"),
  );
  const withdrawal = practiceSessionStore(writer.controlled).withdraw(
    owner.token,
    target,
  );
  await writer.reached.wait;
  const reader = observedPool(() => false);
  const reading = memberExportStore(
    reader.controlled,
    exportSecret,
  ).exportOwned(owner.token, cursor);
  try {
    const end = performance.now() + 3000;
    while (!reader.state.pid && performance.now() < end)
      await new Promise((r) => setTimeout(r, 5));
    expect(reader.state.pid).toBeGreaterThan(0);
    await blocked(reader.state.pid, writer.state.pid);
  } finally {
    writer.resume.release();
  }
  expect(await withdrawal).toBe("withdrawn");
  const result = await reading;
  if (result.kind === "ready")
    expect(
      result.payload.records.practiceExchanges!.some(
        (p) => p.sessionId === target,
      ),
    ).toBe(false);
  else expect(result.kind).toBe("unavailable");
  const after = await exporter.exportOwned(owner.token, cursor);
  if (after.kind !== "ready") throw Error("Fresh continuation unavailable");
  expect(
    after.payload.records.practiceExchanges!.some(
      (p) => p.sessionId === target,
    ),
  ).toBe(false);
});
it("an export child-section parent read commits before concurrent withdrawal can erase its pairs", async () => {
  const { owner, cursor, target } = await continuationFixture();
  const reader = observedPool((sql) =>
    sql.startsWith("SELECT s.id FROM private_practice_sessions"),
  );
  const reading = memberExportStore(
    reader.controlled,
    exportSecret,
  ).exportOwned(owner.token, cursor);
  await reader.reached.wait;
  const writer = observedPool(() => false);
  const withdrawal = practiceSessionStore(writer.controlled).withdraw(
    owner.token,
    target,
  );
  try {
    const end = performance.now() + 3000;
    while (!writer.state.pid && performance.now() < end)
      await new Promise((r) => setTimeout(r, 5));
    expect(writer.state.pid).toBeGreaterThan(0);
    await blocked(writer.state.pid, reader.state.pid);
  } finally {
    reader.resume.release();
  }
  const result = await reading;
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Export unavailable");
  expect(
    result.payload.records.practiceExchanges!.some(
      (p) => p.sessionId === target,
    ),
  ).toBe(true);
  expect(await withdrawal).toBe("withdrawn");
  const after = await memberExportStore(pool, exportSecret).exportOwned(
    owner.token,
    cursor,
  );
  if (after.kind !== "ready") throw Error("Fresh continuation unavailable");
  expect(
    after.payload.records.practiceExchanges!.some(
      (p) => p.sessionId === target,
    ),
  ).toBe(false);
});
