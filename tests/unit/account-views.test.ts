import express from "express";
import request from "supertest";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import {
  accountRole,
  chooseView,
  landingPath,
  withAccountView,
  type AccountRole,
} from "../../src/account-view.ts";
import { mountAccountViews } from "../../src/account-view-routes.ts";
import { administrationLink } from "../../src/administration-presentation.ts";
import { csrf, COOKIE } from "../../src/session.ts";
import { page } from "../../src/views.ts";

const origin = "http://127.0.0.1:3000",
  secret = "invented-account-view-secret",
  token = "a".repeat(64);
const owned: Promise<Server>[] = [];
afterEach(async () => {
  await Promise.all(
    owned.splice(0).map(async (server) => closeLoopback(await server)),
  );
});
const navigation = (html: string) =>
  html.match(
    /<nav[^>]*aria-label="Main navigation"[^>]*>([\s\S]*?)<\/nav>/,
  )?.[1] ?? "";

it("ROLES-02 picks a saved view only when held, else the highest held role", () => {
  expect(chooseView(["student"], undefined)).toBe("student");
  expect(chooseView(["student"], "admin")).toBe("student");
  expect(chooseView(["student", "coach", "admin"], undefined)).toBe("admin");
  expect(chooseView(["student", "coach", "admin"], "coach")).toBe("coach");
  expect(chooseView(["student", "coach"], "nonsense")).toBe("coach");
  expect(chooseView([], "admin")).toBe("student");
  expect(landingPath("student")).toBe("/learn");
  expect(landingPath("coach")).toBe("/coach");
  expect(landingPath("admin")).toBe("/admin");
  expect(accountRole("coach")).toBe(true);
  expect(accountRole("owner")).toBe(false);
  expect(accountRole(["admin"])).toBe(false);
});

it.each([
  ["student", "/account/coaching", "Coaching"],
  ["coach", "/coach", "Coaching"],
  ["admin", "/admin", "Admin"],
] as const)(
  "ROLES-01/02/03 the %s view shows its own header links",
  (view, path, label) => {
    const roles: AccountRole[] = ["student", "coach", "admin"];
    const html = withAccountView({ roles, view, csrf: "c".repeat(64) }, () =>
      page("Learning", "<h1>Learning</h1>"),
    );
    const nav = navigation(html);
    expect(nav).toContain(`href="${path}">${label}</a>`);
    // #846 HEADER-01: every view has one Coaching link; a coach's goes to
    // their students unless they are viewing as a student. Only the admin
    // view has the Admin link.
    expect(nav.match(/>Coaching<\/a>/g)).toHaveLength(1);
    expect(nav).toContain(
      `href="${view === "student" ? "/account/coaching" : "/coach"}">Coaching</a>`,
    );
    expect(nav.includes('href="/admin"')).toBe(view === "admin");
    expect(nav).toContain('href="/account/sign-out"');
    // ROLES-02: a person with several roles can switch to each other view.
    const form = nav.match(
      /<form class="view-switch" method="post" action="\/account\/view">([\s\S]*?)<\/form>/,
    )?.[1];
    expect(form).toContain(`name="csrf" value="${"c".repeat(64)}"`);
    for (const role of roles) {
      const button = `<button type="submit" name="view" value="${role}">Switch to ${role} view</button>`;
      if (role === view) expect(form).not.toContain(button);
      else expect(form).toContain(button);
    }
  },
);

it("ROLES-01 a student-only account sees no switch and no Administration link", () => {
  const html = withAccountView(
    { roles: ["student"], view: "student", csrf: "c".repeat(64) },
    () => page("Learning", "<h1>Learning</h1>"),
  );
  const nav = navigation(html);
  expect(nav).toContain('href="/account/coaching"');
  expect(nav).not.toContain("view-switch");
  expect(nav).not.toContain('href="/admin"');
  // Without any account view (signed-out lookups, staff pages) the header
  // keeps the student links.
  expect(navigation(page("Learning", ""))).toContain(
    'href="/account/coaching"',
  );
});

function fixture(
  options: { disabled?: boolean; live?: boolean; missing?: boolean } = {},
) {
  const accountRoles = vi.fn<(t: string) => Promise<AccountRole[]>>();
  accountRoles.mockResolvedValue(["student", "coach", "admin"]);
  const application = express();
  application.use(express.urlencoded({ extended: false }));
  mountAccountViews(
    application,
    options.missing ? {} : { accountRoles },
    { origin, secret, localStaffEntry: !options.disabled },
    options.live ? "live" : "simulated",
  );
  application.get("/probe", (_req, res) =>
    res.send(
      page("Probe", administrationLink('<a href="/admin">Administration</a>')),
    ),
  );
  const server = listenLoopback(application);
  owned.push(server);
  return {
    accountRoles,
    http: async () => request(await server),
  };
}
const member = `${COOKIE}=${token}`;

it("ROLES-02/03 the header follows the saved view and offers the switch", async () => {
  const f = fixture();
  const http = await f.http();
  const first = await http.get("/probe").set("Cookie", member);
  expect(navigation(first.text)).toContain('href="/admin">Admin</a>');
  expect(first.text).toContain(`value="${csrf(token, secret)}"`);
  // The body's Administration link appears only for an admin role.
  expect(first.text).toContain('<main id="main"><a href="/admin">');
  const coach = await http
    .get("/probe")
    .set("Cookie", `${member}; dne_view=coach`);
  expect(navigation(coach.text)).toContain('href="/coach">Coaching</a>');
  expect(f.accountRoles).toHaveBeenCalledWith(token);

  // ROLES-01: a student-only account and a failed lookup both keep student links.
  f.accountRoles.mockResolvedValueOnce(["student"]);
  const student = await http
    .get("/probe")
    .set("Cookie", `${member}; dne_view=admin`);
  expect(navigation(student.text)).toContain('href="/account/coaching"');
  expect(student.text).not.toContain('href="/admin"');
  f.accountRoles.mockRejectedValueOnce(new Error("database unavailable"));
  const failed = await http.get("/probe").set("Cookie", member);
  expect(failed.status).toBe(200);
  expect(failed.text).not.toContain('href="/admin"');
  f.accountRoles.mockResolvedValueOnce([]);
  expect((await http.get("/probe").set("Cookie", member)).text).not.toContain(
    "view-switch",
  );

  // Signed-out visitors and malformed cookies cost no lookup.
  f.accountRoles.mockClear();
  await http.get("/probe");
  await http.get("/probe").set("Cookie", `${COOKIE}=not-a-member`);
  expect(f.accountRoles).not.toHaveBeenCalled();
});

it("ROLES-03/05 switching saves the view, lands on its page and grants nothing", async () => {
  const f = fixture();
  const http = await f.http();
  const switched = await http
    .post("/account/view")
    .set("Cookie", member)
    .set("Origin", origin)
    .type("form")
    .send({ csrf: csrf(token, secret), view: "coach" });
  expect(switched.status).toBe(303);
  expect(switched.headers.location).toBe("/coach");
  const cookie = String(switched.headers["set-cookie"]);
  expect(cookie).toMatch(/^dne_view=coach;/);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  // ROLES-05: no administrator or member credential is set or cleared.
  expect(cookie).not.toContain("dne_staff");
  expect(cookie).not.toContain(COOKIE);

  for (const [view, landing] of [
    ["student", "/learn"],
    ["admin", "/admin"],
  ])
    expect(
      (
        await http
          .post("/account/view")
          .set("Cookie", member)
          .set("Origin", origin)
          .type("form")
          .send({ csrf: csrf(token, secret), view })
      ).headers.location,
    ).toBe(landing);
});

it("ROLES-04/07 refuses a view the account does not hold and forged switches", async () => {
  const f = fixture();
  const http = await f.http();
  const post = (
    body: Record<string, string>,
    headers: Record<string, string> = { Origin: origin, Cookie: member },
    path = "/account/view",
  ) => http.post(path).set(headers).type("form").send(body);
  const good = { csrf: csrf(token, secret), view: "coach" };

  f.accountRoles.mockResolvedValueOnce(["student"]);
  const denied = await post(good);
  expect(denied.status).toBe(403);
  expect(denied.text).toContain("This view is not available");
  expect(denied.headers["set-cookie"]).toBeUndefined();

  for (const [body, headers, path] of [
    [{ ...good, csrf: "0".repeat(64) }],
    [good, { Origin: "http://evil.test", Cookie: member }],
    [good, { Origin: origin }],
    [{ ...good, view: "owner" }],
    [{ ...good, extra: "x" }],
    [good, undefined, "/account/view?view=admin"],
  ] as const) {
    const r = await post(body, headers, path);
    expect(r.status).toBe(403);
    expect(r.headers["set-cookie"]).toBeUndefined();
  }
  expect(
    (
      await http
        .post("/account/view")
        .set({ Origin: origin, Cookie: member })
        .set("Content-Type", "application/json")
        .send("[]")
    ).status,
  ).toBe(403);

  f.accountRoles.mockRejectedValueOnce(new Error("database unavailable"));
  const failed = await post(good);
  expect(failed.status).toBe(503);
  expect(failed.text).toContain("Your saved work is unchanged");
});

it("ROLES-02 /home sends each account to the landing page of its view", async () => {
  const f = fixture();
  const http = await f.http();
  const land = async (cookie?: string, path = "/home") => {
    const call = http.get(path);
    return (await (cookie ? call.set("Cookie", cookie) : call)).headers
      .location;
  };
  expect(await land(member)).toBe("/admin");
  expect(await land(`${member}; dne_view=coach`)).toBe("/coach");
  f.accountRoles.mockResolvedValueOnce(["student"]);
  expect(await land(`${member}; dne_view=admin`)).toBe("/learn");
  f.accountRoles.mockRejectedValueOnce(new Error("database unavailable"));
  expect(await land(member)).toBe("/learn");
  expect(await land()).toBe("/learn");
  expect(await land(member, "/home?next=/admin")).toBe("/learn");
});

it.each([{ disabled: true }, { live: true }, { missing: true }])(
  "ROLES-06 adds no roles or routes when administration is off (%o)",
  async (options) => {
    const f = fixture(options);
    const http = await f.http();
    const probe = await http.get("/probe").set("Cookie", member);
    expect(probe.text).not.toContain("view-switch");
    expect(probe.text).not.toContain('href="/admin"');
    expect((await http.get("/home").set("Cookie", member)).status).toBe(404);
    expect(f.accountRoles).not.toHaveBeenCalled();
  },
);
