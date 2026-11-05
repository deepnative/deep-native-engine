import express from "express";
import request from "supertest";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import {
  memberSharingStore,
  STAFF_ACCESS_PAGE,
  type MemberSharing,
  type SharingSummary,
  type StaffAccessEntry,
} from "../../src/member-sharing.ts";
import { mountMemberSharing } from "../../src/member-sharing-routes.ts";
import { accountPage, dashboard } from "../../src/views.ts";
import type { Learner } from "../../src/store.ts";

const token = "a".repeat(64);
const empty: SharingSummary = {
  circles: [],
  evidence: 0,
  workflowReviews: 0,
  eventPermissions: 0,
  openSupport: 0,
  publishedContributions: 0,
  coaches: 0,
  staffWithAccess: 0,
};

function server(store: MemberSharing | undefined, contributions = false) {
  const site = express();
  site.use((_req, res, next) => {
    res.locals.token = token;
    next();
  });
  mountMemberSharing(site, store, { contributions });
  return site;
}
const ready = (value: Partial<SharingSummary>): MemberSharing => ({
  summary: () =>
    Promise.resolve({ kind: "ready", value: { ...empty, ...value } }),
  staffAccess: () => Promise.resolve({ kind: "unavailable" }),
});
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

it("WHOSEES-07 the store refuses a bad token before reading and an unknown member after", async () => {
  const query = vi.fn();
  const store = memberSharingStore({ query } as unknown as Pool);
  expect(await store.summary("not-a-token")).toEqual({ kind: "denied" });
  expect(query).not.toHaveBeenCalled();
  query.mockResolvedValueOnce({ rows: [] });
  expect(await store.summary(token)).toEqual({ kind: "denied" });
  expect(query).toHaveBeenCalledTimes(1);
});

it("WHOSEES-02/08 the store names known circles and reports a failed read as unavailable", async () => {
  const query = vi.fn();
  const store = memberSharingStore({ query } as unknown as Pool);
  query
    .mockResolvedValueOnce({
      rows: [
        {
          member: "m",
          evidence: 1,
          workflowReviews: 2,
          eventPermissions: 3,
          openSupport: 4,
          publishedContributions: 5,
          coaches: 6,
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [{ id: "everyday-ai", sharing: true, readablePosts: 7 }],
    });
  expect(await store.summary(token)).toEqual({
    kind: "ready",
    value: {
      circles: [
        {
          id: "everyday-ai",
          title: "Everyday AI practice",
          sharing: true,
          readablePosts: 7,
        },
      ],
      evidence: 1,
      workflowReviews: 2,
      eventPermissions: 3,
      openSupport: 4,
      publishedContributions: 5,
      coaches: 6,
    },
  });
  query.mockRejectedValueOnce(Error("invented outage"));
  expect(await store.summary(token)).toEqual({ kind: "unavailable" });
});

it("WHOSEES-01 a member with nothing shared is told so in every area", async () => {
  const res = await request(server(ready({}))).get("/account/sharing");
  expect(res.status).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  const body = text(res.text);
  expect(body).toContain("Who can see my work");
  expect(body).toContain("You haven't joined a circle");
  expect(body).toContain("You haven't sent anything for review");
  expect(body).toContain("No coach is assigned to you");
  expect(body).toContain("Other members don't see your name");
  expect(body).not.toContain("contribution");
  expect(res.text).toContain('href="/circles"');
  expect(res.text).toContain('href="/member/export"');
});

it("WHOSEES-02 sharing on and off are distinct, and a circle links to its controls", async () => {
  const res = await request(
    server(
      ready({
        circles: [
          { id: "a-b", title: "A <b>", sharing: true, readablePosts: 1 },
          { id: "c", title: "C", sharing: true, readablePosts: 3 },
          { id: "d", title: "D", sharing: true, readablePosts: 0 },
          { id: "e", title: "E", sharing: false, readablePosts: 0 },
        ],
      }),
    ),
  ).get("/account/sharing");
  const body = text(res.text);
  expect(res.text).toContain("A &lt;b&gt;");
  expect(body).toContain("can read 1 of your posts");
  expect(body).toContain("can read 3 of your posts");
  expect(body).toContain("Sharing is on, but you have no posts they can read");
  expect(body).toContain("Discussion sharing is off");
  expect(res.text).toContain('href="/circles/a-b/discussion/choice"');
  expect(res.text).toContain('href="/circles/a-b/discussion/owned"');
});

it("WHOSEES-04 each reviewed area shows a count, a reader and a control", async () => {
  const many = await request(
    server(
      ready({
        evidence: 2,
        workflowReviews: 2,
        eventPermissions: 2,
        openSupport: 2,
      }),
    ),
  ).get("/account/sharing");
  const body = text(many.text);
  expect(body).toContain("2 files or samples allowed for private review");
  expect(body).toContain("2 workflow notes waiting for private review");
  expect(body).toContain("2 event attendance permissions");
  expect(body).toContain("2 open support requests");
  for (const link of [
    "/evidence",
    "/workflow-feedback/review",
    "/events/attendance",
    "/support",
  ])
    expect(many.text).toContain(`href="${link}"`);
  const one = text(
    (
      await request(
        server(
          ready({
            evidence: 1,
            workflowReviews: 1,
            eventPermissions: 1,
            openSupport: 1,
          }),
        ),
      ).get("/account/sharing")
    ).text,
  );
  expect(one).toContain("1 file or sample allowed for private review");
  expect(one).toContain("1 workflow note waiting for private review");
  expect(one).toContain("1 event attendance permission");
  expect(one).toContain("1 open support request");
});

it("WHOSEES-05 contributions appear when the feature is on or something is published", async () => {
  const on = text(
    (await request(server(ready({}), true)).get("/account/sharing")).text,
  );
  expect(on).toContain("No contributions are published");
  const published = await request(
    server(ready({ publishedContributions: 2 })),
  ).get("/account/sharing");
  expect(text(published.text)).toContain(
    "2 contributions are published to signed-in members",
  );
  expect(published.text).toContain('href="/contribute"');
  expect(
    text(
      (
        await request(server(ready({ publishedContributions: 1 }))).get(
          "/account/sharing",
        )
      ).text,
    ),
  ).toContain("1 contribution is published to signed-in members");
});

it("WHOSEES-06 coach and administrator access is stated without naming anyone", async () => {
  const two = text(
    (await request(server(ready({ coaches: 2 }))).get("/account/sharing")).text,
  );
  expect(two).toContain("You have 2 coaches");
  expect(two).toContain(
    "display name, monthly coaching hours and their status",
  );
  expect(two).toContain("Account administrators");
  expect(two).toContain("enrollment and billing summaries");
  expect(two).toContain("don't show your private writing or files");
  expect(
    text(
      (await request(server(ready({ coaches: 1 }))).get("/account/sharing"))
        .text,
    ),
  ).toContain("You have 1 coach.");
  const learner = {
    displayName: "Ada",
    background: "explorer",
    goal: "everyday",
  } as Learner;
  expect(dashboard(learner, undefined, "c")).toContain(
    "Visible to you, your coaches and account administrators",
  );
  expect(
    accountPage({ ...learner, id: "x" } as Learner, "c", "linked", false, true),
  ).toContain('href="/account/sharing"');
  expect(
    accountPage({ ...learner, id: "x" } as Learner, "c", "linked"),
  ).not.toContain('href="/account/sharing"');
});

it("WHOSEES-07/08 denial, stray queries and failures never look like nothing shared", async () => {
  const denied = await request(
    server({
      summary: () => Promise.resolve({ kind: "denied" }),
      staffAccess: () => Promise.resolve({ kind: "unavailable" }),
    }),
  ).get("/account/sharing");
  expect(denied.status).toBe(303);
  expect(denied.headers.location).toBe("/");

  const stray = await request(server(ready({ coaches: 1 }))).get(
    "/account/sharing?x=1",
  );
  expect(stray.status).toBe(400);
  expect(text(stray.text)).toContain("Open this page from My account");

  const failed = await request(
    server(history(() => Promise.resolve({ kind: "unavailable" }))),
  ).get("/account/sharing");
  expect(failed.status).toBe(503);
  expect(failed.headers["cache-control"]).toBe("no-store");
  expect(text(failed.text)).toContain("can't be checked right now");
  expect(text(failed.text)).not.toContain("You haven't");

  expect(
    (await request(server(undefined)).get("/account/sharing")).status,
  ).toBe(404);
});

const entry = (
  source: StaffAccessEntry["source"],
  action: string,
  via: string | null = null,
  file: string | null = null,
): StaffAccessEntry => ({
  source,
  action,
  via,
  file,
  at: new Date("2026-11-05T12:00:00Z"),
});
const history = (staffAccess: MemberSharing["staffAccess"]): MemberSharing => ({
  summary: () => Promise.resolve({ kind: "unavailable" }),
  staffAccess,
});
const showing = (entries: StaffAccessEntry[], older: string | null = null) =>
  history(() => Promise.resolve({ kind: "ready", value: { entries, older } }));
const PATH = "/account/sharing/staff-access";

it.each([
  [
    entry("access", "grant_created", "assignment"),
    "Assigned staff were given access to your learning workspace.",
  ],
  [
    entry("access", "grant_created", "support"),
    "Support staff were given access to your learning workspace.",
  ],
  [
    entry("access", "grant_created", "evidence_review"),
    "A reviewer was given access to one of your files.",
  ],
  [
    entry("access", "grant_revoked", "assignment"),
    "Access to your learning workspace was taken away from assigned staff.",
  ],
  [
    entry("access", "grant_revoked", "evidence_review"),
    "Access to one of your files was taken away from a reviewer.",
  ],
  [
    entry("access", "workspace_read", "support"),
    "Support staff opened your learning workspace.",
  ],
  [
    entry("access", "support_content_read", "support"),
    "Support staff read your support content.",
  ],
  [
    entry("access", "evidence_link_issued", "assignment", "Notes.txt"),
    "Assigned staff got a link to Notes.txt.",
  ],
  [
    entry("access", "evidence_bytes_loaded", "evidence_review", "Notes.txt"),
    "A reviewer opened Notes.txt.",
  ],
  [
    entry("access", "evidence_bytes_loaded", "assignment"),
    "Assigned staff opened a file you've since removed.",
  ],
  [
    entry("feedback", "read", null, "Notes.txt"),
    "A reviewer read your sample Notes.txt.",
  ],
  [
    entry("feedback", "draft-saved", null, "Notes.txt"),
    "A reviewer saved draft feedback on Notes.txt.",
  ],
  [
    entry("feedback", "published"),
    "A reviewer published feedback on a file you've since removed.",
  ],
  [
    entry("feedback", "answered", null, "Notes.txt"),
    "A reviewer answered your question about feedback on Notes.txt.",
  ],
  [
    entry("proposal", "proposal_read", "moderator"),
    "A moderator read a proposal you sent.",
  ],
  [
    entry("proposal", "proposal_quarantined", "moderator"),
    "A moderator set aside a proposal you sent for closer review.",
  ],
  [
    entry("proposal", "proposal_rejected", "platform_admin"),
    "An administrator rejected a proposal you sent.",
  ],
  [
    entry("proposal", "proposal_changes_requested", "moderator"),
    "A moderator asked for changes to a proposal you sent.",
  ],
  [
    entry("access", "a_later_kind", "assignment"),
    "Staff accessed your private work.",
  ],
  [entry("feedback", "a_later_kind"), "Staff accessed your private work."],
  [
    entry("proposal", "a_later_kind", "moderator"),
    "Staff accessed your private work.",
  ],
])("STAFFSEE-02..04 says %j in plain words", async (row, words) => {
  const res = await request(server(showing([row]))).get(PATH);
  expect(res.status).toBe(200);
  expect(res.headers["cache-control"]).toContain("no-store");
  expect(text(res.text).replace(/ \./g, ".")).toContain(words);
  expect(res.text).toContain('<time datetime="2026-11-05T12:00:00.000Z">');
});

it("STAFFSEE-03 a member's file name is escaped", async () => {
  const res = await request(
    server(
      showing([
        entry("access", "evidence_bytes_loaded", "assignment", "<b>x</b>.txt"),
      ]),
    ),
  ).get(PATH);
  expect(res.text).toContain("&lt;b&gt;x&lt;/b&gt;.txt");
  expect(res.text).not.toContain("<b>x</b>");
});

it("STAFFSEE-01 an empty history says none is recorded and what it doesn't cover", async () => {
  const res = await request(server(showing([]))).get(PATH);
  expect(text(res.text)).toContain(
    "No staff access to your private work is recorded.",
  );
  expect(text(res.text)).toContain(
    "workflow notes you sent for private review",
  );
  expect(text(res.text)).toContain(
    "This history is deleted with your account.",
  );
  expect(res.text).not.toContain("Older entries");
});

it("STAFFSEE-05 the sharing page says how much staff access is active", async () => {
  const words = async (staffWithAccess: number) =>
    text(
      (
        await request(server(ready({ staffWithAccess }))).get(
          "/account/sharing",
        )
      ).text,
    );
  expect(await words(0)).toContain(
    "No staff access to your private work is active right now.",
  );
  expect(await words(1)).toContain("1 staff member has access");
  expect(await words(2)).toContain("2 staff members have access");
});

it("STAFFSEE-06 paging passes the position on and refuses anything else", async () => {
  const seen: (string | undefined)[] = [];
  const site = server(
    history((_token, before) => {
      seen.push(before);
      return Promise.resolve({
        kind: "ready",
        value: { entries: [], older: before ? null : "next+/position" },
      });
    }),
  );
  const first = await request(site).get(PATH);
  expect(first.text).toContain(`${PATH}?before=next%2B%2Fposition`);
  const later = await request(site).get(`${PATH}?before=abc`);
  expect(seen).toEqual([undefined, "abc"]);
  expect(text(later.text)).toContain("There are no older entries.");
  expect((await request(site).get(`${PATH}?other=1`)).status).toBe(400);
  expect((await request(site).get(`${PATH}?before=a&before=b`)).status).toBe(
    400,
  );
  expect(seen).toHaveLength(2);
  const refused = await request(
    server(history(() => Promise.resolve({ kind: "invalid" }))),
  ).get(`${PATH}?before=bad`);
  expect(refused.status).toBe(400);
});

it("STAFFSEE-07/08 denial goes home and a failed read never looks like an empty history", async () => {
  const denied = await request(
    server(history(() => Promise.resolve({ kind: "denied" }))),
  ).get(PATH);
  expect(denied.status).toBe(303);
  expect(denied.headers.location).toBe("/");
  const failed = await request(
    server(history(() => Promise.resolve({ kind: "unavailable" }))),
  ).get(PATH);
  expect(failed.status).toBe(503);
  expect(text(failed.text)).toContain("can't be checked right now");
  expect(failed.text).not.toContain("is recorded");
});

it("STAFFSEE-06/07/08 the store checks the token and position, then reads only the owner", async () => {
  const query = vi.fn();
  const store = memberSharingStore({ query } as unknown as Pool);
  expect(await store.staffAccess("not-a-token")).toEqual({ kind: "denied" });
  const encode = (value: string) => Buffer.from(value).toString("base64url");
  for (const before of [
    "junk",
    encode("2026-11-05T12:00:00.000000Z|elsewhere|1"),
    encode("2026-13-45T12:00:00.000000Z|access|1"),
    encode("2026-11-05T12:00:00.000000Z|access|1;DROP"),
  ])
    expect(await store.staffAccess(token, before)).toEqual({ kind: "invalid" });
  expect(query).not.toHaveBeenCalled();

  query.mockResolvedValueOnce({ rows: [] });
  expect(await store.staffAccess(token)).toEqual({ kind: "denied" });
  query.mockRejectedValueOnce(Error("invented failure"));
  expect(await store.staffAccess(token)).toEqual({ kind: "unavailable" });

  const row = {
    source: "access",
    id: "7",
    action: "workspace_read",
    via: "support",
    file: null,
    at: new Date("2026-11-05T12:00:00Z"),
    key: "2026-11-05T12:00:00.000000Z",
  };
  query
    .mockResolvedValueOnce({ rows: [{ id: "w" }] })
    .mockResolvedValueOnce({ rows: Array(STAFF_ACCESS_PAGE + 1).fill(row) });
  const full = await store.staffAccess(token);
  if (full.kind !== "ready") throw Error("Expected a page");
  expect(full.value.entries).toHaveLength(STAFF_ACCESS_PAGE);
  expect(Object.keys(full.value.entries[0]!).sort()).toEqual([
    "action",
    "at",
    "file",
    "source",
    "via",
  ]);
  const position = full.value.older!;
  expect(Buffer.from(position, "base64url").toString()).toBe(
    "2026-11-05T12:00:00.000000Z|access|7",
  );

  query
    .mockResolvedValueOnce({ rows: [{ id: "w" }] })
    .mockResolvedValueOnce({ rows: [row] });
  const last = await store.staffAccess(token, position);
  expect(last).toMatchObject({ kind: "ready", value: { older: null } });
  expect(query.mock.lastCall![1]).toEqual([
    "w",
    "2026-11-05T12:00:00.000000Z",
    "access",
    "7",
    STAFF_ACCESS_PAGE + 1,
  ]);
});
