import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, seedDraftPack } from "../../src/catalog.ts";
import { foundationImportStore } from "../../src/foundation-import.ts";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
import {
  reviewedAssignments,
  reviewedAssignmentImportStore,
} from "../../src/reviewed-assignments.ts";
import { assignmentReadinessStore } from "../../src/assignment-readiness.ts";
import { attemptStore } from "../../src/attempts.ts";
const pool = testPool(),
  auth = authorizationStore(pool),
  catalog = catalogStore(pool),
  members = store(pool),
  importer = reviewedAssignmentImportStore(pool),
  readiness = assignmentReadinessStore(pool),
  attempts = attemptStore(pool);
const token = () => randomBytes(32).toString("hex");
let editor: string, reviewer: string;
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts,content_versions CASCADE");
  await seedDraftPack(pool);
  editor = token();
  reviewer = token();
  await auth.provisionStaff(editor, "editor", new Date(Date.now() + 3600000));
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 3600000),
  );
});
afterAll(() => pool.end());
const versions = async () =>
  (await pool.query("SELECT * FROM content_versions ORDER BY id,version")).rows;
async function foundation() {
  expect(await foundationImportStore(pool).import(editor)).toBe("imported");
  for (const item of await reviewedFoundation()) {
    expect(await catalog.submit(editor, item.id, 2)).toBe(true);
    expect(await catalog.approve(reviewer, item.id, 2, true)).toBe(true);
    expect(await catalog.publish(editor, item.id, 2)).toBe(true);
  }
}
async function published() {
  await foundation();
  expect(await importer.import(editor)).toBe("imported");
  for (const item of await reviewedAssignments()) {
    expect(await catalog.submit(editor, item.id, 2)).toBe(true);
    expect(await catalog.approve(reviewer, item.id, 2, true)).toBe(true);
    expect(await catalog.publish(editor, item.id, 2)).toBe(true);
  }
}
async function member(
  background: "explorer" | "professional" | "technical",
  goal: "everyday" | "work" | "build",
) {
  const value = token();
  await members.create(value, { background, goal });
  const session = await members.session(value);
  if (session.kind !== "active") throw Error("Missing invented member");
  return { token: value, id: session.learner.id };
}
async function prepare(id: string) {
  for (const contentId of ["FND-002", "FND-003"]) {
    expect(await members.openLesson(id, contentId, 2)).toBe(true);
    expect(await members.advanceLesson(id, contentId, 2, "start")).toBe(true);
    expect(await members.advanceLesson(id, contentId, 2, "complete")).toBe(
      true,
    );
  }
}
it("ASN103-01 imports two whole immutable ordinary drafts once and preserves all original rows", async () => {
  const before = await versions();
  expect(
    (
      await Promise.all([importer.import(editor), importer.import(editor)])
    ).sort(),
  ).toEqual(["existing", "imported"]);
  const after = await versions();
  expect(after.filter((x) => x.version === 1)).toEqual(before);
  const rows = after.filter((x) => x.version === 2);
  expect(rows).toHaveLength(2);
  expect(
    rows.every(
      (x) =>
        x.state === "draft" &&
        !x.requires_qualified_signoff &&
        x.reviewed_at === null &&
        x.rubric_version === 1,
    ),
  ).toBe(true);
  expect(await catalog.search({})).toEqual([]);
  expect(await importer.import(reviewer)).toBe("denied");
  expect(await importer.import(token())).toBe("denied");
  expect(await versions()).toEqual(after);
});
it("ASN103-01 requires published exact preparation and distinct ordinary source/rights review", async () => {
  await importer.import(editor);
  expect(await catalog.publish(editor, "ASN-002", 2)).toBe(false);
  expect(await catalog.submit(editor, "ASN-002", 2)).toBe(true);
  expect(await catalog.approve(reviewer, "ASN-002", 2, true)).toBe(false);
  await foundation();
  expect(await catalog.approve(reviewer, "ASN-002", 2, false)).toBe(false);
  await pool.query(
    "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=(SELECT id FROM principals WHERE token_hash=encode(sha256($1::bytea),'hex'))",
    [editor],
  );
  expect(await catalog.approve(editor, "ASN-002", 2, true)).toBe(false);
  await pool.query(
    "UPDATE staff_profiles SET role='editor' WHERE principal_id=(SELECT id FROM principals WHERE token_hash=encode(sha256($1::bytea),'hex'))",
    [editor],
  );
  expect(await catalog.approve(reviewer, "ASN-002", 2, true)).toBe(true);
  expect(await catalog.publish(editor, "ASN-002", 2)).toBe(true);
  expect((await catalog.published("ASN-002"))?.rubricVersion).toBe(1);
  expect(await catalog.submit(editor, "ASN-002", 1)).toBe(true);
  expect(await catalog.approve(reviewer, "ASN-002", 1, true)).toBe(false);
});
it("ASN103-02 all three backgrounds use observed preparation and retain private exact assignment submissions", async () => {
  await published();
  for (const [background, goal] of [
    ["explorer", "everyday"],
    ["professional", "work"],
    ["technical", "build"],
  ] as const) {
    const owner = await member(background, goal),
      outsider = await member(background, goal);
    expect(await readiness.get(owner.token, "ASN-002", 2)).toMatchObject({
      eligible: false,
      requirements: [
        { contentId: "FND-002", contentVersion: 2, observed: "not-started" },
        { contentId: "FND-003", contentVersion: 2, observed: "not-started" },
      ],
    });
    expect(await members.chooseAssignment(owner.id, "ASN-002", 2)).toBe(false);
    expect(await members.openLesson(owner.id, "FND-002", 2)).toBe(true);
    expect(
      await members.advanceLesson(owner.id, "FND-002", 2, "complete"),
    ).toBe(false);
    expect((await readiness.get(owner.token, "ASN-002", 2))?.eligible).toBe(
      false,
    );
    await prepare(owner.id);
    expect((await readiness.get(owner.token, "ASN-002", 2))?.eligible).toBe(
      true,
    );
    expect((await readiness.get(outsider.token, "ASN-002", 2))?.eligible).toBe(
      false,
    );
    expect(await members.chooseAssignment(owner.id, "ASN-002", 2)).toBe(true);
    const id = await attempts.start(owner.token);
    expect(id).not.toBeNull();
    const response =
      "Sam drafts before the trial; the exact trial date and announcement owner remain unknown.";
    expect((await attempts.detail(owner.token, id!))?.revision).toBe(1);
    expect(await attempts.save(owner.token, id!, 0, response)).toBe(false);
    expect(await attempts.save(owner.token, id!, 1, response)).toBe(true);
    expect(await attempts.submit(owner.token, id!, 2)).toBe(true);
    const saved = await attempts.detail(owner.token, id!);
    expect(saved).toMatchObject({
      contentId: "ASN-002",
      contentVersion: 2,
      rubricVersion: 1,
      response,
      submissions: [{ sequence: 1, response }],
    });
    expect(await attempts.detail(owner.token, id!)).toEqual(saved);
    expect(await attempts.detail(outsider.token, id!)).toBeNull();
    expect(
      await attempts.save(
        outsider.token,
        id!,
        1,
        "Another member's forbidden replacement",
      ),
    ).toBe(false);
  }
});
it("ASN103-03 changed goals and retired preparation remove current eligibility without rewriting private work", async () => {
  await published();
  const owner = await member("explorer", "build");
  await prepare(owner.id);
  expect(await members.chooseAssignment(owner.id, "ASN-001", 2)).toBe(true);
  const id = await attempts.start(owner.token);
  expect(
    await attempts.save(
      owner.token,
      id!,
      1,
      "Candidate tests are not run; password rules and delivery behavior are unknown.",
    ),
  ).toBe(true);
  expect(await attempts.submit(owner.token, id!, 2)).toBe(true);
  const before = await attempts.detail(owner.token, id!);
  expect(
    await members.updateProfile(owner.id, {
      background: "explorer",
      goal: "everyday",
      backgroundTags: [],
      domainTags: [],
      itRoles: [],
      experience: "new",
      exploratory: true,
    }),
  ).toBe(true);
  expect(await readiness.get(owner.token, "ASN-001", 2)).toBeNull();
  expect(await members.chooseAssignment(owner.id, "ASN-001", 2)).toBe(false);
  expect((await readiness.get(owner.token, "ASN-002", 2))?.eligible).toBe(true);
  expect(await catalog.retire(editor, "FND-003")).toBe(true);
  expect((await readiness.get(owner.token, "ASN-002", 2))?.eligible).toBe(
    false,
  );
  expect(await members.chooseAssignment(owner.id, "ASN-002", 2)).toBe(false);
  const after = await attempts.detail(owner.token, id!);
  expect(after?.submissions).toEqual(before?.submissions);
  expect(after).toMatchObject({
    contentVersion: 2,
    goalAtStart: "build",
    response: before!.response,
    currentEligible: false,
  });
  expect(await members.assignmentChoice(owner.id)).toMatchObject({
    contentId: "ASN-001",
    contentVersion: 2,
  });
});
it("ASN103-01 conflict, retirement and atomic write failure never replace or partially add reviewed assignments", async () => {
  await pool.query(
    "CREATE FUNCTION deny_reviewed_assignment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='ASN-002' AND NEW.version=2 THEN RAISE EXCEPTION 'invented assignment write failure'; END IF; RETURN NEW; END $$",
  );
  await pool.query(
    "CREATE TRIGGER deny_reviewed_assignment BEFORE INSERT ON content_versions FOR EACH ROW EXECUTE FUNCTION deny_reviewed_assignment()",
  );
  try {
    expect(await importer.import(editor)).toBe("unavailable");
    expect((await versions()).filter((x) => x.version === 2)).toHaveLength(0);
  } finally {
    await pool.query(
      "DROP TRIGGER deny_reviewed_assignment ON content_versions",
    );
    await pool.query("DROP FUNCTION deny_reviewed_assignment()");
  }
  expect(await importer.import(editor)).toBe("imported");
  await pool.query(
    "UPDATE content_versions SET body='Different authored content' WHERE id='ASN-001' AND version=2",
  );
  const before = await versions();
  expect(await importer.import(editor)).toBe("conflict");
  expect(await versions()).toEqual(before);
});
it("ASN103-03 a published replacement never migrates a selected older assignment or permits a stale start", async () => {
  await published();
  const owner = await member("professional", "work");
  await prepare(owner.id);
  expect(await members.chooseAssignment(owner.id, "ASN-002", 2)).toBe(true);
  const id = await attempts.start(owner.token);
  const replacement = {
    ...(await reviewedAssignments())[1]!,
    version: 3,
    body: "A new deliberately authored assignment version.",
  };
  expect(await catalog.createDraft(editor, replacement)).toBe(true);
  expect(await catalog.submit(editor, "ASN-002", 3)).toBe(true);
  expect(await catalog.approve(reviewer, "ASN-002", 3, true)).toBe(true);
  expect(await catalog.publish(editor, "ASN-002", 3)).toBe(true);
  expect(await members.chooseAssignment(owner.id, "ASN-002", 2)).toBe(false);
  expect(await attempts.start(owner.token)).toBeNull();
  expect(await attempts.detail(owner.token, id!)).toMatchObject({
    contentVersion: 2,
    currentPublished: false,
    currentEligible: false,
  });
  expect(await importer.import(editor)).toBe("conflict");
});
