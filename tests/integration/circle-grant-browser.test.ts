import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import { hash, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { circleStore } from "../../src/circles.ts";
import {
  CIRCLE_DISCUSSION_POLICY,
  circleDiscussionStore,
} from "../../src/circle-discussion.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  circles = circleStore(pool),
  discussion = circleDiscussionStore(pool, "invented-circle-admin-test"),
  circle = "everyday-ai";
let running: Awaited<ReturnType<typeof start>>, root: string;
const token = () => randomBytes(32).toString("hex");
const get = (path: string, cookie = "") =>
  request(running.server)
    .get(path)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", cookie);
const csrf = (html: string) => {
  const value = /name="csrf" value="([a-f0-9]{64})"/.exec(html)?.[1];
  if (!value) throw Error("Invented staff form missing CSRF");
  return value;
};
const cookieFrom = (response: request.Response, name: string) => {
  const values = response.headers["set-cookie"] as unknown as string[];
  const value = values?.find((v) => v.startsWith(`${name}=`))?.split(";")[0];
  if (!value) throw Error("Invented staff fixture missing cookie");
  return value;
};
async function signIn(credential: string) {
  const form = await get("/staff/sign-in").expect(200);
  const response = await request(running.server)
    .post("/staff/sign-in")
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", cookieFrom(form, "dne_staff_entry"))
    .type("form")
    .send({ csrf: csrf(form.text), credential })
    .expect(303);
  return cookieFrom(response, "dne_staff");
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dne483-http-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_CIRCLE_DISCUSSION: "enabled",
    DNE_LOCAL_CIRCLE_ADMIN: "enabled",
    DNE_PRIVATE_STORAGE_ROOT: root,
  });
});
beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
afterAll(async () => {
  await running?.close();
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
async function staff(role: "moderator" | "platform_admin") {
  const credential = token();
  const id = await auth.provisionStaff(
    credential,
    role,
    new Date(Date.now() + 3600000),
  );
  return { credential, id };
}
it("CIRADM-01/02 current selected administrator opens browser circle-grant management", async () => {
  const admin = await staff("platform_admin");
  const selected = await signIn(admin.credential);
  const page = await get("/operator/circle-grants", selected);
  expect(
    page.status,
    "Current administrators need the actual grant-management page",
  ).toBe(200);
  expect(page.text).toContain("Circle moderation grants");
  expect(page.text).not.toContain(admin.credential);
});
it("CIRADM-01 current selected moderator reads only their own noncredential reference", async () => {
  const moderator = await staff("moderator");
  const selected = await signIn(moderator.credential);
  const page = await get("/moderate/circle-reference", selected);
  expect(
    page.status,
    "A current moderator needs a reference to request an exact circle grant",
  ).toBe(200);
  expect(page.text).toContain(moderator.id);
  expect(page.text).not.toContain(moderator.credential);
});
it("CIRADM-05 selected moderator credential rotated during the real principal lock wait denies while its replacement retains the exact grant", async () => {
  const admin = await staff("platform_admin"),
    moderator = await staff("moderator"),
    author = token(),
    reporter = token(),
    body =
      "Invented reported circle text belongs only to currently authorized staff";
  for (const credential of [author, reporter]) {
    await members.create(credential, {
      background: "explorer",
      goal: "everyday",
    });
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
  const post = await discussion.post(author, circle, randomUUID(), body, true);
  if (post.kind !== "ready") throw Error("Invented circle post missing");
  expect(
    (
      await discussion.report(
        reporter,
        circle,
        post.value.id,
        randomUUID(),
        "privacy",
      )
    ).kind,
  ).toBe("ready");
  const grant = await discussion.grantModerator(
    admin.credential,
    moderator.id,
    circle,
    randomUUID(),
    new Date(Date.now() + 1800000),
  );
  if (grant.kind !== "ready")
    throw Error("Invented exact moderator grant missing");
  const selected = await signIn(moderator.credential),
    path = `/moderate/circles/${circle}/reports`;
  expect((await get(path, selected).expect(200)).text).toContain(body);
  const holder = await pool.connect(),
    replacement = token();
  let pending: Promise<request.Response> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
      moderator.id,
    ]);
    const holderPid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() pid")
    ).rows[0]!.pid;
    pending = get(path, selected).then((response) => response);
    const observed = Promise.allSettled([pending]);
    let blocked = false;
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      blocked = (
        await pool.query<{ blocked: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) blocked",
          [holderPid],
        )
      ).rows[0]!.blocked;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(
      blocked,
      "Observe the real HTTP request waiting on the exact locked principal",
    ).toBe(true);
    await holder.query("UPDATE principals SET token_hash=$1 WHERE id=$2", [
      hash(replacement),
      moderator.id,
    ]);
    await holder.query("COMMIT");
    const result = await observed;
    expect(result[0]!.status).toBe("fulfilled");
    const stale = await pending;
    const current = await signIn(replacement);
    expect((await get(path, current).expect(200)).text).toContain(body);
    expect(
      (
        await pool.query(
          "SELECT revoked_at FROM preview_circle_moderator_grants WHERE id=$1",
          [grant.value.id],
        )
      ).rows,
    ).toEqual([{ revoked_at: null }]);
    expect(
      stale.status,
      "A credential replaced while its HTTP request waits must not disclose reports",
    ).toBe(403);
    expect(stale.text).not.toContain(body);
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    if (pending) await pending;
  }
}, 15000);
