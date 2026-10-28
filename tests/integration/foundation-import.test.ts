import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, seedDraftPack } from "../../src/catalog.ts";
import { foundationImportStore } from "../../src/foundation-import.ts";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
const pool = testPool(),
  auth = authorizationStore(pool),
  catalog = catalogStore(pool),
  importer = foundationImportStore(pool),
  members = store(pool);
const token = () => randomBytes(32).toString("hex");
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts,content_versions CASCADE");
  await seedDraftPack(pool);
});
afterAll(() => pool.end());
async function staff(role: "editor" | "reviewer" | "operator" = "editor") {
  const value = token();
  const id = await auth.provisionStaff(
    value,
    role,
    new Date(Date.now() + 3600000),
  );
  return { token: value, id };
}
const versions = async () =>
  (await pool.query("SELECT * FROM content_versions ORDER BY id,version")).rows;
async function publish(editor: string, reviewer: string) {
  for (const item of await reviewedFoundation()) {
    expect(await catalog.submit(editor, item.id, 2)).toBe(true);
    expect(await catalog.approve(reviewer, item.id, 2, true)).toBe(true);
    expect(await catalog.publish(editor, item.id, 2)).toBe(true);
  }
}
it("FOUND-01 imports exactly six ordinary drafts once while preserving every original byte and flag", async () => {
  const editor = await staff(),
    before = await versions();
  expect(await importer.import(editor.token)).toBe("imported");
  const after = await versions();
  expect(after.filter((row) => row.version === 1)).toEqual(before);
  expect(after.filter((row) => row.version === 2)).toHaveLength(6);
  expect(
    after
      .filter((row) => row.version === 2)
      .every(
        (row) =>
          row.state === "draft" &&
          row.requires_qualified_signoff === false &&
          row.created_by === editor.id &&
          row.reviewed_at === null,
      ),
  ).toBe(true);
  expect(await catalog.search({})).toEqual([]);
  expect(await importer.import(editor.token)).toBe("existing");
  expect(await versions()).toEqual(after);
});
it("FOUND-02 requires distinct current source/rights review before publication and never releases v1", async () => {
  const editor = await staff(),
    reviewer = await staff("reviewer");
  await importer.import(editor.token);
  expect(await catalog.publish(editor.token, "FND-001", 2)).toBe(false);
  await catalog.submit(editor.token, "FND-001", 2);
  expect(await catalog.approve(reviewer.token, "FND-001", 2, false)).toBe(
    false,
  );
  await pool.query(
    "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
    [editor.id],
  );
  expect(await catalog.approve(editor.token, "FND-001", 2, true)).toBe(false);
  await pool.query(
    "UPDATE staff_profiles SET role='editor' WHERE principal_id=$1",
    [editor.id],
  );
  expect(await catalog.approve(reviewer.token, "FND-001", 2, true)).toBe(true);
  expect(await catalog.publish(editor.token, "FND-001", 2)).toBe(true);
  expect(await catalog.submit(editor.token, "FND-001", 1)).toBe(true);
  expect(await catalog.approve(reviewer.token, "FND-001", 1, true)).toBe(false);
  expect(await catalog.publish(editor.token, "FND-001", 1)).toBe(false);
  expect((await catalog.published("FND-001"))?.version).toBe(2);
});
it.each(["reviewer", "operator"] as const)(
  "FOUND-02 %s cannot import or write any draft",
  async (role) => {
    const actor = await staff(role),
      before = await versions();
    expect(await importer.import(actor.token)).toBe("denied");
    expect(await importer.import(token())).toBe("denied");
    expect(await versions()).toEqual(before);
  },
);
it("FOUND-01 concurrent editors create one whole pack and the second observes the same versions", async () => {
  const first = await staff(),
    second = await staff();
  expect(
    (
      await Promise.all([
        importer.import(first.token),
        importer.import(second.token),
      ])
    ).sort(),
  ).toEqual(["existing", "imported"]);
  expect((await versions()).filter((row) => row.version === 2)).toHaveLength(6);
});
it("FOUND-01 conflicting or incomplete versions refuse without filling or replacing records", async () => {
  const editor = await staff();
  await importer.import(editor.token);
  await pool.query(
    "UPDATE content_versions SET body='Another independently authored draft' WHERE id='FND-003' AND version=2",
  );
  let before = await versions();
  expect(await importer.import(editor.token)).toBe("conflict");
  expect(await versions()).toEqual(before);
  await pool.query(
    "DELETE FROM content_versions WHERE id='FND-004' AND version=2",
  );
  before = await versions();
  expect(await importer.import(editor.token)).toBe("conflict");
  expect(await versions()).toEqual(before);
});
it("FOUND-01 one failing database insertion rolls back every new draft", async () => {
  const editor = await staff(),
    before = await versions();
  await pool.query(
    "CREATE FUNCTION foundation_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='FND-004' AND NEW.version=2 THEN RAISE EXCEPTION 'invented insertion failure'; END IF; RETURN NEW; END $$",
  );
  await pool.query(
    "CREATE TRIGGER foundation_test_failure BEFORE INSERT ON content_versions FOR EACH ROW EXECUTE FUNCTION foundation_test_failure()",
  );
  try {
    expect(await importer.import(editor.token)).toBe("unavailable");
    expect(await versions()).toEqual(before);
  } finally {
    await pool.query(
      "DROP TRIGGER foundation_test_failure ON content_versions",
    );
    await pool.query("DROP FUNCTION foundation_test_failure()");
  }
});
it.each(["revoked", "expired", "wrong-role"])(
  "FOUND-02 %s during an observed native lock wait denies every import",
  async (kind) => {
    const editor = await staff(),
      holder = await pool.connect();
    let pending: ReturnType<typeof importer.import> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      await holder.query(
        kind === "wrong-role"
          ? "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1"
          : kind === "revoked"
            ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
            : "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [editor.id],
      );
      pending = importer.import(editor.token);
      let blocked = false;
      for (let n = 0; n < 200; n++) {
        if (
          (
            await pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
              [pid],
            )
          ).rowCount
        ) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      await holder.query("COMMIT");
      expect(await pending).toBe("denied");
      expect(
        (await versions()).filter((row) => row.version === 2),
      ).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled(pending ? [pending] : []);
    }
  },
);
it("FOUND-03/04 all three backgrounds read six exact versions; replacement and retirement preserve private history", async () => {
  const editor = await staff(),
    reviewer = await staff("reviewer");
  await importer.import(editor.token);
  await publish(editor.token, reviewer.token);
  const memberTokens = new Map<string, string>();
  for (const background of ["explorer", "professional", "technical"] as const) {
    const member = token();
    await members.create(member, { background, goal: "everyday" });
    const session = await members.session(member);
    if (session.kind !== "active") throw Error("Missing member");
    memberTokens.set(session.learner.id, member);
    expect(await catalog.search({ background })).toHaveLength(6);
    for (const item of await reviewedFoundation())
      expect(await members.openLesson(member, item.id, 2)).toBe(true);
    expect(await members.advanceLesson(member, "FND-001", 2, "complete")).toBe(
      false,
    );
    expect(await members.advanceLesson(member, "FND-001", 2, "start")).toBe(
      true,
    );
    expect(await members.advanceLesson(member, "FND-001", 2, "complete")).toBe(
      true,
    );
    const before = await members.lessonActivities(member);
    expect(before).toHaveLength(6);
    expect(before.filter((x) => x.selfAssessedAt)).toHaveLength(1);
    expect(await members.lessonActivities(member)).toEqual(before);
  }
  const replacement = {
    ...(await reviewedFoundation())[0]!,
    version: 3,
    body: "A deliberately authored replacement lesson.",
  };
  expect(await catalog.createDraft(editor.token, replacement)).toBe(true);
  await catalog.submit(editor.token, replacement.id, 3);
  await catalog.approve(reviewer.token, replacement.id, 3, true);
  await catalog.publish(editor.token, replacement.id, 3);
  const retained = (
    await pool.query(
      "SELECT member_id FROM lesson_activity WHERE content_id='FND-001' AND content_version=2",
    )
  ).rows;
  for (const row of retained) {
    const member = memberTokens.get(row.member_id);
    if (!member) throw Error("Missing original member session");
    expect(
      (await members.lessonActivities(member)).find(
        (x) => x.contentId === "FND-001",
      )?.available,
    ).toBe(false);
    expect(await members.openLesson(member, "FND-001", 2)).toBe(false);
  }
  await catalog.retire(editor.token, "FND-001");
  expect(await importer.import(editor.token)).toBe("conflict");
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM lesson_activity WHERE content_id='FND-001' AND content_version=2",
      )
    ).rows[0].count,
  ).toBe(3);
});

it("FOUND-04 a lost acknowledgement after actual COMMIT never reports success and deliberate inspection/replay finds the one whole pack", async () => {
  const editor = await staff();
  const uncertainPool = {
    async connect() {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql === "COMMIT")
            throw Error("Invented lost commit acknowledgement");
          return result;
        },
        release: (error?: Error | boolean) => client.release(error),
      };
    },
  } as unknown as Pool;
  expect(await foundationImportStore(uncertainPool).import(editor.token)).toBe(
    "unavailable",
  );
  const committed = await versions();
  expect(committed.filter((x) => x.version === 2)).toHaveLength(6);
  expect(await importer.import(editor.token)).toBe("existing");
  expect(await versions()).toEqual(committed);
});
