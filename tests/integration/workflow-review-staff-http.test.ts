import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import { authorizationStore, type StaffRole } from "../../src/authorization.ts";
import { store } from "../../src/store.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const auth = authorizationStore(pool);
let running: Awaited<ReturnType<typeof start>>, root: string;
const fresh = () => randomBytes(32).toString("hex");
const field = (html: string, name: string) =>
  html.match(new RegExp(`name="${name}" value="([^"]+)"`))![1]!;
const cookie = (res: request.Response, name: string) =>
  (res.headers["set-cookie"] as unknown as string[])
    .find((value) => value.startsWith(name + "="))!
    .split(";")[0]!;
const get = (path: string, selected = "") =>
  request(running.server)
    .get(path)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", selected);
const post = (path: string, selected: string, body: Record<string, string>) =>
  request(running.server)
    .post(path)
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", selected)
    .type("form")
    .send(body);
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dne489-staff-http-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_WORKFLOW_REVIEW_REQUESTS: "enabled",
    DNE_PRIVATE_STORAGE_ROOT: root,
  });
});
afterAll(async () => {
  await running?.close();
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
async function signIn(role: StaffRole) {
  const credential = fresh();
  const id = await auth.provisionStaff(
    credential,
    role,
    new Date(Date.now() + 3600000),
  );
  const form = await get("/staff/sign-in").expect(200);
  const selected = await post(
    "/staff/sign-in",
    cookie(form, "dne_staff_entry"),
    {
      credential,
      csrf: field(form.text, "csrf"),
    },
  ).expect(303);
  return { id, cookie: cookie(selected, "dne_staff") };
}
it("WFREV-02 current selected administrator can open exact private workflow assignment", async () => {
  const admin = await signIn("platform_admin");
  const page = await get("/operator/workflow-reviews", admin.cookie);
  expect(page.status).toBe(200);
  expect(page.text).toContain("Assign private workflow review");
  expect(page.text).not.toContain('name="note"');
});

it("WFREV-03 selected moderator can obtain a finite private review reference", async () => {
  const moderator = await signIn("moderator");
  const page = await get(
    "/moderate/workflow-review-reference",
    moderator.cookie,
  );
  expect(page.status).toBe(200);
  expect(page.text).toContain(moderator.id);
  expect(page.text).toContain("My private workflow review reference");
});

it("WFREV-02/03/04 browser assignment reads only the exact requested note until owner withdrawal", async () => {
  const member = fresh();
  const db = store(pool);
  const feedback = workflowFeedbackStore(pool);
  await db.create(member, { background: "professional", goal: "work" });
  const note = "Invented workflow note <script>never execute</script>";
  expect(await feedback.save(member, "WF-001", 1, note, 0)).toBe(true);
  const ownerCookie = `dne_preview=${member}`;
  const preview = await get(
    "/workflow-feedback/WF-001/review",
    ownerCookie,
  ).expect(200);
  const requested = await post(
    "/workflow-feedback/review/request",
    ownerCookie,
    {
      csrf: field(preview.text, "csrf"),
      checked: field(preview.text, "checked"),
      operationId: field(preview.text, "operationId"),
      confirm: "yes",
    },
  ).expect(200);
  const requestId = field(requested.text, "requestId");
  const admin = await signIn("platform_admin");
  const moderator = await signIn("moderator");
  const sibling = await signIn("moderator");
  const entry = await get("/operator/workflow-reviews", admin.cookie).expect(
    200,
  );
  const checked = await post("/operator/workflow-reviews/check", admin.cookie, {
    csrf: field(entry.text, "csrf"),
    requestId,
    moderatorId: moderator.id,
    startsAt: field(entry.text, "startsAt"),
    expiresAt: field(entry.text, "expiresAt"),
  }).expect(200);
  expect(checked.text).toContain("Reading starts");
  expect(checked.text).not.toContain("Invented workflow note");
  const instruction = {
    csrf: field(checked.text, "csrf"),
    checked: field(checked.text, "checked"),
    operationId: field(checked.text, "operationId"),
    confirm: "yes",
  };
  const assigned = await post(
    "/operator/workflow-reviews/assign",
    admin.cookie,
    instruction,
  ).expect(200);
  expect(assigned.text).not.toContain("Invented workflow note");
  const grantId = assigned.text.match(/data-grant-id="([^"]+)"/)![1]!;
  const replayed = await post(
    "/operator/workflow-reviews/assign",
    admin.cookie,
    instruction,
  ).expect(200);
  expect(replayed.text).toContain(grantId);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM workflow_review_grants WHERE request_id=$1",
        [requestId],
      )
    ).rows[0].n,
  ).toBe(1);
  const ownReceipt = await get(
    `/workflow-feedback/review/receipts/${requestId}`,
    ownerCookie,
  );
  expect.soft(ownReceipt.status).toBe(200);
  expect.soft(ownReceipt.text).toContain("assigned");
  expect.soft(ownReceipt.text).not.toContain("Invented workflow note");
  const history = await get("/workflow-feedback/review/history", ownerCookie);
  expect.soft(history.status).toBe(200);
  expect
    .soft(history.text)
    .toContain(`href="/workflow-feedback/review/receipts/${requestId}"`);
  expect.soft(history.text).not.toContain("Invented workflow note");
  const readPath = `/moderate/workflow-reviews/${grantId}`;
  const worklist = await get("/moderate/workflow-reviews", moderator.cookie);
  expect(worklist.status).toBe(200);
  expect(worklist.text).toContain(`href="${readPath}"`);
  expect(worklist.text).not.toContain("Invented workflow note");
  const read = await get(readPath, moderator.cookie).expect(200);
  expect(read.text).toContain("Invented workflow note &lt;script&gt;");
  expect(read.text).toContain("WF-001 · version 1 · revision 1");
  expect(read.text).not.toContain(note);
  for (const selected of [sibling.cookie, admin.cookie, ownerCookie]) {
    const denied = await get(readPath, selected);
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain("Invented workflow note");
  }
  await post("/workflow-feedback/review/withdraw", ownerCookie, {
    csrf: field(requested.text, "csrf"),
    requestId,
    operationId: field(requested.text, "operationId"),
    confirm: "yes",
  }).expect(200);
  const withdrawn = await get(readPath, moderator.cookie).expect(403);
  const retainedReceipt = await get(
    `/workflow-feedback/review/receipts/${requestId}`,
    ownerCookie,
  );
  expect.soft(retainedReceipt.status).toBe(200);
  expect.soft(retainedReceipt.text).toContain("withdrawn");

  expect(withdrawn.text).not.toContain("Invented workflow note");
  // WFREV-06: inspect the original committed operation after permission has
  // changed. Inspection must report current metadata, never renew permission.
  const inspected = await post(
    "/operator/workflow-reviews/inspect",
    admin.cookie,
    {
      csrf: instruction.csrf,
      operationId: instruction.operationId,
    },
  );
  const canonical = await get(
    `/operator/workflow-reviews/receipts/${grantId}`,
    admin.cookie,
  );
  expect.soft(inspected.status).toBe(200);
  expect.soft(canonical.status).toBe(200);
  expect.soft(inspected.text).toContain("withdrawn");
  expect.soft(inspected.text).toContain(grantId);
  expect.soft(inspected.text).not.toContain("Invented workflow note");
  expect.soft(canonical.text).toContain("withdrawn");
  expect.soft(canonical.text).not.toContain("Invented workflow note");
  const otherAdmin = await signIn("platform_admin");
  await post("/operator/workflow-reviews/inspect", otherAdmin.cookie, {
    csrf: field(
      (await get("/operator/workflow-reviews", otherAdmin.cookie).expect(200))
        .text,
      "csrf",
    ),
    operationId: instruction.operationId,
  }).expect(403);
  const missing = await post(
    "/operator/workflow-reviews/inspect",
    admin.cookie,
    { csrf: instruction.csrf, operationId: randomUUID() },
  );
  expect.soft(missing.status).toBe(200);
  expect
    .soft(missing.text)
    .toContain("does not prove the write was uncommitted");
  const own = await get("/workflow-feedback/WF-001", ownerCookie).expect(200);
  expect(own.text).toContain("Invented workflow note");
  const metadata = (
    await pool.query(
      "SELECT instruction::text AS text FROM workflow_review_operations WHERE operation_id=$1",
      [instruction.operationId],
    )
  ).rows[0].text;
  expect(metadata).not.toContain("Invented workflow note");
});

it("WFREV-02 administrator can revoke an exact grant without deleting the member note", async () => {
  const member = fresh();
  const db = store(pool);
  const feedback = workflowFeedbackStore(pool);
  await db.create(member, { background: "technical", goal: "work" });
  const note = "Invented note retained after exact staff revocation";
  expect(await feedback.save(member, "WF-001", 1, note, 0)).toBe(true);
  const owner = `dne_preview=${member}`;
  const preview = await get("/workflow-feedback/WF-001/review", owner).expect(
    200,
  );
  const intent = await post("/workflow-feedback/review/request", owner, {
    csrf: field(preview.text, "csrf"),
    checked: field(preview.text, "checked"),
    operationId: field(preview.text, "operationId"),
    confirm: "yes",
  }).expect(200);
  const admin = await signIn("platform_admin"),
    moderator = await signIn("moderator");
  const entry = await get("/operator/workflow-reviews", admin.cookie).expect(
    200,
  );
  const checked = await post("/operator/workflow-reviews/check", admin.cookie, {
    csrf: field(entry.text, "csrf"),
    requestId: field(intent.text, "requestId"),
    moderatorId: moderator.id,
    startsAt: field(entry.text, "startsAt"),
    expiresAt: field(entry.text, "expiresAt"),
  }).expect(200);
  const assigned = await post(
    "/operator/workflow-reviews/assign",
    admin.cookie,
    {
      csrf: field(checked.text, "csrf"),
      checked: field(checked.text, "checked"),
      operationId: field(checked.text, "operationId"),
      confirm: "yes",
    },
  ).expect(200);
  const grantId = assigned.text.match(/data-grant-id="([^"]+)"/)![1]!;
  const body = {
    csrf: field(entry.text, "csrf"),
    grantId,
    operationId: randomUUID(),
    confirm: "yes",
  };
  const revoked = await post(
    "/operator/workflow-reviews/revoke",
    admin.cookie,
    body,
  );
  expect(revoked.status).toBe(200);
  expect(revoked.text).toContain("revoked");
  const replay = await post(
    "/operator/workflow-reviews/revoke",
    admin.cookie,
    body,
  ).expect(200);
  expect(replay.text).toContain(grantId);
  const read = await get(
    `/moderate/workflow-reviews/${grantId}`,
    moderator.cookie,
  ).expect(403);
  expect(read.text).not.toContain(note);
  const own = await get("/workflow-feedback/WF-001", owner).expect(200);
  expect(own.text).toContain(note);
});
