import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import type { PreviewMetrics } from "../../src/metrics.ts";
import { metricsReportPage } from "../../src/metrics-report-views.ts";
import { registerMetricsReportRoutes } from "../../src/metrics-report-routes.ts";
import { withLoopback } from "../support/loopback-server.ts";

const snapshot: PreviewMetrics = {
  scope: "synthetic-local-preview",
  asOf: new Date("2026-10-27T12:00:00Z"),
  definitions: {
    denominator:
      "Retained accounts at asOf, excluding deleted records <private>.",
    activated: "Versioned lesson opens.",
    selfAssessed: "Self-assessed only.",
    participated: "Ever participated.",
    activeCircle: "Membership whose left_at is empty.",
    submittedAssignment: "Observed submission.",
    returnEligible: "First lesson open at least 14 days ago.",
    crossContentReturned:
      "Of returnEligible, different content during days 7 to 14.",
    usefulness: "Self-report, with small groups suppressed.",
  },
  counts: {
    members: 20,
    activated: 18,
    selfAssessed: 9,
    participated: 7,
    activeCircle: 5,
    submittedAssignment: 4,
    returnEligible: 10,
    crossContentReturned: 3,
  },
  usefulness: { disclosure: "coarse-band", helpfulShareBand: "50-74%" },
};
it("MR-01 renders every count with its meaning, denominator, timestamp and separate self-report band", () => {
  const html = metricsReportPage(snapshot);
  for (const [name, value] of Object.entries(snapshot.counts))
    expect(html).toContain(`data-metric="${name}">${value}</strong>`);
  expect(html).toContain("2026-10-27T12:00:00.000Z");
  expect(html).toContain("50-74%");
  expect(html).toContain("Measures overlap and must not be added together");
  expect(html).toContain("The separate starter exercise is not counted");
  expect(html).toContain("SYNTHETIC LOCAL PREVIEW");
  expect(html).toContain("&lt;private&gt;");
  expect(html).toContain("Retained accounts at the snapshot time");
  expect(html).toContain("Membership with no recorded departure");
  expect(html).toContain("Of the eligible member group");
  expect(html).not.toContain("<private>");
  expect(html).not.toContain("a return rate is undefined");
  expect(html).not.toContain("No retained members yet");
  expect(html).toContain('href="/operator/metrics"');
});
it("MR-02 preserves suppressed usefulness and undefined zero-denominator rates without inventing successful outcomes", () => {
  const html = metricsReportPage({
    ...snapshot,
    counts: {
      ...snapshot.counts,
      members: 0,
      returnEligible: 0,
      crossContentReturned: 0,
    },
    usefulness: { disclosure: "suppressed", helpfulShareBand: null },
  });
  expect(html).toContain(
    "No retained members yet; a member-based rate is undefined",
  );
  expect(html).toContain("No eligible members yet; a return rate is undefined");
  expect(html).toContain("Suppressed to protect small groups");
  expect(html).not.toContain("Helpful-share band:");
  expect(html).not.toContain("100% success");
});
it("MR-03 uses the selected actor and handles query, denial, failure and deliberate recovery without partial counts", async () => {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.token = "selected-staff";
    next();
  });
  const read = vi.fn().mockResolvedValue(snapshot);
  registerMetricsReportRoutes(app, { snapshot: read });
  await withLoopback(app, async (server) => {
    const good = await request(server)
      .get("/operator/metrics/report")
      .expect(200);
    expect(good.headers["cache-control"]).toBe("no-store");
    expect(good.type).toBe("text/html");
    expect(read).toHaveBeenCalledExactlyOnceWith("selected-staff");
    read.mockClear();
    const query = await request(server)
      .get("/operator/metrics/report?member=private")
      .expect(400);
    expect(query.text).toContain(
      "does not accept member, lesson, segment or date filters",
    );
    expect(read).not.toHaveBeenCalled();
    read.mockResolvedValueOnce(null);
    const denied = await request(server)
      .get("/operator/metrics/report")
      .expect(403);
    expect(denied.text).toContain("current operator or platform administrator");
    expect(denied.text).not.toContain('data-metric="members"');
    read.mockRejectedValueOnce(Error("private database diagnostic"));
    const failed = await request(server)
      .get("/operator/metrics/report")
      .expect(503);
    expect(failed.text).toContain("No partial counts are shown");
    expect(failed.text).not.toContain("private database diagnostic");
    expect(failed.text).toContain(
      'href="/operator/metrics/report">Reload snapshot',
    );
    expect(failed.text).not.toContain('data-metric="members"');
    await request(server).get("/operator/metrics/report").expect(200);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
