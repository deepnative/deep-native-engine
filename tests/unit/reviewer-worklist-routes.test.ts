import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { withLoopback } from "../support/loopback-server.ts";
import { mountReviewerWorklistRoutes } from "../../src/reviewer-worklist-routes.ts";
import type { ReviewerWorklistStore } from "../../src/reviewer-worklist.ts";
function fixture() {
  const list = vi.fn<ReviewerWorklistStore["list"]>().mockResolvedValue({
    kind: "ready",
    view: "active",
    items: [],
    next: null,
  });
  const app = express();
  app.use((_req, res, next) => {
    res.locals.token = "session";
    next();
  });
  mountReviewerWorklistRoutes(app, { list });
  return { app, list };
}
it("shows an honest empty queue and active/completed navigation", async () => {
  const f = fixture();
  const r = await withLoopback(f.app, (s) =>
    request(s).get("/review/worklist"),
  );
  expect(r.status).toBe(200);
  expect(r.text).toContain("No active sample feedback");
  expect(r.text).toContain("view=completed");
  expect(f.list).toHaveBeenCalledWith("session", "active", undefined);
});
it("escapes metadata and links only exact feedback details and signed continuation", async () => {
  const f = fixture();
  f.list.mockResolvedValue({
    kind: "ready",
    view: "completed",
    items: [
      {
        evidenceId: "11111111-1111-4111-8111-111111111111",
        title: "<script>invented</script>",
        version: 2,
        submittedAt: "2026-10-04T12:00:00.000000Z",
        ageMinutes: 12,
        state: "published",
      },
    ],
    next: "safe.cursor",
  });
  const r = await withLoopback(f.app, (s) =>
    request(s).get("/review/worklist?view=completed&after=previous"),
  );
  expect(r.status).toBe(200);
  expect(r.text).toContain("&lt;script&gt;");
  expect(r.text).not.toContain("<script>invented");
  expect(r.text).toContain("/feedback");
  expect(r.text).toContain("view=completed&amp;after=safe.cursor");
  expect(f.list).toHaveBeenCalledWith("session", "completed", "previous");
});
it.each([
  "?view=other",
  "?view=active&view=completed",
  "?after=a&after=b",
  "?workspace=foreign",
  "?limit=500",
])("rejects invalid query %s without store access", async (query) => {
  const f = fixture();
  const r = await withLoopback(f.app, (s) =>
    request(s).get("/review/worklist" + query),
  );
  expect(r.status).toBe(422);
  expect(f.list).not.toHaveBeenCalled();
});
it.each([
  ["denied", 403],
  ["invalid", 422],
  ["unavailable", 503],
] as const)("renders %s without private results", async (kind, status) => {
  const f = fixture();
  f.list.mockResolvedValue({ kind });
  const r = await withLoopback(f.app, (s) =>
    request(s).get("/review/worklist"),
  );
  expect(r.status).toBe(status);
  expect(r.text).toContain('role="alert"');
  expect(r.text).not.toContain("session");
});
it("withholds unexpected errors without leaking their content", async () => {
  const f = fixture();
  f.list.mockRejectedValue(Error("private failure text"));
  const r = await withLoopback(f.app, (s) =>
    request(s).get("/review/worklist"),
  );
  expect(r.status).toBe(503);
  expect(r.text).not.toContain("private failure text");
});
