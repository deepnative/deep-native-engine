import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { authorizationStore } from "../../src/authorization.ts";
import {
  evidenceStore,
  fileObjectStorage,
  type ObjectStorage,
} from "../../src/evidence.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const access = authorizationStore(pool);
const origin = "http://127.0.0.1:3000";
const secret = "synthetic-deletion-test-secret";
const token = () => randomBytes(32).toString("hex");
let storageRoot = "";
let server: Server | undefined;

type TrackedRow = { table: string; column: string; value: string };
const tracked: TrackedRow[] = [];
function track(table: string, column: string, value: string) {
  tracked.push({ table, column, value });
}
async function count({ table, column, value }: TrackedRow) {
  const row = await pool.query<{ n: number }>(
    `SELECT count(*)::integer AS n FROM ${table} WHERE ${column}=$1`,
    [value],
  );
  return row.rows[0]!.n;
}
async function member() {
  const value = token();
  await db.create(value, { background: "explorer", goal: "everyday" });
  const session = await db.session(value);
  expect(session.kind).toBe("active");
  return {
    token: value,
    id: session.kind === "active" ? session.learner.id : "",
  };
}
async function postDelete(value: string, form: Record<string, string>) {
  if (!server) throw new Error("Test server unavailable");
  return request(server)
    .post("/delete")
    .set("Host", "127.0.0.1:3000")
    .set("Origin", origin)
    .set("Cookie", `${COOKIE}=${value}`)
    .type("form")
    .send(form);
}
function serve(objects: ObjectStorage, remove = db.remove.bind(db)) {
  const evidence = evidenceStore(pool, objects, secret);
  server = app({ ...db, remove }, { origin, secret, evidence }).listen(0);
  return evidence;
}

beforeAll(async () => {
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
  for (const [id, kind] of [
    ["ZDL-001", "lesson"],
    ["ZDL-002", "assignment"],
  ]) {
    await pool.query(
      `INSERT INTO content_versions(id,version,kind,origin,title,body,owner,sources,rights)
       VALUES($1,1,$2,'curated','Invented test content','Synthetic only','Test editor','Original','Test rights')
       ON CONFLICT(id,version) DO NOTHING`,
      [id, kind],
    );
  }
  storageRoot = await mkdtemp(join(tmpdir(), "dne-member-deletion-"));
  tracked.length = 0;
});
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
  await rm(storageRoot, { recursive: true, force: true });
});
afterAll(async () => pool.end());

async function seedOwned(
  owner: { token: string; id: string },
  marker: string,
  staff: {
    adminId: string;
    reviewerId: string;
    reviewerToken: string;
    operatorId: string;
    operatorToken: string;
  },
  evidence: ReturnType<typeof evidenceStore>,
) {
  const id = owner.id;
  for (const [table, column] of [
    ["principals", "id"],
    ["learners", "id"],
    ["workspaces", "owner_principal_id"],
  ])
    track(table!, column!, id);
  await db.save(id, {
    instruction: `${marker} instruction`,
    verification: `${marker} check`,
    complete: true,
  });
  track("exercises", "learner_id", id);
  await pool.query(
    "INSERT INTO lesson_activity(member_id,content_id,content_version,started_at) VALUES($1,'ZDL-001',1,CURRENT_TIMESTAMP)",
    [id],
  );
  track("lesson_activity", "member_id", id);
  await pool.query(
    "INSERT INTO learner_assignment_choices(member_id,content_id,content_version) VALUES($1,'ZDL-002',1)",
    [id],
  );
  track("learner_assignment_choices", "member_id", id);
  await pool.query(
    "INSERT INTO assignment_attempts(id,member_id,content_id,content_version,goal_at_start,response) VALUES($1,$2,'ZDL-002',1,'everyday',$3)",
    [randomUUID(), id, `${marker} response`],
  );
  track("assignment_attempts", "member_id", id);
  await pool.query(
    "INSERT INTO learning_milestones(id,member_id,goal_title,milestone_title,next_action) VALUES($1,$2,$3,'Invented milestone','Review next step')",
    [randomUUID(), id, `${marker} goal`],
  );
  track("learning_milestones", "member_id", id);
  await pool.query(
    "INSERT INTO private_practice(member_id,content_id,content_version,goal_at_save,response) VALUES($1,'ZDL-001',1,'everyday',$2)",
    [id, `${marker} practice`],
  );
  track("private_practice", "member_id", id);
  await pool.query(
    "INSERT INTO content_assessments(id,member_id,content_id,content_version,rubric_version,reviewer_id,result) VALUES($1,$2,'ZDL-002',1,1,$3,$4)",
    [randomUUID(), id, staff.reviewerId, `${marker} simulated assessment`],
  );
  track("content_assessments", "member_id", id);
  await pool.query("INSERT INTO career_preferences(member_id) VALUES($1)", [
    id,
  ]);
  track("career_preferences", "member_id", id);
  await pool.query(
    "INSERT INTO career_entries(id,member_id,kind,title,next_action) VALUES($1,$2,'career',$3,'Compare a sample')",
    [randomUUID(), id, `${marker} career`],
  );
  track("career_entries", "member_id", id);
  await pool.query(
    "INSERT INTO career_drafts(id,member_id,kind,title,body) VALUES($1,$2,'professional',$3,$4)",
    [
      randomUUID(),
      id,
      `${marker} draft`,
      `${marker} invented professional draft body`,
    ],
  );
  track("career_drafts", "member_id", id);
  await pool.query(
    "INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at) VALUES($1,$2,$3,'Invented body','Original',CURRENT_TIMESTAMP)",
    [randomUUID(), id, `${marker} proposal`],
  );
  track("member_proposals", "member_id", id);
  await pool.query(
    "INSERT INTO preview_circle_memberships(circle_id,member_id) VALUES('sample-circle',$1)",
    [id],
  );
  track("preview_circle_memberships", "member_id", id);
  await pool.query(
    "INSERT INTO cohort_memberships(cohort_id,member_id) VALUES('sample-cohort',$1)",
    [id],
  );
  track("cohort_memberships", "member_id", id);

  const grantId = randomUUID(),
    reservationId = randomUUID();
  await pool.query(
    `INSERT INTO synthetic_entitlement_grants(id,member_id,category,quantity,available,reserved,starts_at,expires_at)
    VALUES($1,$2,'study_requests',10,7,3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 day')`,
    [grantId, id],
  );
  track("synthetic_entitlement_grants", "member_id", id);
  await pool.query(
    "INSERT INTO synthetic_entitlement_reservations(id,grant_id,quantity,state) VALUES($1,$2,3,'reserved')",
    [reservationId, grantId],
  );
  track("synthetic_entitlement_reservations", "id", reservationId);
  await pool.query(
    `INSERT INTO synthetic_entitlement_events(id,member_id,grant_id,reservation_id,operation,quantity,idempotency_key,request_fingerprint,result_id)
    VALUES($1,$2,$3,NULL,'grant',10,$4,$5,$3)`,
    [randomUUID(), id, grantId, `${marker}-grant`, "a".repeat(64)],
  );
  track("synthetic_entitlement_events", "member_id", id);

  const assignmentId = await access.grantAssignment(
    staff.adminId,
    staff.reviewerId,
    id,
    "reviewer",
    `${marker} review`,
    new Date(Date.now() + 86_400_000),
  );
  track("assignment_grants", "workspace_id", id);
  await access.grantSupport(
    staff.adminId,
    staff.operatorId,
    id,
    "operator",
    `${marker} support`,
    new Date(Date.now() + 86_400_000),
  );
  track("support_access_grants", "workspace_id", id);
  expect(
    await access.readWorkspace(staff.operatorToken, id, `${marker} support`),
  ).toMatchObject({ kind: "allowed" });
  track("authorization_audit", "workspace_id", id);

  const uploaded = await evidence.upload(owner.token, {
    name: `${marker}.txt`,
    mediaType: "text/plain",
    data: Buffer.from(`${marker} evidence`),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  expect(uploaded.kind).toBe("created");
  if (uploaded.kind !== "created") throw new Error("Evidence setup failed");
  expect(await evidence.transitionQuarantine(uploaded.id, "clean")).toBe(true);
  expect(await evidence.submitForReview(owner.token, uploaded.id)).toBe(true);
  const submission = await pool.query<{ id: string }>(
    "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
    [uploaded.id],
  );
  const submissionId = submission.rows[0]!.id;
  await access.grantEvidenceReview(
    staff.adminId,
    staff.reviewerId,
    assignmentId,
    submissionId,
    `${marker} exact review`,
    new Date(Date.now() + 86_400_000),
  );
  track("reviewer_evidence_grants", "submission_id", submissionId);
  track("evidence_review_submissions", "id", submissionId);
  track("evidence_objects", "id", uploaded.id);
  const derivativeId = await evidence.addDerivative(
    uploaded.id,
    "text-extract",
    Buffer.from(`${marker} derivative`),
  );
  track("evidence_derivatives", "id", derivativeId);
  const keys = await pool.query<{ storage_key: string }>(
    `SELECT storage_key FROM evidence_objects WHERE id=$1
    UNION ALL SELECT storage_key FROM evidence_derivatives WHERE evidence_id=$1`,
    [uploaded.id],
  );
  return {
    evidenceId: uploaded.id,
    keys: keys.rows.map((row) => row.storage_key),
  };
}

it("removes every current member-linked local row and object through the real route while retaining another member", async () => {
  const files = fileObjectStorage(storageRoot);
  const evidence = serve(files);
  await pool.query("INSERT INTO cohorts(id) VALUES('sample-cohort')");
  const admin = token(),
    reviewerToken = token(),
    operatorToken = token();
  const expires = new Date(Date.now() + 86_400_000);
  const staff = {
    adminId: await access.provisionStaff(admin, "platform_admin", expires),
    reviewerId: await access.provisionStaff(reviewerToken, "reviewer", expires),
    reviewerToken,
    operatorId: await access.provisionStaff(operatorToken, "operator", expires),
    operatorToken,
  };
  const owner = await member(),
    unrelated = await member();
  const first = await seedOwned(owner, "owner", staff, evidence);
  const second = await seedOwned(unrelated, "other", staff, evidence);
  for (const row of tracked)
    expect(await count(row), `${row.table} before deletion`).toBe(1);
  for (const key of [...first.keys, ...second.keys])
    expect(await files.get(key)).toBeInstanceOf(Buffer);
  const reviewerLink = await evidence.issueDownload(
    reviewerToken,
    first.evidenceId,
  );
  expect(reviewerLink.kind).toBe("issued");
  const ownerLink = await evidence.issueDownload(owner.token, first.evidenceId);
  expect(ownerLink.kind).toBe("issued");

  await postDelete(unrelated.token, { csrf: "bad", confirm: "yes" }).then(
    (response) => expect(response.status).toBe(403),
  );
  const attacker = await member();
  await postDelete(attacker.token, {
    csrf: csrf(attacker.token, secret),
    confirm: "yes",
    member_id: owner.id,
  }).then((response) => expect(response.status).toBe(303));
  expect(await db.session(attacker.token)).toMatchObject({ kind: "new" });
  expect(await db.session(owner.token)).toMatchObject({ kind: "active" });
  await postDelete(owner.token, {
    csrf: csrf(owner.token, secret),
    confirm: "no",
  }).then((response) => expect(response.status).toBe(422));
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1",
    [owner.id],
  );
  await postDelete(owner.token, {
    csrf: csrf(owner.token, secret),
    confirm: "yes",
  }).then((response) => expect(response.status).toBe(303));
  expect(
    await count({ table: "principals", column: "id", value: owner.id }),
  ).toBe(1);
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP+INTERVAL '1 day' WHERE id=$1",
    [owner.id],
  );
  await postDelete(owner.token, {
    csrf: csrf(owner.token, secret),
    confirm: "yes",
  }).then((response) => expect(response.status).toBe(303));
  for (const row of tracked.slice(0, tracked.length / 2))
    expect(await count(row), `${row.table} owner after deletion`).toBe(0);
  for (const row of tracked.slice(tracked.length / 2))
    expect(await count(row), `${row.table} unrelated after deletion`).toBe(1);
  for (const key of first.keys) await expect(files.get(key)).rejects.toThrow();
  for (const key of second.keys)
    expect(await files.get(key)).toBeInstanceOf(Buffer);
  expect(await db.session(owner.token)).toMatchObject({ kind: "new" });
  expect(await db.session(unrelated.token)).toMatchObject({ kind: "active" });
  if (reviewerLink.kind === "issued")
    expect(
      await evidence.download(
        reviewerToken,
        first.evidenceId,
        reviewerLink.capability,
      ),
    ).toEqual({ kind: "denied" });
  if (ownerLink.kind === "issued")
    expect(
      await evidence.download(
        owner.token,
        first.evidenceId,
        ownerLink.capability,
      ),
    ).toEqual({ kind: "denied" });
});

it("reports object and database deletion failures and safely finishes on retry", async () => {
  const files = fileObjectStorage(storageRoot);
  let removals = 0;
  const flakyObjects: ObjectStorage = {
    ...files,
    async remove(key) {
      removals++;
      if (removals === 2) throw new Error("synthetic private object failure");
      await files.remove(key);
    },
  };
  let failDatabase = true;
  const evidence = serve(flakyObjects, async (id) => {
    if (failDatabase) {
      failDatabase = false;
      throw new Error("synthetic private database failure");
    }
    await db.remove(id);
  });
  const owner = await member();
  const uploaded = await evidence.upload(owner.token, {
    name: "retry.txt",
    mediaType: "text/plain",
    data: Buffer.from("Invented source for retry"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  expect(uploaded.kind).toBe("created");
  if (uploaded.kind !== "created") throw new Error("Evidence setup failed");
  expect(await evidence.transitionQuarantine(uploaded.id, "clean")).toBe(true);
  await evidence.addDerivative(
    uploaded.id,
    "text-extract",
    Buffer.from("Invented derivative"),
  );
  const keys = (
    await pool.query<{ storage_key: string }>(
      `SELECT storage_key FROM evidence_objects WHERE id=$1
       UNION ALL SELECT storage_key FROM evidence_derivatives WHERE evidence_id=$1`,
      [uploaded.id],
    )
  ).rows.map((row) => row.storage_key);
  expect(keys).toHaveLength(2);
  const form = { csrf: csrf(owner.token, secret), confirm: "yes" };

  const failedObject = await postDelete(owner.token, form);
  expect(failedObject.status).toBe(503);
  expect(failedObject.text).not.toContain("synthetic private object failure");
  expect(await db.session(owner.token)).toMatchObject({ kind: "active" });
  expect(
    (
      await pool.query(
        "SELECT quarantine_state FROM evidence_objects WHERE id=$1",
        [uploaded.id],
      )
    ).rows[0]?.quarantine_state,
  ).toBe("deleting");

  const failedDatabase = await postDelete(owner.token, form);
  expect(failedDatabase.status).toBe(503);
  expect(failedDatabase.text).not.toContain(
    "synthetic private database failure",
  );
  expect(await db.session(owner.token)).toMatchObject({ kind: "active" });
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM evidence_objects WHERE id=$1",
        [uploaded.id],
      )
    ).rows[0]?.n,
  ).toBe(0);
  for (const key of keys) await expect(files.get(key)).rejects.toThrow();

  const completed = await postDelete(owner.token, form);
  expect(completed.status).toBe(303);
  expect(await db.session(owner.token)).toMatchObject({ kind: "new" });
});
