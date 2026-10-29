import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { registerCircleDiscussion } from "../../src/circle-discussion-routes.ts";
import {
  disabledCircleDiscussionStore,
  type CircleReportNotice,
} from "../../src/circle-discussion.ts";
import { withLoopback } from "../support/loopback-server.ts";
const circle = "everyday-ai",
  report = "00000000-0000-4000-8000-000000000001",
  path = `/circles/${circle}/discussion/reports/${report}/moderation-notice`;
const notice = (): CircleReportNotice => ({
  reportNoticeVersion: 1,
  circleId: circle,
  reportId: report,
  category: "privacy",
  reportedAt: "2026-10-28T10:00:00Z",
  targetStatus: "hidden",
  decision: {
    action: "hidden",
    reason: "conduct",
    oldRevision: 1,
    newRevision: 2,
    occurredAt: "2026-10-28T10:01:00Z",
  },
});
function fixture() {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.token = "invented-token";
    res.locals.csrf = "invented-csrf";
    next();
  });
  const read = vi.fn().mockResolvedValue({ kind: "ready", value: notice() });
  registerCircleDiscussion(app, {
    ...disabledCircleDiscussionStore(),
    reportModerationNotice: read,
  });
  return { app, read };
}
it("RPTN-01/05 renders a readable truthful decision and explicitly whitelists downloaded fields", async () => {
  const f = fixture(),
    value = {
      ...notice(),
      body: "Private source",
      actor_id: "Private staff",
      target_id: "Private reference",
      decision: { ...notice().decision!, fingerprint: "Private key" },
    };
  f.read.mockResolvedValue({ kind: "ready", value });
  await withLoopback(f.app, async (server) => {
    const html = await request(server).get(path).expect(200);
    expect(html.text).toContain("Your private report decision notice");
    expect(html.text).toContain("Decision time");
    expect(html.text).toContain("not a resolution of your individual report");
    expect(html.text).toContain(path + "/download");
    expect(html.text).not.toContain("Private source");
    const json = await request(server)
      .get(path + "/download")
      .expect(200);
    expect(json.body).toEqual(notice());
    expect(json.headers["cache-control"]).toContain("no-store");
    expect(json.headers["x-content-type-options"]).toBe("nosniff");
    expect(json.headers["content-disposition"]).toBe(
      'attachment; filename="circle-report-decision-notice.json"',
    );
  });
  expect(f.read).toHaveBeenCalledWith("invented-token", circle, report);
});
it.each(["reported", "unavailable"] as const)(
  "RPTN-01/03 %s state offers no invented decision",
  async (status) => {
    const f = fixture();
    f.read.mockResolvedValue({
      kind: "ready",
      value: { ...notice(), targetStatus: status, decision: null },
    });
    await withLoopback(f.app, async (server) => {
      const r = await request(server).get(path).expect(200);
      expect(r.text).toContain(
        status === "reported" ? "Visible" : "Target unavailable",
      );
      expect(r.text).toContain(
        "No later recorded decision is currently available",
      );
      expect(r.text).not.toContain("<dt>Decision time</dt>");
    });
  },
);
it("RPTN-01 untrusted projected text is escaped in HTML", async () => {
  const f = fixture();
  f.read.mockResolvedValue({
    kind: "ready",
    value: {
      ...notice(),
      reportedAt: "<script>unsafe</script>",
      decision: { ...notice().decision!, reason: "<img>" },
    },
  });
  await withLoopback(f.app, async (server) => {
    const r = await request(server).get(path).expect(200);
    expect(r.text).not.toContain("<script>unsafe");
    expect(r.text).toContain("&lt;script&gt;unsafe");
    expect(r.text).toContain("&lt;img&gt;");
  });
});
it.each(["denied", "invalid", "conflict", "limit"])(
  "RPTN-02 %s never attaches a notice",
  async (kind) => {
    const f = fixture();
    f.read.mockResolvedValue({ kind });
    await withLoopback(f.app, async (server) => {
      for (const suffix of ["", "/download"]) {
        const r = await request(server)
          .get(path + suffix)
          .expect(kind === "denied" ? 403 : kind === "invalid" ? 422 : 409);
        expect(r.headers["content-disposition"]).toBeUndefined();
        expect(r.text).not.toContain("Decision time");
      }
    });
  },
);
it("RPTN-02 query fields are rejected before read or attachment", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    for (const suffix of ["", "/download"]) {
      const r = await request(server)
        .get(path + suffix + "?extra=true")
        .expect(422);
      expect(r.headers["content-disposition"]).toBeUndefined();
    }
  });
  expect(f.read).not.toHaveBeenCalled();
});
it("RPTN-05 uncertain database handback is sanitized503 with no attachment", async () => {
  const f = fixture();
  f.read.mockRejectedValue(Error("Private credential or database detail"));
  await withLoopback(f.app, async (server) => {
    for (const suffix of ["", "/download"]) {
      const r = await request(server)
        .get(path + suffix)
        .expect(503);
      expect(r.headers["content-disposition"]).toBeUndefined();
      expect(r.text).not.toContain("Private credential");
      expect(r.text).not.toContain("Decision time");
    }
  });
});
