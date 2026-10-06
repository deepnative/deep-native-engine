import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore, type StaffRole } from "../../src/authorization.ts";
import { circleStore } from "../../src/circles.ts";
import {
  circleDiscussionStore,
  CIRCLE_DISCUSSION_POLICY,
} from "../../src/circle-discussion.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  circles = circleStore(pool),
  discussion = circleDiscussionStore(pool, "invented-grant-http"),
  base = "/operator/circle-grants";
let running: Awaited<ReturnType<typeof start>>, root: string;
const token = () => randomBytes(32).toString("hex");
const field = (html: string, name: string) => {
  const result = new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(
    html,
  )?.[1];
  if (result === undefined) throw Error(`Missing real form field ${name}`);
  return result;
};
const cookieFrom = (res: request.Response, name: string) => {
  const selected = (res.headers["set-cookie"] as unknown as string[])
    ?.find((v) => v.startsWith(`${name}=`))
    ?.split(";")[0];
  if (!selected) throw Error("Missing real selected staff cookie");
  return selected;
};
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
async function launch(overrides: Record<string, string | undefined> = {}) {
  return start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_CIRCLE_DISCUSSION: "enabled",
    DNE_LOCAL_CIRCLE_ADMIN: "enabled",
    DNE_PRIVATE_STORAGE_ROOT: root,
    ...overrides,
  });
}
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne483-http-full-"));
  running = await launch();
});
afterEach(async () => {
  await running?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
afterAll(() => pool.end());
async function staff(role: StaffRole = "platform_admin") {
  const credential = token(),
    expiresAt = new Date(Date.now() + 3600000),
    id = await auth.provisionStaff(credential, role, expiresAt);
  return { credential, id, expiresAt };
}
async function signIn(credential: string, member = "") {
  const form = await get("/staff/sign-in", member).expect(200),
    response = await post(
      "/staff/sign-in",
      `${member}; ${cookieFrom(form, "dne_staff_entry")}`,
      { csrf: field(form.text, "csrf"), credential },
    ).expect(303);
  return `${member}; ${cookieFrom(response, "dne_staff")}`;
}
async function fixture() {
  const admin = await staff(),
    target = await staff("moderator"),
    cookie = await signIn(admin.credential),
    home = await get(base, cookie).expect(200);
  return {
    admin,
    target,
    cookie,
    csrf: field(home.text, "csrf"),
    scope: { staffId: target.id, circleId: "everyday-ai" },
  };
}
async function checked(
  f: Awaited<ReturnType<typeof fixture>>,
  staffId = f.target.id,
  circleId = f.scope.circleId,
) {
  return post(`${base}/check`, f.cookie, {
    csrf: f.csrf,
    staffId,
    circleId,
  }).expect(200);
}
async function create(
  f: Awaited<ReturnType<typeof fixture>>,
  circleId = f.scope.circleId,
) {
  const confirm = await checked(f, f.target.id, circleId),
    input = {
      csrf: f.csrf,
      staffId: f.target.id,
      circleId,
      idempotencyKey: field(confirm.text, "idempotencyKey"),
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      confirm: "yes",
    },
    receipt = await post(`${base}/create`, f.cookie, input).expect(200),
    grantId = /data-circle-grant>([a-f0-9-]{36})/.exec(receipt.text)?.[1];
  if (!grantId) throw Error("Actual HTTP grant receipt missing");
  return { input, receipt, grantId };
}
it("CIRADM-01 current explicit own-reference and unchecked exact confirmation disclose no directory or credential", async () => {
  const f = await fixture(),
    member = token();
  await members.create(member, { background: "technical", goal: "build" });
  const memberSession = await members.session(member);
  if (memberSession.kind !== "active") throw Error("Missing invented member");
  const selected = await signIn(f.target.credential, `dne_preview=${member}`),
    reference = await get("/moderate/circle-reference", selected).expect(200);
  expect(reference.text).toContain(f.target.id);
  expect(reference.text).toContain(f.target.expiresAt.toISOString());
  expect(reference.text).toContain("moderator");
  for (const absent of [
    f.admin.id,
    f.admin.credential,
    f.target.credential,
    member,
    memberSession.learner.id,
  ])
    expect(reference.text).not.toContain(absent);
  await get(base, selected).expect(403);
  await get("/circles", selected).expect(200);
  const confirmation = await checked(f);
  expect(confirmation.text).toContain("circle-discussion-test-v1");
  expect(field(confirmation.text, "staffId")).toBe(f.target.id);
  expect(field(confirmation.text, "circleId")).toBe("everyday-ai");
  expect(field(confirmation.text, "expiresAt")).toBe("");
  expect(confirmation.text).not.toMatch(/type="checkbox"[^>]*checked/);
  expect(confirmation.text).toMatch(/name="idempotencyKey"[^>]*readonly/);
  const self = await checked(f, "self");
  expect(field(self.text, "staffId")).toBe(f.admin.id);
  expect(
    (await pool.query("SELECT id FROM preview_circle_moderator_grants")).rows,
  ).toEqual([]);
});
it.each([
  ["explorer", "everyday", "everyday-ai"],
  ["professional", "work", "professional-work"],
  ["technical", "build", "technical-practice"],
] as const)(
  "CIRADM-02/03 %s HTTP-created overlapping grants enable existing report/hide/restore then exact revokes deny fresh content",
  async (background, goal, circle) => {
    const f = await fixture(),
      author = token(),
      reporter = token(),
      body = `Invented ${background} reported question`,
      privateText = "INVENTED PRIVATE EXERCISE RETAINED";
    for (const credential of [author, reporter]) {
      await members.create(credential, { background, goal });
      expect(await circles.join(credential, circle)).toBe("joined");
      expect(
        (
          await discussion.choose(
            credential,
            circle,
            randomUUID(),
            "1",
            CIRCLE_DISCUSSION_POLICY,
            true,
          )
        ).kind,
      ).toBe("ready");
    }
    const member = await members.session(author);
    if (member.kind !== "active") throw Error("Missing invented author");
    expect(
      await members.save(member.learner.id, {
        instruction: privateText,
        verification: "Invented private check",
        complete: true,
        goal,
      }),
    ).toBe("saved");
    const published = await discussion.post(
      author,
      circle,
      randomUUID(),
      body,
      true,
    );
    if (published.kind !== "ready") throw Error("Missing invented post");
    expect(
      (
        await discussion.report(
          reporter,
          circle,
          published.value.id,
          randomUUID(),
          "privacy",
        )
      ).kind,
    ).toBe("ready");
    const targetCookie = await signIn(f.target.credential),
      queue = `/moderate/circles/${circle}/reports`;
    await get(queue, targetCookie).expect(403);
    await get(queue, f.cookie).expect(403);
    const first = await create(f, circle),
      second = await create(f, circle);
    for (const secret of [
      body,
      privateText,
      author,
      reporter,
      f.target.credential,
      f.admin.credential,
    ])
      expect(first.receipt.text).not.toContain(secret);
    expect(first.receipt.headers["cache-control"]).toContain("no-store");
    const admitted = await get(queue, targetCookie).expect(200);
    expect(admitted.text).toContain(body);
    expect(admitted.text).not.toContain(privateText);
    const decide = (action: string, revision: string) =>
      post(
        `/moderate/circles/${circle}/posts/${published.value.id}`,
        targetCookie,
        {
          csrf: field(admitted.text, "csrf"),
          action,
          expectedRevision: revision,
          idempotencyKey: randomUUID(),
          reason: "test_correction",
        },
      );
    await decide("hide", "1").expect(303);
    expect(
      (
        await get(
          `/circles/${circle}/discussion`,
          `dne_preview=${reporter}`,
        ).expect(200)
      ).text,
    ).not.toContain(body);
    await decide("restore", "2").expect(303);
    expect(
      (
        await get(
          `/circles/${circle}/discussion`,
          `dne_preview=${reporter}`,
        ).expect(200)
      ).text,
    ).toContain(body);
    const revoke = (grantId: string) =>
      post(`${base}/revoke`, f.cookie, {
        csrf: f.csrf,
        staffId: f.target.id,
        circleId: circle,
        grantId,
        confirm: "yes",
      });
    await revoke(first.grantId).expect(200);
    await revoke(first.grantId).expect(200);
    await get(queue, targetCookie).expect(200);
    await revoke(second.grantId).expect(200);
    const denied = await get(queue, targetCookie).expect(403);
    expect(denied.text).not.toContain(body);
    await decide("hide", "3").expect(403);
    expect(
      (
        await pool.query(
          "SELECT state,body FROM preview_circle_posts WHERE id=$1",
          [published.value.id],
        )
      ).rows,
    ).toEqual([{ state: "visible", body }]);
    expect((await members.session(author)).kind).toBe("active");
    expect(
      JSON.stringify(
        await pool.query(
          "SELECT instruction,completed_at FROM exercises WHERE learner_id=$1",
          [member.learner.id],
        ),
      ),
    ).toContain(privateText);
    expect(
      (
        await pool.query(
          "SELECT action FROM preview_circle_grant_audit WHERE grant_id=ANY($1::uuid[]) ORDER BY action",
          [[first.grantId, second.grantId]],
        )
      ).rows,
    ).toEqual([
      { action: "created" },
      { action: "created" },
      { action: "revoked" },
      { action: "revoked" },
    ]);
  },
);
it.each([
  "csrf",
  "origin",
  "host",
  "duplicate-cookie",
  "no-selection",
  "signed-out",
] as const)(
  "CIRADM-05 actual global %s protection denies grant creation without authority fallback",
  async (failure) => {
    const f = await fixture(),
      confirmation = await checked(f),
      input = {
        csrf: f.csrf,
        staffId: f.target.id,
        circleId: f.scope.circleId,
        idempotencyKey: field(confirmation.text, "idempotencyKey"),
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
        confirm: "yes",
      };
    let cookie = f.cookie;
    if (failure === "duplicate-cookie")
      cookie += `; dne_staff=${f.admin.credential}`;
    if (failure === "no-selection")
      cookie = `dne_preview=${f.admin.credential}`;
    if (failure === "signed-out")
      cookie = `dne_preview=${f.admin.credential}; dne_staff=signed-out`;
    const call = post(`${base}/create`, cookie, {
      ...input,
      ...(failure === "csrf" ? { csrf: "stale" } : {}),
    });
    if (failure === "origin") call.set("Origin", "https://invalid.example");
    if (failure === "host") call.set("Host", "invalid.example");
    const denied = await call.expect(403);
    expect(denied.text).not.toContain(f.target.credential);
    expect(
      (await pool.query("SELECT id FROM preview_circle_moderator_grants")).rows,
    ).toEqual([]);
  },
);
it.each([
  "unchecked",
  "past",
  "noncanonical",
  "beyond-target",
  "extra",
  "array",
] as const)(
  "CIRADM-05 exact confirmation rejects %s without silently shortening or mutating a grant",
  async (fault) => {
    const f = await fixture(),
      confirmation = await checked(f),
      input: Record<string, unknown> = {
        csrf: f.csrf,
        staffId: f.target.id,
        circleId: f.scope.circleId,
        idempotencyKey: field(confirmation.text, "idempotencyKey"),
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
        confirm: "yes",
      };
    if (fault === "unchecked") delete input.confirm;
    if (fault === "past")
      input.expiresAt = new Date(Date.now() - 1000).toISOString();
    if (fault === "noncanonical") input.expiresAt = "2030-01-01T00:00:00Z";
    if (fault === "beyond-target")
      input.expiresAt = new Date(+f.target.expiresAt + 1000).toISOString();
    if (fault === "extra") input.purpose = "other";
    if (fault === "array") input.staffId = [f.target.id, f.admin.id];
    await post(`${base}/create`, f.cookie, input).expect(
      fault === "unchecked" ? 403 : 422,
    );
    expect(
      (await pool.query("SELECT id FROM preview_circle_moderator_grants")).rows,
    ).toEqual([]);
  },
);
it("CIRADM-04/07 creator-scoped POST inspection keeps immutable replay and erased-key uncertainty truthful", async () => {
  const f = await fixture(),
    created = await create(f),
    other = await staff(),
    otherCookie = await signIn(other.credential),
    otherCsrf = field((await get(base, otherCookie).expect(200)).text, "csrf");
  expect(
    (await post(`${base}/create`, f.cookie, created.input).expect(200)).text,
  ).toContain(created.grantId);
  await post(`${base}/create`, f.cookie, {
    ...created.input,
    expiresAt: new Date(
      Date.parse(created.input.expiresAt) + 1000,
    ).toISOString(),
  }).expect(409);
  const lookup = {
    staffId: f.target.id,
    circleId: f.scope.circleId,
    lookupKind: "key",
    lookupValue: created.input.idempotencyKey,
  };
  const foreign = await post(`${base}/inspect`, otherCookie, {
    csrf: otherCsrf,
    ...lookup,
  }).expect(200);
  expect(foreign.text).not.toContain(created.grantId);
  expect(foreign.text).toContain("does not prove");
  const own = await post(`${base}/inspect`, f.cookie, {
    csrf: f.csrf,
    ...lookup,
  }).expect(200);
  expect(own.text).toContain(created.grantId);
  expect(own.text).toContain('target="_blank" rel="noopener"');
  expect(own.text).not.toMatch(
    new RegExp(`(?:href|action)="[^"]*${created.input.idempotencyKey}`),
  );
  await pool.query("DELETE FROM principals WHERE id=$1", [f.target.id]);
  const missing = await post(`${base}/inspect`, f.cookie, {
    csrf: f.csrf,
    ...lookup,
  }).expect(200);
  expect(missing.text).toContain("does not prove");
  expect(missing.text).not.toContain(created.grantId);
  const history = await post(`${base}/history`, f.cookie, {
    csrf: f.csrf,
    ...f.scope,
  }).expect(200);
  expect(history.text).toContain(created.grantId);
  expect(history.text).toContain("source-absent");
  expect(history.text).not.toContain(created.input.idempotencyKey);
  expect(history.text).not.toContain(created.input.expiresAt);
});
it.each(["administration", "discussion", "default"] as const)(
  "CIRADM-08 %s pause rejects new writes while exact protected history/inspection/revoke preserve existing authority",
  async (pause) => {
    const f = await fixture(),
      created = await create(f);
    await running.close();
    running = await launch(
      pause === "discussion"
        ? { DNE_CIRCLE_DISCUSSION: "disabled" }
        : {
            DNE_LOCAL_CIRCLE_ADMIN:
              pause === "default" ? undefined : "disabled",
          },
    );
    const cookie = await signIn(f.admin.credential),
      home = await get(base, cookie).expect(200),
      csrf = field(home.text, "csrf");
    expect(home.text).toContain("Creating circle grants is paused");
    await post(`${base}/create`, cookie, {
      ...created.input,
      csrf,
      idempotencyKey: randomUUID(),
    }).expect(403);
    const lookup = {
      csrf,
      ...f.scope,
      lookupKind: "key",
      lookupValue: created.input.idempotencyKey,
    };
    expect(
      (await post(`${base}/inspect`, cookie, lookup).expect(200)).text,
    ).toContain(created.grantId);
    expect(
      (await post(`${base}/history`, cookie, { csrf, ...f.scope }).expect(200))
        .text,
    ).toContain(created.grantId);
    await post(`${base}/revoke`, cookie, {
      csrf,
      ...f.scope,
      grantId: created.grantId,
      confirm: "yes",
    }).expect(200);
    expect(
      (await discussion.moderationQueue(f.target.credential, f.scope.circleId))
        .kind,
    ).toBe("denied");
  },
);
