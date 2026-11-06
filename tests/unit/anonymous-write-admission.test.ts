import { afterEach, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import request from "supertest";
import { app } from "../../src/app.ts";
import {
  ANONYMOUS_WRITE_LIMITS,
  anonymousWriteAdmissionStore,
  anonymousWriteRefusal,
  anonymousWriteSubject,
  type AnonymousWriteAdmission,
} from "../../src/anonymous-write-admission.ts";
import type { MemberPasswordAccess } from "../../src/member-password-access.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import type { Store } from "../../src/store.ts";
import { UNKNOWN_VISITOR, visitorAddress } from "../../src/visitor-address.ts";
import { withLoopback } from "../support/loopback-server.ts";

const origin = "http://127.0.0.1:3000";
const secret = "anonymous-write-unit";
const token = "a".repeat(64);
const visitor = visitorAddress("127.0.0.1", "203.0.113.5");
const settings = { secret, publicOnly: false };
afterEach(() => vi.restoreAllMocks());

// A connection answering the statements the limiter sends, scripted per step.
function connection(steps: { take?: number[]; fail?: RegExp } = {}) {
  const takes = [...(steps.take ?? [1, 1])];
  const sent: string[] = [];
  const client = {
    query: vi.fn((text: string) => {
      sent.push(text);
      if (steps.fail?.test(text)) return Promise.reject(new Error("private"));
      if (text.includes("to_timestamp"))
        return Promise.resolve({
          rows: [{ window_start: new Date(0), seconds_left: 0.2 }],
        });
      if (text.includes("INSERT INTO anonymous_write_windows"))
        return Promise.resolve({ rowCount: takes.shift() });
      return Promise.resolve({ rowCount: 0, rows: [] });
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn().mockResolvedValue(client as unknown as PoolClient),
  } as unknown as Pool;
  return { client, pool, sent };
}

it("ANON-01/02/03 ships the agreed limits", () => {
  expect(ANONYMOUS_WRITE_LIMITS).toEqual({
    signup: { windowSeconds: 3600, perVisitor: 30, service: 300 },
    password_sign_in: { windowSeconds: 900, perVisitor: 60, service: 1200 },
  });
});

it("ANON-01/02/03/05 gives each refusal fixed guidance with a bounded wait", () => {
  const refused = (limit: "visitor" | "service", seconds = 600) =>
    ({ kind: "refused", limit, retryAfterSeconds: seconds }) as const;
  expect(anonymousWriteRefusal("signup", refused("visitor"))).toEqual({
    status: 429,
    retryAfterSeconds: 600,
    message:
      "Too many new accounts have been started from this network. Wait 10 minutes, then submit this form again. Nothing was saved.",
  });
  expect(anonymousWriteRefusal("signup", refused("service", 1)).message).toBe(
    "New accounts are busy right now. Wait 1 minute, then submit this form again. Nothing was saved.",
  );
  expect(
    anonymousWriteRefusal("password_sign_in", refused("visitor", 61)).message,
  ).toBe(
    "Too many sign-in attempts from this network. Wait 2 minutes, or use an email sign-in link.",
  );
  expect(
    anonymousWriteRefusal("password_sign_in", refused("service")).message,
  ).toBe(
    "Sign-in is busy right now. Wait 10 minutes, or use an email sign-in link.",
  );
  expect(anonymousWriteRefusal("signup", { kind: "unavailable" })).toEqual({
    status: 503,
    retryAfterSeconds: 60,
    message:
      "Starting a new account is unavailable right now. Try again in a minute. Nothing was saved.",
  });
  expect(
    anonymousWriteRefusal("password_sign_in", { kind: "unavailable" }).message,
  ).toBe("Sign-in is unavailable right now. Your saved work is unchanged.");
});

it("ANON-06 keys the stored visitor so the address cannot be read back", () => {
  const subject = anonymousWriteSubject(secret, visitor);
  expect(subject).toMatch(/^[a-f0-9]{64}$/);
  expect(subject).not.toBe(anonymousWriteSubject("another", visitor));
  expect(subject).not.toBe(anonymousWriteSubject(secret, UNKNOWN_VISITOR));
});

it("ANON-03 commits only when both the visitor and the service have room", async () => {
  const { client, pool, sent } = connection();
  expect(
    await anonymousWriteAdmissionStore(pool, settings).admit("signup", visitor),
  ).toEqual({ kind: "admitted" });
  expect(sent.at(-1)).toBe("COMMIT");
  expect(client.release).toHaveBeenCalledWith(undefined);
});

it("ANON-02/03 rolls back and names the limit that refused, logging no address", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const full = connection({ take: [0] });
  expect(
    await anonymousWriteAdmissionStore(full.pool, settings).admit(
      "password_sign_in",
      visitor,
    ),
  ).toEqual({ kind: "refused", limit: "visitor", retryAfterSeconds: 1 });
  expect(full.sent.at(-1)).toBe("ROLLBACK");
  // The whole-service row is never touched for a visitor past its allowance.
  expect(full.sent.filter((text) => text.includes("INSERT INTO"))).toHaveLength(
    1,
  );

  const busy = connection({ take: [1, 0] });
  expect(
    await anonymousWriteAdmissionStore(busy.pool, settings).admit(
      "signup",
      visitor,
    ),
  ).toEqual({ kind: "refused", limit: "service", retryAfterSeconds: 1 });
  expect(busy.sent.at(-1)).toBe("ROLLBACK");
  expect(busy.sent.join()).not.toContain("COMMIT");
  expect(JSON.stringify(info.mock.calls)).not.toContain("203.0.113.5");
  expect(info).toHaveBeenLastCalledWith(
    JSON.stringify({
      event: "anonymous_write_refused",
      kind: "signup",
      limit: "service",
      visitorScope: "public",
    }),
  );
});

it("ANON-05 answers unavailable and discards the connection on any failure", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const fail of [/BEGIN/, /to_timestamp/, /INSERT/, /DELETE/, /COMMIT/]) {
    const { client, pool } = connection({ fail });
    expect(
      await anonymousWriteAdmissionStore(pool, settings).admit(
        "signup",
        visitor,
      ),
    ).toEqual({ kind: "unavailable" });
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  }
  const rollback = connection({ take: [0], fail: /ROLLBACK/ });
  expect(
    await anonymousWriteAdmissionStore(rollback.pool, settings).admit(
      "signup",
      visitor,
    ),
  ).toEqual({ kind: "unavailable" });
  expect(rollback.client.release).toHaveBeenCalledWith(expect.any(Error));

  const unreachable = {
    connect: vi.fn().mockRejectedValue(new Error("private")),
  } as unknown as Pool;
  expect(
    await anonymousWriteAdmissionStore(unreachable, settings).admit(
      "signup",
      visitor,
    ),
  ).toEqual({ kind: "unavailable" });
  expect(JSON.stringify(error.mock.calls)).not.toContain("private");
});

it("ANON-06 a local process counts only public addresses", async () => {
  const { pool } = connection();
  const local = anonymousWriteAdmissionStore(pool, {
    secret,
    publicOnly: true,
  });
  for (const local_ of [
    visitorAddress("127.0.0.1", undefined),
    visitorAddress("127.0.0.1", "10.0.0.8"),
  ])
    expect(await local.admit("signup", local_)).toEqual({ kind: "admitted" });
  expect(pool.connect).not.toHaveBeenCalled();
  await local.admit("signup", visitor);
  expect(pool.connect).toHaveBeenCalledTimes(1);
});

function routes(
  result: AnonymousWriteAdmission,
  password: boolean,
): {
  admit: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  access: {
    signIn: ReturnType<typeof vi.fn>;
    emailAvailable: ReturnType<typeof vi.fn>;
  };
  post(path: string, form: Record<string, string>): Promise<request.Response>;
} {
  const admit = vi.fn().mockResolvedValue(result);
  const create = vi.fn().mockResolvedValue(undefined);
  const access = {
    status: vi.fn().mockResolvedValue("unset"),
    signIn: vi.fn().mockResolvedValue({ kind: "refused" }),
    register: vi.fn().mockResolvedValue("saved"),
    emailAvailable: vi.fn().mockResolvedValue(true),
  };
  const application = app(
    {
      session: vi.fn().mockResolvedValue({ kind: "new" }),
      create,
    } as unknown as Store,
    {
      origin,
      secret,
      anonymousWrites: { admit },
      ...(password
        ? { memberPassword: access as unknown as MemberPasswordAccess }
        : {}),
    },
  );
  return {
    admit,
    create,
    access,
    post: (path, form) =>
      withLoopback(application, (server) =>
        request(server)
          .post(path)
          .set("Host", "127.0.0.1:3000")
          .set("Origin", origin)
          .set("Cookie", `${COOKIE}=${token}`)
          .set("X-Forwarded-For", "198.51.100.9, 203.0.113.5")
          .type("form")
          .send({ ...form, csrf: csrf(token, secret) }),
      ),
  };
}
const start = {
  display_name: "Invented Learner",
  background: "explorer",
  goal: "everyday",
};
const refused: AnonymousWriteAdmission = {
  kind: "refused",
  limit: "visitor",
  retryAfterSeconds: 120,
};

it("ANON-01 refuses /start before the lookup and keeps what was typed", async () => {
  const route = routes(refused, true);
  const response = await route.post("/start", {
    ...start,
    signup_email: "kept@example.invalid",
    signup_password: "synthetic signup phrase 31",
  });
  expect(response.status).toBe(429);
  expect(response.headers["retry-after"]).toBe("120");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.text).toContain('value="Invented Learner"');
  expect(response.text).toContain("kept@example.invalid");
  expect(response.text).not.toContain("synthetic signup phrase 31");
  expect(route.admit).toHaveBeenCalledWith("signup", visitor);
  expect(route.access.emailAvailable).not.toHaveBeenCalled();
  expect(route.create).not.toHaveBeenCalled();
});

it("ANON-01 also bounds /start where passwords are not offered", async () => {
  const refusedRoute = routes(refused, false);
  const response = await refusedRoute.post("/start", start);
  expect(response.status).toBe(429);
  expect(response.text).not.toContain('name="signup_email"');
  expect(refusedRoute.create).not.toHaveBeenCalled();

  const admitted = routes({ kind: "admitted" }, false);
  expect((await admitted.post("/start", start)).status).toBe(303);
  expect(admitted.create).toHaveBeenCalledTimes(1);
});

it("ANON-06 asks nothing of the limiter for a malformed form", async () => {
  const route = routes({ kind: "admitted" }, true);
  const response = await route.post("/start", {
    ...start,
    signup_email: "not an email",
    signup_password: "short",
  });
  expect(response.status).toBe(422);
  expect(route.admit).not.toHaveBeenCalled();
});

it("ANON-02/05 refuses sign-in before the password is checked", async () => {
  const route = routes(refused, true);
  const response = await route.post("/password/sign-in", {
    email: "member@example.invalid",
    password: "synthetic route passphrase",
  });
  expect(response.status).toBe(429);
  expect(response.headers["retry-after"]).toBe("120");
  expect(response.text).toContain("Too many sign-in attempts");
  expect(route.access.signIn).not.toHaveBeenCalled();
  expect(route.admit).toHaveBeenCalledWith("password_sign_in", visitor);

  const down = routes({ kind: "unavailable" }, true);
  const unavailable = await down.post("/password/sign-in", {
    email: "member@example.invalid",
    password: "synthetic route passphrase",
  });
  expect(unavailable.status).toBe(503);
  expect(unavailable.headers["retry-after"]).toBe("60");
  expect(down.access.signIn).not.toHaveBeenCalled();

  const open = routes({ kind: "admitted" }, true);
  const ordinary = await open.post("/password/sign-in", {
    email: "member@example.invalid",
    password: "synthetic route passphrase",
  });
  expect(ordinary.status).toBe(401);
  expect(open.access.signIn).toHaveBeenCalledTimes(1);
});
