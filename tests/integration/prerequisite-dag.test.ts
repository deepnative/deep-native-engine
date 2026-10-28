import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { ContentVersion } from "../../src/catalog.ts";
import { authorizationStore } from "../../src/authorization.ts";
import {
  prerequisitesMet,
  type PrerequisiteAtom,
} from "../../src/prerequisites.ts";
import { migrate, store, type LessonActivity } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const token = () => randomBytes(32).toString("hex");
let editor: string;
let owner: string;
let outsider: string;
const atom = (id: string): Extract<PrerequisiteAtom, { kind: "lesson" }> => ({
  kind: "lesson",
  id,
  version: 1,
  activity: "started",
});
const item = (id: string, all: PrerequisiteAtom[] = []): ContentVersion => ({
  id,
  version: 1,
  kind: "lesson",
  origin: "curated",
  title: "Invented prerequisite",
  body: "Synthetic graph only.",
  owner: "Synthetic editor",
  sources: "Invented",
  rights: "Owned",
  goals: [],
  backgrounds: [],
  domains: [],
  prerequisites: "",
  structuredPrerequisites: { schemaVersion: 1, all },
  minimumExperience: "new",
  rubric: null,
  rubricVersion: null,
  state: "published",
  requiresQualifiedSignoff: false,
  reviewedAt: new Date(),
  publishedAt: new Date(),
});
beforeAll(async () => {
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
  editor = await authorizationStore(pool).provisionStaff(
    token(),
    "editor",
    new Date(Date.now() + 86400000),
  );
  const members = await Promise.all(
    [0, 1].map(async () => {
      const t = token();
      await db.create(t, { background: "explorer", goal: "everyday" });
      const session = await db.session(t);
      if (session.kind !== "active")
        throw new Error("Missing synthetic member");
      return session.learner.id;
    }),
  );
  [owner, outsider] = members as [string, string];
});
afterEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => {
  await pool.end();
});

async function seed(items: ContentVersion[]) {
  // Direct synthetic fixtures isolate eligibility from authoring validation.
  await pool.query(
    `INSERT INTO content_versions
    (id,version,kind,origin,title,body,owner,sources,rights,prerequisites,structured_prerequisites,
     state,reviewed_by,reviewed_at,rights_confirmed,published_at,retired_at)
    SELECT x.id,x.version,x.kind,x.origin,x.title,x.body,x.owner,x.sources,x.rights,x.prerequisites,
      x."structuredPrerequisites",x.state,$2,clock_timestamp(),true,x."publishedAt",
      CASE WHEN x.state='retired' THEN clock_timestamp() END
    FROM jsonb_to_recordset($1::jsonb) AS x(id text,version integer,kind text,origin text,title text,
      body text,owner text,sources text,rights text,prerequisites text,"structuredPrerequisites" jsonb,
      state text,"publishedAt" timestamptz)`,
    [JSON.stringify(items), editor],
  );
  await pool.query(
    `INSERT INTO lesson_activity(member_id,content_id,content_version,started_at)
    SELECT $1,id,version,clock_timestamp() FROM content_versions WHERE kind='lesson'`,
    [owner],
  );
}
async function eligible(
  root: ContentVersion,
  member = owner,
  seen: string[] = [],
) {
  return (
    await pool.query("SELECT member_prerequisites_met($1,$2,$3,$4) AS met", [
      member,
      root.id,
      root.version,
      seen,
    ])
  ).rows[0].met as boolean;
}
const observed = (items: ContentVersion[]): LessonActivity[] =>
  items.map((entry) => ({
    contentId: entry.id,
    contentVersion: entry.version,
    openedAt: new Date(),
    startedAt: new Date(),
    selfAssessedAt: null,
    available: true,
  }));

it("AUDIT-DAG-01 evaluates a completed 37-record shared graph within a bounded SQL query and isolates members", async () => {
  const items = Array.from({ length: 37 }, (_, index) => {
    const first = index === 0 ? 1 : 1 + Math.ceil(index / 4) * 4;
    return item(
      `SYN-${100 + index}`,
      first >= 37
        ? []
        : Array.from({ length: 4 }, (_, child) =>
            atom(`SYN-${100 + first + child}`),
          ),
    );
  });
  items[0]!.kind = "assignment";
  await seed(items);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='2s'");
    expect(
      (
        await client.query("SELECT member_prerequisites_met($1,$2,1) AS met", [
          owner,
          items[0]!.id,
        ])
      ).rows[0].met,
    ).toBe(true);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  await migrate(pool);
  expect(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM content_versions WHERE id=ANY($1)",
          [items.map((entry) => entry.id)],
        )
      ).rows[0].count,
    ),
  ).toBe(37);
  expect(await eligible(items[0]!, outsider)).toBe(false);
  expect(await eligible(items[0]!)).toBe(
    prerequisitesMet(items[0]!, items, undefined, observed(items)),
  );
  await pool.query(
    "UPDATE lesson_activity SET started_at=NULL WHERE member_id=$1 AND content_id=$2",
    [owner, items[36]!.id],
  );
  expect(await eligible(items[0]!)).toBe(false);
}, 10000);

it.each([
  "allowed",
  "overdepth",
  "cycle",
  "retired",
  "superseded",
  "draft-newer",
  "missing",
  "wrong-kind",
  "wrong-version",
  "self-assessment",
  "unrecognized",
] as const)(
  "AUDIT-DAG-01 retains TS/SQL boundary equivalence for %s",
  async (boundary) => {
    const leaf = item("SYN-701");
    const shared = item("SYN-700", [atom(leaf.id)]);
    const length = boundary === "overdepth" ? 31 : 30;
    const chain = Array.from({ length }, (_, index) =>
      item(`SYN-${100 + index}`, [
        atom(index === length - 1 ? shared.id : `SYN-${101 + index}`),
      ]),
    );
    const root = item("SYN-799", [atom(shared.id), atom(chain[0]!.id)]);
    root.kind = "assignment";
    let items = [root, shared, leaf, ...chain];
    if (boundary === "cycle")
      leaf.structuredPrerequisites = {
        schemaVersion: 1,
        all: [atom(shared.id)],
      };
    if (boundary === "retired") leaf.state = "retired";
    if (boundary === "superseded" || boundary === "draft-newer")
      items.push({
        ...leaf,
        version: 2,
        state: boundary === "superseded" ? "retired" : "draft",
        publishedAt: boundary === "superseded" ? new Date() : null,
      });
    if (boundary === "missing") items = items.filter((entry) => entry !== leaf);
    if (boundary === "wrong-kind") leaf.kind = "assignment";
    if (boundary === "wrong-version") leaf.version = 2;
    if (boundary === "self-assessment")
      shared.structuredPrerequisites = {
        schemaVersion: 1,
        all: [{ ...atom(leaf.id), activity: "self-assessed" }],
      };
    if (boundary === "unrecognized") {
      leaf.structuredPrerequisites = null;
      leaf.prerequisites = "Unknown approval";
    }
    await seed(items);
    const expected = boundary === "allowed" || boundary === "draft-newer";
    expect(prerequisitesMet(root, items, undefined, observed(items))).toBe(
      expected,
    );
    expect(await eligible(root)).toBe(expected);
    expect(await eligible(root, owner, [leaf.id + ":1"])).toBe(false);
  },
);

it("AUDIT-DAG-01 keeps a source retirement blocked until the eligibility snapshot releases its lock", async () => {
  const leaf = item("SYN-701");
  const root = item("SYN-799", [atom(leaf.id)]);
  await seed([root, leaf]);
  const reader = await pool.connect();
  let retiring: Promise<unknown> | undefined;
  try {
    await reader.query("BEGIN");
    const pid = (await reader.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    expect(
      (
        await reader.query("SELECT member_prerequisites_met($1,$2,1) AS met", [
          owner,
          root.id,
        ])
      ).rows[0].met,
    ).toBe(true);
    retiring = pool.query(
      "UPDATE content_versions SET state='retired',retired_at=clock_timestamp() WHERE id=$1",
      [leaf.id],
    );
    await expect
      .poll(
        async () =>
          Number(
            (
              await pool.query(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))",
                [pid],
              )
            ).rows[0].count,
          ),
        { timeout: 3000 },
      )
      .toBe(1);
    await reader.query("COMMIT");
    await retiring;
    expect(await eligible(root)).toBe(false);
  } finally {
    await reader.query("ROLLBACK");
    reader.release();
    await Promise.allSettled(retiring ? [retiring] : []);
  }
});
