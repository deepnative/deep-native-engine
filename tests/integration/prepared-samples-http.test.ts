import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { PREPARED_SAMPLES } from "../../src/prepared-sample-values.ts";
import { preparedSampleStore } from "../../src/prepared-samples.ts";
import { hash } from "../../src/store.ts";
import { startPreparedSampleRecoveryServer } from "../support/prepared-sample-recovery-server.ts";
import { COOKIE } from "../../src/session.ts";
import {
  MAX_MEMBER_EXPORT_BYTES,
  MAX_MEMBER_EXPORT_RECORDS,
} from "../../src/member-export.ts";

const pool = testPool();
let running: Awaited<ReturnType<typeof start>>, root: string;
const text =
  "An invented neighbourhood reading group wants to choose its next activity. Explain three simple options, state what information is missing, and suggest how the group could check the answer. This is a provided practice example; no real people or dates are included.\n";
const digest = createHash("sha256").update(text).digest("hex");
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dne503-http-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: root,
    DNE_PREPARED_REVIEW_SAMPLES: "enabled",
  });
});
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
});
afterAll(async () => {
  await running?.close();
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
it("PREPARED-01/02 creates an exact provided private copy through a configured native member action without queue or grant", async () => {
  const token = randomBytes(32).toString("hex");
  await store(pool).create(token, { background: "explorer", goal: "everyday" });
  const page = await request(running.server)
    .get("/evidence")
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${token}`)
    .expect(200);
  const nonce = page.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  const response = await request(running.server)
    .post("/evidence/prepared")
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", `${COOKIE}=${token}`)
    .type("form")
    .send({
      csrf: nonce,
      operationId: randomUUID(),
      templateId: "everyday-options",
      templateVersion: "1",
      templateDigest: digest,
      providedExample: "yes",
      privateReview: "yes",
    });
  expect(response.status).toBe(200);
  expect(response.text).toContain("Provided invented example");
  const rows = await pool.query(
    "SELECT quarantine_state,sha256,private_review_allowed,community_publication_allowed,learning_circle_id FROM evidence_objects",
  );
  expect(rows.rows).toEqual([
    {
      quarantine_state: "clean",
      sha256: digest,
      private_review_allowed: true,
      community_publication_allowed: false,
      learning_circle_id: null,
    },
  ]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM evidence_review_submissions",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (await pool.query("SELECT count(*)::int n FROM assignment_grants")).rows[0]
      .n,
  ).toBe(0);
});

async function member() {
  const token = randomBytes(32).toString("hex");
  await store(pool).create(token, { background: "explorer", goal: "everyday" });
  const get = (path: string) =>
    request(running.server)
      .get(path)
      .set("Host", new URL(running.origin).host)
      .set("Cookie", `${COOKIE}=${token}`);
  const page = await get("/evidence").expect(200);
  const csrf = page.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  const post = (path: string, fields: Record<string, string>) =>
    request(running.server)
      .post(path)
      .set("Host", new URL(running.origin).host)
      .set("Origin", running.origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf, ...fields });
  const input = {
    operationId: randomUUID(),
    templateId: "everyday-options",
    templateVersion: "1",
    templateDigest: digest,
    providedExample: "yes",
    privateReview: "yes",
  };
  return { token, get, post, input };
}
it("PREPARED-07 retains exact provided origin in the owner's evidence export and source screen", async () => {
  const m = await member();
  await m.post("/evidence/prepared", m.input).expect(200);
  const exported = await m.get("/api/evidence/export").expect(200);
  expect(exported.body.items[0].origin).toMatchObject({
    kind: "platform-provided-invented",
    templateId: "everyday-options",
    templateVersion: 1,
    templateDigest: digest,
    label: "Provided invented example · local synthetic · unreviewed",
  });
  expect(
    Buffer.from(exported.body.items[0].sourceBase64, "base64").toString(),
  ).toBe(text);
  const saved = await m.get("/evidence").expect(200);
  expect(saved.text).toContain(
    "Provided invented example · local synthetic · unreviewed",
  );
  expect(saved.text).toContain(digest);
});

it("PREPARED-07 exports provided origins and safe receipt history without original replay keys", async () => {
  const m = await member();
  await m.post("/evidence/prepared", m.input).expect(200);
  const exported = await m.get("/api/member/export").expect(200);
  expect(exported.body.records.providedEvidenceOrigins).toHaveLength(1);
  expect(exported.body.records.providedEvidenceOrigins[0]).toMatchObject({
    kind: "platform-provided-invented",
    templateId: "everyday-options",
    templateVersion: 1,
    templateDigest: digest,
    label: "Provided invented example · local synthetic · unreviewed",
  });
  expect(exported.body.records.preparedCopyReceipts).toHaveLength(1);
  expect(JSON.stringify(exported.body)).not.toContain(m.input.operationId);
});
// FIXTURE-02: native copies are setup, not part of the five-second paging body.
describe("PREPARED-07 complete provided-copy pagination", () => {
  let m: Awaited<ReturnType<typeof member>>;
  let other: Awaited<ReturnType<typeof member>>;
  let ids: Set<string>;
  let operations: string[];
  beforeEach(async () => {
    m = await member();
    other = await member();
    const copies = preparedSampleStore(pool, {
      enabled: true,
      mode: "test",
      origin: running.origin,
    });
    ids = new Set<string>();
    operations = [];
    for (let index = 0; index < 55; index++) {
      const operationId = randomUUID();
      operations.push(operationId);
      const result = await copies.create(m.token, {
        operationId,
        templateId: "everyday-options",
        templateVersion: 1,
        templateDigest: digest,
        providedExample: true,
        privateReview: true,
      });
      expect(result.kind).toBe("created");
      if (result.kind !== "created")
        throw Error("Provided boundary copy unavailable");
      ids.add(result.receipt.evidenceId!);
    }
  }, 30000);
  it("PREPARED-07 traverses new provenance sections and bounded evidence pages without duplicates, secret keys or another member's continuation", async () => {
    const evidenceIds: string[] = [],
      originIds: string[] = [],
      receiptIds: string[] = [];
    let cursor: string | null = null,
      pages = 0;
    do {
      const exported: request.Response = await m
        .get(
          "/api/evidence/export" +
            (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
        )
        .expect(200);
      expect(exported.body.items.length).toBeLessThanOrEqual(20);
      for (const item of exported.body.items) {
        evidenceIds.push(item.id);
        expect(item.origin.templateDigest).toBe(digest);
        expect(Buffer.from(item.sourceBase64, "base64").toString()).toBe(text);
      }
      cursor = exported.body.page.nextCursor;
      if (cursor)
        await other
          .get("/api/evidence/export?cursor=" + encodeURIComponent(cursor))
          .expect(403);
      expect(++pages).toBeLessThanOrEqual(10);
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(evidenceIds)).toEqual(ids);
    expect(evidenceIds).toHaveLength(55);
    pages = 0;
    cursor = null;
    do {
      const exported: request.Response = await m
        .get(
          "/api/member/export" +
            (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
        )
        .expect(200);
      expect(exported.body.page.recordCount).toBeLessThanOrEqual(
        MAX_MEMBER_EXPORT_RECORDS,
      );
      expect(Buffer.byteLength(exported.text)).toBeLessThanOrEqual(
        MAX_MEMBER_EXPORT_BYTES,
      );
      originIds.push(
        ...exported.body.records.providedEvidenceOrigins.map(
          (r: { evidenceId: string }) => r.evidenceId,
        ),
      );
      receiptIds.push(
        ...exported.body.records.preparedCopyReceipts.map(
          (r: { evidenceId: string }) => r.evidenceId,
        ),
      );
      expect(exported.text).not.toContain("storageKey");
      expect(exported.text).not.toContain("payloadDigest");
      for (const key of operations) expect(exported.text).not.toContain(key);
      cursor = exported.body.page.nextCursor;
      if (cursor)
        await other
          .get("/api/member/export?cursor=" + encodeURIComponent(cursor))
          .expect(403);
      expect(++pages).toBeLessThanOrEqual(10);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(new Set(originIds)).toEqual(ids);
    expect(originIds).toHaveLength(55);
    expect(new Set(receiptIds)).toEqual(ids);
    expect(receiptIds).toHaveLength(55);
  });
});
it("PREPARED-02/06 cannot change bytes or publish an existing provided identity through later source updates", async () => {
  const m = await member();
  await m.post("/evidence/prepared", m.input).expect(200);
  const id = (await pool.query("SELECT id FROM evidence_objects")).rows[0].id;
  await expect(
    pool.query("UPDATE evidence_objects SET sha256=$2 WHERE id=$1", [
      id,
      "a".repeat(64),
    ]),
  ).rejects.toThrow("Provided source identity is immutable");
  await expect(
    pool.query(
      "UPDATE evidence_objects SET community_publication_allowed=true WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow("Provided source identity is immutable");
});

async function source(m: Awaited<ReturnType<typeof member>>) {
  const r = await m.post("/evidence/prepared", m.input).expect(200);
  return r.text.match(/data-prepared-evidence="([a-f0-9-]+)"/)![1]!;
}
it("PREPARED-01 exposes three fixed templates and keeps the two acknowledgements initially unchecked", async () => {
  const m = await member();
  const page = await m.get("/evidence/prepared").expect(200);
  expect(page.text.match(/data-prepared-template=/g)).toHaveLength(3);
  expect(page.text).not.toMatch(/checked(?:[ >])/);
  expect(page.text.match(/name="providedExample"/g)).toHaveLength(3);
  expect(page.text.match(/name="privateReview"/g)).toHaveLength(3);
  for (const template of PREPARED_SAMPLES) {
    expect(page.text).toContain(template.digest);
    expect(page.text).toContain(template.text.trim());
  }
});
it("PREPARED-02 rejects tampered templates, extra command fields, CSRF and unacknowledged permissions without creating sources", async () => {
  const m = await member();
  const tampering: Record<string, string>[] = [
    { text: "private input" },
    { name: "changed.txt" },
    { media: "text/html" },
    { owner: randomUUID() },
    { sourceId: randomUUID() },
    { templateDigest: "a".repeat(64) },
    { templateVersion: "2" },
    { templateId: "unknown" },
    { privateReview: "no" },
    { providedExample: "no" },
  ];
  for (const changed of tampering) {
    await m.post("/evidence/prepared", { ...m.input, ...changed }).expect(422);
  }
  await m.post("/evidence/prepared", { ...m.input, csrf: "bad" }).expect(403);
  expect(
    (await pool.query("SELECT count(*)::int n FROM evidence_objects")).rows[0]
      .n,
  ).toBe(0);
});
it("PREPARED-04 concurrent original actions retain exactly one source and changed valid payload conflicts", async () => {
  const m = await member();
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => m.post("/evidence/prepared", m.input)),
  );
  expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
  const ids = responses.map(
    (r) => r.text.match(/data-prepared-evidence="([a-f0-9-]+)"/)![1],
  );
  expect(new Set(ids).size).toBe(1);
  const other = PREPARED_SAMPLES[1]!;
  await m
    .post("/evidence/prepared", {
      ...m.input,
      templateId: other.id,
      templateDigest: other.digest,
    })
    .expect(409);
  const stranger = await member();
  const denied = await stranger
    .post("/evidence/prepared/inspect", { operationId: m.input.operationId })
    .expect(403);
  expect(denied.text).not.toContain(ids[0]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM provided_evidence_operations",
      )
    ).rows[0].n,
  ).toBe(1);
});
it("PREPARED-05 withdrawn and deleted sources never reappear through original replay or inspection", async () => {
  const m = await member(),
    id = await source(m);
  await m
    .post(`/evidence/${id}/revoke-private-review`, { confirm: "yes" })
    .expect(303);
  const withdrawn = await m.post("/evidence/prepared", m.input).expect(200);
  expect(withdrawn.text).toContain("withdrawn");
  expect(
    (
      await pool.query(
        "SELECT private_review_allowed FROM evidence_objects WHERE id=$1",
        [id],
      )
    ).rows[0].private_review_allowed,
  ).toBe(false);
  await m.post(`/evidence/${id}/delete`, { confirm: "yes" }).expect(303);
  const removed = await m.post("/evidence/prepared", m.input).expect(200);
  expect(removed.text).toContain("removed");
  expect(removed.text).not.toContain("data-prepared-evidence=");
  await m
    .post("/evidence/prepared/inspect", { operationId: m.input.operationId })
    .expect(200);
  expect(
    (await pool.query("SELECT count(*)::int n FROM provided_evidence_origins"))
      .rows[0].n,
  ).toBe(0);
  expect(
    (await pool.query("SELECT evidence_id FROM provided_evidence_operations"))
      .rows[0].evidence_id,
  ).toBeNull();
  const exported = await m.get("/api/member/export").expect(200);
  expect(exported.body.records.preparedCopyReceipts[0].state).toBe("removed");
});
it("PREPARED-06 a separately edited revision stays pending without provided origin or inherited queue", async () => {
  const m = await member(),
    id = await source(m);
  await m.post(`/evidence/${id}/queue`, { acknowledge: "yes" }).expect(303);
  await m
    .post(`/evidence/${id}/revise`, {
      name: "My new invented revision.txt",
      sample: "Different invented text",
      rights_confirmed: "yes",
      private_review_consent: "yes",
    })
    .expect(303);
  const exported = await m.get("/api/evidence/export").expect(200);
  expect(exported.body.items).toHaveLength(2);
  const revision = exported.body.items.find(
    (row: { revisionNumber: number }) => row.revisionNumber === 2,
  );
  expect(revision).toMatchObject({
    quarantineState: "pending",
    sourceBase64: null,
  });
  expect(revision.origin).toBeUndefined();
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM evidence_review_submissions WHERE evidence_id=$1",
        [revision.id],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("PREPARED-07 downloads exact fixed bytes with provided-origin metadata", async () => {
  const m = await member(),
    id = await source(m);
  const issued = await m.post(`/evidence/${id}/download`, {}).expect(303);
  const downloaded = await m.get(issued.headers.location!).expect(200);
  expect(downloaded.text).toBe(text);
  expect(downloaded.headers["x-evidence-origin"]).toContain(
    "platform-provided-invented",
  );
  expect(downloaded.headers["x-evidence-template-digest"]).toBe(digest);
});
it("PREPARED-08 creation-off runtime preserves existing provenance, original inspection, download and erasure", async () => {
  const m = await member(),
    id = await source(m);
  const paused = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: root,
    DNE_PREPARED_REVIEW_SAMPLES: "disabled",
  });
  try {
    const get = (path: string) =>
      request(paused.server)
        .get(path)
        .set("Host", new URL(paused.origin).host)
        .set("Cookie", `${COOKIE}=${m.token}`);
    const page = await get("/evidence").expect(200);
    expect(page.text).toContain(
      "Provided invented example · local synthetic · unreviewed",
    );
    expect(page.text).not.toContain('href="/evidence/prepared"');
    const csrf = page.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
    const post = (path: string, body: Record<string, string>) =>
      request(paused.server)
        .post(path)
        .set("Host", new URL(paused.origin).host)
        .set("Origin", paused.origin)
        .set("Cookie", `${COOKIE}=${m.token}`)
        .type("form")
        .send({ csrf, ...body });
    await post("/evidence/prepared", m.input).expect(404);
    await post("/evidence/prepared/inspect", {
      operationId: m.input.operationId,
    }).expect(200);
    const link = await post(`/evidence/${id}/download`, {}).expect(303);
    expect((await get(link.headers.location!).expect(200)).text).toBe(text);
    await post(`/evidence/${id}/delete`, { confirm: "yes" }).expect(303);
  } finally {
    await paused.close();
  }
});
it("PREPARED-05 expired and revoked authority cannot create or inspect a retained copy", async () => {
  const m = await member();
  const id = await source(m);
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE token_hash=$1",
    [hash(m.token)],
  );
  const result = await m.post("/evidence/prepared/inspect", {
    operationId: m.input.operationId,
  });
  expect(result.status).toBe(303);
  expect(result.headers.location).toBe("/");
  expect(result.text).not.toContain(id);
  const expired = await member();
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
    [hash(expired.token)],
  );
  const redirected = await expired
    .post("/evidence/prepared", expired.input)
    .expect(303);
  expect(redirected.headers.location).toBe("/");
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM provided_evidence_operations",
      )
    ).rows[0].n,
  ).toBe(1);
});
it("PREPARED-08 repeat migration does not backfill a legacy member upload into provided or clean state", async () => {
  const m = await member();
  await m
    .post("/evidence", {
      name: "Legacy invented upload.txt",
      sample: "Member-supplied invented text",
      rights_confirmed: "yes",
      private_review_consent: "yes",
    })
    .expect(303);
  await source(m);
  await migrate(pool);
  await migrate(pool);
  const exported = await m.get("/api/evidence/export").expect(200);
  const legacy = exported.body.items.find(
    (row: { name: string }) => row.name === "Legacy invented upload.txt",
  );
  expect(legacy).toMatchObject({
    quarantineState: "pending",
    sourceBase64: null,
  });
  expect(legacy.origin).toBeUndefined();
  expect(
    (await pool.query("SELECT count(*)::int n FROM provided_evidence_origins"))
      .rows[0].n,
  ).toBe(1);
});
it("PREPARED-07 account erasure removes provided origins, receipts and evidence", async () => {
  const m = await member();
  await source(m);
  await m.post("/delete", { confirm: "yes" }).expect(303);
  for (const table of [
    "provided_evidence_origins",
    "provided_evidence_operations",
    "evidence_objects",
  ])
    expect(
      (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
    ).toBe(0);
});
it("PREPARED-05 inspection waits behind source deletion and observes removal without a child-first deadlock", async () => {
  const m = await member(),
    id = await source(m);
  const blocker = await pool.connect();
  const reading = preparedSampleStore(pool, {
    enabled: true,
    mode: "test",
    origin: running.origin,
  });
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM evidence_objects WHERE id=$1 FOR UPDATE",
      [id],
    );
    const pending = reading.inspect(m.token, m.input.operationId);
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      waiting = (
        await pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM evidence_objects e JOIN provided_evidence_origins%') waiting",
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await blocker.query("DELETE FROM evidence_objects WHERE id=$1", [id]);
    await blocker.query("COMMIT");
    expect(await pending).toMatchObject({
      kind: "ready",
      receipt: { evidenceId: null, state: "removed", origin: null },
    });
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

it("PREPARED-04 recovers an actually lost successful COMMIT reply through explicit inspection and original replay only", async () => {
  const m = await member();
  const fault = await startPreparedSampleRecoveryServer(pool, root);
  try {
    const get = (path: string) =>
      request(fault.server)
        .get(path)
        .set("Host", new URL(fault.origin).host)
        .set("Cookie", `${COOKIE}=${m.token}`);
    const page = await get("/evidence").expect(200);
    const csrf = page.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
    const post = (path: string, body: Record<string, string>) =>
      request(fault.server)
        .post(path)
        .set("Host", new URL(fault.origin).host)
        .set("Origin", fault.origin)
        .set("Cookie", `${COOKIE}=${m.token}`)
        .type("form")
        .send({ csrf, ...body });
    const filesBefore = await readdir(root);
    const unknown = await post("/evidence/prepared", m.input).expect(503);
    expect(unknown.text).toContain("a copy may have committed");
    expect(unknown.text).toContain(`value="${m.input.operationId}"`);
    expect(unknown.text).not.toContain("Invented lost prepared-copy");
    expect(fault.observed).toEqual({
      commits: 1,
      lostReplies: 1,
      rollbacksAfterCommit: 0,
    });
    const inspected = await post("/evidence/prepared/inspect", {
      operationId: m.input.operationId,
    }).expect(200);
    expect(inspected.text).toContain("available");
    const id = inspected.text.match(
      /data-prepared-evidence="([a-f0-9-]+)"/,
    )![1]!;
    const repeated = await post("/evidence/prepared", m.input).expect(200);
    expect(repeated.text).toContain(`data-prepared-evidence="${id}"`);
    expect(fault.observed.commits).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::int n FROM evidence_objects")).rows[0]
        .n,
    ).toBe(1);
    expect(await readdir(root)).toEqual(filesBefore);
    const absent = await post("/evidence/prepared/inspect", {
      operationId: randomUUID(),
    }).expect(200);
    expect(absent.text).toContain("does not establish that the write failed");
    expect(fault.observed.commits).toBe(1);
  } finally {
    await fault.close();
  }
});

it("PREPARED-05 a creation blocked on the original instruction cannot outlive actual member expiry", async () => {
  const m = await member(),
    blocker = await pool.connect();
  let response: Promise<request.Response> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(50301,hashtext($1))", [
      m.input.operationId,
    ]);
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '800 milliseconds' WHERE token_hash=$1",
      [hash(m.token)],
    );
    response = Promise.resolve(m.post("/evidence/prepared", m.input));
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      waiting = (
        await pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock(50301%') waiting",
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(waiting).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(
      (
        await pool.query(
          "SELECT expires_at<clock_timestamp() expired FROM principals WHERE token_hash=$1",
          [hash(m.token)],
        )
      ).rows[0].expired,
    ).toBe(true);
    await blocker.query("COMMIT");
    const denied = await response;
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain("data-prepared-evidence=");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM provided_evidence_operations",
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await response;
  }
});
