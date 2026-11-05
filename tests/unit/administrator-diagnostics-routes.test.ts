import express from "express";
import request from "supertest";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { mountAdministratorDiagnostics } from "../../src/administrator-diagnostics-routes.ts";
import type {
  AdministratorDiagnostics,
  DiagnosticsResult,
  EmailDiagnosis,
  SiteDiagnosis,
} from "../../src/administrator-diagnostics.ts";
import { csrf, COOKIE } from "../../src/session.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => closeLoopback(s)));
});
const origin = "http://127.0.0.1:3000",
  secret = "invented-diagnostics-secret",
  token = "a".repeat(64),
  credential = "b".repeat(64),
  cookies = `${COOKIE}=${token}; dne_staff=${credential}`;
const site: SiteDiagnosis = {
  accounts: 12,
  verifiedEmails: 4,
  unverifiedEmails: 3,
  passwords: 5,
  day: { attach: 2, signIn: 6, used: 1, notices: 3, lookups: 4 },
  latestMigration: 93,
};
const found: EmailDiagnosis = {
  address: "shi@deepnative.io",
  verified: null,
  unverified: {
    accountId: "11111111-1111-4111-8111-111111111111",
    displayName: "Shi <b>",
    since: new Date("2026-11-04T15:00:00Z"),
  },
  links: [
    {
      purpose: "sign_in",
      created: new Date("2026-11-04T15:10:00Z"),
      state: "expired",
    },
  ],
  notices: [new Date("2026-11-04T14:30:00Z")],
};
async function fixture(
  results: {
    site?: DiagnosticsResult<SiteDiagnosis>;
    email?: DiagnosticsResult<EmailDiagnosis>;
  } = {},
  options: { live?: boolean; disabled?: boolean } = {},
) {
  const store = {
    site: vi.fn(async () => results.site ?? { kind: "ready", value: site }),
    email: vi.fn(async () => results.email ?? { kind: "ready", value: found }),
  } as unknown as AdministratorDiagnostics & {
    site: ReturnType<typeof vi.fn>;
    email: ReturnType<typeof vi.fn>;
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  mountAdministratorDiagnostics(app, store, {
    origin,
    secret,
    localStaffEntry: !options.disabled,
    mode: options.live ? "live" : "demo",
  });
  const server = await listenLoopback(app);
  servers.push(server);
  return { http: request(server), store };
}

it("WORDING-03 says no account uses an address that has none", async () => {
  const f = await fixture({
    email: {
      kind: "ready",
      value: { ...found, verified: null, unverified: null },
    },
  });
  const result = await f.http
    .post("/operator/diagnostics/email")
    .set("Origin", origin)
    .set("Cookie", cookies)
    .type("form")
    .send({ csrf: csrf(token, secret), email: "nobody@example.test" });
  expect(result.text).toContain(
    "Verified email</th><td>No account uses this address</td>",
  );
  expect(result.text).not.toContain("Not verified");
});
it("DIAG-02 shows site counts and an email lookup form to an administrator", async () => {
  const f = await fixture();
  const page = await f.http.get("/operator/diagnostics").set("Cookie", cookies);
  expect(page.status).toBe(200);
  expect(page.headers["cache-control"]).toBe("no-store");
  expect(f.store.site).toHaveBeenCalledExactlyOnceWith(credential);
  for (const text of [
    "<h1>Diagnostics</h1>",
    '<th scope="row">Accounts</th><td>12</td>',
    '<th scope="row">Sign-in links, last 24 hours</th><td>6</td>',
    '<th scope="row">No-account notices, last 24 hours</th><td>3</td>',
    '<th scope="row">Email lookups here, last 24 hours</th><td>4</td>',
    "Each email lookup is recorded.",
    '<th scope="row">Latest database migration</th><td>93</td>',
    'method="post" action="/operator/diagnostics/email"',
  ])
    expect(page.text).toContain(text);
});

it("DIAG-01 looks an email up by POST, so the address never sits in a URL", async () => {
  const f = await fixture();
  const result = await f.http
    .post("/operator/diagnostics/email")
    .set("Origin", origin)
    .set("Cookie", cookies)
    .type("form")
    .send({ csrf: csrf(token, secret), email: "shi@deepnative.io" });
  expect(result.status).toBe(200);
  expect(f.store.email).toHaveBeenCalledExactlyOnceWith(
    credential,
    "shi@deepnative.io",
  );
  for (const text of [
    "<h2>shi@deepnative.io</h2>",
    "Verified email</th><td>Not verified</td>",
    "Unverified sign-up email</th><td>Shi &lt;b&gt; · <code>11111111-1111-4111-8111-111111111111</code> · since 2026-11-04 15:00 UTC</td>",
    "<li>Sign-in link · 2026-11-04 15:10 UTC · expired</li>",
    "<li>2026-11-04 14:30 UTC</li>",
  ])
    expect(result.text).toContain(text);
});

it("DIAG-03 refuses lookups without the administrator session, CSRF or a valid address", async () => {
  const f = await fixture();
  const send = (cookie: string, body: Record<string, string>, from = origin) =>
    f.http
      .post("/operator/diagnostics/email")
      .set("Origin", from)
      .set("Cookie", cookie)
      .type("form")
      .send(body);
  const body = { csrf: csrf(token, secret), email: "shi@deepnative.io" };
  expect((await send(`${COOKIE}=${token}`, body)).status).toBe(403);
  expect((await send(cookies, { ...body, csrf: "x" })).status).toBe(403);
  expect((await send(cookies, body, "https://evil.test")).status).toBe(403);
  expect((await send(cookies, { ...body, extra: "1" })).status).toBe(403);
  expect(f.store.email).not.toHaveBeenCalled();
  expect(
    (
      await f.http
        .get("/operator/diagnostics")
        .set("Cookie", `${COOKIE}=${token}`)
    ).status,
  ).toBe(403);

  const invalid = await fixture({ email: { kind: "invalid" } });
  const refused = await invalid.http
    .post("/operator/diagnostics/email")
    .set("Origin", origin)
    .set("Cookie", cookies)
    .type("form")
    .send({ csrf: csrf(token, secret), email: "nope" });
  expect(refused.status).toBe(422);
  expect(refused.text).toContain("Enter a full email address.");

  const denied = await fixture({ site: { kind: "denied" } });
  expect(
    (await denied.http.get("/operator/diagnostics").set("Cookie", cookies))
      .status,
  ).toBe(403);
  const live = await fixture({}, { live: true });
  expect(
    (await live.http.get("/operator/diagnostics").set("Cookie", cookies))
      .status,
  ).toBe(404);
});

it("DIAG-03 answers unavailable or not found without showing partial results", async () => {
  const body = { csrf: csrf(token, secret), email: "shi@deepnative.io" };
  const lookup = async (
    f: Awaited<ReturnType<typeof fixture>>,
    cookie = cookies,
    payload: Record<string, string> = body,
  ) =>
    f.http
      .post("/operator/diagnostics/email")
      .set("Origin", origin)
      .set("Cookie", cookie)
      .type("form")
      .send(payload);
  const ok = await fixture();
  expect(
    (await ok.http.get("/operator/diagnostics?x=1").set("Cookie", cookies))
      .status,
  ).toBe(403);
  expect(
    (
      await ok.http
        .post("/operator/diagnostics/email?x=1")
        .set("Origin", origin)
        .set("Cookie", cookies)
        .type("form")
        .send(body)
    ).status,
  ).toBe(403);
  expect((await lookup(ok, `dne_staff=${credential}`)).status).toBe(403);
  expect(
    (await lookup(ok, cookies, { csrf: csrf(token, secret) })).status,
  ).toBe(403);
  expect(
    (
      await ok.http
        .post("/operator/diagnostics/email")
        .set("Origin", origin)
        .set("Cookie", cookies)
    ).status,
  ).toBe(403);

  const down = await fixture({ site: { kind: "unavailable" } });
  expect(
    (await down.http.get("/operator/diagnostics").set("Cookie", cookies))
      .status,
  ).toBe(503);
  expect((await lookup(down)).status).toBe(503);
  const denied = await fixture({ site: { kind: "denied" } });
  expect((await lookup(denied)).status).toBe(403);
  const lost = await fixture({ email: { kind: "unavailable" } });
  const result = await lookup(lost);
  expect(result.status).toBe(503);
  expect(result.text).not.toContain("shi@deepnative.io");
  const gone = await fixture({ email: { kind: "denied" } });
  expect((await lookup(gone)).status).toBe(403);

  const off = await fixture({}, { disabled: true });
  expect(
    (await off.http.get("/operator/diagnostics").set("Cookie", cookies)).status,
  ).toBe(404);
  const app = express();
  mountAdministratorDiagnostics(app, undefined, {
    origin,
    secret,
    localStaffEntry: true,
  });
  const server = await listenLoopback(app);
  servers.push(server);
  expect(
    (await request(server).get("/operator/diagnostics").set("Cookie", cookies))
      .status,
  ).toBe(404);
});

it("DIAG-01 lists a verified owner and an address with nothing sent", async () => {
  const f = await fixture({
    email: {
      kind: "ready",
      value: {
        address: "tom@deepnative.io",
        verified: {
          accountId: "22222222-2222-4222-8222-222222222222",
          displayName: null,
          since: new Date("2026-10-30T09:00:00Z"),
        },
        unverified: null,
        links: [
          {
            purpose: "attach",
            created: new Date("2026-10-30T08:55:00Z"),
            state: "used",
          },
        ],
        notices: [],
      },
    },
  });
  const result = await f.http
    .post("/operator/diagnostics/email")
    .set("Origin", origin)
    .set("Cookie", cookies)
    .type("form")
    .send({ csrf: csrf(token, secret), email: "tom@deepnative.io" });
  for (const text of [
    "Verified email</th><td>Name needed · <code>22222222-2222-4222-8222-222222222222</code> · since 2026-10-30 09:00 UTC</td>",
    "Unverified sign-up email</th><td>None</td>",
    "<li>Link-an-email link · 2026-10-30 08:55 UTC · used</li>",
    "<li>None.</li>",
  ])
    expect(result.text).toContain(text);
  const empty = await fixture({
    email: {
      kind: "ready",
      value: { ...found, unverified: null, links: [], notices: [] },
    },
  });
  expect(
    (
      await empty.http
        .post("/operator/diagnostics/email")
        .set("Origin", origin)
        .set("Cookie", cookies)
        .type("form")
        .send({ csrf: csrf(token, secret), email: "shi@deepnative.io" })
    ).text,
  ).toContain("<li>No links were created for this address.</li>");
});
