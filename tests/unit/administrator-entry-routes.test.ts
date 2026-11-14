import express from "express";
import request from "supertest";
import type { Server } from "node:http";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { afterEach, expect, it, vi } from "vitest";
import type { AdministratorDiagnostics } from "../../src/administrator-diagnostics.ts";
import type { WorkWaiting } from "../../src/administrator-work-waiting.ts";
import {
  waitedFor,
  workQueueTools,
  workWaitingCard,
} from "../../src/administrator-work-waiting-views.ts";
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
const joined = new Date("2026-11-02T12:00:00Z");
const listing = {
  total: 1,
  page: 1,
  pageSize: 25,
  search: "",
  months: { current: "2026-11", previous: "2026-10" },
  awaiting: [],
};
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
      value: { members: [], courses: [], ...listing },
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

it("ADMINHOME-01/ADMINNAV-01 lands on one Students page with the menu and no hub buttons", async () => {
  const f = fixture();
  const response = await (
    await http(f.app)
  )
    .get("/operator")
    .set("Cookie", `dne_staff=${credential}; ${COOKIE}=${token}`);
  expect(response.status).toBe(200);
  const main = mainHtml(response.text);
  expect(response.text).toContain("<title>Students ·");
  expect(main).toContain("<h1>Students</h1>");
  // HIDE-01: billing and roles are off in this fixture, so they get no link.
  expect(main).toContain(
    '<nav class="admin-menu" aria-label="Administration"><a href="/operator" aria-current="page">Students</a><a href="/staff">More</a></nav>',
  );
  expect(main.indexOf('id="awaiting-review"')).toBeLessThan(
    main.indexOf('id="all-students"'),
  );
  expect(main).toContain("No hours are waiting for review.");
  expect(main).toContain("No students yet.");
  // The in-page anchor buttons, the hub footer and the empty cards are gone.
  for (const gone of [
    'href="#',
    "portal-actions",
    "portal-footer",
    "portal-card",
    "Courses",
    "Invoices",
    "Administration console",
    "Learner",
    'href="/admin"',
    'href="/account"',
  ])
    expect(main).not.toContain(gone);
  const on = fixture({ billing: true });
  on.state.directory = {
    kind: "ready",
    value: {
      ...listing,
      members: [],
      courses: [{ id: "FND-001", version: 2, title: "<Invented lesson>" }],
    },
  };
  const listed = mainHtml(
    (
      await (
        await http(on.app)
      )
        .get("/operator")
        .set("Cookie", `dne_staff=${credential}`)
    ).text,
  );
  expect(listed).toContain('<a href="/operator/invoices">Invoices</a>');
  expect(listed).toContain(
    '<h2 id="courses">Courses</h2><p>Published lessons that can be put on a course invoice.</p><ul class="admin-list"><li>&lt;Invented lesson&gt;<span>FND-001 version 2</span></li></ul>',
  );
});
it("ADMINHOME-01 lists submitted hours first, each opening that student's month", async () => {
  const f = fixture();
  const id = "11111111-1111-4111-8111-111111111111",
    other = "22222222-2222-4222-8222-222222222222";
  f.state.directory = {
    kind: "ready",
    value: {
      ...listing,
      members: [],
      courses: [],
      awaiting: [
        {
          id,
          displayName: "Mei <Tanaka>",
          month: "2026-10",
          periodStart: "2026-10-01",
          periodEnd: "2026-10-31",
          minutes: 270,
        },
        {
          id: other,
          displayName: null,
          month: "2026-10-16",
          periodStart: "2026-10-16",
          periodEnd: "2026-10-29",
          minutes: 60,
        },
      ],
    },
  };
  const main = mainHtml(
    (
      await (
        await http(f.app)
      )
        .get("/operator")
        .set("Cookie", `dne_staff=${credential}`)
    ).text,
  );
  expect(main).toContain(
    `<h2 id="awaiting-review">Awaiting review</h2><ul class="admin-list"><li><a href="/operator/coaching/${id}?month=2026-10">Mei &lt;Tanaka&gt;</a><span>October 2026 · 4h 30m</span></li><li><a href="/operator/coaching/${other}?month=2026-10-16">Name needed</a><span>16 Oct 2026 to 29 Oct 2026 · 1h</span></li></ul>`,
  );
  expect(main).not.toContain("No hours are waiting for review.");
});
it("ADMINSTUDENT-01/ADMINCON02 an old selected-student link is a small page for that student, escaped", async () => {
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
          joined,
        },
      ],
      courses: [{ id: "FND-001", version: 2, title: "<Invented lesson>" }],
      ...listing,
      selected: {
        member: {
          id,
          displayName: "<Invented member>",
          background: "<professional>",
          goal: "<work>",
          joined,
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
  expect(r.text).toContain("<title>&lt;Invented member&gt; ·");
  const main = mainHtml(r.text);
  // The page is the student, not the whole console again.
  expect(main).toContain(
    `<a href="/operator">Students</a><a href="/operator/invoices">Invoices</a><a href="/staff">More</a></nav><h1>&lt;Invented member&gt;</h1><div class="portal-actions"><a href="/operator/coaching/${id}" class="button">Hours, rate and invoices</a></div>`,
  );
  for (const gone of [
    "<table",
    "portal-search",
    "Awaiting review",
    "Selected learner",
    "Account reference",
    "&lt;professional&gt;",
    "&lt;Invented lesson&gt;",
    `<code>${id}</code>`,
  ])
    expect(main).not.toContain(gone);
  expect(r.text).not.toContain("<Invented member>");
  expect(main).toContain("<li>&lt;Foundations&gt; · local-foundation-1</li>");
  expect(main).toContain("<li>Course bundle · offered</li>");
  expect(main).toContain(
    `<a href="/operator/invoices/${id}">&lt;Sample-1&gt;</a> · CAD 12.00 · delivery not_sent`,
  );
  expect(main).toContain(
    `<a href="/operator/invoices?ownerId=${id}">Prepare course billing for this student</a>`,
  );
  f.state.directory.value.selected!.enrollments = [];
  f.state.directory.value.selected!.plans = [];
  f.state.directory.value.selected!.invoices = [];
  f.state.directory.value.selected!.member.displayName = null;
  const empty = await (
    await http(f.app)
  )
    .get("/operator")
    .set("Cookie", `dne_staff=${credential}`);
  expect(empty.text).toContain("<title>Student ·");
  expect(empty.text).toContain("<h1>Name needed</h1>");
  expect(empty.text).toContain(
    "No course enrollment, bundle or course invoice yet.",
  );
  expect(empty.text).not.toContain("portal-columns");
  const off = fixture();
  off.state.directory = f.state.directory;
  const disabled = (
    await (
      await http(off.app)
    )
      .get("/operator")
      .set("Cookie", `dne_staff=${credential}`)
  ).text;
  expect(disabled).toContain("Billing is switched off on this site.");
  expect(disabled).not.toContain("/operator/invoices");
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
it("ADMINHOME-01/ADMINTABLE-01/02/03/04 renders a paged student table that keeps the search", async () => {
  const f = fixture();
  const calls: unknown[][] = [];
  const member = (index: number) => ({
    id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    displayName: index === 2 ? null : `Learner <${index}>`,
    background: "professional",
    goal: "work",
    joined: new Date("2026-11-02T12:00:00Z"),
    rateCents: index === 1 ? 12000 : null,
  });
  const members = [member(1), member(2)];
  const app = express();
  mountAdministratorEntry(
    app,
    {
      status: f.fn,
      enter: f.fn,
      end: f.fn,
      console: async (...args: unknown[]) => {
        calls.push(args);
        return f.state.directory;
      },
    },
    { origin, secret, localStaffEntry: true, mode: "local" },
  );
  const get = async (query = "") =>
    (await http(app))
      .get("/operator" + query)
      .set("Cookie", `dne_staff=${credential}`);
  const ready = (page: number, total: number, search = "") => {
    f.state.directory = {
      kind: "ready",
      value: { ...listing, members, courses: [], total, page, search },
    };
  };
  ready(1, 60);
  const first = await get();
  expect(first.status).toBe(200);
  expect(first.text).toContain("Showing 1–2 of 60");
  expect(first.text).toContain(
    '<table class="member-table stack-table"><thead><tr><th scope="col">Name</th><th scope="col">Hourly rate</th><th scope="col">This month<span>November 2026</span></th><th scope="col">Coaches</th><th scope="col">Joined</th></tr></thead>',
  );
  // ADMINHOME-01: no starting point, goal or account reference columns.
  for (const gone of [
    "Starting point",
    "Goal",
    "Account reference",
    "<code>",
    "Last month",
    "Earlier coaching",
  ])
    expect(first.text).not.toContain(gone);
  // ADMINSTUDENT-01: the name opens the one student page. Each cell carries
  // its label for the stacked phone layout.
  expect(first.text).toContain(
    `<tr><td data-label="Name"><a href="/operator/coaching/${members[0]!.id}">Learner &lt;1&gt;</a></td><td data-label="Hourly rate">CAD 120.00</td><td data-label="This month (November 2026)" class="member-coaching">—</td><td data-label="Coaches"><a href="/operator?ownerId=${members[0]!.id}" aria-label="Coaches for Learner &lt;1&gt;">Coaches</a></td><td data-label="Joined">2026-11-02</td></tr>`,
  );
  expect(first.text).toContain(
    `<a href="/operator/coaching/${members[1]!.id}">Name needed</a></td><td data-label="Hourly rate">Not set</td>`,
  );
  expect(first.text).toContain('href="/operator?page=2">Next');
  expect(first.text).not.toContain(">Previous<");
  expect(first.text).not.toContain("Clear search");

  ready(3, 60);
  const last = await get("?page=3");
  expect(calls.at(-1)).toEqual([
    credential,
    undefined,
    { page: 3, search: "" },
  ]);
  expect(last.text).toContain("Showing 51–52 of 60");
  expect(last.text).toContain('href="/operator?page=2">Previous');
  expect(last.text).not.toContain(">Next<");

  for (const malformed of ["0", "-1", "two", "1.5", "99999999999"]) {
    ready(1, 60);
    expect((await get(`?page=${malformed}`)).status).toBe(200);
    expect(calls.at(-1)).toEqual([
      credential,
      undefined,
      { page: 1, search: "" },
    ]);
  }

  ready(2, 1000, "a&b <c>");
  const searched = await get("?page=2&q=a%26b%20%3Cc%3E");
  expect(calls.at(-1)).toEqual([
    credential,
    undefined,
    { page: 2, search: "a&b <c>" },
  ]);
  expect(searched.text).toContain("Showing 26–27 of 1,000");
  expect(searched.text).toContain('value="a&amp;b &lt;c&gt;"');
  expect(searched.text).toContain(
    'href="/operator?page=1&amp;q=a%26b+%3Cc%3E">Previous',
  );
  expect(searched.text).toContain(
    'href="/operator?page=3&amp;q=a%26b+%3Cc%3E">Next',
  );
  expect(searched.text).toContain('href="/operator">Clear search</a>');
  expect(searched.text).toContain(
    '<label for="console-search">Search by name</label>',
  );

  // One page of students needs no pager.
  ready(1, 2);
  expect((await get()).text).not.toContain("member-pager");

  f.state.directory = {
    kind: "ready",
    value: {
      ...listing,
      members: [],
      courses: [],
      total: 0,
      search: "nobody",
    },
  };
  const none = await get("?q=nobody");
  expect(none.text).toContain("No students match this search.");
  expect(none.text).not.toContain("<table");
  expect(none.text).not.toContain("Showing");
  f.state.directory = {
    kind: "ready",
    value: { members: [], courses: [], ...listing, total: 0 },
  };
  expect((await get()).text).toContain("No students yet.");

  for (const query of ["?q=a&q=b", "?page=1&page=2", "?q=" + "x".repeat(121)])
    expect((await get(query)).status).toBe(403);
});
it("NAME03/05 names are primary, escaped and distinguishable without exposing private data", async () => {
  const f = fixture();
  const first = {
    id: "11111111-1111-4111-8111-111111111111",
    displayName: "李明 <Sam>",
    background: "explorer",
    goal: "work",
    joined,
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
          joined,
        },
      ],
      courses: [],
      ...listing,
    },
  };
  const response = await (
    await http(f.app)
  )
    .get("/operator")
    .set("Cookie", `dne_staff=${credential}`);
  expect(response.status).toBe(200);
  expect(response.text).toContain(">李明 &lt;Sam&gt;</a>");
  expect(response.text).toContain("Name needed");
  for (const member of f.state.directory.value.members)
    expect(response.text).toContain(member.id);
  expect(response.text).not.toContain("<Sam>");
});
it("ADMINHOME-01/ADMIN-LAYOUT-01 the entry page is short: one sentence and the control for the current state", async () => {
  const f = fixture({ billing: true });
  const client = await http(f.app);
  const before = await client.get("/admin").set("Cookie", `${COOKIE}=${token}`);
  expect(before.status).toBe(200);
  const anti = `<input type="hidden" name="csrf" value="${csrf(token, secret)}">`;
  // Not entered: the sentence and Enter administration, nothing else.
  expect(mainHtml(before.text)).toContain(
    `<div class="portal-page admin-entry"><h1>Administration</h1><p>An administrator session lasts up to eight hours and stays separate from your learning account.</p><div class="portal-actions"><form method="post" action="/admin/enter">${anti}<button type="submit">Enter administration</button></form></div></div>`,
  );
  for (const gone of ["admin-menu", "/admin/end", "/operator", "portal-card"])
    expect(mainHtml(before.text)).not.toContain(gone);
  // Entered in this browser: the menu, one primary link and End administration.
  const after = await client
    .get("/admin")
    .set("Cookie", `${COOKIE}=${token}; dne_staff=${credential}`);
  const main = mainHtml(after.text);
  expect(main).toContain(
    '<nav class="admin-menu" aria-label="Administration"><a href="/operator">Students</a><a href="/operator/invoices">Invoices</a><a href="/staff">More</a></nav><h1>Administration</h1>',
  );
  expect(main).toContain(
    `<div class="portal-actions"><a href="/operator" class="button">Go to Students</a><form method="post" action="/admin/end">${anti}<button class="secondary" type="submit">End administration</button></form></div></div>`,
  );
  expect(main).not.toContain("/admin/enter");
  expect(main).not.toContain("portal-card");
  expect(main.match(/class="button/g)).toHaveLength(1);
  // An ended or malformed administration cookie reads as not entered.
  for (const staff of ["signed-out", "short"])
    expect(
      mainHtml(
        (
          await client
            .get("/admin")
            .set("Cookie", `${COOKIE}=${token}; dne_staff=${staff}`)
        ).text,
      ),
    ).toContain('action="/admin/enter"');
  expect(
    portalActionRows((await client.get("/admin")).text).join(""),
  ).toContain('href="/email/sign-in" class="button secondary">Email sign-in');
});
it("ADMINHOME-01/ADMIN-LAYOUT-02 the Students page is plain sections, with a search and no cards", async () => {
  const f = fixture({ billing: true }),
    id = "11111111-1111-4111-8111-111111111111",
    member = {
      id,
      displayName: "Invented",
      background: "explorer",
      goal: "everyday",
      joined,
    };
  f.state.directory = {
    kind: "ready",
    value: { members: [member], courses: [], ...listing },
  };
  const main = mainHtml(
    (
      await (
        await http(f.app)
      )
        .get("/operator")
        .set("Cookie", `dne_staff=${credential}; ${COOKIE}=${"a".repeat(64)}`)
    ).text,
  );
  expect(main).toContain('<div class="portal-page administrator-console">');
  expect(main).toContain(
    '<section class="admin-section" aria-labelledby="awaiting-review">',
  );
  expect(main).toContain(
    '<section class="admin-section" aria-labelledby="all-students"><h2 id="all-students">All students</h2><form class="portal-search" method="get" action="/operator">',
  );
  expect(main).toContain(
    '<div class="table-scroll" tabindex="0" role="region" aria-label="Students">',
  );
  expect(main).not.toContain("portal-card");
  expect(main).not.toContain("portal-actions");
  expect(main).not.toContain('name="ownerId"');
  expect(main.match(/<h2/g)).toHaveLength(2);
});
it("ADMINHOME-01/CONSOLEMONTHS-01/02 shows this month's hours and status, linked to that month", async () => {
  const f = fixture();
  const base = {
    background: "professional",
    goal: "work",
    joined: new Date("2026-11-02T12:00:00Z"),
  };
  const coaching = (state: string, extra = {}) => ({
    month: "2026-11",
    minutes: 10320,
    state,
    returned: false,
    totalCents: null,
    paidCents: null,
    voided: false,
    ...extra,
  });
  const id = (n: number) =>
    `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const members = [
    {
      id: id(1),
      displayName: "Draft",
      ...base,
      // Earlier months are on the student's own page, not in this table.
      coaching: coaching("draft", { month: "2026-09" }),
      thisMonth: coaching("draft", { minutes: 720 }),
      lastMonth: coaching("submitted", { month: "2026-10", minutes: 90 }),
    },
    {
      id: id(2),
      displayName: "Review",
      ...base,
      thisMonth: coaching("submitted"),
    },
    {
      id: id(3),
      displayName: "Paid",
      ...base,
      thisMonth: coaching("invoiced", {
        totalCents: "5000",
        paidCents: "5000",
      }),
    },
    {
      id: id(4),
      displayName: "Due",
      ...base,
      thisMonth: coaching("invoiced", {
        totalCents: "5000",
        paidCents: "1000",
      }),
    },
    {
      id: id(5),
      displayName: "Void",
      ...base,
      thisMonth: coaching("invoiced", { totalCents: "5000", voided: true }),
    },
    {
      id: id(6),
      displayName: "Returned",
      ...base,
      thisMonth: coaching("draft", { returned: true, minutes: 90 }),
    },
    {
      // #832: a defined period is named by its dates.
      id: id(7),
      displayName: "Period",
      ...base,
      thisMonth: coaching("draft", {
        month: "2026-11-03",
        periodStart: "2026-11-03",
        periodEnd: "2026-11-16",
        minutes: 60,
      }),
    },
    { id: id(8), displayName: "None", ...base, thisMonth: null },
    { id: id(9), displayName: "Never", ...base },
  ];
  const app = express();
  mountAdministratorEntry(
    app,
    {
      status: f.fn,
      enter: f.fn,
      end: f.fn,
      console: async () => ({
        kind: "ready" as const,
        value: {
          ...listing,
          members,
          courses: [],
          total: 9,
        },
      }),
    },
    {
      origin,
      secret,
      localStaffEntry: true,
      mode: "local",
      simpleInvoices: true,
    },
  );
  const res = await (
    await http(app)
  )
    .get("/operator")
    .set("Cookie", `dne_staff=${credential}`);
  expect(res.status).toBe(200);
  const cell =
    'data-label="This month (November 2026)" class="member-coaching">';
  // CONSOLEMONTHS-01: the column names its month and links to it.
  expect(res.text).toContain(
    '<th scope="col">This month<span>November 2026</span></th>',
  );
  expect(res.text).toContain(
    `${cell}<a href="/operator/coaching/${id(1)}?month=2026-11">12h</a><span>Draft</span></td>`,
  );
  for (const label of [
    "Awaiting review",
    "Invoiced · Paid",
    "Invoiced · CAD 40.00 due",
    "Void",
    "Returned for correction",
  ])
    expect(res.text).toContain(`<span>${label}</span>`);
  expect(res.text).toContain(
    `${cell}<a href="/operator/coaching/${id(7)}?month=2026-11-03">3 Nov 2026 to 16 Nov 2026</a><span>1h · Draft</span></td>`,
  );
  // CONSOLEMONTHS-02: a month with nothing saved reads as empty.
  expect(res.text.split(`${cell}—</td>`)).toHaveLength(3);
  expect(res.text).not.toContain("month=2026-10");
  expect(res.text).not.toContain("month=2026-09");
});
it("ADMINSTUDENT-01/DEFCOACH-04/ROLEADMIN-01 keeps the coaches control on the student's small page, and Roles in the menu", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const learnerCoaches = vi.fn(async () => ({
    kind: "ready" as const,
    value: {
      assigned: ["d".repeat(64)],
      coaches: [{ emailHash: "d".repeat(64), label: "Invented Coach" }],
    },
  }));
  const status = vi.fn(async () => ({ kind: "ready" as const }));
  const app = express();
  mountAdministratorEntry(
    app,
    {
      status,
      enter: status,
      end: status,
      console: async () => ({
        kind: "ready" as const,
        value: {
          members: [],
          courses: [],
          ...listing,
          selected: {
            member: {
              id,
              displayName: "Invented Ada",
              background: "explorer",
              goal: "everyday",
              joined,
            },
            enrollments: [],
            plans: [],
            invoices: [],
          },
        },
      }),
    },
    {
      origin,
      secret,
      localStaffEntry: true,
      mode: "local",
      roleAdmin: {
        learnerCoaches,
        roles: vi.fn(),
        grant: vi.fn(),
        remove: vi.fn(),
        setCoaches: vi.fn(),
        changes: vi.fn(),
      },
    },
  );
  const client = await http(app);
  const res = await client
    .get(`/operator?ownerId=${id}`)
    .set("Cookie", `dne_staff=${credential}`);
  expect(res.status).toBe(200);
  expect(learnerCoaches).toHaveBeenCalledWith(credential, id);
  expect(res.text).toContain("<h1>Invented Ada</h1>");
  expect(res.text).toContain('<h2 id="learner-coach">Coaches</h2>');
  expect(res.text).toContain("<legend>Coaches for this student</legend>");
  expect(res.text).toContain(
    `<input type="hidden" name="csrf" value="${csrf(credential, secret)}">`,
  );
  expect(res.text).toContain(
    `value="${"d".repeat(64)}" checked><span>Invented Coach</span>`,
  );
  // HIDE-01: roles are on and billing is off, so the menu says exactly that.
  const menu =
    '<a href="/operator/roles">Roles</a><a href="/operator/changes">History</a><a href="/staff">More</a></nav>';
  expect(res.text).toContain(`<a href="/operator">Students</a>${menu}`);
  expect(app.locals.adminMenu).toEqual({ invoices: false, roles: true });
  const admin = await client
    .get("/admin")
    .set("Cookie", `${COOKIE}=${token}; dne_staff=${credential}`);
  expect(admin.text).toContain(menu);
});
const consoleHtml = (res: { text: string }) => mainHtml(res.text);
const emptyQueue = {
  waiting: 0,
  oldestWaitingMinutes: null,
  assigned: 0,
  oldestAssignedMinutes: null,
  people: 1,
};
const invented: WorkWaiting = {
  support: {
    waiting: 2,
    oldestWaitingMinutes: 200,
    assigned: 1,
    oldestAssignedMinutes: 45,
    people: 0,
  },
  feedback: { ...emptyQueue, waiting: 1, oldestWaitingMinutes: 1, people: 3 },
  workflow: {
    ...emptyQueue,
    waiting: 21,
    oldestWaitingMinutes: 4320,
    people: 0,
    references: ["22222222-2222-4222-8222-222222222222"],
  },
  contributions: {
    ...emptyQueue,
    assigned: null,
    waiting: 1,
    oldestWaitingMinutes: 0,
    people: 2,
  },
};
const allQueues = {
  support: true,
  feedback: true,
  workflow: true,
  contributions: true,
};
async function consoleWith(
  work: unknown,
  queues: Partial<typeof allQueues> | undefined = allQueues,
) {
  const app = express();
  mountAdministratorEntry(
    app,
    {
      status: vi.fn(),
      enter: vi.fn(),
      end: vi.fn(),
      console: async () => ({
        kind: "ready" as const,
        value: { members: [], courses: [], ...listing },
      }),
    },
    {
      origin,
      secret,
      localStaffEntry: true,
      mode: "local",
      administratorDiagnostics: {
        work: work as AdministratorDiagnostics["work"],
      },
    },
    queues && { ...allQueues, ...queues },
  );
  return (await http(app))
    .get("/operator")
    .set("Cookie", `dne_staff=${credential}`);
}
const row = (html: string, queue: string) =>
  html.match(new RegExp(`<tr data-work-queue="${queue}">.*?</tr>`))?.[0] ?? "";

it("WAITWORK-01 shows waiting work below the students, with ages and links to each queue", async () => {
  const work = vi.fn(async () => ({
    kind: "ready" as const,
    value: invented,
  }));
  const res = await consoleWith(work);
  expect(res.status).toBe(200);
  expect(work).toHaveBeenCalledWith(credential);
  const text = consoleHtml(res);
  expect(text.indexOf('id="all-students"')).toBeLessThan(
    text.indexOf('id="work-waiting"'),
  );
  expect(text).toContain("not a response-time promise");
  const support = row(text, "support");
  expect(support).toContain(
    '<a href="/operator/support-assignment/inbox">Support requests</a>',
  );
  expect(support).toContain("<td>2</td><td>3 hours</td>");
  expect(support).toContain("<td>1 · oldest 45 minutes</td>");
  const feedback = row(text, "feedback");
  expect(feedback).toContain('href="/operator/sample-assignments/pending"');
  expect(feedback).toContain("<td>1</td><td>1 minute</td><td>0</td><td>3</td>");
  expect(row(text, "workflow")).toContain("<td>21</td><td>3 days</td>");
  const contributions = row(text, "contributions");
  expect(contributions).toContain('href="/moderate/proposals"');
  expect(contributions).toContain(
    "<td>1</td><td>Under a minute</td><td>—</td><td>2</td>",
  );
});
it("HIDE-01 leaves Work waiting out when nothing is waiting or assigned in a queue that is on", async () => {
  const quiet = {
    support: emptyQueue,
    feedback: emptyQueue,
    workflow: { ...emptyQueue, references: [] },
    contributions: { ...emptyQueue, assigned: null },
  };
  const ready = (value: unknown) => async () => ({ kind: "ready", value });
  expect(consoleHtml(await consoleWith(ready(quiet)))).not.toContain(
    "work-waiting",
  );
  // One assigned item, or one waiting item, brings the whole card back.
  for (const busy of [
    { ...quiet, feedback: { ...emptyQueue, assigned: 1 } },
    { ...quiet, contributions: { ...quiet.contributions, waiting: 1 } },
  ])
    expect(consoleHtml(await consoleWith(ready(busy)))).toContain(
      'id="work-waiting"',
    );
  // Work in a queue that is switched off here does not count.
  expect(
    consoleHtml(
      await consoleWith(
        ready({ ...quiet, support: { ...emptyQueue, waiting: 4 } }),
        { support: false },
      ),
    ),
  ).not.toContain("work-waiting");
});
it("WAITWORK-04 lists workflow references and says when the list is cut short", async () => {
  const many = consoleHtml(
    await consoleWith(async () => ({ kind: "ready", value: invented })),
  );
  expect(many).toContain("<code>22222222-2222-4222-8222-222222222222</code>");
  expect(many).toContain("Showing the oldest 20 of 21.");
  const few = consoleHtml(
    await consoleWith(async () => ({
      kind: "ready",
      value: { ...invented, workflow: { ...invented.workflow, waiting: 1 } },
    })),
  );
  expect(few).toContain("Oldest first.");
  const none = consoleHtml(
    await consoleWith(async () => ({
      kind: "ready",
      value: {
        ...invented,
        workflow: { ...invented.workflow, waiting: 0, references: [] },
      },
    })),
  );
  expect(none).not.toContain("Workflow review references");
});

it("WAITWORK-06 omits queues that are off on this site", async () => {
  const value = { kind: "ready", value: invented };
  const some = consoleHtml(
    await consoleWith(async () => value, {
      support: false,
      workflow: false,
    }),
  );
  expect(row(some, "support")).toBe("");
  expect(row(some, "workflow")).toBe("");
  expect(some).not.toContain("Workflow review references");
  expect(row(some, "feedback")).not.toBe("");
  const none = consoleHtml(
    await consoleWith(async () => value, {
      support: false,
      feedback: false,
      workflow: false,
      contributions: false,
    }),
  );
  expect(none).not.toContain("work-waiting");
  expect(
    workWaitingCard(invented, {
      support: false,
      feedback: false,
      workflow: false,
      contributions: false,
    }),
  ).toBe("");
});

it("WAITWORK-07 reads nothing for a request the console refuses", async () => {
  const work = vi.fn();
  const app = express();
  mountAdministratorEntry(
    app,
    {
      status: vi.fn(),
      enter: vi.fn(),
      end: vi.fn(),
      console: async () => ({ kind: "denied" as const }),
    },
    {
      origin,
      secret,
      localStaffEntry: true,
      mode: "local",
      administratorDiagnostics: { work },
    },
    allQueues,
  );
  const http_ = await http(app);
  const refused = await http_
    .get("/operator")
    .set("Cookie", `dne_staff=${credential}`);
  expect(refused.status).toBe(403);
  expect((await http_.get("/operator")).status).toBe(403);
  expect(work).not.toHaveBeenCalled();
});

it("WAITWORK-08 keeps the console and never shows zero when counts cannot be read", async () => {
  for (const work of [
    async () => ({ kind: "unavailable" }),
    async () => {
      throw Error("private database failure");
    },
  ]) {
    const res = await consoleWith(work);
    expect(res.status).toBe(200);
    const text = consoleHtml(res);
    expect(text).toContain('id="all-students"');
    expect(text).toContain("This does not mean nothing is waiting.");
    expect(text).not.toContain("data-work-queue");
    expect(text).not.toContain("private database failure");
  }
});

it("WAITWORK-09 says when nobody is set up to take a queue, naming the role", async () => {
  const text = consoleHtml(
    await consoleWith(async () => ({ kind: "ready", value: invented })),
  );
  expect(row(text, "support")).toContain(
    "0 · No support operator is set up on this site",
  );
  expect(row(text, "workflow")).toContain(
    "0 · No moderator is set up on this site",
  );
  expect(row(text, "feedback")).not.toContain("set up");
});

it("WAITWORK ages read naturally at each boundary", () => {
  expect(
    [null, 0, 1, 59, 60, 119, 2879, 2880, 4319].map((m) => waitedFor(m)),
  ).toEqual([
    "—",
    "Under a minute",
    "1 minute",
    "59 minutes",
    "1 hour",
    "1 hour",
    "47 hours",
    "2 days",
    "2 days",
  ]);
});

it("WAITWORK-06 turns a queue on only when its store and its site setting are both on", () => {
  const none = {
    support: false,
    feedback: false,
    workflow: false,
    contributions: false,
  };
  expect(workQueueTools({})).toEqual(none);
  // A store alone isn't enough: the site must also have the tool switched on.
  expect(
    workQueueTools({
      supportAssignment: {},
      sampleAssignments: {},
      workflowReviewStaff: {},
      localSupportAssignment: false,
      sampleAssignmentAdministration: false,
      workflowReviewRequests: false,
    }),
  ).toEqual(none);
  expect(
    workQueueTools({
      localSupportAssignment: true,
      sampleAssignmentAdministration: true,
      workflowReviewRequests: true,
    }),
  ).toEqual(none);
  expect(
    workQueueTools({
      supportAssignment: {},
      localSupportAssignment: true,
      sampleAssignments: {},
      sampleAssignmentAdministration: true,
      workflowReviewStaff: {},
      workflowReviewRequests: true,
      proposals: {},
    }),
  ).toEqual({
    support: true,
    feedback: true,
    workflow: true,
    contributions: true,
  });
});
// #838 ADMINEXP-01: an earlier administrator session that was never ended is
// named, with the button that ends it, instead of the generic refusal.
it("ADMINEXP-01 tells an owner to end the earlier session and offers the button", async () => {
  const f = fixture();
  f.state.result = { kind: "unended" };
  const r = await post(f.app);
  expect(r.status).toBe(409);
  expect(r.headers["set-cookie"]).toBeUndefined();
  expect(r.text).toContain("<h1>End your earlier administrator session</h1>");
  expect(r.text).toContain(
    "An administrator session lasts up to eight hours. Your earlier one for this sign-in was not ended, so it has to be ended before you enter again.",
  );
  expect(r.text).toContain(
    `<form method="post" action="/admin/end"><input type="hidden" name="csrf" value="${csrf(token, secret)}"><button type="submit">End administration for this sign-in</button></form>`,
  );
  expect(r.text).not.toContain("Administration unavailable");
});
