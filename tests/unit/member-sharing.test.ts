import express from "express";
import request from "supertest";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import {
  memberSharingStore,
  type MemberSharing,
  type SharingSummary,
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
    server({ summary: () => Promise.resolve({ kind: "denied" }) }),
  ).get("/account/sharing");
  expect(denied.status).toBe(303);
  expect(denied.headers.location).toBe("/");

  const stray = await request(server(ready({ coaches: 1 }))).get(
    "/account/sharing?x=1",
  );
  expect(stray.status).toBe(400);
  expect(text(stray.text)).toContain("Open this page from My account");

  const failed = await request(
    server({ summary: () => Promise.resolve({ kind: "unavailable" }) }),
  ).get("/account/sharing");
  expect(failed.status).toBe(503);
  expect(failed.headers["cache-control"]).toBe("no-store");
  expect(text(failed.text)).toContain("can't be checked right now");
  expect(text(failed.text)).not.toContain("You haven't");

  expect(
    (await request(server(undefined)).get("/account/sharing")).status,
  ).toBe(404);
});
