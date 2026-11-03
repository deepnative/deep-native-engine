import { expect, it, vi } from "vitest";
import { randomBytes, scryptSync } from "node:crypto";
import request from "supertest";
import type { Pool } from "pg";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import {
  acceptablePassword,
  memberPasswordAccess,
  type MemberPasswordAccess,
} from "../../src/member-password-access.ts";
import { passwordSignInForm } from "../../src/member-password-routes.ts";
import type { MemberEmailAccess } from "../../src/member-email-access.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";

const origin = "http://127.0.0.1:3000";
const host = "127.0.0.1:3000";
const secret = "password-route-test";
const token = "a".repeat(64);
const good = "synthetic route passphrase";

function fixture(active = true) {
  const access = {
    status: vi.fn<MemberPasswordAccess["status"]>().mockResolvedValue("unset"),
    setPassword: vi
      .fn<MemberPasswordAccess["setPassword"]>()
      .mockResolvedValue("saved"),
    signIn: vi
      .fn<MemberPasswordAccess["signIn"]>()
      .mockResolvedValue({ kind: "refused" }),
    register: vi
      .fn<MemberPasswordAccess["register"]>()
      .mockResolvedValue("saved"),
    emailAvailable: vi
      .fn<MemberPasswordAccess["emailAvailable"]>()
      .mockResolvedValue(true),
  };
  const session = vi.fn().mockResolvedValue(
    active
      ? {
          kind: "active",
          expiresAt: new Date(Date.now() + 3600000),
          learner: { id: "member-id" },
        }
      : { kind: "new" },
  );
  const application = app({ session } as unknown as Store, {
    origin,
    secret,
    memberPassword: access,
  });
  const get = (path: string) =>
    withLoopback(application, (s) =>
      request(s)
        .get(path)
        .set("Host", host)
        .set("Cookie", `${COOKIE}=${token}`),
    );
  const post = (path: string, body: Record<string, string>, query = "") =>
    withLoopback(application, (s) =>
      request(s)
        .post(path + query)
        .set("Host", host)
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${token}`)
        .type("form")
        .send({ ...body, csrf: csrf(token, secret) }),
    );
  return { access, get, post };
}

it("PWD-01 renders each password state and refuses signed-out or malformed requests", async () => {
  const f = fixture();
  expect((await f.get("/account/password?x=1")).headers.location).toBe(
    "/account/password",
  );
  const unset = await f.get("/account/password");
  expect(unset.text).toContain("Choose a password");
  expect(unset.text).toContain('autocomplete="new-password"');
  expect(unset.text).not.toContain('name="current"');
  f.access.status.mockResolvedValueOnce("set");
  const set = await f.get("/account/password");
  expect(set.text).toContain("Password set");
  expect(set.text).toContain('name="current"');
  f.access.status.mockResolvedValueOnce("email_required");
  // SIGNUP-01 (#637): without an email, the page offers email and password.
  const blocked = await f.get("/account/password");
  expect([
    blocked.status,
    blocked.text.includes("Add a sign-in email and password"),
    blocked.text.includes('name="email"'),
  ]).toEqual([200, true, true]);
  f.access.status.mockResolvedValueOnce("unavailable");
  expect((await f.get("/account/password")).status).toBe(503);
  expect(
    (await f.post("/account/password", { password: good, extra: "x" })).status,
  ).toBe(400);
  expect(
    (await f.post("/account/password", { password: good }, "?q=1")).status,
  ).toBe(400);

  const out = fixture(false);
  expect((await out.get("/account/password")).headers.location).toBe(
    "/email/sign-in",
  );
  expect(
    (await out.post("/account/password", { password: good, confirm: good }))
      .headers.location,
  ).toBe("/email/sign-in");
  expect(out.access.setPassword).not.toHaveBeenCalled();
});

it("PWD-01/05 explains every password change outcome without echoing passwords", async () => {
  const f = fixture();
  const change = (body: Record<string, string>) =>
    f.post("/account/password", body);
  const short = await change({ password: "short", confirm: "short" });
  expect([short.status, short.text.includes("Use 12 to 128")]).toEqual([
    422,
    true,
  ]);
  const mismatch = await change({ password: good, confirm: `${good}!` });
  expect([mismatch.status, mismatch.text.includes("do not match")]).toEqual([
    422,
    true,
  ]);
  expect(mismatch.text).not.toContain(good);
  expect(f.access.setPassword).not.toHaveBeenCalled();

  expect((await change({ password: good, confirm: good })).status).toBe(200);
  expect(f.access.setPassword).toHaveBeenLastCalledWith(token, good, undefined);
  await change({ password: good, confirm: good, current: "old phrase" });
  expect(f.access.setPassword).toHaveBeenLastCalledWith(
    token,
    good,
    "old phrase",
  );
  const outcomes = [
    ["email_required", 409, "Add a sign-in email"],
    ["current_required", 403, "Enter your current password"],
    ["current_incorrect", 403, "current password is not correct"],
    ["invalid", 422, "Use 12 to 128"],
    ["unavailable", 503, "unavailable"],
  ] as const;
  for (const [result, status, text] of outcomes) {
    f.access.setPassword.mockResolvedValueOnce(result);
    if (result === "email_required")
      f.access.status.mockResolvedValueOnce("email_required");
    if (result === "unavailable")
      f.access.status.mockResolvedValueOnce("unavailable");
    const response = await change({ password: good, confirm: good });
    expect([result, response.status, response.text.includes(text)]).toEqual([
      result,
      status,
      true,
    ]);
  }
  f.access.setPassword.mockRejectedValueOnce(new Error("private failure"));
  f.access.status.mockResolvedValueOnce("unavailable");
  const failed = await change({ password: good, confirm: good });
  expect(failed.status).toBe(503);
  expect(failed.text).not.toContain("private failure");
});

it("PWD-02/03/04 signs in, refuses and limits with fixed messages", async () => {
  const f = fixture();
  const signIn = (body: Record<string, string>) =>
    f.post("/password/sign-in", body);
  expect(
    (await signIn({ email: "a@b.co", password: good, x: "1" })).status,
  ).toBe(400);
  const refused = await signIn({ email: "a@b.co", password: good });
  expect([
    refused.status,
    refused.text.includes("Email or password is incorrect"),
  ]).toEqual([401, true]);
  expect(refused.text).not.toContain(good);
  f.access.signIn.mockResolvedValueOnce({ kind: "limited" });
  expect((await signIn({ email: "a@b.co", password: good })).status).toBe(429);
  f.access.signIn.mockRejectedValueOnce(new Error("private failure"));
  const unavailable = await signIn({ email: "a@b.co", password: good });
  expect([unavailable.status, unavailable.text.includes("private")]).toEqual([
    503,
    false,
  ]);
  f.access.signIn.mockResolvedValueOnce({
    kind: "signed_in",
    token: "b".repeat(64),
  });
  const ok = await signIn({});
  expect(f.access.signIn).toHaveBeenLastCalledWith("", "");
  expect(ok.status).toBe(303);
  expect(ok.headers.location).toBe("/learn");
  expect([ok.headers["set-cookie"]].flat().join(";")).toContain(
    `${COOKIE}=${"b".repeat(64)}`,
  );
  expect(passwordSignInForm("c", "Shown")).toContain('role="alert"');
  expect(passwordSignInForm("c")).not.toContain('role="alert"');
});

it("PWD-01 accepts only 12-128 printable characters and reports database loss as unavailable", async () => {
  for (const value of ["x".repeat(12), "é".repeat(128), "a phrase with spaces"])
    expect(acceptablePassword(value)).toBe(true);
  for (const value of [
    undefined,
    "x".repeat(11),
    "x".repeat(129),
    " ".repeat(12),
    `${"x".repeat(12)}\n`,
    `${"x".repeat(12)}\u007f`,
  ])
    expect(acceptablePassword(value)).toBe(false);
  const broken = memberPasswordAccess({
    query: vi.fn().mockRejectedValue(new Error("database down")),
  } as unknown as Pool);
  expect(await broken.status(token)).toBe("unavailable");
  const empty = memberPasswordAccess({
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as unknown as Pool);
  expect(await empty.status(token)).toBe("unavailable");
  expect(await empty.setPassword(token, good)).toBe("unavailable");
  expect(await empty.setPassword(token, "short")).toBe("invalid");
});

it("PWD-02/05 treats an account that changes mid-request as unavailable or refused", async () => {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  const salt = randomBytes(16);
  const key = scryptSync(good, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 128 * 32768 * 8 * 2,
  });
  const stored = `scrypt$32768$8$1$${salt.toString("hex")}$${key.toString("hex")}`;
  const query = vi
    .fn()
    // setPassword: owner found, then revoked before the write.
    .mockResolvedValueOnce({
      rows: [{ id: "member-id", verified: true, stored: null }],
    })
    // signIn: no recent failures, matching password, then account gone.
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({
      rows: [{ principal_id: "member-id", stored }],
    });
  const racing = memberPasswordAccess({
    query,
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool);
  expect(await racing.setPassword(token, good)).toBe("unavailable");
  expect(await racing.signIn("member@example.com", good)).toEqual({
    kind: "refused",
  });
  expect(client.query).toHaveBeenCalledWith("COMMIT");
});

it("PWD-03 reads a body-less sign-in as empty fields", async () => {
  const f = fixture();
  const response = await withLoopback(
    app({ session: vi.fn() } as unknown as Store, {
      origin,
      secret,
      memberPassword: f.access,
    }),
    (s) =>
      request(s)
        .post("/password/sign-in")
        .set("Host", host)
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${token}`)
        .set("x-csrf-token", csrf(token, secret)),
  );
  expect(response.status).toBe(401);
  expect(f.access.signIn).toHaveBeenCalledWith("", "");
  const change = await withLoopback(
    app(
      {
        session: vi.fn().mockResolvedValue({
          kind: "active",
          expiresAt: new Date(Date.now() + 3600000),
          learner: { id: "member-id" },
        }),
      } as unknown as Store,
      { origin, secret, memberPassword: f.access },
    ),
    (s) =>
      request(s)
        .post("/account/password")
        .set("Host", host)
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${token}`)
        .set("x-csrf-token", csrf(token, secret)),
  );
  expect(change.status).toBe(422);
  expect(f.access.setPassword).not.toHaveBeenCalled();
});

it("SIGNUP-01/03 adds an email and password from the password page with every outcome", async () => {
  const f = fixture();
  f.access.status.mockResolvedValue("email_required");
  const add = (body: Record<string, string>) =>
    f.post("/account/password", { password: good, confirm: good, ...body });
  expect((await add({ email: "new@example.com" })).status).toBe(200);
  expect(f.access.register).toHaveBeenLastCalledWith(
    token,
    "new@example.com",
    good,
  );
  f.access.register.mockResolvedValueOnce("taken");
  const taken = await add({ email: "taken@example.com" });
  expect([taken.status, taken.text.includes("already used")]).toEqual([
    409,
    true,
  ]);
  expect(taken.text).toContain('value="taken@example.com"');
  f.access.register.mockResolvedValueOnce("invalid");
  const long = await add({ email: `${"x".repeat(250)}@example.com` });
  expect([long.status, long.text.includes("valid email")]).toEqual([422, true]);
  expect(long.text).not.toContain("x".repeat(250));
  f.access.register.mockRejectedValueOnce(new Error("private failure"));
  f.access.status.mockResolvedValueOnce("unavailable");
  expect((await add({ email: "down@example.com" })).status).toBe(503);
  f.access.register.mockResolvedValueOnce("unavailable");
  f.access.status.mockResolvedValueOnce("unavailable");
  expect((await add({ email: "gone@example.com" })).status).toBe(503);
});

function signupApp(
  access: MemberPasswordAccess,
  requestAttach?: () => Promise<"sent">,
) {
  const db = {
    session: vi.fn().mockResolvedValue({ kind: "new" }),
    create: vi.fn().mockResolvedValue(undefined),
  };
  const application = app(db as unknown as Store, {
    origin,
    secret,
    memberPassword: access,
    ...(requestAttach
      ? {
          memberEmail: {
            requestAttach: vi.fn(requestAttach),
            signOut: vi.fn(),
          } as unknown as MemberEmailAccess,
        }
      : {}),
  });
  const start = (body: Record<string, string>) =>
    withLoopback(application, (s) =>
      request(s)
        .post("/start")
        .set("Host", host)
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${token}`)
        .type("form")
        .send({
          display_name: "Fake Learner",
          background: "explorer",
          goal: "everyday",
          csrf: csrf(token, secret),
          ...body,
        }),
    );
  return { db, application, start };
}

it("SIGNUP-01/05 starts the account even when saving the sign-in or sending the email fails", async () => {
  const f = fixture();
  const fields = { signup_email: "a@example.com", signup_password: good };
  const failingEmail = signupApp(f.access, () =>
    Promise.reject(new Error("provider down")),
  );
  expect((await failingEmail.start(fields)).status).toBe(303);
  expect(failingEmail.db.create).toHaveBeenCalled();
  f.access.register.mockRejectedValueOnce(new Error("database down"));
  const failingSave = signupApp(f.access, () => Promise.resolve("sent"));
  expect((await failingSave.start(fields)).status).toBe(303);
  const noEmail = signupApp(f.access);
  expect((await noEmail.start(fields)).status).toBe(303);
  const tooLong = await noEmail.start({
    ...fields,
    signup_email: `${"y".repeat(250)}@example.com`,
  });
  expect(tooLong.status).toBe(422);
  expect(tooLong.text).not.toContain("y".repeat(250));
  // The password page's verification hand-off also tolerates a failed send.
  const page = await withLoopback(
    app(
      {
        session: vi.fn().mockResolvedValue({
          kind: "active",
          expiresAt: new Date(Date.now() + 3600000),
          learner: { id: "member-id" },
        }),
      } as unknown as Store,
      {
        origin,
        secret,
        memberPassword: f.access,
        memberEmail: {
          requestAttach: vi.fn().mockRejectedValue(new Error("down")),
          signOut: vi.fn(),
        } as unknown as MemberEmailAccess,
      },
    ),
    (s) =>
      request(s)
        .post("/account/password")
        .set("Host", host)
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${token}`)
        .type("form")
        .send({
          email: "a@example.com",
          password: good,
          confirm: good,
          csrf: csrf(token, secret),
        }),
  );
  expect(page.status).toBe(200);
});

it("SIGNUP-02 asks for access-loss acknowledgement only when no way back exists", async () => {
  const f = fixture();
  const active = vi.fn().mockResolvedValue({
    kind: "active",
    expiresAt: new Date(Date.now() + 3600000),
    learner: { id: "member-id" },
  });
  const signOutPage = (access: MemberPasswordAccess) =>
    withLoopback(
      app({ session: active } as unknown as Store, {
        origin,
        secret,
        memberPassword: access,
      }),
      (s) =>
        request(s)
          .get("/account/sign-out")
          .set("Host", host)
          .set("Cookie", `${COOKIE}=${token}`),
    );
  f.access.status.mockResolvedValueOnce("set");
  expect((await signOutPage(f.access)).text).not.toContain(
    "acknowledgeAccessLoss",
  );
  f.access.status.mockResolvedValueOnce("unset");
  expect((await signOutPage(f.access)).text).toContain("acknowledgeAccessLoss");
});
