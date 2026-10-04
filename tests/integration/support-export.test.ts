import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import {
  memberExportStore,
  MAX_MEMBER_EXPORT_BYTES,
  MAX_MEMBER_EXPORT_RECORDS,
} from "../../src/member-export.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  exporter = memberExportStore(pool);
beforeAll(async () => {
  await migrate(pool);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Synthetic member missing");
  return { token, id: session.learner.id };
}
async function seed(memberId: string, count: number, body: string) {
  const requests: string[] = [],
    replies: string[] = [];
  for (let i = 0; i < count; i++) {
    const requestId = randomUUID(),
      replyId = randomUUID();
    requests.push(requestId);
    replies.push(replyId);
    await pool.query(
      `INSERT INTO support_requests(id,member_id,workspace_id,intake_key,subject,body) VALUES($1,$2,$2,$3,'Invented sample',$4)`,
      [requestId, memberId, randomUUID(), body],
    );
    await pool.query(
      `INSERT INTO support_request_replies(id,request_id,actor_id,body) VALUES($1,$2,$3,$4)`,
      [replyId, requestId, randomUUID(), body],
    );
    await pool.query(
      `INSERT INTO support_request_notes(id,request_id,actor_id,body) VALUES($1,$2,$3,'INTERNAL-MARKER-NEVER-EXPORT')`,
      [randomUUID(), requestId, randomUUID()],
    );
  }
  return { requests: requests.sort(), replies: replies.sort() };
}
it.each([
  [105, "Invented sample"],
  [80, "中".repeat(2000)],
])(
  "exports %i support series across bounded live pages without notes or another owner",
  async (count, body) => {
    const owner = await member(),
      other = await member();
    const expected = await seed(owner.id, Number(count), String(body));
    await seed(other.id, 2, "OTHER-OWNER-MARKER");
    const requests: string[] = [],
      replies: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await exporter.exportOwned(owner.token, cursor);
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") throw Error("Missing owner export");
      const payload = result.payload;
      expect(payload.version).toBe("local-member-records-v19");
      expect(payload.page.recordCount).toBeLessThanOrEqual(
        MAX_MEMBER_EXPORT_RECORDS,
      );
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(
        MAX_MEMBER_EXPORT_BYTES,
      );
      expect(JSON.stringify(payload)).not.toContain("INTERNAL-MARKER");
      expect(JSON.stringify(payload)).not.toContain("OTHER-OWNER-MARKER");
      expect(JSON.stringify(payload)).not.toContain("actorId");
      requests.push(
        ...payload.records.supportRequests!.map((row) => String(row.id)),
      );
      replies.push(
        ...payload.records.supportReplies!.map((row) => String(row.id)),
      );
      cursor = payload.page.nextCursor ?? undefined;
      expect(++pages).toBeLessThan(20);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(requests.sort()).toEqual(expected.requests);
    expect(replies.sort()).toEqual(expected.replies);
    expect(new Set(requests).size).toBe(requests.length);
    expect(new Set(replies).size).toBe(replies.length);
  },
);

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
  } as unknown as import("pg").Pool;
  return { controlled, reached, resume, state };
}
async function blocked(waiting: number, blocker: number) {
  const until = performance.now() + 3000;
  while (performance.now() < until) {
    if (
      (
        await pool.query(
          "SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked",
          [blocker, waiting],
        )
      ).rows[0].blocked
    )
      return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Expected support privacy lock not observed");
}
const exportSecret = Buffer.alloc(32, 53);
async function replyContinuation() {
  const owner = await member();
  const seeded = await seed(owner.id, 1, "中".repeat(2000));
  const requestId = seeded.requests[0]!;
  await pool.query(
    `INSERT INTO support_request_replies(id,request_id,actor_id,body) SELECT gen_random_uuid(),$1,$2,repeat('样',2000) FROM generate_series(1,100)`,
    [requestId, randomUUID()],
  );
  const first = await memberExportStore(pool, exportSecret).exportOwned(
    owner.token,
  );
  if (first.kind !== "ready" || !first.payload.page.nextCursor)
    throw Error("Missing support continuation");
  const cursor = first.payload.page.nextCursor;
  const data = JSON.parse(
    Buffer.from(cursor.split(".")[0]!, "base64url").toString(),
  );
  expect(data[1]).toBe(20);
  return { owner, requestId, cursor };
}
it("withdrawal committed before direct support-reply continuation withholds all request bytes", async () => {
  const { supportRequestStore } = await import("../../src/support-requests.ts");
  const { owner, requestId, cursor } = await replyContinuation();
  const writer = observedPool((sql) =>
    sql.startsWith("DELETE FROM support_request_replies"),
  );
  const withdrawing = supportRequestStore(writer.controlled).withdraw(
    owner.token,
    requestId,
  );
  await writer.reached.wait;
  const reader = observedPool(() => false);
  const reading = memberExportStore(
    reader.controlled,
    exportSecret,
  ).exportOwned(owner.token, cursor);
  try {
    const until = performance.now() + 3000;
    while (!reader.state.pid && performance.now() < until)
      await new Promise((r) => setTimeout(r, 5));
    expect(reader.state.pid).toBeGreaterThan(0);
    await blocked(reader.state.pid, writer.state.pid);
  } finally {
    writer.resume.release();
  }
  expect(await withdrawing).toMatchObject({ kind: "withdrawn" });
  const result = await reading;
  if (result.kind === "ready")
    expect(result.payload.records.supportReplies).toEqual([]);
  else expect(result.kind).toBe("unavailable");
  const fresh = await memberExportStore(pool, exportSecret).exportOwned(
    owner.token,
  );
  expect(fresh).toMatchObject({
    kind: "ready",
    payload: {
      records: {
        supportRequests: [{ subject: null, body: null, state: "withdrawn" }],
        supportReplies: [],
      },
    },
  });
  expect(JSON.stringify(fresh)).not.toContain("中");
  expect(JSON.stringify(fresh)).not.toContain("样");
});
it("an authorized reply page holds privacy locks until its success before withdrawal completes", async () => {
  const { supportRequestStore } = await import("../../src/support-requests.ts");
  const { owner, requestId, cursor } = await replyContinuation();
  const reader = observedPool((sql) =>
    sql.startsWith("SELECT r.id FROM support_requests r"),
  );
  const reading = memberExportStore(
    reader.controlled,
    exportSecret,
  ).exportOwned(owner.token, cursor);
  await reader.reached.wait;
  const writer = observedPool(() => false);
  const withdrawing = supportRequestStore(writer.controlled).withdraw(
    owner.token,
    requestId,
  );
  try {
    const until = performance.now() + 3000;
    while (!writer.state.pid && performance.now() < until)
      await new Promise((r) => setTimeout(r, 5));
    expect(writer.state.pid).toBeGreaterThan(0);
    await blocked(writer.state.pid, reader.state.pid);
  } finally {
    reader.resume.release();
  }
  const result = await reading;
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Protected read unavailable");
  expect(result.payload.records.supportReplies!.length).toBeGreaterThan(0);
  expect(await withdrawing).toMatchObject({ kind: "withdrawn" });
  expect(
    await memberExportStore(pool, exportSecret).exportOwned(
      owner.token,
      cursor,
    ),
  ).toMatchObject({
    kind: "ready",
    payload: { records: { supportReplies: [] } },
  });
});
