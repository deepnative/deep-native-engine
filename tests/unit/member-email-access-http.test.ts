import request from "supertest";
import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import type { MemberEmailAccess } from "../../src/member-email-access.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";

const origin = "http://127.0.0.1:3000";
const secret = "synthetic-email-access-test";
const credential = "a".repeat(64);
const code = "b".repeat(64);
function fixture(active = true, enabled = true) {
  const store = {
    session: vi.fn(async () =>
      active
        ? {
            kind: "active" as const,
            expiresAt: new Date("2090-01-01"),
            learner: {
              id: "member",
              background: "explorer" as const,
              goal: "everyday" as const,
            },
          }
        : { kind: "new" as const },
    ),
    progress: vi.fn(async () => undefined),
    assignmentChoice: vi.fn(async () => null),
    lessonActivities: vi.fn(async () => []),
  } as unknown as Store;
  const email = {
    ownedStatus: vi.fn(
      async () => "unlinked" as "linked" | "unlinked" | "unavailable",
    ),
    requestAttach: vi.fn(async () => "sent" as const),
    requestSignIn: vi.fn(async () => undefined),
    consume: vi.fn(async () => ({ kind: "attached" as const })),
  };
  return {
    application: app(store, {
      origin,
      secret,
      memberEmail: enabled ? (email as MemberEmailAccess) : undefined,
    }),
    email,
    store,
  };
}
const listeners = new WeakMap<ReturnType<typeof app>, Promise<Server>>();
const managedServers: Promise<Server>[] = [];
afterEach(async () => {
  await Promise.all(
    managedServers.splice(0).map(async (server) => closeLoopback(await server)),
  );
});
async function http(application: ReturnType<typeof app>) {
  let server = listeners.get(application);
  if (!server) {
    server = listenLoopback(application);
    listeners.set(application, server);
    managedServers.push(server);
  }
  return request(await server);
}
async function get(application: ReturnType<typeof app>, path: string) {
  return (await http(application))
    .get(path)
    .set("Host", "127.0.0.1:3000")
    .set("Cookie", `${COOKIE}=${credential}`);
}
async function post(
  application: ReturnType<typeof app>,
  path: string,
  body: Record<string, string>,
  includeCsrf = true,
) {
  return (await http(application))
    .post(path)
    .set("Host", "127.0.0.1:3000")
    .set("Origin", origin)
    .set("Cookie", `${COOKIE}=${credential}`)
    .type("form")
    .send({
      ...body,
      ...(includeCsrf ? { csrf: csrf(credential, secret) } : {}),
    });
}

it("lets a returning member request a private email sign-in link without an existing cookie", async () => {
  const response = await (
    await http(
      app({} as Store, {
        origin: "http://127.0.0.1:3000",
        secret: "synthetic-email-access-test",
      }),
    )
  )
    .get("/email/sign-in")
    .set("Host", "127.0.0.1:3000");

  expect(response.status).toBe(200);
  expect(response.text).toContain("email");
});

it("shows configured email sign-in and links it from the welcome page", async () => {
  const { application } = fixture(false);
  const landing = await get(application, "/email/sign-in");
  expect(landing.status).toBe(200);
  expect(landing.text).toContain('action="/email/sign-in"');
  const welcome = await get(application, "/");
  expect(welcome.text).toContain('href="/email/sign-in">Sign in</a>');
});

it("offers active members an email link from their learning path", async () => {
  const { application } = fixture();
  const dashboard = await get(application, "/learn");
  expect(dashboard.status).toBe(200);
  expect(dashboard.text).toContain('href="/email/attach"');
});

it("returns the same generic sign-in response for any address and requires CSRF", async () => {
  const { application, email } = fixture(false);
  expect(
    (
      await post(
        application,
        "/email/sign-in",
        { email: "x@example.com" },
        false,
      )
    ).status,
  ).toBe(403);
  const response = await post(application, "/email/sign-in", {
    email: "x@example.com",
  });
  expect(response.status).toBe(200);
  expect(response.text).not.toContain("x@example.com");
  expect(response.text).toContain("wait 15 minutes before requesting again");
  expect(response.text).toContain(
    "will not send another message while a link is pending",
  );
  expect(email.requestSignIn).toHaveBeenCalledExactlyOnceWith("x@example.com");
  await post(application, "/email/sign-in", {});
  expect(email.requestSignIn).toHaveBeenLastCalledWith("");
});

it.each([
  ["/email/sign-in", "sign-in"],
  ["/email/attach", "attachment"],
])("acknowledges %s without waiting for email delivery", async (path, kind) => {
  const { application, email } = fixture();
  let finish!: () => void;
  const pending = new Promise<unknown>((resolve) => {
    finish = () => resolve(kind === "attachment" ? "sent" : undefined);
  });
  if (kind === "attachment")
    email.requestAttach.mockReturnValueOnce(pending as never);
  else email.requestSignIn.mockReturnValueOnce(pending as never);
  const responsePromise = post(application, path, {
    email: "saved@example.com",
  }).then((response) => response);
  let timer: NodeJS.Timeout | undefined;
  let first: unknown;
  try {
    first = await Promise.race([
      responsePromise,
      new Promise<"waiting">((resolve) => {
        timer = setTimeout(() => resolve("waiting"), 1000);
      }),
    ]);
  } finally {
    finish();
    if (timer) clearTimeout(timer);
  }
  const response = await responsePromise;
  expect(first).not.toBe("waiting");
  expect(response.status).toBe(200);
  expect(response.text).not.toContain("saved@example.com");
});

it("keeps email delivery work bounded while every requester gets the same acknowledgement", async () => {
  const { application, email } = fixture(false);
  let finish!: () => void;
  const pending = new Promise<undefined>((resolve) => {
    finish = () => resolve(undefined);
  });
  email.requestSignIn.mockImplementation(() => pending);
  try {
    const responses = await Promise.all(
      Array.from({ length: 33 }, () =>
        post(application, "/email/sign-in", {
          email: "saved@example.com",
        }).then((response) => response),
      ),
    );
    await vi.waitFor(() =>
      expect(email.requestSignIn).toHaveBeenCalledTimes(32),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(
      responses.every((response) =>
        response.text.includes("<h1>Check your email</h1>"),
      ),
    ).toBe(true);
    expect(
      responses.every(
        (response) => !response.text.includes("saved@example.com"),
      ),
    ).toBe(true);
  } finally {
    finish();
  }
});

it("keeps a delivery error out of the generic response and private logs", async () => {
  const { application, email } = fixture(false);
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  try {
    email.requestSignIn.mockRejectedValueOnce(
      new Error("private saved@example.com"),
    );
    const response = await post(application, "/email/sign-in", {
      email: "saved@example.com",
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(email.requestSignIn).toHaveBeenCalledExactlyOnceWith(
        "saved@example.com",
      );
      expect(stderr).toHaveBeenCalledWith(
        "Member email request could not be confirmed.\n",
      );
    });
    expect(response.text).not.toContain("saved@example.com");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(
      "saved@example.com",
    );
  } finally {
    stderr.mockRestore();
  }
});

it("makes attachment available only to an active member without revealing whether an address is bound", async () => {
  const inactive = fixture(false);
  expect((await get(inactive.application, "/email/attach")).status).toBe(303);
  expect(
    (
      await post(inactive.application, "/email/attach", {
        email: "x@example.com",
      })
    ).status,
  ).toBe(401);
  expect(inactive.email.requestAttach).not.toHaveBeenCalled();
  const active = fixture();
  expect((await get(active.application, "/email/attach")).text).toContain(
    'action="/email/attach"',
  );
  const sent = await post(active.application, "/email/attach", {
    email: "x@example.com",
  });
  expect(sent.status).toBe(200);
  expect(sent.text).toContain("wait 15 minutes before requesting again");
  expect(sent.text).toContain(
    "will not send another message while a link is pending",
  );
  expect(active.email.requestAttach).toHaveBeenCalledWith(
    credential,
    "x@example.com",
  );
  active.email.requestAttach.mockResolvedValueOnce("unavailable" as never);
  const unavailable = await post(active.application, "/email/attach", {
    email: "x@example.com",
  });
  expect(unavailable.status).toBe(sent.status);
  expect(unavailable.text).toBe(sent.text);
  active.email.requestAttach.mockResolvedValueOnce("unavailable" as never);
  const malformed = await post(active.application, "/email/attach", {});
  expect(malformed.status).toBe(sent.status);
  expect(malformed.text).toBe(sent.text);
  expect(active.email.requestAttach).toHaveBeenLastCalledWith(credential, "");
});

it("fails closed when no sender is configured", async () => {
  const { application } = fixture(true, false);
  expect((await get(application, "/email/sign-in")).text).toContain(
    "Email sign-in is unavailable",
  );
  expect(
    (await post(application, "/email/sign-in", { email: "x@example.com" }))
      .status,
  ).toBe(503);
  expect((await get(application, "/email/attach")).status).toBe(503);
  expect(
    (await post(application, "/email/attach", { email: "x@example.com" }))
      .status,
  ).toBe(503);
  expect((await get(application, `/email/confirm?code=${code}`)).status).toBe(
    404,
  );
  expect(
    (await post(application, "/email/confirm", { code }, false)).status,
  ).toBe(404);
});

it("opens a confirmation page without consuming the code, then handles attach, sign-in and invalidation", async () => {
  const { application, email } = fixture();
  const invalid = await get(application, "/email/confirm?code=bad");
  expect(invalid.status).toBe(404);
  expect(invalid.headers["referrer-policy"]).toBe("origin");
  expect((await get(application, "/email/confirm")).status).toBe(404);
  const preview = await get(application, `/email/confirm?code=${code}`);
  expect(preview.status).toBe(200);
  expect(preview.text).toContain('action="/email/confirm"');
  expect(email.consume).not.toHaveBeenCalled();
  const linked = await post(application, "/email/confirm", { code }, false);
  expect(linked.status).toBe(200);
  expect(email.consume).toHaveBeenCalledWith(code, credential);
  email.consume.mockResolvedValueOnce({ kind: "unavailable" } as never);
  expect((await post(application, "/email/confirm", {}, false)).status).toBe(
    409,
  );
  email.consume.mockResolvedValueOnce({
    kind: "signed_in",
    token: credential,
  } as never);
  const signedIn = await post(application, "/email/confirm", { code }, false);
  expect(signedIn.status).toBe(303);
  expect(signedIn.headers["set-cookie"]?.[0]).toContain(
    `${COOKIE}=${credential}`,
  );
});

it("EMAIL-HTTP-01 keeps a competing listener out of the exact email error request", async () => {
  const { application, email } = fixture(false);
  email.requestSignIn.mockRejectedValueOnce(
    new Error("private saved@example.com"),
  );
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  const call = (await http(application))
    .post("/email/sign-in")
    .set("Host", "127.0.0.1:3000")
    .set("Origin", origin)
    .set("Cookie", `${COOKIE}=${credential}`)
    .type("form")
    .send({ email: "saved@example.com", csrf: csrf(credential, secret) });
  const owned = (call as unknown as { app: Server }).app;
  const address = owned.address();
  if (!address || typeof address === "string")
    throw Error("Owned listener unavailable");
  let ownedHits = 0,
    foreignHits = 0;
  owned.on("request", () => ownedHits++);
  const foreign = createServer((_req, res) => {
    foreignHits++;
    res.writeHead(400).end("Synthetic foreign response");
  });
  let foreignBound = false;
  try {
    foreignBound = await new Promise<boolean>((resolve, reject) => {
      foreign.once("error", (error: NodeJS.ErrnoException) =>
        error.code === "EADDRINUSE" ? resolve(false) : reject(error),
      );
      foreign.listen(address.port, "127.0.0.1", () => resolve(true));
    });
    const response = await call;
    expect(response.status).toBe(200);
    expect(ownedHits).toBe(1);
    expect(foreignHits).toBe(0);
    await vi.waitFor(() => {
      expect(email.requestSignIn).toHaveBeenCalledExactlyOnceWith(
        "saved@example.com",
      );
      expect(stderr).toHaveBeenCalledWith(
        "Member email request could not be confirmed.\n",
      );
    });
    expect(response.text).not.toContain("saved@example.com");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(
      "saved@example.com",
    );
  } finally {
    stderr.mockRestore();
    if (foreignBound)
      await new Promise<void>((resolve, reject) =>
        foreign.close((error) => (error ? reject(error) : resolve())),
      );
  }
});

it("EMAIL-ACCESS-05A/05B shows only the current owner's linked state and refuses stale attachment dispatch", async () => {
  const { application, email } = fixture();
  email.ownedStatus.mockResolvedValue("linked");
  const linked = await get(application, "/email/attach");
  const stale = await post(application, "/email/attach", {
    email: "foreign@example.com",
  });
  expect(linked.status).toBe(200);
  expect(stale.status).toBe(200);
  expect(stale.text).toBe(linked.text);
  expect(linked.text).toContain("Email already linked");
  expect(linked.text).toContain("another browser");
  expect(linked.text).toContain('href="/email/sign-in"');
  expect(linked.text).not.toContain('action="/email/attach"');
  expect(linked.text).not.toContain("foreign@example.com");
  expect(email.ownedStatus.mock.calls).toEqual([[credential], [credential]]);
  expect(email.requestAttach).not.toHaveBeenCalled();
});

it("EMAIL-ACCESS-05D withholds attachment state and dispatch when current ownership cannot be verified", async () => {
  const { application, email } = fixture();
  email.ownedStatus.mockResolvedValue("unavailable");
  const getResult = await get(application, "/email/attach");
  const postResult = await post(application, "/email/attach", {
    email: "private@example.com",
  });
  for (const response of [getResult, postResult]) {
    expect(response.status).toBe(503);
    expect(response.text).not.toContain("Email already linked");
    expect(response.text).not.toContain('action="/email/attach"');
    expect(response.text).not.toContain("private@example.com");
  }
  expect(email.requestAttach).not.toHaveBeenCalled();
});
