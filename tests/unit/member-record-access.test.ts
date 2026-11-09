import { createHmac } from "node:crypto";
import express from "express";
import type { Pool } from "pg";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { MAX_MEMBER_EXPORT_BYTES } from "../../src/member-export.ts";
import {
  disabledMemberRecordAccess,
  isRecordScope,
  memberRecordAccessStore,
  RECORD_SCOPES,
  type MemberRecordAccess,
  type RecordAccessEntry,
} from "../../src/member-record-access.ts";
import { mountMemberRecordAccess } from "../../src/member-record-access-routes.ts";
import {
  operatorRecordsPage,
  operatorRecordsRefusal,
  recordAccessPage,
  recordAccessRefusal,
} from "../../src/member-record-access-views.ts";
import { hash } from "../../src/store.ts";
import { withLoopback } from "../support/loopback-server.ts";

const token = "a".repeat(64),
  staffToken = "b".repeat(64),
  reference = "11111111-1111-4111-8111-111111111111",
  accessId = "22222222-2222-4222-8222-222222222222",
  secret = Buffer.alloc(32, 7);

type Handler = (sql: string, values?: unknown[]) => unknown;
/** A pool whose one client answers each statement through `handler`. */
function fakePool(handler: Handler, connect?: () => Promise<unknown>) {
  const release = vi.fn();
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const value = await handler(sql, values);
    return value ?? { rows: [] };
  });
  const pool = {
    connect: connect ?? (async () => ({ query, release })),
    query,
  } as unknown as Pool;
  return { pool, query, release };
}
const memberRow = (sql: string) =>
  sql.includes("p.kind='member'") ? { rows: [{ id: reference }] } : undefined;

it("RECACCESS-U01 scopes name only real export sections and parse strictly", () => {
  expect(isRecordScope("learning")).toBe(true);
  expect(isRecordScope("toString")).toBe(false);
  expect(isRecordScope(1)).toBe(false);
  expect(Object.keys(RECORD_SCOPES)).toEqual([
    "learning",
    "support",
    "billing",
  ]);
});

it("RECACCESS-U02 member changes refuse bad input before reading and report failures", async () => {
  const { pool, query } = fakePool(memberRow);
  const store = memberRecordAccessStore(pool, secret);
  expect(await store.list("bad")).toEqual({ kind: "denied" });
  expect(await store.grant(token, "everything")).toEqual({ kind: "invalid" });
  expect(await store.revoke(token, "not-an-id")).toEqual({ kind: "invalid" });
  expect(query).not.toHaveBeenCalled();
  expect(await store.grant(token, "learning")).toEqual({ kind: "ready" });
  expect(query.mock.calls.map(([sql]) => sql)).toEqual(
    expect.arrayContaining(["BEGIN", "COMMIT"]),
  );
  expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(false);

  const missing = fakePool(() => undefined);
  expect(await memberRecordAccessStore(missing.pool).list(token)).toEqual({
    kind: "denied",
  });
  expect(missing.query).toHaveBeenCalledWith("ROLLBACK");

  const down = fakePool(memberRow, async () => {
    throw Error("down");
  });
  expect(await memberRecordAccessStore(down.pool).list(token)).toEqual({
    kind: "unavailable",
  });

  const broken = fakePool((sql) => {
    if (sql === "ROLLBACK") throw Error("gone");
    if (sql.startsWith("SELECT a.id,a.scope")) throw Error("read failed");
    return memberRow(sql);
  });
  expect(await memberRecordAccessStore(broken.pool).list(token)).toEqual({
    kind: "unavailable",
  });
  expect(broken.release).toHaveBeenCalledWith(expect.any(Error));
});

it("RECACCESS-U03 listing and revoking read only the member's own permissions", async () => {
  const entry: RecordAccessEntry = {
    id: accessId,
    scope: "billing",
    createdAt: new Date(0),
    expiresAt: new Date(1),
    revokedAt: null,
    current: true,
    downloads: 0,
  };
  let owned = true,
    revoked = false;
  const { pool } = fakePool((sql) => {
    if (sql.startsWith("SELECT a.id,a.scope")) return { rows: [entry] };
    if (sql.startsWith("UPDATE member_record_access"))
      return { rows: revoked ? [] : [{ id: accessId }] };
    if (sql.startsWith("SELECT 1 FROM member_record_access"))
      return { rows: owned ? [{}] : [] };
    return memberRow(sql);
  });
  const store = memberRecordAccessStore(pool);
  expect(await store.list(token)).toEqual({ kind: "ready", value: [entry] });
  expect(await store.revoke(token, accessId)).toEqual({ kind: "ready" });
  revoked = true;
  expect(await store.revoke(token, accessId)).toEqual({ kind: "ready" });
  owned = false;
  expect(await store.revoke(token, accessId)).toEqual({ kind: "invalid" });
});

it("RECACCESS-U04 only an operator or administrator session may use the form", async () => {
  let rows: unknown[] = [{ id: "staff" }];
  const { pool } = fakePool(() => ({ rows }));
  const store = memberRecordAccessStore(pool);
  expect(await store.operator("bad")).toBe("denied");
  expect(await store.operator(staffToken)).toBe("allowed");
  rows = [];
  expect(await store.operator(staffToken)).toBe("denied");
  const broken = fakePool(() => {
    throw Error("down");
  });
  expect(await memberRecordAccessStore(broken.pool).operator(staffToken)).toBe(
    "unavailable",
  );
});

interface Download {
  staff?: boolean;
  target?: boolean;
  access?: boolean;
  rows?: (name: string) => Record<string, unknown>[];
  fail?: string;
  delay?: number;
}
function downloadPool(options: Download = {}) {
  const sections: string[] = [];
  const fake = fakePool(async (sql, values) => {
    if (options.fail && sql.startsWith(options.fail)) throw Error("failed");
    if (sql.includes("p.kind='staff'"))
      return { rows: options.staff === false ? [] : [{ id: "staff-id" }] };
    if (sql.startsWith("SELECT l.id FROM learners"))
      return { rows: options.target === false ? [] : [{ id: values![0] }] };
    if (sql.startsWith("SELECT a.id,a.expires_at"))
      return {
        rows:
          options.access === false
            ? []
            : [{ id: accessId, expiresAt: new Date(86_400_000) }],
      };
    if (sql.includes('AS "_key"')) {
      if (options.delay)
        await new Promise((resolve) => setTimeout(resolve, options.delay));
      const name = Object.values(RECORD_SCOPES)
        .flat()
        .find((section) => sql === SECTION_SQL[section]);
      sections.push(name!);
      return { rows: options.rows?.(name!) ?? [] };
    }
    return undefined;
  });
  return { ...fake, sections };
}
const { MEMBER_EXPORT_SECTIONS: SECTION_SQL } =
  await import("../../src/member-export.ts");
const bound = (scope = "learning", staff = staffToken, ref = reference) =>
  `${hash(staff)}.${ref}.${scope}`;
function signed(data: unknown, scope = "learning") {
  const body = Buffer.from(
    typeof data === "string" ? data : JSON.stringify(data),
  ).toString("base64url");
  const mac = createHmac("sha256", secret)
    .update(bound(scope))
    .update(".")
    .update(body)
    .digest("base64url");
  return `${body}.${mac}`;
}

const tamper = (value: string) =>
  value.slice(0, -1) + (value.endsWith("A") ? "B" : "A");

it("RECACCESS-U05 a download refuses bad input, staff, members, permissions and cursors alike", async () => {
  const pool = downloadPool();
  const store = memberRecordAccessStore(pool.pool, secret);
  expect(await store.download("bad", reference, "learning")).toEqual({
    kind: "denied",
  });
  expect(await store.download(staffToken, "nope", "learning")).toEqual({
    kind: "invalid",
  });
  expect(await store.download(staffToken, 1, "learning")).toEqual({
    kind: "invalid",
  });
  expect(await store.download(staffToken, reference, "all")).toEqual({
    kind: "invalid",
  });
  const later = Date.now() + 60_000;
  for (const cursor of [
    1,
    "x".repeat(1025),
    "no-dot",
    tamper(signed([1, 0, ["k"], 2, later])),
    signed("not json"),
    signed({}),
    signed([1, 0, ["k"], 2]),
    signed([2, 0, ["k"], 2, later]),
    signed([1, 0.5, ["k"], 2, later]),
    signed([1, -1, ["k"], 2, later]),
    signed([1, 0, "k", 2, later]),
    signed([1, 0, [], 2, later]),
    signed([1, 0, ["a", "b", "c", "d"], 2, later]),
    signed([1, 0, ["x".repeat(161)], 2, later]),
    signed([1, 0, [-1], 2, later]),
    signed([1, 0, [true], 2, later]),
    signed([1, 0, ["k"], 1.5, later]),
    signed([1, 0, ["k"], 1, later]),
    signed([1, 0, ["k"], 2, 1.5]),
    signed([1, 0, ["k"], 2, Date.now() - 1]),
    signed([1, 7, ["k"], 2, later]),
    signed([1, 0, ["k"], 2, later], "billing"),
  ])
    expect(
      await store.download(staffToken, reference, "learning", cursor),
    ).toEqual({ kind: "denied" });
  expect(pool.query).not.toHaveBeenCalled();
  for (const missing of [
    { staff: false },
    { target: false },
    { access: false },
  ]) {
    const refused = downloadPool(missing);
    expect(
      await memberRecordAccessStore(refused.pool).download(
        staffToken,
        reference,
        "support",
      ),
    ).toEqual({ kind: "denied" });
    expect(refused.query).toHaveBeenCalledWith("ROLLBACK");
    expect(refused.sections).toEqual([]);
  }
});

it("RECACCESS-U06 a download reads its scope's sections, logs its first page and pages on", async () => {
  const many = (name: string) =>
    name === "milestones"
      ? Array.from({ length: 101 }, (_, i) => ({ _key: [i], n: i }))
      : [];
  const pool = downloadPool({ rows: many });
  const store = memberRecordAccessStore(pool.pool, secret);
  const first = await store.download(staffToken, reference, "learning");
  if (first.kind !== "ready") throw Error(first.kind);
  expect(pool.sections).toEqual(RECORD_SCOPES.learning.slice(0, 6));
  expect(first.payload.page).toMatchObject({
    number: 1,
    recordCount: 100,
    complete: false,
  });
  expect(first.payload.records.milestones).toHaveLength(100);
  expect(
    pool.query.mock.calls.filter(([sql]) =>
      sql.startsWith("INSERT INTO member_record_access_downloads"),
    ),
  ).toHaveLength(1);
  const next = await store.download(
    staffToken,
    reference,
    "learning",
    first.payload.page.nextCursor,
  );
  if (next.kind !== "ready") throw Error(next.kind);
  expect(next.payload.page.number).toBe(2);
  expect(
    pool.query.mock.calls.filter(([sql]) =>
      sql.startsWith("INSERT INTO member_record_access_downloads"),
    ),
  ).toHaveLength(1);

  const empty = downloadPool();
  const done = await memberRecordAccessStore(empty.pool).download(
    staffToken,
    reference,
    "billing",
  );
  expect(done).toMatchObject({
    kind: "ready",
    payload: { page: { complete: true, nextCursor: null, recordCount: 0 } },
  });
});

it("RECACCESS-U07 a download stops at the byte limit, and a single oversized record is a limit", async () => {
  const big = "x".repeat(MAX_MEMBER_EXPORT_BYTES / 2);
  const two = downloadPool({
    rows: (name) =>
      name === "invoices"
        ? [
            { _key: ["a"], text: big },
            { _key: ["b"], text: big },
          ]
        : [],
  });
  const split = await memberRecordAccessStore(two.pool, secret).download(
    staffToken,
    reference,
    "billing",
  );
  expect(split).toMatchObject({
    kind: "ready",
    payload: { page: { recordCount: 1, complete: false } },
  });
  const huge = downloadPool({
    rows: (name) =>
      name === "billingProfile"
        ? [{ _key: ["a"], text: "x".repeat(MAX_MEMBER_EXPORT_BYTES) }]
        : [],
  });
  expect(
    await memberRecordAccessStore(huge.pool).download(
      staffToken,
      reference,
      "billing",
    ),
  ).toEqual({ kind: "limit" });
  expect(
    huge.query.mock.calls.some(([sql]) =>
      sql.startsWith("INSERT INTO member_record_access_downloads"),
    ),
  ).toBe(false);
});

it("RECACCESS-U08 a failed read, rollback or connection is unavailable, and an expired cursor is refused", async () => {
  const failed = downloadPool({
    fail: "INSERT INTO member_record_access_downloads",
  });
  expect(
    await memberRecordAccessStore(failed.pool).download(
      staffToken,
      reference,
      "support",
    ),
  ).toEqual({ kind: "unavailable" });
  const rollback = downloadPool({ fail: "ROLLBACK", access: false });
  expect(
    await memberRecordAccessStore(rollback.pool).download(
      staffToken,
      reference,
      "support",
    ),
  ).toEqual({ kind: "denied" });
  expect(rollback.release).toHaveBeenCalledWith(expect.any(Error));
  const down = fakePool(
    () => undefined,
    async () => {
      throw Error("down");
    },
  );
  expect(
    await memberRecordAccessStore(down.pool).download(
      staffToken,
      reference,
      "support",
    ),
  ).toEqual({ kind: "unavailable" });
  const slow = downloadPool({ delay: 80 });
  const soon = signed([1, 0, ["k"], 2, Date.now() + 40]);
  expect(
    await memberRecordAccessStore(slow.pool, secret).download(
      staffToken,
      reference,
      "learning",
      soon,
    ),
  ).toEqual({ kind: "denied" });
});

it("RECACCESS-U09 the disabled store refuses everything", async () => {
  const store = disabledMemberRecordAccess();
  expect(await store.list(token)).toEqual({ kind: "unavailable" });
  expect(await store.grant(token, "learning")).toEqual({ kind: "unavailable" });
  expect(await store.revoke(token, accessId)).toEqual({ kind: "unavailable" });
  expect(await store.operator(staffToken)).toBe("unavailable");
  expect(await store.download(staffToken, reference, "learning")).toEqual({
    kind: "unavailable",
  });
});

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const entry = (over: Partial<RecordAccessEntry>): RecordAccessEntry => ({
  id: accessId,
  scope: "learning",
  createdAt: new Date("2026-11-01T00:00:00Z"),
  expiresAt: new Date("2026-11-08T00:00:00Z"),
  revokedAt: null,
  current: true,
  downloads: 0,
  ...over,
});

it("RECACCESS-U10 the member page lists permissions, offers only scopes not yet allowed, and explains", () => {
  const none = text(recordAccessPage([], "csrf-token", reference));
  expect(none).toContain(
    "Operators can't download any of your records right now.",
  );
  expect(none).toContain(reference);
  expect(none).toContain("Allow for 7 days");
  expect(none).not.toContain("Ended");

  const html = recordAccessPage(
    [
      entry({ downloads: 1 }),
      entry({ scope: "support", downloads: 2 }),
      entry({ scope: "billing", current: false, downloads: 0 }),
      entry({
        scope: "billing",
        current: false,
        revokedAt: new Date("2026-11-02T00:00:00Z"),
      }),
    ],
    "csrf-token",
    reference,
  );
  const page = text(html);
  expect(page).toContain("Downloaded once.");
  expect(page).toContain("Downloaded 2 times.");
  expect(page).toContain("No downloads yet.");
  expect(page).toContain("You stopped it on");
  expect(page).toContain("Ended on");
  expect(page).toContain("Stop operators downloading my learning records");
  expect(html).toContain('value="billing"');
  expect(html).not.toContain('value="learning"');

  const all = text(
    recordAccessPage(
      [entry({}), entry({ scope: "support" }), entry({ scope: "billing" })],
      "csrf-token",
      reference,
    ),
  );
  expect(all).toContain("Operators may already download every kind of record");
});

it("RECACCESS-U11 refusals and the operator form say what happened", () => {
  expect(recordAccessRefusal("invalid")[0]).toBe(400);
  expect(recordAccessRefusal("unavailable")[0]).toBe(503);
  expect(text(operatorRecordsPage("csrf-token"))).toContain(
    "Student reference",
  );
  for (const [kind, status] of [
    ["denied", 403],
    ["invalid", 400],
    ["limit", 413],
    ["unavailable", 503],
  ] as const) {
    const [code, html] = operatorRecordsRefusal(kind);
    expect(code).toBe(status);
    expect(text(html)).toContain("Nothing was downloaded");
  }
});

function site(store: MemberRecordAccess | undefined) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.token = token;
    res.locals.csrf = "csrf-token";
    res.locals.learner = { id: reference };
    next();
  });
  mountMemberRecordAccess(app, store);
  return app;
}
const fakeStore = (
  over: Partial<MemberRecordAccess> = {},
): MemberRecordAccess => ({
  list: async () => ({ kind: "ready", value: [] }),
  grant: async () => ({ kind: "ready" }),
  revoke: async () => ({ kind: "ready" }),
  operator: async () => "allowed",
  download: async () => ({
    kind: "ready",
    payload: {
      kind: "ready",
      version: "operator-member-records-v1",
      reference,
      scope: "learning",
      accessExpiresAt: new Date(0),
      records: {},
      page: { number: 1, recordCount: 0, complete: true, nextCursor: null },
    },
  }),
  ...over,
});

it("RECACCESS-U12 the routes check their input and map each outcome", async () => {
  const call = (
    app: express.Express,
    method: "get" | "post",
    path: string,
    form?: Record<string, string>,
  ) =>
    withLoopback(app, (listener) => {
      const r = request(listener)[method](path);
      return form ? r.type("form").send(form) : r;
    });
  // No store, no pages.
  expect(
    (await call(site(undefined), "get", "/account/record-access")).status,
  ).toBe(404);

  const ok = site(fakeStore());
  expect((await call(ok, "get", "/account/record-access")).status).toBe(200);
  expect((await call(ok, "get", "/account/record-access?x=1")).status).toBe(
    400,
  );
  expect(
    (await call(ok, "post", "/account/record-access", { scope: "learning" }))
      .headers.location,
  ).toBe("/account/record-access");
  expect(
    (
      await call(ok, "post", "/account/record-access", {
        scope: "learning",
        extra: "1",
      })
    ).status,
  ).toBe(400);
  expect(
    (await call(ok, "post", `/account/record-access/${accessId}/revoke`, {}))
      .status,
  ).toBe(303);
  expect(
    (
      await call(ok, "post", `/account/record-access/${accessId}/revoke`, {
        x: "1",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await withLoopback(ok, (listener) =>
        request(listener)
          .post("/account/record-access")
          .send({ scope: ["learning"] }),
      )
    ).status,
  ).toBe(400);
  expect((await call(ok, "get", "/operator/member-records")).status).toBe(200);
  expect((await call(ok, "get", "/operator/member-records?x=1")).status).toBe(
    400,
  );
  const json = await call(ok, "post", "/operator/member-records", {
    reference: ` ${reference.toUpperCase()} `,
    scope: "learning",
    cursor: "",
  });
  expect(json.status).toBe(200);
  expect(json.headers["content-disposition"]).toBe(
    `attachment; filename="member-${reference}-learning-page-1.json"`,
  );
  expect(
    (await call(ok, "post", "/operator/member-records", { bad: "1" })).status,
  ).toBe(400);

  const download = vi.fn(async () => ({ kind: "denied" as const }));
  const denied = site(
    fakeStore({
      list: async () => ({ kind: "denied" }),
      grant: async () => ({ kind: "denied" }),
      revoke: async () => ({ kind: "invalid" }),
      operator: async () => "denied",
      download,
    }),
  );
  expect(
    (await call(denied, "get", "/account/record-access")).headers.location,
  ).toBe("/");
  expect(
    (await call(denied, "post", "/account/record-access", { scope: "x" }))
      .headers.location,
  ).toBe("/");
  expect(
    (
      await call(
        denied,
        "post",
        `/account/record-access/${accessId}/revoke`,
        {},
      )
    ).status,
  ).toBe(400);
  expect((await call(denied, "get", "/operator/member-records")).status).toBe(
    403,
  );
  expect(
    (
      await call(denied, "post", "/operator/member-records", {
        reference,
        scope: "learning",
        cursor: " next ",
      })
    ).status,
  ).toBe(403);
  expect(download).toHaveBeenCalledWith(token, reference, "learning", "next");
  expect(
    (
      await call(denied, "post", "/operator/member-records", {
        scope: "learning",
      })
    ).status,
  ).toBe(403);

  const down = site(
    fakeStore({
      list: async () => ({ kind: "unavailable" }),
      operator: async () => "unavailable",
    }),
  );
  expect((await call(down, "get", "/account/record-access")).status).toBe(503);
  expect((await call(down, "get", "/operator/member-records")).status).toBe(
    503,
  );
});
