import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
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
import { careerStore } from "../../src/career.ts";
import { proposalStore } from "../../src/proposals.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";

// #42: a signed-in member could create private text records with no count.
// A private database per file, because these tests read every counter row.
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
const secret = "synthetic-member-record-secret";
// Small allowances keep these tests short; the shipped values are in the unit
// test and the limits document.
const limits: AnonymousWriteLimits = {
  ...ANONYMOUS_WRITE_LIMITS,
  member_record: { windowSeconds: 3600, perVisitor: 4, service: 6 },
};
const members = store(pool);
const career = careerStore(pool);
const application = () =>
  app(members, {
    origin,
    secret,
    career,
    proposals: proposalStore(pool),
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
  await pool.query("TRUNCATE principals,anonymous_write_windows CASCADE");
});
afterAll(async () => {
  await closeLoopback(server);
  await pool.end();
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
}, 60_000);

async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  await career.enable(token);
  return token;
}
function post(
  path: string,
  form: Record<string, string>,
  forwardedFor: string,
  token: string,
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

type Route = "milestone" | "entry" | "draft" | "proposal";
const ROUTES: Route[] = ["milestone", "entry", "draft", "proposal"];
// Every form carries its own marker, so a refusal can be checked for keeping
// exactly what this member typed.
function form(route: Route, marker: string): [string, Record<string, string>] {
  switch (route) {
    case "milestone":
      return [
        "/milestones",
        {
          goal_title: `Goal ${marker}`,
          milestone_title: `Milestone ${marker}`,
          evidence_note: `Evidence ${marker}`,
          next_action: `Next ${marker}`,
          sample_only: "yes",
        },
      ];
    case "entry":
      return [
        "/career/entries",
        {
          kind: "career",
          title: `Entry ${marker}`,
          note: `Note ${marker}`,
          next_action: `Next ${marker}`,
          self_reported_outcome: `Outcome ${marker}`,
          sample_only: "yes",
        },
      ];
    case "draft":
      return [
        "/career/drafts",
        {
          kind: "proposal",
          title: `Draft ${marker}`,
          body: `Draft body ${marker} for an invented practice note.`,
          sample_only: "yes",
        },
      ];
    case "proposal":
      return [
        "/contribute",
        {
          title: `Proposal ${marker}`,
          body: `Proposal body ${marker}`,
          sources: `Sources ${marker}`,
          sample_confirmed: "yes",
        },
      ];
  }
}
const create = (route: Route, marker: string, ip: string, token: string) => {
  const [path, fields] = form(route, marker);
  return post(path, fields, ip, token);
};
async function saved() {
  const n = async (table: string) =>
    (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))
      .rows[0]!.n;
  return {
    milestones: await n("learning_milestones"),
    entries: await n("career_entries"),
    drafts: await n("career_drafts"),
    proposals: await n("member_proposals"),
  };
}
const counted = async () =>
  (
    await pool.query<{ n: number }>(
      "SELECT coalesce(sum(admitted),0)::int AS n FROM anonymous_write_windows WHERE kind='member_record' AND subject<>'service'",
    )
  ).rows[0]!.n;

it("RECORD-01 refuses a visitor past its allowance across accounts and routes, keeps the typed text and leaves other visitors alone", async () => {
  const [a, b] = [await member(), await member()];
  // Four creations from one address, spread over two accounts and every route.
  for (const [i, route] of ROUTES.entries())
    expect(
      (await create(route, `ok-${i}`, "203.0.113.10", i % 2 ? b : a)).status,
    ).toBe(303);
  const before = await saved();
  expect(before).toEqual({
    milestones: 1,
    entries: 1,
    drafts: 1,
    proposals: 1,
  });
  for (const route of ROUTES) {
    const marker = `kept-${route}`;
    const refused = await create(route, marker, "203.0.113.10", b);
    expect.soft(refused.status, route).toBe(429);
    expect
      .soft(Number(refused.headers["retry-after"]), route)
      .toBeGreaterThan(0);
    expect.soft(refused.headers["cache-control"], route).toContain("no-store");
    expect
      .soft(refused.text, route)
      .toContain("Too many new records have been saved from this network.");
    expect.soft(refused.text, route).toContain("Nothing was saved.");
    for (const value of Object.values(form(route, marker)[1]).filter((v) =>
      v.includes(marker),
    ))
      expect.soft(refused.text, `${route} keeps ${value}`).toContain(value);
  }
  expect(await saved()).toEqual(before);
  // Another address still has its own allowance.
  expect((await create("milestone", "other", "203.0.113.11", b)).status).toBe(
    303,
  );
});

it("RECORD-02 refuses a new address once the service ceiling is used", async () => {
  const token = await member();
  for (let i = 0; i < 6; i++)
    expect(
      (await create(ROUTES[i % 4]!, `svc-${i}`, `198.51.100.${i + 1}`, token))
        .status,
    ).toBe(303);
  const before = await saved();
  const refused = await create("proposal", "svc-new", "198.51.100.99", token);
  expect(refused.status).toBe(429);
  expect(refused.text).toContain("Saving new records is busy right now.");
  expect(refused.text).toContain("Proposal svc-new");
  expect(await saved()).toEqual(before);
});

it("RECORD-03 fails closed with 503 and saves nothing when the limiter cannot answer", async () => {
  const token = await member();
  expect(
    (await create("milestone", "seed", "203.0.113.30", token)).status,
  ).toBe(303);
  const before = await saved();
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT 1 FROM anonymous_write_windows WHERE kind='member_record' AND subject='service' FOR UPDATE",
    );
    for (const route of ROUTES) {
      const held = await create(route, `held-${route}`, "203.0.113.31", token);
      expect.soft(held.status, route).toBe(503);
      expect.soft(held.headers["retry-after"], route).toBe("60");
      expect
        .soft(held.text, route)
        .toContain(
          "Saving new records is unavailable right now. Try again in a minute. Nothing was saved.",
        );
      expect.soft(held.text, route).toContain(`held-${route}`);
    }
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  expect(await saved()).toEqual(before);
}, 60_000);

it("RECORD-04 counts only well-formed creations, not invalid forms, edits, deletes or reads", async () => {
  const token = await member();
  expect((await create("milestone", "one", "203.0.113.40", token)).status).toBe(
    303,
  );
  expect(await counted()).toBe(1);
  const id = (
    await pool.query<{ id: string }>("SELECT id FROM learning_milestones")
  ).rows[0]!.id;
  for (let i = 0; i < 6; i++) {
    // Missing required text is refused as invalid before counting.
    expect(
      (
        await post(
          "/milestones",
          { goal_title: "", milestone_title: "" },
          "203.0.113.40",
          token,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await post(
          "/career/entries",
          { kind: "career", title: "" },
          "203.0.113.40",
          token,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await post(
          "/contribute",
          { title: "", body: "", sources: "" },
          "203.0.113.40",
          token,
        )
      ).status,
    ).toBe(422);
    const [, fields] = form("milestone", `edit-${i}`);
    expect(
      (
        await post(
          `/milestones/${id}/update`,
          { ...fields, version: String(i + 1) },
          "203.0.113.40",
          token,
        )
      ).status,
    ).toBe(303);
    expect(
      (
        await request(server)
          .get("/milestones")
          .set("Host", "127.0.0.1:3000")
          .set("Cookie", `${COOKIE}=${token}`)
          .set("X-Forwarded-For", "203.0.113.40")
      ).status,
    ).toBe(200);
  }
  expect(await counted()).toBe(1);
  expect(
    (
      await post(
        `/milestones/${id}/delete`,
        { version: "7", confirm: "yes" },
        "203.0.113.40",
        token,
      )
    ).status,
  ).toBe(303);
  expect(await counted()).toBe(1);
});

it("RECORD-05 stores only a keyed hash and lets a refused visitor continue after the window", async () => {
  const token = await member();
  for (let i = 0; i < 4; i++)
    await create("draft", `window-${i}`, "203.0.113.50", token);
  expect((await create("draft", "late", "203.0.113.50", token)).status).toBe(
    429,
  );
  const rows = await pool.query<{ subject: string }>(
    "SELECT subject FROM anonymous_write_windows WHERE kind='member_record'",
  );
  expect(rows.rows.map((row) => row.subject).sort()).toEqual([
    expect.stringMatching(/^[a-f0-9]{64}$/),
    "service",
  ]);
  expect(JSON.stringify(rows.rows)).not.toContain("203.0.113.50");
  await pool.query(
    "UPDATE anonymous_write_windows SET window_start=window_start-INTERVAL '2 hours' WHERE kind='member_record'",
  );
  expect((await create("draft", "after", "203.0.113.50", token)).status).toBe(
    303,
  );
});

it("RECORD-06 keeps counted rows valid when every migration re-runs at start", async () => {
  const token = await member();
  expect((await create("entry", "restart", "203.0.113.60", token)).status).toBe(
    303,
  );
  const before = await pool.query(
    "SELECT kind,subject,window_start,admitted FROM anonymous_write_windows ORDER BY subject",
  );
  expect(before.rows.map((row) => row.kind)).toEqual([
    "member_record",
    "member_record",
  ]);
  await migrate(pool);
  await migrate(pool);
  expect(
    (
      await pool.query(
        "SELECT kind,subject,window_start,admitted FROM anonymous_write_windows ORDER BY subject",
      )
    ).rows,
  ).toEqual(before.rows);
  // The widened check still refuses an unknown kind.
  await expect(
    pool.query(
      "INSERT INTO anonymous_write_windows(kind,subject,window_start,admitted) VALUES('unknown','service',now(),1)",
    ),
  ).rejects.toThrow(/anonymous_write_windows_kind_check/);
});
