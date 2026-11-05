import express from "express";
import request from "supertest";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import {
  accountRoleAdmin,
  maskedEmail,
  type AccountRoleAdmin,
} from "../../src/account-role-admin.ts";
import {
  coachAssignmentCard,
  mountAccountRoleAdmin,
} from "../../src/account-role-admin-routes.ts";
import { emailHash } from "../../src/member-email-access.ts";
import { csrf } from "../../src/session.ts";

const origin = "http://127.0.0.1:3000",
  secret = "invented-role-admin-secret",
  staff = "b".repeat(64),
  ada = "11111111-1111-4111-8111-111111111111",
  h = (c: string) => c.repeat(64);
const owned: Promise<Server>[] = [];
afterEach(async () => {
  await Promise.all(
    owned.splice(0).map(async (server) => closeLoopback(await server)),
  );
});

/** A fake pool whose client answers by the start of each SQL statement. */
function fakePool(answers: Record<string, unknown[][] | (() => never)>) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql))
      return { rows: [], rowCount: 0 };
    const key = Object.keys(answers).find((k) => sql.includes(k));
    if (!key) return { rows: [], rowCount: 0 };
    const answer = answers[key]!;
    if (typeof answer === "function") answer();
    const rows = (answer as unknown[][]).shift() ?? [];
    return { rows, rowCount: rows.length };
  });
  const pool = {
    connect: async () => ({ query, release: vi.fn() }),
  } as unknown as Pool;
  return { pool, calls };
}
const actor = (own: string[] = [h("a")]) => [
  { id: "22222222-2222-4222-8222-222222222222", own },
];

it("ROLEADMIN-01 refuses anyone without a current administrator session", async () => {
  const { pool, calls } = fakePool({ "FROM principals p": [[]] });
  const admin = accountRoleAdmin(pool);
  expect(await admin.roles("not-a-token")).toEqual({ kind: "denied" });
  expect(calls).toHaveLength(0);
  expect(await admin.roles(staff)).toEqual({ kind: "denied" });
  expect(calls.some((c) => c.sql.includes("authorized_staff_profiles"))).toBe(
    true,
  );
  expect(calls.some((c) => c.sql.includes("s.role='platform_admin'"))).toBe(
    true,
  );
  const broken = accountRoleAdmin(
    fakePool({
      "FROM principals p": () => {
        throw Error("private database failure");
      },
    }).pool,
  );
  expect(await broken.roles(staff)).toEqual({ kind: "unavailable" });
});

it("ROLEADMIN-01 lists holders in a fixed role order and marks the actor's own email", async () => {
  const { pool } = fakePool({
    "FROM principals p": [actor()],
    "FROM account_roles r": [
      [
        {
          emailHash: h("a"),
          roles: ["admin", "coach"],
          people: [{ id: ada, name: "Ada" }],
          hint: "ad…@example.test",
          grantedAt: null,
        },
        {
          emailHash: h("c"),
          roles: ["coach"],
          people: [],
          hint: null,
          grantedAt: "2026-11-04",
        },
      ],
    ],
  });
  expect(await accountRoleAdmin(pool).roles(staff)).toEqual({
    kind: "ready",
    value: {
      holders: [
        {
          emailHash: h("a"),
          roles: ["coach", "admin"],
          people: [{ id: ada, name: "Ada" }],
          hint: "ad…@example.test",
          grantedAt: null,
          self: true,
        },
        {
          emailHash: h("c"),
          roles: ["coach"],
          people: [],
          hint: null,
          grantedAt: "2026-11-04",
          self: false,
        },
      ],
    },
  });
});

it("ROLE-LABEL-01 masks an email to a short hint that tells rows apart", () => {
  expect(maskedEmail("coach@example.test")).toBe("co…@example.test");
  expect(maskedEmail("ab@example.test")).toBe("a…@example.test");
  expect(maskedEmail("a@example.test")).toBe("a…@example.test");
});

it("ROLEADMIN-02/05 grants only new roles to a normalized email and audits each", async () => {
  const { pool, calls } = fakePool({
    "FROM principals p": [actor()],
    "INSERT INTO account_roles": [[{}], []],
  });
  const admin = accountRoleAdmin(pool);
  for (const input of [
    { email: "nope", roles: ["coach" as const] },
    { email: "x@example.test", roles: [] },
    { email: "x@example.test", roles: ["owner" as never] },
    { email: "x@example.test", roles: ["coach" as const, "coach" as const] },
  ])
    expect(await admin.grant(staff, input)).toEqual({ kind: "invalid" });
  expect(calls).toHaveLength(0);
  expect(
    await admin.grant(staff, {
      email: " X@Example.TEST ",
      roles: ["admin", "coach"],
    }),
  ).toEqual({ kind: "ready" });
  const inserts = calls.filter((c) => c.sql.includes("INSERT INTO"));
  const target = emailHash("x@example.test");
  // Coach first, then admin; the admin role already existed, so one event.
  expect(inserts.map((c) => c.values)).toEqual([
    [target, "coach", "x…@example.test"],
    [actor()[0]!.id, "granted", target, "coach", null],
    [target, "admin", "x…@example.test"],
  ]);
  // ROLE-LABEL-01: a role granted before the hint existed gains one.
  expect(calls.find((c) => c.sql.includes("SET email_hint"))?.values).toEqual([
    target,
    "x…@example.test",
  ]);
});

it("ROLEADMIN-03/04 removes a role, never the actor's own admin role", async () => {
  const { pool, calls } = fakePool({
    "FROM principals p": [actor(), actor(), actor()],
    "DELETE FROM account_roles": [[{}], []],
  });
  const admin = accountRoleAdmin(pool);
  expect(await admin.remove(staff, { emailHash: "x", role: "coach" })).toEqual({
    kind: "invalid",
  });
  expect(
    await admin.remove(staff, { emailHash: h("c"), role: "owner" as never }),
  ).toEqual({ kind: "invalid" });
  expect(
    await admin.remove(staff, { emailHash: h("a"), role: "admin" }),
  ).toEqual({ kind: "self" });
  expect(calls.some((c) => c.sql.startsWith("DELETE"))).toBe(false);
  expect(
    await admin.remove(staff, { emailHash: h("a"), role: "coach" }),
  ).toEqual({ kind: "ready" });
  expect(
    await admin.remove(staff, { emailHash: h("c"), role: "admin" }),
  ).toEqual({ kind: "not-found" });
  expect(
    calls
      .filter((c) => c.sql.includes("account_role_events"))
      .map((c) => c.values),
  ).toEqual([[actor()[0]!.id, "removed", h("a"), "coach", null]]);
});

it("DEFCOACH-04 lists coach choices by name and the learner's current coaches", async () => {
  const { pool } = fakePool({
    "FROM principals p": [actor(), actor()],
    "FROM learners l": [[{ assigned: [h("c"), h("d")] }], []],
    "FROM account_roles r": [
      [
        { emailHash: h("e"), people: [], hint: null },
        { emailHash: h("f"), people: [], hint: "zz…@example.test" },
        {
          emailHash: h("d"),
          people: [{ name: "Bo" }, { name: null }],
          hint: "bo…@example.test",
        },
        { emailHash: h("c"), people: [{ name: "Bo" }, { name: null }] },
      ],
    ],
  });
  const admin = accountRoleAdmin(pool);
  expect(await admin.learnerCoaches(staff, "nope")).toEqual({
    kind: "not-found",
  });
  expect(await admin.learnerCoaches(staff, ada)).toEqual({
    kind: "ready",
    value: {
      assigned: [h("c"), h("d")],
      coaches: [
        { emailHash: h("c"), label: "Bo, Name needed" },
        { emailHash: h("d"), label: "Bo, Name needed" },
        { emailHash: h("e"), label: "Email not linked to an account yet" },
        // ROLE-LABEL-02: an unlinked coach carries the Roles page hint.
        { emailHash: h("f"), label: "zz…@example.test (not signed up yet)" },
      ],
    },
  });
  expect(await admin.learnerCoaches(staff, ada)).toEqual({
    kind: "not-found",
  });
});

it("DEFCOACH-01/04 sets only coach-role holders and audits each added and removed coach", async () => {
  const { pool, calls } = fakePool({
    "FROM principals p": [actor(), actor(), actor()],
    "FROM learners WHERE": [[{}], [{}], []],
    "FROM account_roles WHERE": [[{}, {}], [{}]],
    "DELETE FROM coach_assignments": [[{ coach: h("f") }, { coach: h("e") }]],
    "INSERT INTO coach_assignments": [[{ coach: h("d") }]],
  });
  const admin = accountRoleAdmin(pool);
  const set = (learnerId: string, coaches: string[]) =>
    admin.setCoaches(staff, { learnerId, coaches });
  expect(await set("x", [])).toEqual({ kind: "not-found" });
  expect(await set(ada, ["x"])).toEqual({ kind: "invalid" });
  expect(await set(ada, [h("d"), h("d")])).toEqual({ kind: "invalid" });
  expect(
    await set(
      ada,
      Array.from({ length: 101 }, () => h("d")),
    ),
  ).toEqual({
    kind: "invalid",
  });
  expect(calls).toHaveLength(0);
  expect(await set(ada, [h("c"), h("d")])).toEqual({ kind: "ready" });
  // One of the two no longer holds the coach role.
  expect(await set(ada, [h("c"), h("d")])).toEqual({ kind: "invalid" });
  expect(await set(ada, [])).toEqual({ kind: "not-found" });
  const id = actor()[0]!.id;
  expect(
    calls
      .filter((c) => c.sql.includes("account_role_events"))
      .map((c) => c.values),
  ).toEqual([
    [id, "cleared", h("e"), null, ada],
    [id, "cleared", h("f"), null, ada],
    [id, "assigned", h("d"), null, ada],
  ]);
  expect(
    calls.find((c) => c.sql.includes("INSERT INTO coach_assignments"))?.values,
  ).toEqual([ada, [h("c"), h("d")], id]);
});

function routes(store?: Partial<AccountRoleAdmin>) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.token = staff;
    next();
  });
  mountAccountRoleAdmin(app, store as AccountRoleAdmin | undefined, {
    origin,
    secret,
  });
  const server = listenLoopback(app);
  owned.push(server);
  return async () => request(await server);
}
const good = { csrf: csrf(staff, secret) };

it("ROLEADMIN-01 renders the Roles page without a remove button for the actor's own admin role", async () => {
  const roles = vi.fn<AccountRoleAdmin["roles"]>(async () => ({
    kind: "ready",
    value: {
      holders: [
        {
          emailHash: h("a"),
          roles: ["coach", "admin"],
          people: [{ id: ada, name: "<Ada>" }],
          hint: "ad…@example.test",
          grantedAt: "2026-11-04",
          self: true,
        },
        {
          emailHash: h("c"),
          roles: ["admin"],
          people: [{ id: ada, name: null }],
          hint: null,
          grantedAt: null,
          self: false,
        },
        {
          emailHash: h("d"),
          roles: ["coach"],
          people: [],
          hint: "co…@example.test",
          grantedAt: "2026-11-05",
          self: false,
        },
        {
          emailHash: h("e"),
          roles: ["coach"],
          people: [],
          hint: null,
          grantedAt: null,
          self: false,
        },
      ],
    },
  }));
  const http = await routes({ roles })();
  const res = await http.get("/operator/roles");
  expect(res.status).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.text).toContain("&lt;Ada&gt;");
  expect(res.text).toContain('Admin <span class="small">(you)</span>');
  expect(res.text).toContain('aria-label="Remove coach role from &lt;Ada&gt;"');
  expect(res.text).toContain('aria-label="Remove admin role from Name needed"');
  // ROLE-LABEL-01: an email with no account shows its hint and grant date.
  expect(res.text).toContain(
    'co…@example.test <span class="small">· not signed up yet</span>',
  );
  expect(res.text).toContain("Granted 5 Nov 2026");
  expect(res.text).toContain("Granted 4 Nov 2026");
  expect(res.text).toContain(
    'aria-label="Remove coach role from co…@example.test"',
  );
  expect(res.text).toContain('aria-label="Remove coach role from this email"');
  expect(res.text).toContain("Email not linked to an account yet");
  expect(res.text).toContain(`name="csrf" value="${good.csrf}"`);
  expect(res.text).toContain('name="coach" value="yes"');
  expect(res.text).toContain('name="admin" value="yes"');
  expect(roles).toHaveBeenCalledWith(staff);

  roles.mockResolvedValueOnce({ kind: "ready", value: { holders: [] } });
  expect((await http.get("/operator/roles")).text).toContain(
    "Nobody holds a coach or admin role.",
  );
  roles.mockResolvedValueOnce({ kind: "denied" });
  expect((await http.get("/operator/roles")).status).toBe(403);
  roles.mockResolvedValueOnce({ kind: "unavailable" });
  expect((await http.get("/operator/roles")).status).toBe(503);
  const query = await http.get("/operator/roles?x=1");
  expect(query.status).toBe(403);
});

it("ROLEADMIN-02..04 posts grants and removals only with origin, CSRF and known fields", async () => {
  const grant = vi.fn<AccountRoleAdmin["grant"]>(async () => ({
    kind: "ready",
  }));
  const remove = vi.fn<AccountRoleAdmin["remove"]>(async () => ({
    kind: "ready",
  }));
  const http = await routes({ grant, remove })();
  const post = (path: string, body: object, from = origin) =>
    http.post(path).set("Origin", from).type("form").send(body);

  const granted = await post("/operator/roles/grant", {
    ...good,
    email: "x@example.test",
    admin: "yes",
  });
  expect(granted.status).toBe(303);
  expect(granted.headers.location).toBe("/operator/roles");
  expect(grant).toHaveBeenCalledWith(staff, {
    email: "x@example.test",
    roles: ["admin"],
  });
  expect(
    (await post("/operator/roles/grant", { ...good, coach: "on" })).status,
  ).toBe(400);
  grant.mockResolvedValueOnce({ kind: "invalid" });
  expect((await post("/operator/roles/grant", good)).status).toBe(400);
  expect(grant).toHaveBeenLastCalledWith(staff, { email: "", roles: [] });

  const removed = await post("/operator/roles/remove", {
    ...good,
    emailHash: h("c"),
    role: "coach",
  });
  expect(removed.headers.location).toBe("/operator/roles");
  expect(remove).toHaveBeenCalledWith(staff, {
    emailHash: h("c"),
    role: "coach",
  });
  for (const [kind, status] of [
    ["self", 409],
    ["not-found", 404],
    ["denied", 403],
    ["unavailable", 503],
  ] as const) {
    remove.mockResolvedValueOnce({ kind });
    expect((await post("/operator/roles/remove", good)).status).toBe(status);
  }
  expect(remove).toHaveBeenLastCalledWith(staff, {
    emailHash: "",
    role: undefined,
  });

  remove.mockClear();
  expect(
    (
      await post("/operator/roles/remove", {
        ...good,
        emailHash: h("c"),
        x: "1",
      })
    ).status,
  ).toBe(403);
  expect(remove).not.toHaveBeenCalled();
  grant.mockClear();
  for (const [body, from] of [
    [{ csrf: "0".repeat(64), email: "x@example.test" }, origin],
    [{ ...good, email: "x@example.test" }, "http://evil.test"],
    [{ ...good, extra: "x" }, origin],
    [{ ...good, email: ["a", "b"] }, origin],
  ] as const)
    expect((await post("/operator/roles/grant", body, from)).status).toBe(403);
  expect(
    (
      await http
        .post("/operator/roles/grant?x=1")
        .set("Origin", origin)
        .type("form")
        .send(good)
    ).status,
  ).toBe(403);
  expect(
    (
      await http
        .post("/operator/roles/grant")
        .set("Origin", origin)
        .set("Content-Type", "application/json")
        .send("[]")
    ).status,
  ).toBe(403);
  expect(grant).not.toHaveBeenCalled();
});

it("DEFCOACH-04 saves one, several or no coaches and returns to the learner", async () => {
  const setCoaches = vi.fn<AccountRoleAdmin["setCoaches"]>(async () => ({
    kind: "ready",
  }));
  const http = await routes({ setCoaches })();
  const post = (body: string) =>
    http
      .post("/operator/coach-assignments")
      .set("Origin", origin)
      .type("form")
      .send(body);
  const form = (fields: [string, string][]) =>
    new URLSearchParams([["csrf", good.csrf], ...fields]).toString();
  const saved = await post(
    form([
      ["learnerId", ada],
      ["coach", h("d")],
    ]),
  );
  expect(saved.status).toBe(303);
  expect(saved.headers.location).toBe(`/operator?ownerId=${ada}#learner-coach`);
  expect(setCoaches).toHaveBeenCalledWith(staff, {
    learnerId: ada,
    coaches: [h("d")],
  });
  await post(
    form([
      ["learnerId", ada],
      ["coach", h("c")],
      ["coach", h("d")],
    ]),
  );
  expect(setCoaches).toHaveBeenLastCalledWith(staff, {
    learnerId: ada,
    coaches: [h("c"), h("d")],
  });
  await post(form([["learnerId", ada]]));
  expect(setCoaches).toHaveBeenLastCalledWith(staff, {
    learnerId: ada,
    coaches: [],
  });
  setCoaches.mockClear();
  // Only `coach` may repeat, and no unknown field is accepted.
  for (const fields of [
    [
      ["learnerId", ada],
      ["learnerId", ada],
    ],
    [
      ["learnerId", ada],
      ["x", "1"],
    ],
  ] as [string, string][][])
    expect((await post(form(fields))).status).toBe(403);
  expect(setCoaches).not.toHaveBeenCalled();
  setCoaches.mockResolvedValueOnce({ kind: "not-found" });
  expect((await post(form([]))).status).toBe(404);
  expect(setCoaches).toHaveBeenLastCalledWith(staff, {
    learnerId: "",
    coaches: [],
  });
  setCoaches.mockResolvedValueOnce({ kind: "invalid" });
  expect((await post(form([["learnerId", ada]]))).status).toBe(400);
});

it("ROLEADMIN-01 adds no routes without a store", async () => {
  const http = await routes()();
  expect((await http.get("/operator/roles")).status).toBe(404);
});

it("DEFCOACH-04 renders the console coaches card", () => {
  const anti = good.csrf;
  const card = coachAssignmentCard(
    {
      kind: "ready",
      value: {
        assigned: [h("d")],
        coaches: [
          { emailHash: h("c"), label: "<Bo>" },
          { emailHash: h("d"), label: "Cy" },
        ],
      },
    },
    ada,
    anti,
  );
  expect(card).toContain('<h2 id="learner-coach">Coaches</h2>');
  expect(card).toContain(
    `<input type="checkbox" name="coach" value="${h("c")}"><span>&lt;Bo&gt;</span>`,
  );
  expect(card).toContain(
    `<input type="checkbox" name="coach" value="${h("d")}" checked><span>Cy</span>`,
  );
  expect(card).toContain(`name="learnerId" value="${ada}"`);
  expect(card).toContain(`name="csrf" value="${anti}"`);
  expect(card).toContain("Save coaches");
  expect(card).not.toContain("Nobody holds the coach role yet");
  const none = coachAssignmentCard(
    { kind: "ready", value: { assigned: [], coaches: [] } },
    ada,
    anti,
  );
  expect(none).toContain("Nobody holds the coach role yet");
  expect(none).not.toContain("<form");
  for (const kind of ["denied", "not-found", "unavailable"] as const)
    expect(coachAssignmentCard({ kind }, ada, anti)).toContain(
      "Coach assignment is unavailable right now.",
    );
});
