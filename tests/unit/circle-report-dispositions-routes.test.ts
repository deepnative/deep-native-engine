import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { registerCircleDiscussion } from "../../src/circle-discussion-routes.ts";
import {
  disabledCircleDiscussionStore,
  type CircleReportDisposition,
  type ModeratorReport,
} from "../../src/circle-discussion.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #196 RPTD: transport, forms and the whitelisted reporter download.
const circle = "everyday-ai",
  report = "00000000-0000-4000-8000-000000000001",
  key = "00000000-0000-4000-8000-000000000002",
  member = `/circles/${circle}/discussion/reports/${report}/disposition`,
  action = `/moderate/circles/${circle}/reports/${report}/disposition`;
const record = (): CircleReportDisposition => ({
  reportDispositionVersion: 1,
  circleId: circle,
  reportId: report,
  category: "off_topic",
  reportedAt: "2026-11-10T10:00:00Z",
  disposition: "closed",
  revision: 3,
  history: [
    {
      action: "escalated",
      reason: "policy_unclear",
      occurredAt: "2026-11-10T10:01:00Z",
    },
    {
      action: "closed",
      reason: "recorded_target_decision",
      occurredAt: "2026-11-10T10:02:00Z",
    },
  ],
});
const target = {
  id: "00000000-0000-4000-8000-000000000003",
  body: "Invented <body>",
  state: "hidden" as const,
  revision: 2,
  createdAt: "2026-11-10T09:00:00Z",
  pseudonym: "Peer",
};
function fixture() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.token = "invented-token";
    res.locals.csrf = "invented-csrf";
    next();
  });
  const read = vi.fn().mockResolvedValue({ kind: "ready", value: record() });
  const dispose = vi
    .fn()
    .mockResolvedValue({ kind: "ready", value: { id: report, revision: 2 } });
  const queue = vi.fn();
  registerCircleDiscussion(app, {
    ...disabledCircleDiscussionStore(),
    reportDisposition: read,
    disposeReport: dispose,
    moderationQueue: queue,
  });
  return { app, read, dispose, queue };
}
const form = {
  csrf: "invented-csrf",
  idempotencyKey: key,
  action: "reject",
  reason: "rule_not_breached",
  reportRevision: "1",
  sourceRevision: "2",
  confirm: "yes",
};

it("RPTD-01/05 shows the reporter's record and downloads only whitelisted fields", async () => {
  const f = fixture();
  f.read.mockResolvedValue({
    kind: "ready",
    value: {
      ...record(),
      actorId: "Private staff",
      body: "Private source",
      history: record().history.map((h) => ({ ...h, actor: "Private staff" })),
    },
  });
  await withLoopback(f.app, async (server) => {
    const html = await request(server).get(member).expect(200);
    expect(html.text).toContain("What happened to your report");
    expect(html.text).toContain(
      "Closed after a recorded decision · revision 3",
    );
    expect(html.text).toContain("Policy unclear");
    expect(html.text).toContain("assigns nobody and promises no response");
    expect(html.text).not.toContain("Private");
    const json = await request(server).get(`${member}/download`).expect(200);
    expect(json.body).toEqual(record());
    expect(json.headers["cache-control"]).toContain("no-store");
    expect(json.headers["x-content-type-options"]).toBe("nosniff");
    expect(json.headers["content-disposition"]).toBe(
      'attachment; filename="circle-report-disposition.json"',
    );
  });
  expect(f.read).toHaveBeenCalledWith("invented-token", circle, report);
});
it("RPTD-05 shows an open report with no recorded action, and denies others without an attachment", async () => {
  const f = fixture();
  f.read.mockResolvedValue({
    kind: "ready",
    value: { ...record(), disposition: "open", revision: 1, history: [] },
  });
  await withLoopback(f.app, async (server) => {
    const html = await request(server).get(member).expect(200);
    expect(html.text).toContain(
      "No action has been recorded on this report yet.",
    );
    f.read.mockResolvedValue({ kind: "denied" });
    const denied = await request(server).get(`${member}/download`).expect(403);
    expect(denied.headers["content-disposition"]).toBeUndefined();
    await request(server).get(`${member}?x=1`).expect(422);
  });
});
it("RPTD-01..03 submits one confirmed disposition and redirects to the worklist", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    const ok = await request(server).post(action).type("form").send(form);
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe(`/moderate/circles/${circle}/reports`);
    await request(server)
      .post(action)
      .type("form")
      .send({
        ...form,
        action: "close",
        reason: "recorded_target_decision",
        decisionRevision: "2",
      })
      .expect(303);
  });
  expect(f.dispose.mock.calls).toEqual([
    [
      "invented-token",
      circle,
      report,
      key,
      "reject",
      "rule_not_breached",
      1,
      2,
      null,
    ],
    [
      "invented-token",
      circle,
      report,
      key,
      "close",
      "recorded_target_decision",
      1,
      2,
      2,
    ],
  ]);
});
it("RPTD-06 rejects unconfirmed or malformed forms and maps store conflicts", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    for (const bad of [
      { ...form, confirm: undefined },
      { ...form, reportRevision: "0" },
      { ...form, sourceRevision: "x" },
      { ...form, decisionRevision: "-1" },
      { ...form, actor: "forged" },
      { ...form, reportRevision: undefined },
      { ...form, sourceRevision: undefined },
    ])
      await request(server).post(action).type("form").send(bad).expect(422);
    expect(f.dispose).not.toHaveBeenCalled();
    f.dispose.mockResolvedValue({ kind: "conflict" });
    await request(server).post(action).type("form").send(form).expect(409);
  });
});
it("RPTD-07 an unconfirmed result links to the original-key recovery for this action", async () => {
  const f = fixture();
  f.dispose.mockRejectedValue(new Error("Circle outcome unconfirmed"));
  await withLoopback(f.app, async (server) => {
    const r = await request(server).post(action).type("form").send(form);
    expect(r.status).toBe(503);
    expect(r.text).toContain(
      `/moderate/circles/${circle}/reconcile?kind=report-disposition&amp;key=${key}`,
    );
  });
});
it("RPTD-01..03 offers each action only where the disposition allows it", async () => {
  const f = fixture();
  const item = (over: Partial<ModeratorReport>): ModeratorReport => ({
    id: report,
    category: "privacy",
    target,
    disposition: "open",
    dispositionRevision: 1,
    decisionRevision: 2,
    ...over,
  });
  const render = async (items: ModeratorReport[]) => {
    f.queue.mockResolvedValue({
      kind: "ready",
      value: { items, nextCursor: null },
    });
    return withLoopback(
      f.app,
      async (server) =>
        (
          await request(server)
            .get(`/moderate/circles/${circle}/reports`)
            .expect(200)
        ).text,
    );
  };
  const open = await render([item({})]);
  expect(open).toContain("Report disposition: Open · revision 1");
  for (const label of [
    "Ask for a local second look",
    "Reject this report",
    "Close against decision revision 2",
  ])
    expect(open).toContain(label);
  expect(open).toContain('name="decisionRevision" value="2"');
  expect(open).toContain("kind=report-disposition");
  const escalated = await render([
    item({
      disposition: "escalated",
      dispositionRevision: 2,
      decisionRevision: null,
    }),
  ]);
  expect(escalated).not.toContain("Ask for a local second look");
  expect(escalated).not.toContain("Close against");
  expect(escalated).toContain('name="reportRevision" value="2"');
  for (const done of [
    item({ disposition: "rejected", dispositionRevision: 2 }),
    item({ target: null }),
    item({
      disposition: undefined,
      dispositionRevision: undefined,
      target: null,
    }),
  ]) {
    const html = await render([done]);
    expect(html).not.toContain("Reject this report");
  }
});
it("RPTD-07 the staff recovery form accepts the report-disposition kind", async () => {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.token = "invented-token";
    res.locals.csrf = "invented-csrf";
    next();
  });
  const reconcile = vi.fn().mockResolvedValue({
    kind: "ready",
    value: { found: true, id: report, status: "escalated", revision: 2 },
  });
  registerCircleDiscussion(app, {
    ...disabledCircleDiscussionStore(),
    reconcile,
  });
  await withLoopback(app, async (server) => {
    const r = await request(server)
      .get(
        `/moderate/circles/${circle}/reconcile?kind=report-disposition&key=${key}`,
      )
      .expect(200);
    expect(r.text).toContain("Original-key receipt: escalated · revision 2");
    const blank = await request(server)
      .get(`/moderate/circles/${circle}/reconcile`)
      .expect(200);
    expect(blank.text).toContain('<option value="report-disposition">');
  });
  expect(reconcile).toHaveBeenCalledWith(
    "invented-token",
    circle,
    "report-disposition",
    key,
  );
});
