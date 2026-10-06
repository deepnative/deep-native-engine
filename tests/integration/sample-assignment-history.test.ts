import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { hash, migrate } from "../../src/store.ts";
import {
  memberExportStore,
  MAX_MEMBER_EXPORT_BYTES,
  MAX_MEMBER_EXPORT_RECORDS,
} from "../../src/member-export.ts";
import { SAMPLE_FEEDBACK_PURPOSE } from "../../src/sample-feedback-values.ts";
import { testPool } from "../support/database.ts";
import {
  sampleAssignmentFixture,
  sampleAssignmentToken,
} from "../support/sample-assignment.ts";
const pool = testPool();
let root = "";
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne480-history-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
afterAll(() => pool.end());
async function auditSnapshot() {
  return (
    await pool.query(`SELECT (SELECT count(*) FROM authorization_audit)::int AS auth,
 (SELECT count(*) FROM private_sample_feedback_audit)::int AS feedback,(SELECT count(*) FROM review_time_events)::int AS minutes,
 (SELECT count(*) FROM assignment_grants)::int AS assignments,(SELECT count(*) FROM reviewer_evidence_grants)::int AS grants,
 (SELECT count(*) FROM private_sample_assignment_operations)::int AS receipts`)
  ).rows[0];
}
it("REVADM-08 pages over 100 legacy and receipt rows once, with scheduled/expired/revoked/ineffective/removed states and no read effects", async () => {
  const f = await sampleAssignmentFixture(pool, root),
    source = { evidenceId: f.input.evidenceId, sourceRevision: 1 };
  const created = await f.assignments.assign(f.administratorToken, f.input);
  if (created.kind !== "applied") throw Error("Expected receipt");
  const original = (
    await pool.query(
      "SELECT assignment_id,submission_id FROM reviewer_evidence_grants WHERE id=$1",
      [created.row.exactGrantId],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO reviewer_evidence_grants(id,reviewer_id,assignment_id,submission_id,purpose,starts_at,expires_at,revoked_at,granted_by,created_at)
    SELECT gen_random_uuid(),$1,$2,$3,$4,
     CASE WHEN n%4=1 THEN clock_timestamp()+interval '5 minutes' WHEN n%4=2 THEN clock_timestamp()-interval '2 hours' ELSE clock_timestamp()-interval '1 minute' END,
     CASE WHEN n%4=1 THEN clock_timestamp()+interval '10 minutes' WHEN n%4=2 THEN clock_timestamp()-interval '1 hour' ELSE clock_timestamp()+interval '10 minutes' END,
     CASE WHEN n%4=3 THEN clock_timestamp() ELSE NULL END,$5,'2020-01-01T00:00:00.123456Z'
    FROM generate_series(1,105) n`,
    [
      f.reviewerId,
      original.assignment_id,
      original.submission_id,
      SAMPLE_FEEDBACK_PURPOSE,
      f.administratorId,
    ],
  );
  const stale = await f.auth.provisionStaff(
    sampleAssignmentToken(),
    "reviewer",
    f.end,
  );
  const staleAssignment = await f.auth.grantAssignment(
    f.administratorId,
    stale,
    f.ownerId,
    "reviewer",
    SAMPLE_FEEDBACK_PURPOSE,
    f.end,
  );
  await f.auth.grantEvidenceReview(
    f.administratorId,
    stale,
    staleAssignment,
    original.submission_id,
    SAMPLE_FEEDBACK_PURPOSE,
    f.end,
  );
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [stale],
  );
  const removed = await f.assignments.assign(f.administratorToken, {
    ...f.input,
    operationId: randomUUID(),
  });
  if (removed.kind !== "applied") throw Error("Expected retained receipt");
  await pool.query("DELETE FROM reviewer_evidence_grants WHERE id=$1", [
    removed.row.exactGrantId,
  ]);
  const before = await auditSnapshot(),
    ids: string[] = [],
    states = new Set<string>();
  let after: string | undefined,
    pages = 0,
    first: string | undefined;
  do {
    const page = await f.assignments.history(
      f.administratorToken,
      source,
      after,
    );
    expect(page.kind).toBe("ready");
    if (page.kind !== "ready") throw Error("History unavailable");
    expect(page.history.rows.length).toBeLessThanOrEqual(20);
    for (const row of page.history.rows) {
      ids.push(row.exactGrantId);
      states.add(row.state);
    }
    after = page.history.next ?? undefined;
    first ??= after;
    pages++;
  } while (after && pages < 10);
  expect(after).toBeUndefined();
  expect(pages).toBe(6);
  expect(ids).toHaveLength(108);
  expect(new Set(ids).size).toBe(108);
  expect([...states].sort()).toEqual([
    "active",
    "expired",
    "ineffective",
    "removed",
    "revoked",
    "scheduled",
  ]);
  expect(await auditSnapshot()).toEqual(before);
  const otherToken = sampleAssignmentToken();
  await f.auth.provisionStaff(otherToken, "platform_admin", f.end);
  expect(await f.assignments.history(otherToken, source, first)).toEqual({
    kind: "invalid",
  });
  expect(
    await f.assignments.history(
      f.administratorToken,
      { ...source, sourceRevision: 2 },
      first,
    ),
  ).toEqual({ kind: "invalid" });
  expect(
    await f.assignments.history(f.administratorToken, source, first + "x"),
  ).toEqual({ kind: "invalid" });
});

it("REVADM-08 v22 owner export traverses retained source-deleted receipts with unchanged v2 bounds and excludes every staff/key/internal-grant field", async () => {
  const first = await sampleAssignmentFixture(pool, root),
    second = await sampleAssignmentFixture(pool, root);
  const created = await first.assignments.assign(
    first.administratorToken,
    first.input,
  );
  const foreign = await second.assignments.assign(
    second.administratorToken,
    second.input,
  );
  if (created.kind !== "applied" || foreign.kind !== "applied")
    throw Error("Expected isolated receipts");
  // Trusted legacy fixture populates immutable historical structural records;
  // these identifiers are never represented as effective grants.
  await pool.query(
    `INSERT INTO private_sample_assignment_operations(id,workspace_id,administrator_id,operation_id,reviewer_id,evidence_id,source_revision,submission_id,assignment_id,exact_grant_id,starts_at,expires_at)
    SELECT gen_random_uuid(),workspace_id,administrator_id,gen_random_uuid(),reviewer_id,evidence_id,source_revision,
     gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),starts_at,expires_at FROM private_sample_assignment_operations WHERE id=$1`,
    [created.row.receiptId],
  );
  await pool.query(
    `INSERT INTO private_sample_assignment_operations(id,workspace_id,administrator_id,operation_id,reviewer_id,evidence_id,source_revision,submission_id,assignment_id,exact_grant_id,starts_at,expires_at)
    SELECT gen_random_uuid(),o.workspace_id,o.administrator_id,gen_random_uuid(),o.reviewer_id,o.evidence_id,o.source_revision,
     gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),o.starts_at,o.expires_at FROM private_sample_assignment_operations o CROSS JOIN generate_series(1,104) n WHERE o.id=$1`,
    [created.row.receiptId],
  );
  expect(
    await first.evidence.remove(first.ownerToken, first.input.evidenceId),
  ).toBe(true);
  const secret = Buffer.alloc(32, 7),
    exporter = memberExportStore(pool, secret);
  const rows: Record<string, unknown>[] = [],
    cursors: string[] = [];
  let cursor: string | undefined,
    pages = 0;
  do {
    const result = await exporter.exportOwned(first.ownerToken, cursor);
    if (result.kind !== "ready") throw Error("Owned export unavailable");
    expect(result.payload.version).toBe("local-member-records-v23");
    expect(result.payload.page.recordCount).toBeLessThanOrEqual(
      MAX_MEMBER_EXPORT_RECORDS,
    );
    expect(
      Buffer.byteLength(JSON.stringify(result.payload)),
    ).toBeLessThanOrEqual(MAX_MEMBER_EXPORT_BYTES);
    rows.push(...result.payload.records.sampleAssignmentOperations!);
    cursor = result.payload.page.nextCursor ?? undefined;
    if (cursor) cursors.push(cursor);
    pages++;
  } while (cursor && pages < 10);
  expect(cursor).toBeUndefined();
  expect(rows).toHaveLength(106);
  expect(new Set(rows.map((row) => row.receiptId)).size).toBe(106);
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual(
      [
        "receiptId",
        "evidenceId",
        "sourceRevision",
        "startsAt",
        "expiresAt",
        "createdAt",
        "state",
      ].sort(),
    );
    expect(row).toMatchObject({
      evidenceId: first.input.evidenceId,
      sourceRevision: 1,
      state: "retained-structural-receipt",
    });
  }
  expect(JSON.stringify(rows)).not.toContain(foreign.row.receiptId!);
  expect(JSON.stringify(rows)).not.toContain(first.administratorId);
  expect(await exporter.exportOwned(second.ownerToken, cursors[0])).toEqual({
    kind: "denied",
  });
  const body = Buffer.from(
    JSON.stringify([
      2,
      36,
      ["00000000-0000-4000-8000-000000000000"],
      2,
      Date.now() + 60000,
    ]),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(hash(first.ownerToken))
    .update(".")
    .update(body)
    .digest("base64url");
  const direct = await exporter.exportOwned(
    first.ownerToken,
    `${body}.${signature}`,
  );
  expect(direct).toMatchObject({
    kind: "ready",
    payload: { page: { recordCount: 100, complete: false } },
  });
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
    [first.ownerId],
  );
  expect(await exporter.exportOwned(first.ownerToken)).toEqual({
    kind: "denied",
  });
  await pool.query("DELETE FROM principals WHERE id=$1", [first.ownerId]);
  expect(
    (await pool.query("SELECT id FROM private_sample_assignment_operations"))
      .rows,
  ).toEqual([{ id: foreign.row.receiptId }]);
});
