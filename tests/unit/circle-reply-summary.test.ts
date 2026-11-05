import request from "supertest";
import { expect, it, vi } from "vitest";
import { withLoopback } from "../support/loopback-server.ts";
import { app } from "../../src/app.ts";
import { COOKIE } from "../../src/session.ts";
import type { Learner } from "../../src/store.ts";
import { circleReplySummaries } from "../../src/circle-discussion-routes.ts";
import {
  disabledCircleDiscussionStore,
  type CircleActivity,
  type CircleDiscussionStore,
} from "../../src/circle-discussion.ts";
import { CIRCLES } from "../../src/circles.ts";
import { databaseMoment } from "../../src/display-time.ts";
import { circlesPage } from "../../src/views.ts";

const circle = CIRCLES[0]!;
const joined = [{ ...circle, joined: true, seatsRemaining: 3 }];
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const withActivity = (activity?: CircleActivity | "unavailable") =>
  circlesPage(
    joined,
    "everyday",
    "csrf",
    true,
    new Map(activity ? [[circle.id, activity]] : []),
  );

it.each([
  ["2 replies", 2],
  ["1 reply", 1],
])(
  "FOLLOW-04 says %s, when the latest came and where to go",
  (words, replies) => {
    const html = withActivity({
      questions: 2,
      replies,
      latestReplyAt: "2026-11-05 14:30:00.123456+00",
    });
    expect(text(html)).toContain(`${words} to your questions · latest`);
    expect(html).toContain('datetime="2026-11-05T14:30:00.123Z"');
    expect(html).toContain(
      `href="/circles/${circle.id}/discussion/owned">See your questions`,
    );
  },
);

it("FOLLOW-04 says so when my questions have no replies yet", () => {
  expect(
    text(withActivity({ questions: 1, replies: 0, latestReplyAt: null })),
  ).toContain("No replies to your questions yet. See your questions");
});

it("FOLLOW-07 says nothing about replies when I have no shared questions or no summary", () => {
  for (const html of [
    withActivity({ questions: 0, replies: 0, latestReplyAt: null }),
    withActivity(),
  ]) {
    expect(html).not.toContain("to your questions");
    expect(html).not.toContain("See your questions");
  }
});

it("FOLLOW-08 a failed read is not the same as no replies", () => {
  const html = text(withActivity("unavailable"));
  expect(html).toContain(
    "Replies to your questions can't be checked right now",
  );
  expect(html).not.toContain("No replies");
  expect(html).toContain(`Leave ${circle.title}`);
});

it("FOLLOW-08 the reader keeps each circle's result apart when one fails", async () => {
  const activity = vi.fn<CircleDiscussionStore["activity"]>(
    async (_token, id) => {
      if (id === "bad") throw Error("Circle operation unavailable");
      if (id === "off") return { kind: "denied" };
      return {
        kind: "ready",
        value: { questions: 1, replies: 0, latestReplyAt: null },
      };
    },
  );
  const summaries = await circleReplySummaries(
    { ...disabledCircleDiscussionStore(), activity },
    "token",
    ["good", "off", "bad"],
  );
  expect([...summaries.entries()].sort()).toEqual([
    ["bad", "unavailable"],
    ["good", { questions: 1, replies: 0, latestReplyAt: null }],
  ]);
});

it("FOLLOW-04 the Circles page asks only for joined circles while discussion is on", async () => {
  const activity = vi.fn<CircleDiscussionStore["activity"]>(async () => ({
    kind: "ready",
    value: { questions: 1, replies: 0, latestReplyAt: null },
  }));
  const member = {
    id: "invented",
    background: "explorer",
    goal: "everyday",
  } as unknown as Learner;
  const site = (enabled: boolean) =>
    app(
      {
        check: vi.fn(async () => true),
        session: vi.fn(async () => ({
          kind: "active",
          expiresAt: new Date(Date.now() + 3600000),
          learner: member,
        })),
      } as never,
      {
        origin: "http://127.0.0.1",
        secret: "secret",
        circles: {
          list: vi.fn(async () => [
            { ...circle, joined: true, seatsRemaining: 3 },
            { ...CIRCLES[1]!, joined: false, seatsRemaining: 3 },
          ]),
        } as never,
        circleDiscussion: {
          ...disabledCircleDiscussionStore(),
          activity,
        },
        circleDiscussionEnabled: enabled,
      },
    );
  const read = (enabled: boolean) =>
    withLoopback(site(enabled), (listener) =>
      request(listener)
        .get("/circles")
        .set("Host", "127.0.0.1")
        .set("Cookie", `${COOKIE}=${"a".repeat(64)}`)
        .expect(200),
    );
  expect((await read(true)).text).toContain("No replies to your questions yet");
  expect(activity.mock.calls.map((call) => call[1])).toEqual([circle.id]);
  activity.mockClear();
  expect((await read(false)).text).not.toContain("to your questions");
  expect(activity).not.toHaveBeenCalled();
});

it("reads PostgreSQL's text times and leaves anything else unchanged", () => {
  expect(databaseMoment("2026-11-05 14:30:00+00")).toBe(
    "2026-11-05T14:30:00.000Z",
  );
  expect(databaseMoment("2026-11-05 14:30:00.5+00")).toBe(
    "2026-11-05T14:30:00.500Z",
  );
  expect(databaseMoment("not a time")).toBe("not a time");
});
