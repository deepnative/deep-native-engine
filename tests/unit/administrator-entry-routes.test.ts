import express from "express";
import request from "supertest";
import type { Server } from "node:http";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { afterEach, expect, it, vi } from "vitest";
import { mountAdministratorEntry } from "../../src/administrator-entry-routes.ts";
import type {
  AdministratorResult,
  AdministratorConsoleResult,
} from "../../src/administrator-entry.ts";
import { csrf, COOKIE } from "../../src/session.ts";
import {
  expectPortalActions,
  mainHtml,
  portalActionRows,
} from "../support/portal-layout.ts";
const listeners = new WeakMap<express.Express, Promise<Server>>();
const ownedServers: Promise<Server>[] = [];
async function http(application: express.Express) {
  let server = listeners.get(application);
  if (!server) {
    server = listenLoopback(application);
    listeners.set(application, server);
    ownedServers.push(server);
  }
  return request(await server);
}
afterEach(async () => {
  await Promise.all(
    ownedServers.splice(0).map(async (server) => closeLoopback(await server)),
  );
});
const origin = "http://127.0.0.1:3000",
  secret = "invented-admin-route-secret",
  token = "a".repeat(64),
  credential = "b".repeat(64);
function fixture(
  options: {
    disabled?: boolean;
    live?: boolean;
    missing?: boolean;
    billing?: boolean;
    missingConsole?: boolean;
  } = {},
) {
  const state: {
    result: AdministratorResult;
    throws: boolean;
    directory: AdministratorConsoleResult;
  } = {
    result: {
      kind: "ready",
      credential,
      expires: new Date(Date.now() + 60000),
    },
    throws: false,
    directory: {
      kind: "ready",
      value: { members: [], courses: [] },
    } as AdministratorConsoleResult,
  };
  const fn = vi.fn(async () => {
    if (state.throws) throw Error("private database failure");
    return state.result;
  });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  mountAdministratorEntry(
    app,
    options.missing
      ? undefined
      : {
          status: fn,
          enter: fn,
          end: fn,
          console: options.missingConsole
            ? undefined
            : async () => {
                if (state.throws) throw Error("private directory error");
                return state.directory;
              },
        },
    {
      origin,
      secret,
      localStaffEntry: !options.disabled,
      mode: options.live ? "live" : "local",
      simpleInvoices: options.billing ? {} : undefined,
    },
  );
  return { app, state, fn };
}
async function post(
  app: express.Express,
  path = "enter",
  body: Record<string, string> = { csrf: csrf(token, secret) },
  cookie = `${COOKIE}=${token}`,
  source = origin,
) {
  return (await http(app))
    .post(`/admin/${path}`)
    .set("Origin", source)
    .set("Cookie", cookie)
    .type("form")
    .send(body);
}
it("ADMINONLY01/04 shows deliberate entry and keeps learner cookie unchanged", async () => {
  const f = fixture();
  const page = await (
    await http(f.app)
  )
    .get("/admin")
    .set("Cookie", `${COOKIE}=${token}`);
  expect(page.status).toBe(200);
  expect(page.text).toContain("Enter administration");
  expect(page.headers["set-cookie"]).toBeUndefined();
  const entered = await post(f.app);
  expect(entered.status).toBe(303);
  expect(entered.headers.location).toBe("/operator");
  expect((entered.headers["set-cookie"] as unknown as string[])[0]).toContain(
    `dne_staff=${credential}`,
  );
  expect((entered.headers["set-cookie"] as unknown as string[])[0]).toContain(
    "HttpOnly",
  );
  expect(
    (entered.headers["set-cookie"] as unknown as string[]).some((x: string) =>
      x.startsWith(`${COOKIE}=`),
    ),
  ).toBe(false);
  const ended = await post(f.app, "end");
  expect(ended.status).toBe(303);
  expect((ended.headers["set-cookie"] as unknown as string[])[0]).toContain(
    "dne_staff=signed-out",
  );
});
it("ADMINONLY02 denies missing/duplicate cookies, forged body, origin, CSRF and query", async () => {
  for (const cookie of [
    "",
    `${COOKIE}=bad`,
    `${COOKIE}=${token}; ${COOKIE}=${token}`,
  ]) {
    const f = fixture();
    expect(
      (await (await http(f.app)).get("/admin").set("Cookie", cookie)).status,
    ).toBe(403);
    expect(
      (await post(f.app, "enter", { csrf: csrf(token, secret) }, cookie))
        .status,
    ).toBe(403);
    expect(f.fn).not.toHaveBeenCalled();
  }
  for (const body of [
    {},
    { csrf: "bad" },
    { csrf: csrf(token, secret), email: "tom@deepnative.io" },
  ] as Record<string, string>[]) {
    const f = fixture();
    expect((await post(f.app, "enter", body)).status).toBe(403);
    expect(f.fn).not.toHaveBeenCalled();
  }
  const f = fixture();
  expect(
    (
      await post(
        f.app,
        "enter",
        { csrf: csrf(token, secret) },
        `${COOKIE}=${token}`,
        "https://elsewhere.invalid",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await (
        await http(f.app)
      )
        .get("/admin?owner=forged")
        .set("Cookie", `${COOKIE}=${token}`)
    ).status,
  ).toBe(403);
  expect((await post(f.app, "enter?owner=forged")).status).toBe(403);
  expect(f.fn).not.toHaveBeenCalled();
});
it("ADMINONLY03/05 refuses disabled/live or missing stores and denies unknown results without credentials", async () => {
  for (const o of [{ disabled: true }, { live: true }]) {
    const f = fixture(o);
    expect((await (await http(f.app)).get("/admin")).status).toBe(404);
    expect((await post(f.app)).status).toBe(404);
    expect(f.fn).not.toHaveBeenCalled();
  }
  const missing = fixture({ missing: true });
  expect(
    (
      await (
        await http(missing.app)
      )
        .get("/admin")
        .set("Cookie", `${COOKIE}=${token}`)
    ).status,
  ).toBe(503);
  expect((await post(missing.app)).status).toBe(503);
  for (const kind of ["denied", "unavailable"] as const) {
    const f = fixture();
    f.state.result = { kind };
    expect(
      (
        await (
          await http(f.app)
        )
          .get("/admin")
          .set("Cookie", `${COOKIE}=${token}`)
      ).status,
    ).toBe(kind === "denied" ? 403 : 503);
    expect((await post(f.app)).status).toBe(kind === "denied" ? 403 : 503);
  }
  const f = fixture();
  f.state.throws = true;
  expect((await post(f.app)).status).toBe(503);
  expect((await post(f.app)).headers["set-cookie"]).toBeUndefined();
  for (const result of [
    { kind: "ready" },
    { kind: "ready", credential: "bad", expires: new Date() },
    { kind: "ready", credential, expires: new Date(NaN) },
    { kind: "ready", credential, expires: new Date(0) },
  ] as AdministratorResult[]) {
    f.state.throws = false;
    f.state.result = result;
    expect((await post(f.app)).status).toBe(503);
  }
});

it("ADMINCON01 offers one administration workspace instead of a missing route", async () => {
  const f = fixture();
  const response = await (
    await http(f.app)
  )
    .get("/operator")
    .set("Cookie", `dne_staff=${credential}`);
  expect(response.status).toBe(200);
  expect(response.text).toContain('href="#learners"');
  expect(response.text).toContain('href="#courses"');
  expect(response.text).toContain('href="#invoices"');
});

it("ADMINCON01/02 renders only bounded account and billing summaries with escaped content", async () => {
  const f = fixture({ billing: true }),
    id = "11111111-1111-4111-8111-111111111111";
  f.state.directory = {
    kind: "ready",
    value: {
      members: [
        {
          id,
          displayName: "<Invented member>",
          background: "<professional>",
          goal: "<work>",
        },
      ],
      courses: [{ id: "FND-001", version: 2, title: "<Invented lesson>" }],
      selected: {
        member: {
          id,
          displayName: "<Invented member>",
          background: "<professional>",
          goal: "<work>",
        },
        enrollments: [{ id: "local-foundation-1", title: "<Foundations>" }],
        plans: [{ id, state: "offered" }],
        invoices: [
          {
            id,
            number: "<Sample-1>",
            totalCents: "1200",
            delivery: "not_sent",
          },
        ],
      },
    },
  };
  const r = await (
    await http(f.app)
  )
    .get("/operator?ownerId=" + id)
    .set("Cookie", `dne_staff=${credential}`);
  expect(r.status).toBe(200);
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.text).toContain("&lt;Invented member&gt;");
  expect(r.text).toContain("&lt;professional&gt;");
  expect(r.text).toContain("&lt;work&gt;");
  expect(r.text).not.toContain("<Invented member>");
  expect(r.text).toContain("&lt;Invented lesson&gt;");
  expect(r.text).toContain("&lt;Foundations&gt;");
  expect(r.text).toContain("&lt;Sample-1&gt;");
  expect(r.text).toContain("CAD 12.00");
  expect(r.text).toContain("/operator/invoices?ownerId=" + id);
  expect(r.text).toContain("Private writing and files are not available");
  f.state.directory.value.selected!.enrollments = [];
  f.state.directory.value.selected!.plans = [];
  f.state.directory.value.selected!.invoices = [];
  f.state.directory.value.selected!.member.displayName = null;
  const empty = await (
    await http(f.app)
  )
    .get("/operator")
    .set("Cookie", `dne_staff=${credential}`);
  expect(empty.text).toContain("Name needed");
  expect(empty.text).toContain("No recorded enrollment");
  expect(empty.text).toContain("No course bundles");
  expect(empty.text).toContain("No issued invoices");
  const off = fixture();
  off.state.directory = f.state.directory;
  expect(
    (
      await (
        await http(off.app)
      )
        .get("/operator")
        .set("Cookie", `dne_staff=${credential}`)
    ).text,
  ).toContain("Billing is disabled");
});
it("ADMINCON04 denies direct malformed or expired console requests without authority renewal", async () => {
  const f = fixture();
  for (const cookie of [
    "",
    `dne_staff=signed-out`,
    `dne_staff=${credential}; dne_staff=${credential}`,
  ])
    expect(
      (await (await http(f.app)).get("/operator").set("Cookie", cookie)).status,
    ).toBe(403);
  for (const query of [
    "?ownerId=wrong",
    "?ownerId=a&ownerId=b",
    "?unexpected=x",
  ])
    expect(
      (
        await (
          await http(f.app)
        )
          .get("/operator" + query)
          .set("Cookie", `dne_staff=${credential}`)
      ).status,
    ).toBe(403);
  for (const opts of [{ disabled: true }, { live: true }])
    expect(
      (await (await http(fixture(opts).app)).get("/operator")).status,
    ).toBe(404);
  for (const opts of [{ missing: true }, { missingConsole: true }])
    expect(
      (
        await (
          await http(fixture(opts).app)
        )
          .get("/operator")
          .set("Cookie", `dne_staff=${credential}`)
      ).status,
    ).toBe(503);
  for (const [kind, status] of [
    ["denied", 403],
    ["not-found", 404],
    ["unavailable", 503],
  ] as const) {
    f.state.directory = { kind };
    expect(
      (
        await (
          await http(f.app)
        )
          .get("/operator")
          .set("Cookie", `dne_staff=${credential}`)
      ).status,
    ).toBe(status);
  }
  f.state.throws = true;
  expect(
    (
      await (
        await http(f.app)
      )
        .get("/operator")
        .set("Cookie", `dne_staff=${credential}`)
    ).status,
  ).toBe(503);
  expect(f.fn).not.toHaveBeenCalled();
});
it("NAME03/05 names are primary, escaped and distinguishable without exposing private data", async () => {
  const f = fixture();
  const first = {
    id: "11111111-1111-4111-8111-111111111111",
    displayName: "李明 <Sam>",
    background: "explorer",
    goal: "work",
  };
  f.state.directory = {
    kind: "ready",
    value: {
      members: [
        first,
        { ...first, id: "22222222-2222-4222-8222-222222222222" },
        {
          id: "33333333-3333-4333-8333-333333333333",
          background: "professional",
          goal: "everyday",
        },
      ],
      courses: [],
    },
  };
  const response = await (
    await http(f.app)
  )
    .get("/operator")
    .set("Cookie", `dne_staff=${credential}`);
  expect(response.status).toBe(200);
  expect(response.text).toContain(">李明 &lt;Sam&gt;</a>");
  expect(response.text).toContain("Exploring AI");
  expect(response.text).toContain("Make everyday work clearer");
  expect(response.text).toContain("Name needed");
  for (const member of f.state.directory.value.members)
    expect(response.text).toContain(member.id);
  expect(response.text).not.toContain("<Sam>");
});
it("ADMIN-LAYOUT-01 groups session controls and tool links as spaced button rows", async () => {
  const page = await (
    await http(fixture().app)
  )
    .get("/admin")
    .set("Cookie", `${COOKIE}=${token}`);
  expect(page.status).toBe(200);
  const main = mainHtml(page.text);
  expect(main).toContain('<div class="portal-page">');
  expectPortalActions(page.text, [
    ["/operator", "Administration console"],
    ["/operator/invoices", "Courses and invoices"],
    ["/operator/coaching", "Monthly coaching"],
    ["/staff", "Staff tools"],
    ["/account", "My learning account"],
  ]);
  const session = portalActionRows(page.text).find((row) =>
    row.includes('action="/admin/enter"'),
  );
  expect(session).toContain('action="/admin/end"');
  expect(session).toContain(
    '<button class="secondary" type="submit">End administration for this sign-in</button>',
  );
  expect(main.match(/<section class="portal-card"/g)).toHaveLength(3);
  expect(
    portalActionRows(
      (await (await http(fixture().app)).get("/admin")).text,
    ).join(""),
  ).toContain('href="/email/sign-in" class="button secondary">Email sign-in');
});
it("ADMIN-LAYOUT-02 separates console areas into cards with button actions and wrapping references", async () => {
  const f = fixture({ billing: true }),
    id = "11111111-1111-4111-8111-111111111111",
    member = {
      id,
      displayName: "Invented",
      background: "explorer",
      goal: "everyday",
    };
  f.state.directory = {
    kind: "ready",
    value: {
      members: [member],
      courses: [],
      selected: { member, enrollments: [], plans: [], invoices: [] },
    },
  };
  const get = async (app = f.app) =>
    (
      await (
        await http(app)
      )
        .get("/operator")
        .set("Cookie", `dne_staff=${credential}`)
    ).text;
  const selected = await get();
  const main = mainHtml(selected);
  expect(main).toContain('<div class="portal-page administrator-console">');
  for (const area of ["learners", "courses", "invoices"])
    expect(main).toContain(`<section class="portal-card" id="${area}"`);
  expect(main).toContain(
    '<section class="portal-card" aria-labelledby="selected-member">',
  );
  expect(main).toContain(
    '<nav class="portal-actions" aria-label="Administration sections">',
  );
  expect(main).toContain(
    `<p class="portal-reference">Account reference: <code>${id}</code></p>`,
  );
  expect(main).toContain(
    '<form class="portal-search" method="get" action="/operator">',
  );
  expectPortalActions(selected, [
    ["#learners", "Learners"],
    [`/operator/invoices?ownerId=${id}`, "Compose courses for this learner"],
    [`/operator/coaching/${id}`, "Monthly coaching and rates"],
    ["/operator/invoices", "Courses and invoices"],
    ["/operator/coaching", "Monthly coaching"],
    ["/admin", "Administrator session"],
    ["/account", "My learning account"],
  ]);
  expect(main).toContain(
    `<a href="/operator/invoices?ownerId=${id}" class="button">Compose courses`,
  );
  f.state.directory = { kind: "ready", value: { members: [], courses: [] } };
  const plain = mainHtml(await get());
  expect(plain).not.toContain("selected-member");
  expect(plain.match(/<section class="portal-card"/g)).toHaveLength(3);
});
