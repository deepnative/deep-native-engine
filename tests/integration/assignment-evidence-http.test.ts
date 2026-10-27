import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { attemptStore } from "../../src/attempts.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore } from "../../src/catalog.ts";
import { COOKIE } from "../../src/session.ts";

const url = process.env.DNE_TEST_DATABASE_URL!;
if (!/^\/dne_test_[a-f0-9]{32}$/.test(new URL(url).pathname))
  throw Error("Dedicated generated test database required");
const pool = new pg.Pool({ connectionString: url });
let running: Awaited<ReturnType<typeof start>>, root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dne545-red-private-"));
  running = await start({
    DNE_DATABASE_URL: url,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: root,
    DNE_ASSIGNMENT_HANDOFF: "enabled",
  });
});
afterAll(async () => {
  await running?.close();
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
it("AHO-01/02 previews one exact owned submitted sequence while a newer private draft exists", async () => {
  const token = randomBytes(32).toString("hex"),
    editor = randomBytes(32).toString("hex"),
    reviewer = randomBytes(32).toString("hex");
  const db = store(pool),
    auth = authorizationStore(pool),
    catalog = catalogStore(pool);
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  expect(session.kind).toBe("active");
  if (session.kind !== "active") throw Error("Invented member setup failed");
  const expiry = new Date(Date.now() + 86400000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  const draft = {
    id: "SYN-545",
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
  expect(await db.chooseAssignment(session.learner.id, draft.id, 1)).toBe(true);
  const attempts = attemptStore(pool),
    id = await attempts.start(token);
  expect(id).toBeTruthy();
  const first =
    "An invented reading group compares three activities. We will check missing information before choosing.\n";
  expect(await attempts.save(token, id!, 1, first)).toBe(true);
  expect(await attempts.submit(token, id!, 2)).toBe(true);
  expect(await attempts.revise(token, id!)).toBe(true);
  const prior = await attempts.detail(token, id!);
  expect(prior?.submissions?.[0]?.response).toBe(first);
  const newer =
    "A separate invented unsent draft must never replace the selected submitted response.";
  expect(await attempts.save(token, id!, prior!.revision, newer)).toBe(true);
  const response = await request(running.server)
    .get(`/assignments/attempts/${id}/handoff?sequence=1`)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${token}`);
  // Meaningful missing behavior: authenticated normal handoff preview must exist,
  // retain the exact old submitted bytes and require separate unchecked consent.
  expect(
    response.status,
    "An authorized exact submitted-version preview is missing",
  ).toBe(200);
  expect(response.text).toContain(first.trim());
  expect(response.text).not.toContain(newer);
  expect(response.text).toContain("private");
  expect(response.text).not.toMatch(/type="checkbox"[^>]*checked/);
  const ownedCount = async () =>
    Number(
      (
        await pool.query(
          "SELECT count(*)::int n FROM evidence_objects WHERE owner_principal_id=$1",
          [session.learner.id],
        )
      ).rows[0].n,
    );
  expect(await ownedCount()).toBe(0);
  const fields = Object.fromEntries(
    [
      ...response.text.matchAll(
        /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
      ),
    ].map((match) => [match[1]!, match[2]!]),
  );
  const post = (path: string, body: Record<string, string>, asToken = token) =>
    request(running.server)
      .post(path)
      .set("Host", new URL(running.origin).host)
      .set("Origin", running.origin)
      .set("Cookie", `${COOKIE}=${asToken}`)
      .type("form")
      .send(body);
  const handoff = `/assignments/attempts/${id}/handoff`;
  await post(handoff, { ...fields, privateReview: "yes", csrf: "bad" }).expect(
    403,
  );
  await post(handoff, fields).expect(422);
  expect(await ownedCount()).toBe(0);
  const created = await post(handoff, {
    ...fields,
    privateReview: "yes",
  }).expect(200);
  expect(created.text).toContain("Your private assignment copy was saved.");
  const evidenceId = created.text.match(
    /data-assignment-evidence="([a-f0-9-]+)"/,
  )![1]!;
  const replayed = await post(handoff, {
    ...fields,
    privateReview: "yes",
  }).expect(200);
  expect(replayed.text).toContain(`data-assignment-evidence="${evidenceId}"`);
  expect(await ownedCount()).toBe(1);
  const inspected = await post("/assignment-feedback/inspect", {
    csrf: fields.csrf!,
    operationId: fields.operationId!,
  }).expect(200);
  expect(inspected.text).toContain(`data-assignment-evidence="${evidenceId}"`);
  const exported = await request(running.server)
    .get("/api/evidence/export")
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${token}`)
    .expect(200);
  expect(exported.body.items).toHaveLength(1);
  expect(
    Buffer.from(exported.body.items[0].sourceBase64, "base64").toString("utf8"),
  ).toBe(first);
  expect(exported.body.items[0].assignmentOrigin).toMatchObject({
    attemptId: id,
    sequence: 1,
    contentId: draft.id,
    contentVersion: 1,
    rubricVersion: 1,
  });
  const outsider = randomBytes(32).toString("hex");
  await db.create(outsider, { background: "professional", goal: "work" });
  const denied = await request(running.server)
    .get(`${handoff}?sequence=1`)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${outsider}`)
    .expect(403);
  expect(denied.text).not.toContain(first.trim());
  const foreignCsrf = denied.text.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
  // The denial page need not include a form. Obtain this member's ordinary
  // nonce from their own evidence page rather than borrowing the owner's.
  const foreignPage = await request(running.server)
    .get("/evidence")
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${outsider}`)
    .expect(200);
  const nonce =
    foreignCsrf ??
    foreignPage.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  const foreignReceipt = await post(
    "/assignment-feedback/inspect",
    { csrf: nonce, operationId: fields.operationId! },
    outsider,
  ).expect(403);
  expect(foreignReceipt.text).not.toContain(evidenceId);
  expect(foreignReceipt.text).not.toContain(first.trim());
  expect(await ownedCount()).toBe(1);
  // An actual runtime restart rotates the process-bound CSRF secret. Turning
  // creation off must still leave a normal current-owner inspection entry.
  const port = new URL(running.origin).port;
  await running.close();
  running = await start({
    DNE_DATABASE_URL: url,
    DNE_APP_MODE: "test",
    DNE_PORT: port,
    DNE_PRIVATE_STORAGE_ROOT: root,
    DNE_ASSIGNMENT_HANDOFF: "disabled",
  });
  await post("/assignment-feedback/inspect", {
    csrf: fields.csrf!,
    operationId: fields.operationId!,
  }).expect(403);
  const fresh = await request(running.server)
    .get("/assignment-feedback/inspect")
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${token}`)
    .expect(200);
  const currentNonce = fresh.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  expect(currentNonce).not.toBe(fields.csrf);
  const recovered = await post("/assignment-feedback/inspect", {
    csrf: currentNonce,
    operationId: fields.operationId!,
  }).expect(200);
  expect(recovered.text).toContain(`data-assignment-evidence="${evidenceId}"`);
  expect(await ownedCount()).toBe(1);
});
