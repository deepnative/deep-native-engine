import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { authorizationStore, type StaffRole } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { testPool } from "../support/database.ts";
import { COOKIE } from "../../src/session.ts";
import { sampleAssignmentFixture } from "../support/sample-assignment.ts";

const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool);
let running: Awaited<ReturnType<typeof start>>, root: string;
const fresh = () => randomBytes(32).toString("hex");
const csrfFrom = (html: string) =>
  html.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
const cookieFrom = (res: request.Response, name: string) =>
  (res.headers["set-cookie"] as unknown as string[])
    .find((value) => value.startsWith(name + "="))!
    .split(";")[0]!;
const get = (path: string, cookie = "") =>
  request(running.server)
    .get(path)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", cookie);
const post = (path: string, cookie: string, fields: Record<string, string>) =>
  request(running.server)
    .post(path)
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", cookie)
    .type("form")
    .send(fields);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dne480-http-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION: "enabled",
    DNE_PRIVATE_STORAGE_ROOT: root,
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

async function signIn(role: StaffRole) {
  const credential = fresh(),
    id = await auth.provisionStaff(
      credential,
      role,
      new Date(Date.now() + 3600000),
    );
  const form = await get("/staff/sign-in").expect(200);
  const signed = await post(
    "/staff/sign-in",
    cookieFrom(form, "dne_staff_entry"),
    {
      credential,
      csrf: csrfFrom(form.text),
    },
  )
    .expect(303)
    .expect("Location", "/staff");
  const cookie = cookieFrom(signed, "dne_staff");
  await get("/staff", cookie).expect(200);
  return { cookie, id, credential };
}

it("REVADM-01-REFERENCES baseline: the ordinary member evidence page exposes its exact source UUID and revision", async () => {
  const owner = fresh();
  await members.create(owner, { background: "explorer", goal: "everyday" });
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(root),
    "invented-reference-test-secret",
  );
  const uploaded = await evidence.upload(owner, {
    name: "Invented reference sample",
    mediaType: "text/plain",
    data: Buffer.from("Invented reference source."),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (uploaded.kind !== "created")
    throw Error("Invented evidence fixture unavailable");
  await evidence.transitionQuarantine(uploaded.id, "clean");
  expect(await evidence.submitForReview(owner, uploaded.id)).toBe(true);
  const page = await get("/evidence", `${COOKIE}=${owner}`).expect(200);
  expect(page.text).toContain(uploaded.id);
  expect(page.text).toContain("Private evidence version 1");
});

it("REVADM-01-REFERENCES current reviewer obtains only their own noncredential reference after actual staff form entry", async () => {
  const reviewer = await signIn("reviewer");
  const page = await get(
    "/review/sample-assignment-reference",
    reviewer.cookie,
  ).expect(200);
  expect(page.text).toContain(reviewer.id);
  expect(page.text).toContain("Your reviewer reference");
});

it("REVADM-02-ASSIGN current administrator reaches the exact-sample assignment form after actual staff form entry", async () => {
  const administrator = await signIn("platform_admin");
  const page = await get(
    "/operator/sample-assignments",
    administrator.cookie,
  ).expect(200);
  expect(page.text).toContain("Assign private sample feedback");
  expect(page.text).toContain('name="evidenceId"');
  expect(page.text).toContain('name="sourceRevision"');
  expect(page.text).toContain('name="reviewerId"');
});

it("REVADM-02/05 actual administrator form creates and recovers a metadata-only pair without putting its key in a URL", async () => {
  const f = await sampleAssignmentFixture(pool, root),
    admin = await signIn("platform_admin");
  const form = await get("/operator/sample-assignments", admin.cookie).expect(
      200,
    ),
    csrf = csrfFrom(form.text);
  const checked = await post(
    "/operator/sample-assignments/check",
    admin.cookie,
    {
      csrf,
      evidenceId: f.input.evidenceId,
      sourceRevision: "1",
      reviewerId: f.reviewerId,
    },
  ).expect(200);
  expect(checked.text).toContain("Confirm private sample assignment");
  expect(checked.text).not.toContain("Invented private sample");
  const key = checked.text.match(
    /name="operationId" value="([a-f0-9-]+)"/,
  )![1]!;
  const fields = {
    csrf,
    ...f.input,
    sourceRevision: "1",
    operationId: key,
    confirm: "yes",
  };
  const assigned = await post(
    "/operator/sample-assignments/assign",
    admin.cookie,
    fields,
  ).expect(200);
  expect(assigned.text).toContain("Private sample assignment receipt");
  expect(assigned.text).not.toContain(key);
  expect(assigned.text).not.toContain(f.ownerId);
  expect(assigned.text).not.toContain("Invented source");
  const replay = await post(
    "/operator/sample-assignments/assign",
    admin.cookie,
    fields,
  ).expect(200);
  expect(replay.text).toContain("No new grant was created");
  await post("/operator/sample-assignments/assign", admin.cookie, {
    ...fields,
    reviewerId: randomUUID(),
  }).expect(409);
  const recovered = await post(
    "/operator/sample-assignments/recover",
    admin.cookie,
    { csrf, operationId: key },
  ).expect(200);
  expect(recovered.text).toContain("data-receipt");
  expect(recovered.text).not.toContain(key);
  const absent = await post(
    "/operator/sample-assignments/recover",
    admin.cookie,
    { csrf, operationId: randomUUID() },
  ).expect(200);
  expect(absent.text).toContain(
    "No retained receipt was found; this does not establish that no write committed.",
  );
  await get(
    "/operator/sample-assignments/recover?operationId=" + key,
    admin.cookie,
  ).expect(404);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM private_sample_assignment_operations",
      )
    ).rows[0].n,
  ).toBe(1);
});

it.each(["coach", "reviewer", "editor", "moderator", "operator"] as const)(
  "REVADM-06 actual signed-in %s receives no administrator metadata",
  async (role) => {
    const actor = await signIn(role);
    await get("/operator/sample-assignments", actor.cookie).expect(403);
    const self = await get(
      "/review/sample-assignment-reference",
      actor.cookie,
    ).expect(role === "reviewer" ? 200 : 403);
    if (role !== "reviewer") expect(self.text).not.toContain(actor.id);
  },
);

it("REVADM-06 explicitly selected cookie wins over legacy identity; ambiguity/signout/expiry and alias paths fail closed", async () => {
  const admin = await signIn("platform_admin"),
    reviewer = await signIn("reviewer");
  for (const cookie of [
    "",
    `${COOKIE}=${admin.credential}`,
    `${admin.cookie}; ${admin.cookie}`,
    "dne_staff=signed-out",
    `${reviewer.cookie}; ${COOKIE}=${admin.credential}`,
  ])
    await get("/OPERATOR/SAMPLE-ASSIGNMENTS/", cookie).expect(403);
  await get(
    "/REVIEW/SAMPLE-ASSIGNMENT-REFERENCE/",
    `${admin.cookie}; ${COOKIE}=${reviewer.credential}`,
  ).expect(403);
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [admin.id],
  );
  await get("/operator/sample-assignments", admin.cookie).expect(403);
});

it("REVADM-06 rejects wrong Host/Origin/CSRF and duplicate, extra, oversized or unsigned fields before any grants", async () => {
  const f = await sampleAssignmentFixture(pool, root),
    admin = await signIn("platform_admin");
  const form = await get("/operator/sample-assignments", admin.cookie).expect(
      200,
    ),
    csrf = csrfFrom(form.text),
    path = "/operator/sample-assignments/check";
  const refs = {
    csrf,
    evidenceId: f.input.evidenceId,
    sourceRevision: "1",
    reviewerId: f.reviewerId,
  };
  await request(running.server)
    .get("/operator/sample-assignments")
    .set("Host", "invalid.local")
    .set("Cookie", admin.cookie)
    .expect(403);
  await request(running.server)
    .post(path)
    .set("Host", new URL(running.origin).host)
    .set("Origin", "http://invalid.local")
    .set("Cookie", admin.cookie)
    .type("form")
    .send(refs)
    .expect(403);
  await post(path, admin.cookie, { ...refs, csrf: "bad" }).expect(403);
  await post(path, admin.cookie, { ...refs, actorId: admin.id }).expect(422);
  await post(path, admin.cookie, {
    ...refs,
    evidenceId: "x".repeat(100),
  }).expect(422);
  await request(running.server)
    .post(path)
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", admin.cookie)
    .type("form")
    .send(new URLSearchParams(refs).toString() + "&reviewerId=" + f.reviewerId)
    .expect(422);
  await post("/operator/sample-assignments/assign", admin.cookie, {
    csrf,
    ...f.input,
    sourceRevision: "1",
    confirm: "no",
  }).expect(422);
  await post("/operator/sample-assignments/assign", admin.cookie, {
    csrf,
    ...f.input,
    sourceRevision: "1",
    confirm: "yes",
    purpose: "wrong",
  }).expect(422);
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM assignment_grants"))
      .rows[0].n,
  ).toBe(0);
});
