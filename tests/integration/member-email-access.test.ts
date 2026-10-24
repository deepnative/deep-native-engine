import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import request from "supertest";
import { app } from "../../src/app.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { hash, migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const members = store(pool);
const origin = "http://127.0.0.1:3000";
const secret = "synthetic-email-sign-in-secret";
const delivered: { address: string; link: string }[] = [];
const access = memberEmailAccess(
  pool,
  {
    async send(address, link) {
      delivered.push({ address, link });
    },
  },
  origin,
);
const application = app(members, { origin, secret, memberEmail: access });

beforeAll(() => migrate(pool));
beforeEach(async () => {
  delivered.length = 0;
  await pool.query("TRUNCATE principals CASCADE");
});
afterAll(() => pool.end());

async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member unavailable");
  return { token, id: session.learner.id };
}
function code() {
  return new URL(delivered.at(-1)!.link).searchParams.get("code")!;
}
function post(path: string, value: Record<string, string>, cookie?: string) {
  const call = request(application)
    .post(path)
    .set("Host", "127.0.0.1:3000")
    .set("Origin", origin);
  if (cookie) call.set("Cookie", `${COOKIE}=${cookie}`);
  return call.type("form").send({ ...value, csrf: csrf(cookie ?? "", secret) });
}
async function anonymousPost(path: string, value: Record<string, string>) {
  const landing = await request(application)
    .get("/email/sign-in")
    .set("Host", "127.0.0.1:3000");
  const cookie = landing.headers["set-cookie"]?.[0]?.match(
    /dne_preview=([a-f0-9]{64})/,
  )?.[1];
  if (!cookie) throw new Error("Sign-in page did not set a browser cookie");
  return post(path, value, cookie);
}

it("EMAIL-ACCESS-01/02 links only the current verified member and reopens the same saved work", async () => {
  const owner = await member();
  await members.save(owner.id, {
    instruction: "Synthetic plan",
    verification: "Synthetic evidence",
    complete: true,
  });
  expect(await members.session(owner.token)).toMatchObject({
    kind: "active",
    learner: { id: owner.id },
  });
  const attach = await post(
    "/email/attach",
    { email: " Member@Example.COM " },
    owner.token,
  );
  expect([attach.status, attach.text.includes("Session expired")]).toEqual([
    200,
    false,
  ]);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.address).toBe("member@example.com");
  const attachCode = code();
  const preview = await request(application)
    .get(`/email/confirm?code=${attachCode}`)
    .set("Host", "127.0.0.1:3000");
  expect(preview.status).toBe(200);
  expect(
    await pool.query("SELECT 1 FROM member_email_identities"),
  ).toHaveProperty("rowCount", 0);
  expect(
    (await post("/email/confirm", { code: attachCode }, owner.token)).status,
  ).toBe(200);
  expect(
    (await post("/email/confirm", { code: attachCode }, owner.token)).status,
  ).toBe(409);
  const signin = await anonymousPost("/email/sign-in", {
    email: "MEMBER@example.com",
  });
  expect(signin.status).toBe(200);
  expect(delivered).toHaveLength(2);
  const signedIn = await post("/email/confirm", { code: code() });
  expect(signedIn.status).toBe(303);
  const nextToken = signedIn.headers["set-cookie"]?.[0]?.match(
    /dne_preview=([a-f0-9]{64})/,
  )?.[1];
  expect(nextToken).toBeDefined();
  expect((await members.session(owner.token)).kind).not.toBe("active");
  const resumed = await members.session(nextToken!);
  expect(resumed).toMatchObject({ kind: "active", learner: { id: owner.id } });
  expect(await members.progress(owner.id)).toMatchObject({
    instruction: "Synthetic plan",
  });
});

it("EMAIL-ACCESS-03/04 does not reveal unknown addresses, reuse links, or merge members", async () => {
  const owner = await member();
  const other = await member();
  await access.requestAttach(owner.token, "member@example.com");
  expect((await access.consume(code())).kind).toBe("attached");
  const unknown = await anonymousPost("/email/sign-in", {
    email: "unknown@example.com",
  });
  const known = await anonymousPost("/email/sign-in", {
    email: "member@example.com",
  });
  expect(unknown.status).toBe(known.status);
  expect(unknown.text).toBe(known.text);
  expect(delivered).toHaveLength(2);
  const stolen = code();
  const otherAttach = await access.requestAttach(
    other.token,
    "member@example.com",
  );
  expect(otherAttach).toBe("unavailable");
  expect((await members.session(other.token)).kind).toBe("active");
  await pool.query(
    "UPDATE member_email_links SET created_at=clock_timestamp()-INTERVAL '20 minutes', expires_at=clock_timestamp()-INTERVAL '5 minutes' WHERE token_hash=$1",
    [hash(stolen)],
  );
  expect((await access.consume(stolen)).kind).toBe("unavailable");
  expect((await members.session(owner.token)).kind).toBe("active");
  expect(
    (await pool.query("SELECT principal_id FROM member_email_identities"))
      .rows[0]?.principal_id,
  ).toBe(owner.id);
});

it("EMAIL-ACCESS-03 does not switch another active member or consume their link", async () => {
  const owner = await member();
  const other = await member();
  await access.requestAttach(owner.token, "owner@example.com");
  const attachCode = code();
  expect(
    (await post("/email/confirm", { code: attachCode }, other.token)).status,
  ).toBe(409);
  expect(
    (await pool.query("SELECT 1 FROM member_email_identities")).rowCount,
  ).toBe(0);
  expect(
    (await post("/email/confirm", { code: attachCode }, owner.token)).status,
  ).toBe(200);
  await access.requestSignIn("owner@example.com");
  const signInCode = code();

  const foreignSession = await post(
    "/email/confirm",
    { code: signInCode },
    other.token,
  );
  expect(foreignSession.status).toBe(409);
  expect((await members.session(owner.token)).kind).toBe("active");
  expect((await members.session(other.token)).kind).toBe("active");
  expect(
    (
      await pool.query(
        "SELECT consumed_at FROM member_email_links WHERE token_hash=$1",
        [hash(signInCode)],
      )
    ).rows[0]?.consumed_at,
  ).toBeNull();

  const rightfulSession = await post("/email/confirm", { code: signInCode });
  expect(rightfulSession.status).toBe(303);
  expect((await members.session(other.token)).kind).toBe("active");
});

it("EMAIL-ACCESS-03 bounds concurrent requests for one address across different members", async () => {
  const owners = await Promise.all(Array.from({ length: 6 }, () => member()));
  const results = await Promise.all(
    owners.map((owner) =>
      access.requestAttach(owner.token, "shared@example.com"),
    ),
  );
  expect(results.filter((result) => result === "sent")).toHaveLength(5);
  expect(results.filter((result) => result === "unavailable")).toHaveLength(1);
  expect(delivered).toHaveLength(5);
  const verified = await access.consume(code());
  expect(verified.kind).toBe("attached");
  expect(
    (await pool.query("SELECT 1 FROM member_email_identities")).rowCount,
  ).toBe(1);
});
