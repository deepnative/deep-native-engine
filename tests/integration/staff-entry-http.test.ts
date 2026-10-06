import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { testPool } from "../support/database.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { COOKIE } from "../../src/session.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  support = supportRequestStore(pool);
let running: Awaited<ReturnType<typeof start>>, root: string;
const fresh = () => randomBytes(32).toString("hex");
const csrfFrom = (html: string) =>
  html.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
const cookiesFrom = (res: request.Response) =>
  res.headers["set-cookie"] as unknown as string[];
const get = (path: string, cookie = "") =>
  request(running.server)
    .get(path)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", cookie);
const post = (path: string, cookie: string, fields: Record<string, unknown>) =>
  request(running.server)
    .post(path)
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", cookie)
    .type("form")
    .send(fields);
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dne-staff-http-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
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
async function fixture(grantLifetime = 3600000) {
  const owner = fresh(),
    operator = fresh(),
    admin = fresh();
  await members.create(owner, { background: "professional", goal: "work" });
  const member = await members.session(owner);
  if (member.kind !== "active") throw Error("Missing invented owner");
  await members.save(member.learner.id, {
    instruction: "An invented team summarizes its sample meeting notes.",
    verification: "Check every action against the original invented notes.",
    complete: true,
    goal: "work",
  });
  const expires = new Date(Date.now() + 3600000);
  const adminId = await auth.provisionStaff(admin, "platform_admin", expires);
  const staffId = await auth.provisionStaff(operator, "operator", expires);
  const created = await support.create(owner, {
    idempotencyKey: randomUUID(),
    subject: "Invented staff-entry request",
    body: "PRIVATE-REQUEST-MARKER",
  });
  if (!("receipt" in created)) throw Error("Missing invented support");
  const requestId = created.receipt.requestId;
  const granted = await support.grant(admin, {
    idempotencyKey: randomUUID(),
    requestId,
    staffId,
    role: "operator",
    startsAt: new Date(Date.now() - 1000),
    expiresAt: new Date(Date.now() + grantLifetime),
  });
  if (!("grantId" in granted)) throw Error("Missing invented grant");
  return {
    owner,
    operator,
    staffId,
    requestId,
    grant: granted.grantId,
    memberId: member.learner.id,
    admin,
    adminId,
  };
}
it("STAFF-01-COEXIST saved learner signs in through the form, uses exact-granted support and retains saved progress", async () => {
  const f = await fixture(),
    learnerCookie = `${COOKIE}=${f.owner}`;
  const before = (
    await pool.query("SELECT * FROM exercises WHERE learner_id=$1", [
      f.memberId,
    ])
  ).rows;
  const form = await get("/staff/sign-in", learnerCookie).expect(200);
  const entry = cookiesFrom(form)
    .find((v) => v.startsWith("dne_staff_entry="))!
    .split(";")[0]!;
  const signed = await post("/staff/sign-in", `${learnerCookie}; ${entry}`, {
    csrf: csrfFrom(form.text),
    credential: f.operator,
  })
    .expect(303)
    .expect("Location", "/staff");
  const staffCookie = cookiesFrom(signed)
    .find((v) => v.startsWith("dne_staff="))!
    .split(";")[0]!;
  expect(cookiesFrom(signed).some((v) => v.startsWith(COOKIE + "="))).toBe(
    false,
  );
  const both = `${learnerCookie}; ${staffCookie}`;
  const portal = await get("/staff", both).expect(200);
  expect(portal.text).toContain("Your granted support requests");
  const detail = await get(
    `/OPERATOR/support/${f.requestId}/?grant=${f.grant}`,
    both,
  ).expect(200);
  expect(detail.text).toContain("PRIVATE-REQUEST-MARKER");
  await post(`/operator/support/${f.requestId}/notes`, both, {
    csrf: csrfFrom(detail.text),
    grantId: f.grant,
    idempotencyKey: randomUUID(),
    confirm: "yes",
    body: "Invented staff-only note",
  }).expect(303);
  const progress = await get("/progress", both).expect(200);
  expect(progress.text).toContain("Self-reported complete");
  expect(
    (
      await pool.query("SELECT * FROM exercises WHERE learner_id=$1", [
        f.memberId,
      ])
    ).rows,
  ).toEqual(before);
  const nonce = cookiesFrom(portal)
    .find((v) => v.startsWith("dne_staff_entry="))!
    .split(";")[0]!;
  const out = await post("/staff/sign-out", `${both}; ${nonce}`, {
    csrf: csrfFrom(portal.text),
  }).expect(303);
  expect(cookiesFrom(out).join(" ")).toContain("dne_staff=signed-out");
  expect(cookiesFrom(out).some((v) => v.startsWith(COOKIE + "="))).toBe(false);
  await get(
    "/operator/support",
    `${learnerCookie}; dne_staff=signed-out`,
  ).expect(403);
  await get("/progress", `${learnerCookie}; dne_staff=signed-out`).expect(200);
  expect(
    (
      await pool.query("SELECT * FROM exercises WHERE learner_id=$1", [
        f.memberId,
      ])
    ).rows,
  ).toEqual(before);
});
async function signIn(credential: string, existing = "") {
  const form = await get("/staff/sign-in", existing).expect(200);
  const nonce = cookiesFrom(form)
    .find((v) => v.startsWith("dne_staff_entry="))!
    .split(";")[0]!;
  const response = await post("/staff/sign-in", `${existing}; ${nonce}`, {
    csrf: csrfFrom(form.text),
    credential,
  });
  return {
    response,
    cookie: cookiesFrom(response)
      ?.find((v) => v.startsWith("dne_staff="))
      ?.split(";")[0],
  };
}
it("STAFF-03-CREDENTIAL all representable invalid current principals fail admission without creating or renewing authority", async () => {
  const member = fresh();
  await members.create(member, { background: "explorer", goal: "everyday" });
  const values = ["invalid", fresh(), member];
  for (const change of [
    "revoked",
    "expired",
    "missing-profile",
    "wrong-kind",
    "infinite",
  ]) {
    const credential = fresh(),
      id = await auth.provisionStaff(
        credential,
        "operator",
        new Date(Date.now() + 60000),
      );
    if (change === "revoked")
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [id],
      );
    if (change === "expired")
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id],
      );
    if (change === "missing-profile" || change === "wrong-kind")
      await pool.query("DELETE FROM staff_profiles WHERE principal_id=$1", [
        id,
      ]);
    if (change === "wrong-kind")
      await pool.query("UPDATE principals SET kind='member' WHERE id=$1", [id]);
    if (change === "infinite")
      await pool.query(
        "UPDATE principals SET expires_at='infinity' WHERE id=$1",
        [id],
      );
    values.push(credential);
  }
  const before = (await pool.query("SELECT * FROM principals ORDER BY id"))
    .rows;
  for (const credential of values) {
    const { response } = await signIn(credential);
    expect([403, 503]).toContain(response.status);
    expect(cookiesFrom(response)).toBeUndefined();
    expect(response.text).not.toContain(credential);
    expect(response.headers["cache-control"]).toBe("no-store");
  }
  expect(
    (await pool.query("SELECT * FROM principals ORDER BY id")).rows,
  ).toEqual(before);
});
it("STAFF-03-AMBIGUITY raw duplicate equal/conflicting cookies and duplicate form fields never admit or fall back", async () => {
  const f = await fixture();
  for (const tail of [
    `dne_staff=${f.operator}; dne_staff=${f.operator}`,
    `dne_staff=${f.operator}; dne_staff=${f.owner}`,
    "dne_staff=bad",
    "dne_staff =bad",
    "dne_staff=signed-out",
  ]) {
    await get("/OPERATOR/support/", `${COOKIE}=${f.operator}; ${tail}`).expect(
      403,
    );
  }
  for (const value of [f.operator, f.owner]) {
    const form = await get("/staff/sign-in").expect(200);
    const nonce = cookiesFrom(form)[0]!.split(";")[0]!;
    await request(running.server)
      .post("/staff/sign-in")
      .set("Host", new URL(running.origin).host)
      .set("Origin", running.origin)
      .set("Cookie", nonce)
      .type("form")
      .send(
        `csrf=${csrfFrom(form.text)}&credential=${f.operator}&credential=${value}`,
      )
      .expect(403);
    await post("/staff/sign-in", `${nonce}; ${nonce}`, {
      csrf: csrfFrom(form.text),
      credential: f.operator,
    }).expect(403);
  }
});
it.each([
  "principal-revoked",
  "principal-expired",
  "role-changed",
  "grant-revoked",
  "grant-expired",
])(
  "STAFF-02-CURRENT fresh HTTP access after %s cannot fall back to legacy staff",
  async (change) => {
    const f = await fixture(change === "grant-expired" ? 2000 : 3600000),
      other = fresh();
    await auth.provisionStaff(other, "operator", new Date(Date.now() + 60000));
    const { response, cookie } = await signIn(f.operator);
    expect(response.status).toBe(303);
    const both = `${COOKIE}=${other}; ${cookie}`;
    const path = `/operator/support/${f.requestId}?grant=${f.grant}`;
    await get(path, both).expect(200);
    if (change === "principal-revoked")
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [f.staffId],
      );
    if (change === "principal-expired")
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [f.staffId],
      );
    if (change === "role-changed")
      await pool.query(
        "UPDATE staff_profiles SET role='coach' WHERE principal_id=$1",
        [f.staffId],
      );
    if (change === "grant-revoked")
      await pool.query(
        "UPDATE support_request_grants SET revoked_at=clock_timestamp() WHERE id=$1",
        [f.grant],
      );
    if (change === "grant-expired")
      await pool.query(
        "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))+0.1) FROM support_request_grants WHERE id=$1",
        [f.grant],
      );
    await get(path, both).expect(403);
  },
);
it("STAFF-04-SIGNOUT STAFF-04-RECOVERY signout preserves durable principal/profile/grants/accounting and another browser, including expired access recovery", async () => {
  const f = await fixture();
  const authority = async () =>
    (
      await pool.query(
        "SELECT (SELECT jsonb_agg(p ORDER BY p.id) FROM principals p) principals,(SELECT jsonb_agg(s ORDER BY s.principal_id) FROM staff_profiles s) profiles,(SELECT jsonb_agg(g ORDER BY g.id) FROM support_request_grants g) grants,(SELECT count(*)::int FROM synthetic_entitlement_events) accounting",
      )
    ).rows;
  const { cookie } = await signIn(f.operator),
    both = `${COOKIE}=${f.owner}; ${cookie}`,
    before = await authority();
  const portal = await get("/staff", both).expect(200),
    nonce = cookiesFrom(portal)[0]!.split(";")[0]!;
  await post("/staff/sign-out", `${both}; ${nonce}`, {
    csrf: csrfFrom(portal.text),
  }).expect(303);
  expect(await authority()).toEqual(before);
  await get("/staff", cookie).expect(200);
  await get("/staff", `${COOKIE}=${f.operator}; dne_staff=signed-out`).expect(
    403,
  );
  const reentry = await signIn(
    f.operator,
    `${COOKIE}=${f.owner}; dne_staff=signed-out`,
  );
  expect(reentry.response.status).toBe(303);
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [f.staffId],
  );
  const form = await get("/staff/sign-in", both).expect(200);
  const recovery = cookiesFrom(form)[0]!.split(";")[0]!;
  await post("/staff/sign-out", `${both}; ${recovery}`, {
    csrf: csrfFrom(form.text),
  }).expect(303);
  await get("/progress", `${COOKIE}=${f.owner}; dne_staff=signed-out`).expect(
    200,
  );
});
function apiWrite(
  method: "post" | "delete",
  path: string,
  cookie: string,
  csrf: string,
) {
  const client = request(running.server);
  return client[method](path)
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", cookie)
    .set("X-CSRF-Token", csrf);
}
it("STAFF-05-MEMBER cohort/evidence/progress/export actions retain the learner and its CSRF with both cookies", async () => {
  const f = await fixture(),
    both = `${COOKIE}=${f.owner}; dne_staff=${f.operator}`;
  const memberForm = await get("/evidence", both).expect(200),
    memberCsrf = csrfFrom(memberForm.text),
    staffForm = await get(
      `/operator/support/${f.requestId}?grant=${f.grant}`,
      both,
    ).expect(200),
    staffCsrf = csrfFrom(staffForm.text);
  expect(memberCsrf).not.toBe(staffCsrf);
  await pool.query("INSERT INTO cohorts(id) VALUES('staff-entry-circle')");
  await pool.query(
    "INSERT INTO cohort_content(cohort_id,content_id,body) VALUES('staff-entry-circle','sample','Owner shared sample')",
  );
  await pool.query(
    "INSERT INTO cohort_memberships(cohort_id,member_id,can_read_shared_content) VALUES('staff-entry-circle',$1,true)",
    [f.memberId],
  );
  expect(
    (
      await get("/api/cohorts/staff-entry-circle/content/sample", both).expect(
        200,
      )
    ).body.body,
  ).toBe("Owner shared sample");
  const upload = await apiWrite("post", "/api/evidence", both, memberCsrf)
    .set("Content-Type", "text/plain")
    .set("X-Evidence-Name", "Owner invented source")
    .set("X-Evidence-Rights", "confirmed")
    .set("X-Evidence-Scopes", "private-review")
    .send("Invented private owner source")
    .expect(201);
  const id = upload.body.id as string;
  expect(
    (
      await pool.query(
        "SELECT owner_principal_id FROM evidence_objects WHERE id=$1",
        [id],
      )
    ).rows[0].owner_principal_id,
  ).toBe(f.memberId);
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(root),
    "unused-capability-secret",
  );
  await evidence.transitionQuarantine(id, "clean");
  await apiWrite("post", `/api/evidence/${id}/review`, both, staffCsrf).expect(
    403,
  );
  await apiWrite("post", `/api/evidence/${id}/review`, both, memberCsrf).expect(
    204,
  );
  expect(
    (
      await pool.query(
        "SELECT submitted_by FROM evidence_review_submissions WHERE evidence_id=$1",
        [id],
      )
    ).rows[0].submitted_by,
  ).toBe(f.memberId);
  await get("/api/member/export", both).expect(200);
  await get("/api/evidence/export", both).expect(200);
  await get("/progress", both).expect(200);
  await get("/review-minutes", both).expect(200);
  await apiWrite(
    "post",
    `/api/evidence/${id}/revoke-private-review`,
    both,
    memberCsrf,
  ).expect(204);
  expect(
    (
      await pool.query(
        "SELECT private_review_allowed FROM evidence_objects WHERE id=$1",
        [id],
      )
    ).rows[0].private_review_allowed,
  ).toBe(false);
  await apiWrite("delete", `/api/evidence/${id}`, both, staffCsrf).expect(403);
  await apiWrite("delete", `/api/evidence/${id}`, both, memberCsrf).expect(204);
  expect(
    (await pool.query("SELECT id FROM evidence_objects WHERE id=$1", [id]))
      .rowCount,
  ).toBe(0);
});
it("STAFF-05-MIXED all three mixed APIs preserve original legacy/member actor, purpose, capability, CSRF and audit", async () => {
  const f = await fixture(),
    reviewer = fresh(),
    outsider = fresh(),
    expiry = new Date(Date.now() + 3600000);
  await members.create(outsider, { background: "explorer", goal: "everyday" });
  const reviewerId = await auth.provisionStaff(reviewer, "reviewer", expiry),
    legacyCookie = `${COOKIE}=${reviewer}`;
  const supportPurpose = "Invented precise workspace support";
  await auth.grantSupport(
    f.adminId,
    f.staffId,
    f.memberId,
    "operator",
    supportPurpose,
    expiry,
  );
  const memberCookie = `${COOKIE}=${f.owner}; dne_staff=${reviewer}`,
    operatorCookie = `${COOKIE}=${f.operator}; dne_staff=${reviewer}`;
  expect(
    (
      await get(`/api/workspaces/${f.memberId}/private`, memberCookie).expect(
        200,
      )
    ).body.via,
  ).toBe("member");
  await get(
    `/api/workspaces/${f.memberId}/private?purpose=wrong`,
    operatorCookie,
  ).expect(403);
  expect(
    (
      await get(
        `/api/workspaces/${f.memberId}/private?purpose=${encodeURIComponent(supportPurpose)}`,
        operatorCookie,
      ).expect(200)
    ).body.via,
  ).toBe("support");
  await get(
    `/api/workspaces/${f.memberId}/private?purpose=${encodeURIComponent(supportPurpose)}`,
    `${COOKIE}=${outsider}; dne_staff=${f.operator}`,
  ).expect(403);
  const evidence = evidenceStore(pool, fileObjectStorage(root), "fixture-only");
  const upload = await evidence.upload(f.owner, {
    name: "Mixed actor source",
    mediaType: "text/plain",
    data: Buffer.from("PRIVATE-MIXED-BYTES"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (upload.kind !== "created") throw Error("Missing mixed source");
  await evidence.transitionQuarantine(upload.id, "clean");
  await evidence.submitForReview(f.owner, upload.id);
  const submission = (
    await pool.query(
      "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
      [upload.id],
    )
  ).rows[0].id as string;
  const assignment = await auth.grantAssignment(
    f.adminId,
    reviewerId,
    f.memberId,
    "reviewer",
    "Invented review scope",
    expiry,
  );
  await auth.grantEvidenceReview(
    f.adminId,
    reviewerId,
    assignment,
    submission,
    "private_sample_feedback_v1",
    expiry,
  );
  const reviewerCsrf = csrfFrom(
      (await get("/editor/library", legacyCookie).expect(200)).text,
    ),
    memberCsrf = csrfFrom(
      (await get("/evidence", `${COOKIE}=${f.owner}`).expect(200)).text,
    );
  const both = `${legacyCookie}; dne_staff=${f.operator}`,
    linkPath = `/api/evidence/${upload.id}/download-link`;
  await apiWrite("post", linkPath, both, memberCsrf).expect(403);
  const link = await apiWrite("post", linkPath, both, reviewerCsrf).expect(200);
  expect(link.body.href).not.toContain(reviewer);
  expect((await get(link.body.href, both).expect(200)).text).toBe(
    "PRIVATE-MIXED-BYTES",
  );
  await get(
    `/api/evidence/${upload.id}/download?capability=invalid`,
    both,
  ).expect(403);
  const outsiderCookie = `${COOKIE}=${outsider}; dne_staff=${reviewer}`,
    outsiderCsrf = csrfFrom(
      (await get("/evidence", outsiderCookie).expect(200)).text,
    );
  await apiWrite("post", linkPath, outsiderCookie, outsiderCsrf).expect(403);
  await get(link.body.href, outsiderCookie).expect(403);
  const memberLink = await apiWrite(
    "post",
    linkPath,
    memberCookie,
    memberCsrf,
  ).expect(200);
  expect((await get(memberLink.body.href, memberCookie).expect(200)).text).toBe(
    "PRIVATE-MIXED-BYTES",
  );
  const audited = (
    await pool.query(
      "SELECT actor_id,action FROM authorization_audit WHERE evidence_id=$1 ORDER BY id",
      [upload.id],
    )
  ).rows;
  expect(audited).toEqual([
    { actor_id: reviewerId, action: "evidence_link_issued" },
    { actor_id: reviewerId, action: "evidence_bytes_loaded" },
  ]);
  expect(
    (
      await pool.query(
        "SELECT actor_id FROM authorization_audit WHERE action='workspace_read'",
        [],
      )
    ).rows,
  ).toEqual([{ actor_id: f.staffId }]);
});
