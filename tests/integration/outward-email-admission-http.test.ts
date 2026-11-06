import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { Pool } from "pg";
import request from "supertest";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
import {
  anonymousWriteAdmissionStore,
  ANONYMOUS_WRITE_LIMITS,
  type AnonymousWriteLimits,
} from "../../src/anonymous-write-admission.ts";
import { app } from "../../src/app.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { memberPasswordAccess } from "../../src/member-password-access.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";

// #42: a private database per file, because these tests read every counter row
// and every delivered email.
const root = new URL(
  process.env.DNE_TEST_DATABASE_URL ??
    process.env.DNE_DATABASE_URL ??
    "postgresql://dne:local-preview-only@127.0.0.1:54329/dne_dev",
);
const name = `dne_test_${randomBytes(16).toString("hex")}`;
const admin = new Pool({
  connectionString: root.toString(),
  connectionTimeoutMillis: 3000,
});
const scoped = new URL(root);
scoped.pathname = `/${name}`;
const pool = new Pool({
  connectionString: scoped.toString(),
  connectionTimeoutMillis: 3000,
});
const origin = "http://127.0.0.1:3000";
const secret = "synthetic-outward-email-secret";
const PASSWORD = "synthetic signup phrase 42";
const NEXT_PASSWORD = "synthetic changed phrase 42";
// Small allowances keep real scrypt work short; the shipped values are in the
// unit test and the limits document. Signup stays out of the way here.
const limits: AnonymousWriteLimits = {
  ...ANONYMOUS_WRITE_LIMITS,
  signup: { windowSeconds: 3600, perVisitor: 1000, service: 1000 },
  email_attach: { windowSeconds: 3600, perVisitor: 3, service: 5 },
  email_sign_in: { windowSeconds: 3600, perVisitor: 3, service: 5 },
  password_change: { windowSeconds: 900, perVisitor: 3, service: 5 },
};
const delivered: string[] = [];
const passwords = memberPasswordAccess(pool);
const application = () =>
  app(store(pool), {
    origin,
    secret,
    memberEmail: memberEmailAccess(
      pool,
      { send: async (address) => void delivered.push(address) },
      origin,
    ),
    memberPassword: passwords,
    anonymousWrites: anonymousWriteAdmissionStore(
      pool,
      { secret, publicOnly: false },
      limits,
    ),
  });

let server: Server;
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  await migrate(pool);
  server = await listenLoopback(application());
}, 120_000);
beforeEach(async () => {
  delivered.length = 0;
  vi.restoreAllMocks();
  await pool.query(
    "TRUNCATE principals,member_password_failures,anonymous_write_windows CASCADE",
  );
});
afterAll(async () => {
  await closeLoopback(server);
  await pool.end();
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
}, 60_000);

function post(
  path: string,
  form: Record<string, string>,
  forwardedFor: string,
  token = randomBytes(32).toString("hex"),
) {
  return request(server)
    .post(path)
    .set("Host", "127.0.0.1:3000")
    .set("Origin", origin)
    .set("Cookie", `${COOKIE}=${token}`)
    .set("X-Forwarded-For", forwardedFor)
    .type("form")
    .send({ ...form, csrf: csrf(token, secret) });
}

let accountNumber = 0;
// Each account starts from its own address, so only the request under test
// counts against the visitor being measured.
async function member() {
  accountNumber += 1;
  const token = randomBytes(32).toString("hex");
  const email = `member-${accountNumber}@example.invalid`;
  const started = await post(
    "/start",
    {
      display_name: "Invented Learner",
      background: "explorer",
      goal: "everyday",
      signup_email: email,
      signup_password: PASSWORD,
    },
    `198.51.100.${(accountNumber % 250) + 1}`,
    token,
  );
  expect(started.status).toBe(303);
  await vi.waitFor(() => expect(delivered).toContain(email));
  delivered.length = 0;
  return { token, email };
}
const members = (count: number) =>
  Array.from({ length: count }).reduce<
    Promise<Awaited<ReturnType<typeof member>>[]>
  >(async (all) => [...(await all), await member()], Promise.resolve([]));
const settled = () => new Promise((resolve) => setTimeout(resolve, 100));
const counted = async (kind: string) =>
  (
    await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM anonymous_write_windows WHERE kind=$1",
      [kind],
    )
  ).rows[0]!.n;

it("OUTWARD-01 refuses verification email past the visitor allowance, across accounts", async () => {
  const [a, b, c, d] = await members(4);
  for (const [i, who] of [a!, b!, c!].entries()) {
    const sent = await post(
      "/email/attach",
      { email: `third-party-${i}@example.invalid` },
      "203.0.113.10",
      who.token,
    );
    expect(sent.status).toBe(200);
  }
  await vi.waitFor(() => expect(delivered).toHaveLength(3));

  const refused = await post(
    "/email/attach",
    { email: "typed-kept@example.invalid" },
    // A forged left-hand entry cannot buy a fresh allowance.
    "192.0.2.77, 203.0.113.10",
    d!.token,
  );
  expect(refused.status).toBe(429);
  expect(refused.headers["cache-control"]).toBe("no-store");
  expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
  expect(refused.text).toContain(
    "Too many email links have been requested from this network.",
  );
  expect(refused.text).toContain("Nothing was sent.");
  expect(refused.text).toContain('value="typed-kept@example.invalid"');
  await settled();
  expect(delivered).toHaveLength(3);

  // Someone else on another address is unaffected.
  const neighbour = await post(
    "/email/attach",
    { email: "neighbour@example.invalid" },
    "203.0.113.11",
    d!.token,
  );
  expect(neighbour.status).toBe(200);
  await vi.waitFor(() =>
    expect(delivered).toContain("neighbour@example.invalid"),
  );
});

it("OUTWARD-02 refuses verification email past the service ceiling from a new address", async () => {
  const all = await members(6);
  for (const [i, who] of all.slice(0, 5).entries())
    expect(
      (
        await post(
          "/email/attach",
          { email: `spread-${i}@example.invalid` },
          `203.0.113.${20 + i}`,
          who.token,
        )
      ).status,
    ).toBe(200);
  await vi.waitFor(() => expect(delivered).toHaveLength(5));
  const refused = await post(
    "/email/attach",
    { email: "over-ceiling@example.invalid" },
    "203.0.113.30",
    all[5]!.token,
  );
  expect(refused.status).toBe(429);
  expect(refused.text).toContain("Email links are busy right now.");
  await settled();
  expect(delivered).toHaveLength(5);
});

it("OUTWARD-03 refuses sign-in links past the visitor allowance without revealing who is registered", async () => {
  const [a, b, c, d] = await members(4);
  for (const who of [a!, b!, c!])
    expect(
      (await post("/email/sign-in", { email: who.email }, "203.0.113.40"))
        .status,
    ).toBe(200);
  await vi.waitFor(() => expect(delivered).toHaveLength(3));

  const registered = await post(
    "/email/sign-in",
    { email: d!.email },
    "203.0.113.40",
  );
  const unregistered = await post(
    "/email/sign-in",
    { email: "nobody@example.invalid" },
    "203.0.113.40",
  );
  expect(registered.status).toBe(429);
  expect(unregistered.status).toBe(429);
  expect(Number(registered.headers["retry-after"])).toBeGreaterThan(0);
  expect(registered.headers["cache-control"]).toBe("no-store");
  expect(registered.text).toContain(
    "Too many email links have been requested from this network.",
  );
  // The same refusal either way, apart from the address typed and the form token.
  const neutral = (text: string, email: string) =>
    text
      .replaceAll(email, "ADDRESS")
      .replace(/name="csrf" value="[^"]*"/g, "")
      .replace(/ nonce="[^"]*"/g, "");
  expect(neutral(registered.text, d!.email)).toBe(
    neutral(unregistered.text, "nobody@example.invalid"),
  );
  expect(registered.text).toContain(`value="${d!.email}"`);
  // Password sign-in is offered as the way in that doesn't need a link.
  expect(registered.text).toContain('action="/password/sign-in"');
  await settled();
  expect(delivered).toHaveLength(3);
});

it("OUTWARD-04 refuses sign-in links past the service ceiling", async () => {
  const all = await members(6);
  for (const [i, who] of all.slice(0, 5).entries())
    expect(
      (
        await post(
          "/email/sign-in",
          { email: who.email },
          `203.0.113.${50 + i}`,
        )
      ).status,
    ).toBe(200);
  await vi.waitFor(() => expect(delivered).toHaveLength(5));
  const refused = await post(
    "/email/sign-in",
    { email: all[5]!.email },
    "203.0.113.60",
  );
  expect(refused.status).toBe(429);
  expect(refused.text).toContain("Email links are busy right now.");
  await settled();
  expect(delivered).toHaveLength(5);
});

it("OUTWARD-05 refuses a password change past the allowance before any hashing and keeps the old password", async () => {
  const [a] = await members(1);
  const hashing = vi.spyOn(passwords, "setPassword");
  for (let i = 0; i < 3; i++) {
    const wrong = await post(
      "/account/password",
      {
        current: "not the current phrase",
        password: NEXT_PASSWORD,
        confirm: NEXT_PASSWORD,
      },
      "203.0.113.70",
      a!.token,
    );
    expect(wrong.status).toBe(403);
  }
  expect(hashing).toHaveBeenCalledTimes(3);

  const refused = await post(
    "/account/password",
    { current: PASSWORD, password: NEXT_PASSWORD, confirm: NEXT_PASSWORD },
    "203.0.113.70",
    a!.token,
  );
  expect(refused.status).toBe(429);
  expect(refused.headers["cache-control"]).toBe("no-store");
  expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
  expect(refused.text).toContain(
    "Too many password changes from this network.",
  );
  expect(refused.text).toContain("Your password has not changed.");
  expect(refused.text).not.toContain(PASSWORD);
  expect(refused.text).not.toContain(NEXT_PASSWORD);
  expect(hashing).toHaveBeenCalledTimes(3);
  const signedIn = await post(
    "/password/sign-in",
    { email: a!.email, password: PASSWORD },
    "203.0.113.71",
  );
  expect(signedIn.status).toBe(303);
});

it("OUTWARD-05 also bounds adding a sign-in email with a password", async () => {
  const [a] = await members(1);
  const adding = vi.spyOn(passwords, "register");
  await pool.query("DELETE FROM member_login_emails");
  for (let i = 0; i < 3; i++)
    await post(
      "/account/password",
      {
        current: "not the current phrase",
        password: NEXT_PASSWORD,
        confirm: NEXT_PASSWORD,
      },
      "203.0.113.72",
      a!.token,
    );
  adding.mockClear();
  const refused = await post(
    "/account/password",
    {
      email: "added@example.invalid",
      password: NEXT_PASSWORD,
      confirm: NEXT_PASSWORD,
    },
    "203.0.113.72",
    a!.token,
  );
  expect(refused.status).toBe(429);
  expect(refused.text).toContain('value="added@example.invalid"');
  expect(adding).not.toHaveBeenCalled();
  await settled();
  expect(delivered).toHaveLength(0);
});

it("OUTWARD-06 fails closed with 503 and does no work when the limiter cannot answer", async () => {
  const [a] = await members(1);
  await post(
    "/email/attach",
    { email: "held@example.invalid" },
    "203.0.113.80",
    a!.token,
  );
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  await post("/email/sign-in", { email: a!.email }, "203.0.113.80");
  await post(
    "/account/password",
    {
      current: "not it at all",
      password: NEXT_PASSWORD,
      confirm: NEXT_PASSWORD,
    },
    "203.0.113.80",
    a!.token,
  );
  await vi.waitFor(() => expect(delivered).toHaveLength(2));
  delivered.length = 0;
  const hashing = vi.spyOn(passwords, "setPassword");
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT 1 FROM anonymous_write_windows WHERE subject='service' FOR UPDATE",
    );
    const attach = await post(
      "/email/attach",
      { email: "while-held@example.invalid" },
      "203.0.113.81",
      a!.token,
    );
    const signIn = await post(
      "/email/sign-in",
      { email: a!.email },
      "203.0.113.81",
    );
    const change = await post(
      "/account/password",
      { current: PASSWORD, password: NEXT_PASSWORD, confirm: NEXT_PASSWORD },
      "203.0.113.81",
      a!.token,
    );
    for (const response of [attach, signIn, change]) {
      expect(response.status).toBe(503);
      expect(response.headers["retry-after"]).toBe("60");
    }
    expect(attach.text).toContain('value="while-held@example.invalid"');
    expect(change.text).toContain("Your password has not changed.");
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  await settled();
  expect(delivered).toHaveLength(0);
  expect(hashing).not.toHaveBeenCalled();
}, 30_000);

it("OUTWARD-07 charges nothing for a request that could not send or hash anything", async () => {
  const [a] = await members(1);
  const before = {
    attach: await counted("email_attach"),
    signIn: await counted("email_sign_in"),
    change: await counted("password_change"),
  };
  expect(before).toEqual({ attach: 0, signIn: 0, change: 0 });
  for (let i = 0; i < 5; i++) {
    expect(
      (
        await post(
          "/email/attach",
          { email: "not-an-address" },
          "203.0.113.90",
          a!.token,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          "/email/sign-in",
          { email: "not-an-address" },
          "203.0.113.90",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          "/account/password",
          { password: "short", confirm: "short" },
          "203.0.113.90",
          a!.token,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await post(
          "/account/password",
          { password: NEXT_PASSWORD, confirm: "does not match at all" },
          "203.0.113.90",
          a!.token,
        )
      ).status,
    ).toBe(422);
  }
  // Without a session there is no member to act for.
  expect(
    (
      await post(
        "/email/attach",
        { email: "x@example.invalid" },
        "203.0.113.90",
      )
    ).status,
  ).toBe(401);
  expect(await counted("email_attach")).toBe(0);
  expect(await counted("email_sign_in")).toBe(0);
  expect(await counted("password_change")).toBe(0);
});

it("OUTWARD-08 stores only a keyed hash and lets a refused visitor continue after the window", async () => {
  const [a] = await members(1);
  for (let i = 0; i < 3; i++)
    await post("/email/sign-in", { email: a!.email }, "203.0.113.100");
  expect(
    (await post("/email/sign-in", { email: a!.email }, "203.0.113.100")).status,
  ).toBe(429);
  const rows = await pool.query<{ subject: string }>(
    "SELECT subject FROM anonymous_write_windows WHERE kind='email_sign_in'",
  );
  expect(rows.rows.map((row) => row.subject).sort()).toEqual([
    expect.stringMatching(/^[a-f0-9]{64}$/),
    "service",
  ]);
  expect(JSON.stringify(rows.rows)).not.toContain("203.0.113.100");
  // The window ends.
  await pool.query(
    "UPDATE anonymous_write_windows SET window_start=window_start-INTERVAL '2 hours' WHERE kind='email_sign_in'",
  );
  expect(
    (await post("/email/sign-in", { email: a!.email }, "203.0.113.100")).status,
  ).toBe(200);
});
