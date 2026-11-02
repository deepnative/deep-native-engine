import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { attemptStore } from "../../src/attempts.ts";
import { catalogStore } from "../../src/catalog.ts";
import { start } from "../../src/runtime.ts";
import { COOKIE } from "../../src/session.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";

// #587: copy routes share the evidence upload budget delivered by #315.
const pool = testPool();
let running: Awaited<ReturnType<typeof start>>, root: string;
const provided =
  "An invented neighbourhood reading group wants to choose its next activity. Explain three simple options, state what information is missing, and suggest how the group could check the answer. This is a provided practice example; no real people or dates are included.\n";
const digest = createHash("sha256").update(provided).digest("hex");
let catalogItem = 100;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dne587-copy-admission-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: root,
    DNE_PREPARED_REVIEW_SAMPLES: "enabled",
    DNE_ASSIGNMENT_HANDOFF: "enabled",
  });
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE principals,cohorts,upload_admission_windows,upload_admission_leases,upload_admission_denials CASCADE",
  );
});
afterAll(async () => {
  await running?.close();
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});

async function member() {
  const token = randomBytes(32).toString("hex");
  await store(pool).create(token, { background: "explorer", goal: "everyday" });
  const host = new URL(running.origin).host;
  const page = await request(running.server)
    .get("/evidence")
    .set("Host", host)
    .set("Cookie", `${COOKIE}=${token}`)
    .expect(200);
  const csrf = page.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  const post = (path: string, fields: Record<string, string>) =>
    request(running.server)
      .post(path)
      .set("Host", host)
      .set("Origin", running.origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf, ...fields });
  const upload = (name: string) =>
    request(running.server)
      .post("/api/evidence")
      .set("Host", host)
      .set("Origin", running.origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .set("X-CSRF-Token", csrf)
      .set("Content-Type", "text/plain")
      .set("X-Evidence-Name", name)
      .set("X-Evidence-Rights", "confirmed")
      .set("X-Evidence-Scopes", "private-review")
      .send(`Invented evidence sample ${name}.`);
  const prepared = (operationId = randomUUID()) => ({
    operationId,
    templateId: "everyday-options",
    templateVersion: "1",
    templateDigest: digest,
    providedExample: "yes",
    privateReview: "yes",
  });
  return { token, csrf, post, upload, prepared };
}
type Member = Awaited<ReturnType<typeof member>>;

// A submitted assignment version the member can copy, as in AHO-01.
async function submittedAttempt(m: Member) {
  const editor = randomBytes(32).toString("hex"),
    reviewer = randomBytes(32).toString("hex");
  const auth = authorizationStore(pool),
    catalog = catalogStore(pool);
  const expiry = new Date(Date.now() + 86400000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  const draft = {
    id: `CPYAD-${catalogItem++}`,
    version: 1,
    kind: "assignment" as const,
    origin: "curated" as const,
    title: "Invented neighbourhood options",
    body: "Use invented examples only.",
    owner: "Synthetic editor",
    sources: "Original invented brief",
    rights: "Owned sample",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites: "None",
    rubric: "Explain options, limits and one check.",
    rubricVersion: 1,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, draft.id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, draft.id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, draft.id, 1)).toBe(true);
  expect(await store(pool).chooseAssignment(m.token, draft.id, 1)).toBe(true);
  const attempts = attemptStore(pool),
    id = (await attempts.start(m.token))!;
  expect(
    await attempts.save(
      m.token,
      id,
      1,
      "An invented reading group compares three activities.\n",
    ),
  ).toBe(true);
  expect(await attempts.submit(m.token, id, 2)).toBe(true);
  const page = await request(running.server)
    .get(`/assignments/attempts/${id}/handoff?sequence=1`)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${m.token}`)
    .expect(200);
  const fields: Record<string, string> = Object.fromEntries(
    [
      ...page.text.matchAll(
        /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
      ),
    ]
      .filter((match) => match[1] !== "csrf")
      .map((match) => [match[1]!, match[2]!]),
  );
  fields.privateReview = "yes";
  return { path: `/assignments/attempts/${id}/handoff`, fields };
}

async function count(table: string) {
  return Number(
    (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))
      .rows[0]!.n,
  );
}
async function useBudget(m: Member, uploads: number) {
  for (let i = 1; i <= uploads; i++)
    expect((await m.upload(`budget-${i}.txt`)).status).toBe(201);
}
function expectRefusal(
  response: request.Response,
  status: number,
  text: RegExp,
) {
  expect(response.status).toBe(status);
  expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  expect(response.headers["cache-control"]).toContain("no-store");
  expect(response.text).toMatch(text);
}
const overBudget =
  /Wait \d+ seconds?, then upload again\. Saved evidence is unchanged\./;

it("ADMIT-10 refuses a prepared-sample copy once the member's upload budget is used and keeps the instruction", async () => {
  const m = await member();
  await useBudget(m, 10);
  const files = await readdir(root, { recursive: true });
  const instruction = m.prepared();
  const refused = await m.post("/evidence/prepared", instruction);
  expectRefusal(refused, 429, overBudget);
  expect(refused.text).toContain(`value="${instruction.operationId}"`);
  expect(refused.text).toContain('action="/evidence/prepared/inspect"');
  expect(await count("evidence_objects")).toBe(10);
  expect(await count("provided_evidence_operations")).toBe(0);
  expect(await readdir(root, { recursive: true })).toEqual(files);
});

it("ADMIT-10 refuses an assignment-evidence copy once the member's upload budget is used and keeps the request", async () => {
  const m = await member();
  const attempt = await submittedAttempt(m);
  await useBudget(m, 10);
  const files = await readdir(root, { recursive: true });
  const refused = await m.post(attempt.path, attempt.fields);
  expectRefusal(refused, 429, overBudget);
  expect(refused.text).toContain(`value="${attempt.fields.operationId}"`);
  expect(refused.text).toContain('action="/assignment-feedback/inspect"');
  expect(await count("evidence_objects")).toBe(10);
  expect(await count("assignment_evidence_operations")).toBe(0);
  expect(await readdir(root, { recursive: true })).toEqual(files);
});

it("ADMIT-10 counts admitted copies in the same member and service windows as uploads", async () => {
  const m = await member();
  const attempt = await submittedAttempt(m);
  expect((await m.post("/evidence/prepared", m.prepared())).status).toBe(200);
  expect((await m.post(attempt.path, attempt.fields)).status).toBe(200);
  const windows = await pool.query<{ pool: string; admitted: number }>(
    "SELECT pool,admitted FROM upload_admission_windows ORDER BY pool",
  );
  expect(windows.rows).toEqual([
    { pool: "global", admitted: 2 },
    { pool: "member", admitted: 2 },
  ]);
  await useBudget(m, 8);
  expect((await m.upload("over.txt")).status).toBe(429);
  expect(await count("upload_admission_leases")).toBe(0);
});

it("ADMIT-12 keeps inspection open over budget and replays the original copy after the window", async () => {
  const m = await member();
  const instruction = m.prepared();
  const created = await m.post("/evidence/prepared", instruction);
  expect(created.status).toBe(200);
  await useBudget(m, 9);
  const inspected = await m.post("/evidence/prepared/inspect", {
    operationId: instruction.operationId,
  });
  expect(inspected.status).toBe(200);
  expect(inspected.text).toContain("Provided invented example");
  expectRefusal(
    await m.post("/evidence/prepared", instruction),
    429,
    overBudget,
  );
  await pool.query(
    "UPDATE upload_admission_windows SET window_start=window_start-interval '10 minutes'",
  );
  const replayed = await m.post("/evidence/prepared", instruction);
  expect(replayed.status).toBe(200);
  expect(replayed.text).toContain(
    "Your original copy instruction was replayed; no new copy or permission was created.",
  );
  expect(await count("evidence_objects")).toBe(10);
});

it("ADMIT-12 keeps assignment-copy inspection open over budget and replays the original copy after the window", async () => {
  const m = await member();
  const attempt = await submittedAttempt(m);
  const created = await m.post(attempt.path, attempt.fields);
  expect(created.status).toBe(200);
  const evidenceId = created.text.match(
    /data-assignment-evidence="([a-f0-9-]+)"/,
  )![1]!;
  await useBudget(m, 9);
  const inspected = await m.post("/assignment-feedback/inspect", {
    operationId: attempt.fields.operationId!,
  });
  expect(inspected.status).toBe(200);
  expect(inspected.text).toContain(`data-assignment-evidence="${evidenceId}"`);
  expectRefusal(await m.post(attempt.path, attempt.fields), 429, overBudget);
  await pool.query(
    "UPDATE upload_admission_windows SET window_start=window_start-interval '10 minutes'",
  );
  const replayed = await m.post(attempt.path, attempt.fields);
  expect(replayed.status).toBe(200);
  expect(replayed.text).toContain(`data-assignment-evidence="${evidenceId}"`);
  expect(await count("evidence_objects")).toBe(10);
  expect(await count("upload_admission_leases")).toBe(0);
});

it("ADMIT-13 fails both copy routes closed when the limiter does not answer", async () => {
  const m = await member();
  const attempt = await submittedAttempt(m);
  const blocker = new Pool({
    connectionString: process.env.DNE_TEST_DATABASE_URL,
  });
  const held = await blocker.connect();
  try {
    await held.query("SELECT pg_advisory_lock(315085)");
    const unavailable =
      /Uploads are temporarily unavailable\. Try again in a minute\. Saved evidence is unchanged\./;
    const prepared = await m.post("/evidence/prepared", m.prepared());
    expectRefusal(prepared, 503, unavailable);
    expect(prepared.headers["retry-after"]).toBe("60");
    const copy = await m.post(attempt.path, attempt.fields);
    expectRefusal(copy, 503, unavailable);
    expect(await count("evidence_objects")).toBe(0);
  } finally {
    await held.query("SELECT pg_advisory_unlock(315085)");
    held.release();
    await blocker.end();
  }
});
