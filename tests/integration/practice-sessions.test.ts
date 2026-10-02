import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate, store } from "../../src/store.ts";
import {
  practiceSessionStore,
  type PracticeSessionStore,
} from "../../src/practice-sessions.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  db = store(pool),
  practice = practiceSessionStore(pool),
  catalog = catalogStore(pool);
const token = () => randomBytes(32).toString("hex");
beforeAll(async () => {
  await migrate(pool);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE adapter_jobs, principals, cohorts, content_versions CASCADE",
  );
});
afterAll(async () => {
  await pool.end();
});
async function member(
  background: "explorer" | "professional" | "technical" = "explorer",
  goal: "everyday" | "work" | "build" = "everyday",
) {
  const value = token();
  await db.create(value, { background, goal });
  const session = await db.session(value);
  if (session.kind !== "active") throw Error("Synthetic member missing");
  return { token: value, id: session.learner.id };
}
async function fixture() {
  const owner = await member(),
    other = await member(),
    editor = token(),
    reviewer = token();
  const auth = authorizationStore(pool);
  await auth.provisionStaff(editor, "editor", new Date(Date.now() + 86400000));
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86400000),
  );
  const source: DraftContent = {
    id: "SYN-130",
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: "Invented practice source",
    body: "Compare only invented examples. Verify every claim against this exact source.",
    owner: "Synthetic editor",
    sources: "Original synthetic work",
    rights: "Owned synthetic work",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
  };
  async function publish(
    version = 1,
    contentId = source.id,
    changes: Partial<DraftContent> = {},
  ) {
    expect(
      await catalog.createDraft(editor, {
        ...source,
        ...changes,
        id: contentId,
        version,
      }),
    ).toBe(true);
    expect(await catalog.submit(editor, contentId, version)).toBe(true);
    expect(await catalog.approve(reviewer, contentId, version, true)).toBe(
      true,
    );
    expect(await catalog.publish(editor, contentId, version)).toBe(true);
  }
  await publish();
  const input = {
    contentId: source.id,
    contentVersion: 1,
    goal: "everyday" as const,
    promptVersion: "practice-v1",
  };
  async function begin(value = owner.token, start = input) {
    const result = await practice.start(value, start);
    if (result.kind !== "started" && result.kind !== "replayed")
      throw Error("Synthetic practice start denied");
    return result.sessionId;
  }
  return { owner, other, editor, reviewer, source, input, publish, begin };
}
const append = (
  value: string,
  id: string,
  sequence = 1,
  response = "Invented response",
  use = practice,
) => use.append(value, id, { expectedSequence: sequence, response });
it("opts all three backgrounds into exact-goal sessions with two durable ordered pairs", async () => {
  const f = await fixture();
  for (const [background, goal] of [
    ["explorer", "everyday"],
    ["professional", "work"],
    ["technical", "build"],
  ] as const) {
    const owner = await member(background, goal);
    const source = (await practice.source(owner.token, f.source.id))!;
    expect(source).toMatchObject({
      goal,
      promptVersion: "practice-v1",
      sourceExcerpt: f.source.body,
    });
    const result = await practice.start(owner.token, { ...f.input, goal });
    expect(result.kind).toBe("started");
    if (!("sessionId" in result)) throw Error("Missing practice session");
    expect(
      await append(
        owner.token,
        result.sessionId,
        1,
        "  First invented words\n🧪 ",
      ),
    ).toBe("saved");
    expect(
      await append(owner.token, result.sessionId, 2, "Second invented words"),
    ).toBe("saved");
    const reloaded = await practiceSessionStore(pool).detail(
      owner.token,
      result.sessionId,
    );
    expect(reloaded).toMatchObject({
      contentId: f.source.id,
      contentVersion: 1,
      goal,
      nextSequence: 3,
      exchanges: [
        { sequence: 1, response: "  First invented words\n🧪 " },
        { sequence: 2, response: "Second invented words" },
      ],
    });
    for (const pair of reloaded!.exchanges) {
      expect(pair.comparison).toContain(pair.response);
      expect(pair.comparison).toContain(f.source.body);
      expect(pair.comparison).toContain("unreviewed");
      expect(pair.comparison).toContain("cannot judge competence");
      expect(pair.sourceExcerpt).toBe(f.source.body);
    }
  }
  expect(
    (await pool.query("SELECT count(*)::integer n FROM private_practice"))
      .rows[0].n,
  ).toBe(0);
  expect(
    (await pool.query("SELECT count(*)::integer n FROM adapter_jobs")).rows[0]
      .n,
  ).toBe(0);
});
it("serializes duplicate starts and response slots, caps 15 pairs, and replays only exact bytes", async () => {
  const f = await fixture();
  const starts = await Promise.all([
    practice.start(f.owner.token, f.input),
    practice.start(f.owner.token, f.input),
  ]);
  expect(starts.map((s) => s.kind).sort()).toEqual(["replayed", "started"]);
  const id = await f.begin();
  expect(starts).toEqual(
    expect.arrayContaining([expect.objectContaining({ sessionId: id })]),
  );
  expect(await append(f.owner.token, id, 2)).toBe("conflict");
  for (let sequence = 1; sequence < 15; sequence++)
    expect(await append(f.owner.token, id, sequence)).toBe("saved");
  const outcomes = await Promise.all([
    append(f.owner.token, id, 15, "Final A"),
    append(f.owner.token, id, 15, "Final B"),
  ]);
  expect(outcomes.sort()).toEqual(["conflict", "saved"]);
  const saved = (await practice.detail(f.owner.token, id))!.exchanges[14]!
    .response;
  expect(await append(f.owner.token, id, 15, saved)).toBe("replayed");
  expect(await append(f.owner.token, id, 15, saved + " ")).toBe("conflict");
  expect(await append(f.owner.token, id, 16)).toBe("full");
  expect(await practice.detail(f.owner.token, id)).toMatchObject({
    availability: "full",
    nextSequence: null,
  });
  expect(
    (
      await pool.query(
        "SELECT sequence FROM private_practice_exchanges WHERE session_id=$1 ORDER BY sequence",
        [id],
      )
    ).rows.map((r) => r.sequence),
  ).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
});
it("denies forged owners, staff and nonexistent sessions without exposing retained history", async () => {
  const f = await fixture(),
    id = await f.begin();
  await append(f.owner.token, id);
  for (const value of [f.other.token, f.editor, f.reviewer, token()]) {
    expect(await practice.detail(value, id)).toBeNull();
    expect(await append(value, id)).toBe("unavailable");
    expect(await practice.withdraw(value, id)).toBe("unavailable");
  }
  expect(await practice.history(f.other.token)).toEqual({
    items: [],
    nextCursor: null,
  });
  expect(await practice.history(f.editor)).toBeNull();
  expect(await practice.source(f.editor, f.source.id)).toBeNull();
  expect(await practice.start(f.editor, f.input)).toEqual({
    kind: "unavailable",
  });
  expect(await practice.detail(f.owner.token, randomUUID())).toBeNull();
  expect(await practice.history(f.owner.token)).toMatchObject({
    items: [{ id }],
    nextCursor: null,
  });
});
it("retains the pinned history across goal change, replacement and retirement without silently retargeting", async () => {
  const f = await fixture(),
    id = await f.begin();
  await append(f.owner.token, id);
  await pool.query("UPDATE learners SET goal='work' WHERE id=$1", [f.owner.id]);
  expect(await append(f.owner.token, id)).toBe("unavailable");
  expect(await practice.detail(f.owner.token, id)).toMatchObject({
    goal: "everyday",
    availability: "source-unavailable",
    exchanges: [{ response: "Invented response" }],
  });
  expect(await practice.start(f.owner.token, f.input)).toEqual({
    kind: "unavailable",
  });
  const work = await practice.start(f.owner.token, {
    ...f.input,
    goal: "work",
  });
  expect(work.kind).toBe("started");
  await pool.query("UPDATE learners SET goal='everyday' WHERE id=$1", [
    f.owner.id,
  ]);
  expect(await append(f.owner.token, id, 2)).toBe("saved");
  await f.publish(2, f.source.id, { body: "New exact version" });
  expect(await append(f.owner.token, id)).toBe("unavailable");
  expect(await practice.source(f.owner.token, f.source.id)).toMatchObject({
    contentVersion: 2,
  });
  expect(await practice.detail(f.owner.token, id)).toMatchObject({
    contentVersion: 1,
    availability: "source-unavailable",
    exchanges: [
      expect.objectContaining({ sourceExcerpt: f.source.body }),
      expect.objectContaining({ sourceExcerpt: f.source.body }),
    ],
  });
  await catalog.retire(f.editor, f.source.id);
  expect(await practice.source(f.owner.token, f.source.id)).toBeNull();
  expect(await practice.withdraw(f.owner.token, id)).toBe("withdrawn");
  expect(await practice.start(f.owner.token, f.input)).toEqual({
    kind: "withdrawn",
  });
});
it("requires a currently eligible published lesson and preserves unknown template history", async () => {
  const f = await fixture();
  await f.publish(1, "SYN-131", { kind: "workflow" });
  await f.publish(1, "SYN-132", { goals: ["build"] });
  await catalog.createDraft(f.editor, { ...f.source, id: "SYN-133" });
  for (const contentId of ["SYN-131", "SYN-132", "SYN-133", "SYN-999"]) {
    expect(await practice.source(f.owner.token, contentId)).toBeNull();
    expect(
      await practice.start(f.owner.token, { ...f.input, contentId }),
    ).toEqual({ kind: "unavailable" });
  }
  const id = randomUUID();
  await pool.query(
    "INSERT INTO private_practice_sessions(id,member_id,content_id,content_version,goal_at_start,prompt_version) VALUES($1,$2,$3,1,'everyday','retained-unknown')",
    [id, f.owner.id, f.source.id],
  );
  await pool.query(
    "INSERT INTO private_practice_exchanges(session_id,sequence,response,comparison,source_excerpt) VALUES($1,1,'Retained words','Historical comparison','Historical excerpt')",
    [id],
  );
  expect(await practice.detail(f.owner.token, id)).toMatchObject({
    prompt: null,
    availability: "unknown-template",
    exchanges: [
      { response: "Retained words", comparison: "Historical comparison" },
    ],
  });
  expect(await append(f.owner.token, id, 1, "Retained words")).toBe(
    "unavailable",
  );
  expect(await practice.withdraw(f.owner.token, id)).toBe("withdrawn");
});
it("atomically removes every response-derived byte, preserves only metadata, and keeps other owners intact", async () => {
  const f = await fixture(),
    id = await f.begin(),
    otherId = await f.begin(f.other.token);
  await append(f.owner.token, id, 1, "Erase this exact text");
  await append(f.other.token, otherId, 1, "Keep other words");
  expect(await practice.withdraw(f.owner.token, id)).toBe("withdrawn");
  expect(await practice.withdraw(f.owner.token, id)).toBe("already-withdrawn");
  expect(await append(f.owner.token, id, 1, "Erase this exact text")).toBe(
    "withdrawn",
  );
  expect(await practice.start(f.owner.token, f.input)).toEqual({
    kind: "withdrawn",
  });
  expect(await practice.detail(f.owner.token, id)).toMatchObject({
    withdrawnAt: expect.any(Date),
    prompt: null,
    exchanges: [],
    nextSequence: null,
    availability: "withdrawn",
  });
  expect(
    (
      await pool.query(
        "SELECT * FROM private_practice_exchanges WHERE session_id=$1",
        [id],
      )
    ).rows,
  ).toEqual([]);
  expect(
    Object.keys(
      (
        await pool.query(
          "SELECT * FROM private_practice_sessions WHERE id=$1",
          [id],
        )
      ).rows[0],
    ).sort(),
  ).toEqual(
    [
      "id",
      "member_id",
      "content_id",
      "content_version",
      "goal_at_start",
      "prompt_version",
      "created_at",
      "withdrawn_at",
    ].sort(),
  );
  await db.remove(f.owner.id);
  expect(
    (
      await pool.query(
        "SELECT * FROM private_practice_sessions WHERE member_id=$1",
        [f.owner.id],
      )
    ).rows,
  ).toEqual([]);
  expect(await practice.detail(f.other.token, otherId)).toMatchObject({
    exchanges: [{ response: "Keep other words" }],
  });
});
it("pages metadata with stable UUID ties and preserved microseconds without gaps or duplicates", async () => {
  const f = await fixture();
  const ids: string[] = [];
  for (let i = 0; i < 43; i++) {
    const id = randomUUID();
    ids.push(id);
    await pool.query(
      "INSERT INTO private_practice_sessions(id,member_id,content_id,content_version,goal_at_start,prompt_version,created_at) VALUES($1,$2,$3,1,'everyday',$4,'2026-01-01T00:00:00.123000Z'::timestamptz+$5::integer*interval '1 microsecond')",
      [id, f.owner.id, f.source.id, `retained-${i}`, i % 23],
    );
  }
  let after: string | undefined;
  const collected: string[] = [];
  do {
    const page = (await practice.history(f.owner.token, after))!;
    expect(page.items.length).toBeLessThanOrEqual(20);
    expect(page.items.every((row) => !Object.hasOwn(row, "response"))).toBe(
      true,
    );
    collected.push(...page.items.map((row) => row.id));
    after = page.nextCursor ?? undefined;
  } while (after);
  expect(collected).toHaveLength(43);
  expect(new Set(collected)).toEqual(new Set(ids));
  expect(collected).toEqual(
    (
      await pool.query(
        "SELECT id FROM private_practice_sessions WHERE member_id=$1 ORDER BY created_at DESC,id DESC",
        [f.owner.id],
      )
    ).rows.map((row) => row.id),
  );
});
it("enforces immutable metadata/pairs and structural size/sequence constraints in PostgreSQL", async () => {
  const f = await fixture(),
    id = await f.begin();
  expect(await append(f.owner.token, id, 1, "x".repeat(1000))).toBe("saved");
  for (const [field, value] of [
    ["id", randomUUID()],
    ["member_id", f.other.id],
    ["content_id", "SYN-999"],
    ["content_version", 2],
    ["goal_at_start", "work"],
    ["prompt_version", "changed"],
    ["created_at", new Date("2020-01-01")],
  ])
    await expect(
      pool.query(
        `UPDATE private_practice_sessions SET ${field}=$2 WHERE id=$1`,
        [id, value],
      ),
    ).rejects.toThrow("immutable");
  await expect(
    pool.query(
      "UPDATE private_practice_exchanges SET response='changed' WHERE session_id=$1",
      [id],
    ),
  ).rejects.toThrow("immutable");
  for (const [sequence, response, comparison, excerpt] of [
    [0, "x", "y", "z"],
    [16, "x", "y", "z"],
    [2, "", "y", "z"],
    [2, " ", "y", "z"],
    [2, "x".repeat(1001), "y", "z"],
    [2, "x", "y".repeat(4001), "z"],
    [2, "x", "y", "z".repeat(601)],
  ] as const)
    await expect(
      pool.query(
        "INSERT INTO private_practice_exchanges(session_id,sequence,response,comparison,source_excerpt) VALUES($1,$2,$3,$4,$5)",
        [id, sequence, response, comparison, excerpt],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  await practice.withdraw(f.owner.token, id);
  await expect(
    pool.query(
      "UPDATE private_practice_sessions SET withdrawn_at=NULL WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query(
      "UPDATE private_practice_sessions SET withdrawn_at=clock_timestamp() WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow("immutable");
  await migrate(pool);
  expect(await practice.detail(f.owner.token, id)).toMatchObject({
    availability: "withdrawn",
    exchanges: [],
  });
});
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function controlled(match?: string) {
  const connected = latch(),
    reached = latch(),
    resume = latch(),
    state = { pid: 0 };
  const use = practiceSessionStore({
    async connect() {
      const client = await pool.connect();
      state.pid = (
        await client.query("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      connected.release();
      let paused = false;
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (match && !paused && sql.startsWith(match)) {
            paused = true;
            reached.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool);
  return { use, connected, reached, resume, state };
}
async function blocked(pid: number, by: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (
      (
        await pool.query(
          "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) blocked",
          [by, pid],
        )
      ).rows[0].blocked
    )
      return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Expected PostgreSQL lock wait was not observed");
}
it("retains the exact source for an append overlapping replacement publication, then denies new pairs", async () => {
  const f = await fixture(),
    id = await f.begin(),
    client = await pool.connect(),
    waiting = controlled();
  let pending: Promise<unknown> | undefined;
  try {
    await client.query("BEGIN");
    const pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await client.query(
      "SELECT id FROM private_practice_sessions WHERE id=$1 FOR UPDATE",
      [id],
    );
    pending = append(
      f.owner.token,
      id,
      1,
      "Overlapping invented words",
      waiting.use,
    );
    await waiting.connected.wait;
    await blocked(waiting.state.pid, pid);
    expect(
      (
        await pool.query("SELECT query FROM pg_stat_activity WHERE pid=$1", [
          waiting.state.pid,
        ])
      ).rows[0].query,
    ).toContain("FOR UPDATE OF s");
    // The append has read eligible v1 and holds the owner's workspace lock.
    // Publication inserts a new row, so it may complete while this append waits.
    // These overlapping operations can linearize append before publication;
    // subsequent operations must re-evaluate and reject the replaced source.
    await f.publish(2, f.source.id, { body: "Replacement invented source" });
    expect(
      (
        await pool.query("SELECT member_content_eligible($1,$2,1) eligible", [
          f.owner.id,
          f.source.id,
        ])
      ).rows[0].eligible,
    ).toBe(false);
    await client.query("COMMIT");
    expect(await pending).toBe("saved");
    expect(await practice.detail(f.owner.token, id)).toMatchObject({
      contentVersion: 1,
      availability: "source-unavailable",
      exchanges: [
        {
          sequence: 1,
          response: "Overlapping invented words",
          sourceExcerpt: f.source.body,
        },
      ],
    });
    expect(
      (
        await pool.query(
          `SELECT e.accepted_at>cv.published_at AS "acceptedAfterPublication"
        FROM private_practice_exchanges e JOIN content_versions cv ON cv.id=$2 AND cv.version=2
        WHERE e.session_id=$1 AND e.sequence=1`,
          [id, f.source.id],
        )
      ).rows[0].acceptedAfterPublication,
    ).toBe(true);
    expect(
      await append(f.owner.token, id, 2, "New post-publication words"),
    ).toBe("unavailable");
    expect(await practice.start(f.owner.token, f.input)).toEqual({
      kind: "unavailable",
    });
    expect((await practice.detail(f.owner.token, id))!.exchanges).toHaveLength(
      1,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await Promise.allSettled(pending ? [pending] : []);
  }
});
it.each(["append-first", "withdraw-first"] as const)(
  "serializes %s without replay resurrecting withdrawn text",
  async (order) => {
    const f = await fixture(),
      id = await f.begin();
    await append(f.owner.token, id);
    const first = controlled("SELECT id FROM workspaces"),
      second = controlled();
    const a =
      order === "append-first"
        ? append(f.owner.token, id, 2, "Second", first.use)
        : first.use.withdraw(f.owner.token, id);
    let b: Promise<unknown> | undefined;
    try {
      await first.reached.wait;
      b =
        order === "append-first"
          ? second.use.withdraw(f.owner.token, id)
          : append(f.owner.token, id, 1, "Invented response", second.use);
      await second.connected.wait;
      await blocked(second.state.pid, first.state.pid);
      first.resume.release();
      expect(await a).toBe(order === "append-first" ? "saved" : "withdrawn");
      expect(await b).toBe("withdrawn");
      expect(await practice.detail(f.owner.token, id)).toMatchObject({
        exchanges: [],
        availability: "withdrawn",
      });
    } finally {
      first.resume.release();
      await Promise.allSettled([a, ...(b ? [b] : [])]);
    }
  },
);
it.each(["delete", "revoke", "expire", "deleting", "goal", "retire"] as const)(
  "denies a waiting append when %s commits first",
  async (change) => {
    const f = await fixture(),
      id = await f.begin(),
      client = await pool.connect(),
      waiting = controlled();
    let pending: Promise<unknown> | undefined;
    try {
      await client.query("BEGIN");
      const pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      if (change === "delete")
        await store(client as unknown as Pool).remove(f.owner.id);
      else
        await client.query(
          change === "revoke"
            ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
            : change === "expire"
              ? "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1"
              : change === "deleting"
                ? "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1"
                : change === "goal"
                  ? "UPDATE learners SET goal='work' WHERE id=$1"
                  : "UPDATE content_versions SET state='retired',retired_at=clock_timestamp() WHERE id=$1",
          [change === "retire" ? f.source.id : f.owner.id],
        );
      pending = append(f.owner.token, id, 1, "Should never save", waiting.use);
      await waiting.connected.wait;
      await blocked(waiting.state.pid, pid);
      await client.query("COMMIT");
      expect(await pending).toBe("unavailable");
      expect(
        (
          await pool.query(
            "SELECT * FROM private_practice_exchanges WHERE session_id=$1",
            [id],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await Promise.allSettled(pending ? [pending] : []);
    }
  },
);
it("commits an append before waiting account deletion, then cascades both tables without touching another owner", async () => {
  const f = await fixture(),
    id = await f.begin(),
    otherId = await f.begin(f.other.token);
  await append(f.other.token, otherId);
  const first = controlled("INSERT INTO private_practice_exchanges"),
    client = await pool.connect();
  const saving = append(f.owner.token, id, 1, "Commit then erase", first.use);
  let deleting: Promise<unknown> | undefined;
  try {
    await first.reached.wait;
    const pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    deleting = store(client as unknown as Pool).remove(f.owner.id);
    await blocked(pid, first.state.pid);
    first.resume.release();
    expect(await saving).toBe("saved");
    await deleting;
    expect(await practice.history(f.owner.token)).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT * FROM private_practice_sessions WHERE member_id=$1",
          [f.owner.id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT * FROM private_practice_exchanges WHERE session_id=$1",
          [id],
        )
      ).rows,
    ).toEqual([]);
    expect(await practice.detail(f.other.token, otherId)).toMatchObject({
      exchanges: [{ response: "Invented response" }],
    });
  } finally {
    first.resume.release();
    await Promise.allSettled([saving, ...(deleting ? [deleting] : [])]);
    client.release();
  }
});
const invoke = (
  operation: "append" | "withdraw" | "detail" | "history",
  use: PracticeSessionStore,
  value: string,
  id: string,
) =>
  operation === "append"
    ? append(value, id, 2, "Must roll back", use)
    : operation === "withdraw"
      ? use.withdraw(value, id)
      : operation === "detail"
        ? use.detail(value, id)
        : use.history(value);
it.each(["detail", "history"] as const)(
  "reads %s only after a waiting withdrawal has removed its text",
  async (operation) => {
    const f = await fixture(),
      id = await f.begin();
    await append(f.owner.token, id);
    const first = controlled("DELETE FROM private_practice_exchanges"),
      second = controlled();
    const withdrawing = first.use.withdraw(f.owner.token, id);
    let reading: Promise<unknown> | undefined;
    try {
      await first.reached.wait;
      reading = invoke(operation, second.use, f.owner.token, id);
      await second.connected.wait;
      await blocked(second.state.pid, first.state.pid);
      first.resume.release();
      expect(await withdrawing).toBe("withdrawn");
      expect(await reading).toMatchObject(
        operation === "detail"
          ? { exchanges: [], prompt: null, availability: "withdrawn" }
          : { items: [{ id, withdrawnAt: expect.any(Date) }] },
      );
      expect(JSON.stringify(await reading)).not.toContain("Invented response");
    } finally {
      first.resume.release();
      await Promise.allSettled([withdrawing, ...(reading ? [reading] : [])]);
    }
  },
);
it.each(["start", "append", "withdraw"] as const)(
  "rolls back %s when wall-time expiry occurs after its writes",
  async (operation) => {
    const f = await fixture(),
      id = operation === "start" ? null : await f.begin();
    if (id) await append(f.owner.token, id);
    const expires = (
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1 RETURNING expires_at",
        [f.owner.id],
      )
    ).rows[0].expires_at as Date;
    const first = controlled(
      operation === "start"
        ? "INSERT INTO private_practice_sessions"
        : operation === "append"
          ? "INSERT INTO private_practice_exchanges"
          : "UPDATE private_practice_sessions SET withdrawn_at",
    );
    const pending =
      operation === "start"
        ? first.use.start(f.owner.token, f.input)
        : invoke(operation, first.use, f.owner.token, id!);
    try {
      await first.reached.wait;
      while (
        !(
          await pool.query(
            "SELECT clock_timestamp()>=$1::timestamptz expired",
            [expires],
          )
        ).rows[0].expired
      )
        await new Promise((r) => setTimeout(r, 5));
      first.resume.release();
      expect(await pending).toEqual(
        operation === "start" ? { kind: "unavailable" } : "unavailable",
      );
      const rows = (
        await pool.query(
          "SELECT id,withdrawn_at FROM private_practice_sessions WHERE member_id=$1",
          [f.owner.id],
        )
      ).rows;
      expect(rows).toEqual(
        operation === "start" ? [] : [{ id, withdrawn_at: null }],
      );
      if (id)
        expect(
          (
            await pool.query(
              "SELECT response FROM private_practice_exchanges WHERE session_id=$1",
              [id],
            )
          ).rows,
        ).toEqual([{ response: "Invented response" }]);
    } finally {
      first.resume.release();
      await Promise.allSettled([pending]);
    }
  },
);
it.each(["append", "withdraw", "detail", "history"] as const)(
  "denies %s after expiry while waiting on an owned session lock",
  async (operation) => {
    const f = await fixture(),
      id = await f.begin();
    await append(f.owner.token, id);
    const expires = (
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1 RETURNING expires_at",
        [f.owner.id],
      )
    ).rows[0].expires_at as Date;
    const client = await pool.connect(),
      waiting = controlled();
    let pending: Promise<unknown> | undefined;
    try {
      await client.query("BEGIN");
      const pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      await client.query(
        "SELECT id FROM private_practice_sessions WHERE id=$1 FOR UPDATE",
        [id],
      );
      pending = invoke(operation, waiting.use, f.owner.token, id);
      await waiting.connected.wait;
      await blocked(waiting.state.pid, pid);
      while (
        !(
          await pool.query(
            "SELECT clock_timestamp()>=$1::timestamptz expired",
            [expires],
          )
        ).rows[0].expired
      )
        await new Promise((r) => setTimeout(r, 5));
      await client.query("COMMIT");
      expect(await pending).toBe(
        operation === "append" || operation === "withdraw"
          ? "unavailable"
          : null,
      );
      expect(
        (
          await pool.query(
            "SELECT response FROM private_practice_exchanges WHERE session_id=$1",
            [id],
          )
        ).rows,
      ).toEqual([{ response: "Invented response" }]);
      expect(
        (
          await pool.query(
            "SELECT withdrawn_at FROM private_practice_sessions WHERE id=$1",
            [id],
          )
        ).rows[0].withdrawn_at,
      ).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await Promise.allSettled(pending ? [pending] : []);
    }
  },
);
it("rolls back a failed pair insert and a failed withdrawal after deleting text", async () => {
  const f = await fixture(),
    id = await f.begin();
  await append(f.owner.token, id);
  await pool.query(
    "CREATE FUNCTION dne_test_practice_session_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic private failure'; END $$",
  );
  try {
    await pool.query(
      "CREATE TRIGGER dne_test_pair_fail BEFORE INSERT ON private_practice_exchanges FOR EACH ROW EXECUTE FUNCTION dne_test_practice_session_fail()",
    );
    await expect(append(f.owner.token, id, 2)).rejects.toThrow(
      /^Practice session unavailable$/,
    );
    await pool.query(
      "DROP TRIGGER dne_test_pair_fail ON private_practice_exchanges",
    );
    await pool.query(
      "CREATE TRIGGER dne_test_marker_fail BEFORE UPDATE ON private_practice_sessions FOR EACH ROW EXECUTE FUNCTION dne_test_practice_session_fail()",
    );
    await expect(practice.withdraw(f.owner.token, id)).rejects.toThrow(
      /^Practice session unavailable$/,
    );
    expect(await practice.detail(f.owner.token, id)).toMatchObject({
      withdrawnAt: null,
      exchanges: [{ sequence: 1, response: "Invented response" }],
    });
  } finally {
    await pool.query(
      "DROP TRIGGER IF EXISTS dne_test_pair_fail ON private_practice_exchanges; DROP TRIGGER IF EXISTS dne_test_marker_fail ON private_practice_sessions; DROP FUNCTION dne_test_practice_session_fail()",
    );
  }
});
it.each(["append", "withdraw"] as const)(
  "reports an uncertain %s commit without replay and reloads its actual durable result",
  async (operation) => {
    const f = await fixture(),
      id = await f.begin();
    await append(f.owner.token, id);
    let commits = 0;
    const uncertain = practiceSessionStore({
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              commits++;
              throw Error("Lost acknowledgment");
            }
            return result;
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool);
    await expect(
      invoke(operation, uncertain, f.owner.token, id),
    ).rejects.toThrow(/^Practice session unavailable$/);
    expect(commits).toBe(1);
    const actual = (await practice.detail(f.owner.token, id))!;
    expect(actual.exchanges).toHaveLength(operation === "append" ? 2 : 0);
    expect(actual.availability).toBe(
      operation === "append" ? "available" : "withdrawn",
    );
  },
);
it("discards a connection whose rollback fails and leaves the original history readable", async () => {
  const f = await fixture(),
    id = await f.begin();
  await append(f.owner.token, id);
  const isolated = testPool();
  let discarded = false;
  const failing = practiceSessionStore({
    async connect() {
      const client = await isolated.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql === "COMMIT" || sql === "ROLLBACK")
            throw Error("Disconnected transaction");
          return client.query(sql, values);
        },
        release(error?: Error) {
          discarded = error instanceof Error;
          client.release(error);
        },
      };
    },
  } as unknown as Pool);
  try {
    await expect(failing.withdraw(f.owner.token, id)).rejects.toThrow(
      /^Practice session unavailable$/,
    );
    expect(discarded).toBe(true);
    expect(await practice.detail(f.owner.token, id)).toMatchObject({
      withdrawnAt: null,
      exchanges: [{ response: "Invented response" }],
    });
  } finally {
    await isolated.end();
  }
});
