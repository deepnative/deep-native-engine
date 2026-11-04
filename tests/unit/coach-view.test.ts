import express from "express";
import request from "supertest";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import {
  coachViewStore,
  type CoachSummaryResult,
} from "../../src/coach-view.ts";
import { mountCoachView } from "../../src/coach-view-routes.ts";
import { COOKIE } from "../../src/session.ts";
import { hash } from "../../src/store.ts";

const token = "a".repeat(64);
const owned: Promise<Server>[] = [];
afterEach(async () => {
  await Promise.all(
    owned.splice(0).map(async (server) => closeLoopback(await server)),
  );
});

it("ROLES-03/04 the coach summary checks the coach role, then reads hours only", async () => {
  const query = vi.fn();
  const coach = coachViewStore({ query } as unknown as Pool);
  expect(await coach.summary("not-a-token")).toEqual({ kind: "denied" });
  expect(await coach.summary(token, "2026-13")).toEqual({ kind: "invalid" });
  expect(query).not.toHaveBeenCalled();

  // Not a coach: nothing else is read.
  query.mockResolvedValueOnce({ rows: [] });
  expect(await coach.summary(token)).toEqual({ kind: "denied" });
  expect(query).toHaveBeenCalledTimes(1);
  expect(String(query.mock.calls[0]![0])).toContain("r.role='coach'");

  query.mockResolvedValueOnce({ rows: [{ today: "2026-11" }] });
  expect(await coach.summary(token, "2026-12")).toEqual({ kind: "invalid" });

  query
    .mockResolvedValueOnce({ rows: [{ today: "2026-11" }] })
    .mockResolvedValueOnce({
      rows: [
        { displayName: "Ada", minutes: 90, state: "draft", returned: false },
        { displayName: null, minutes: 30, state: "draft", returned: true },
        { displayName: "Bo", minutes: 60, state: "submitted", returned: false },
        { displayName: "Cy", minutes: 15, state: "invoiced", returned: false },
      ],
    });
  const ready = await coach.summary(token);
  expect(ready).toEqual({
    kind: "ready",
    value: {
      month: "2026-11",
      today: "2026-11",
      rows: [
        { name: "Ada", minutes: 90, status: "Draft" },
        { name: null, minutes: 30, status: "Returned for changes" },
        { name: "Bo", minutes: 60, status: "Submitted" },
        { name: "Cy", minutes: 15, status: "Reviewed" },
      ],
    },
  });
  const sql = String(query.mock.calls.at(-1)![0]);
  expect(sql).not.toMatch(/rate|cents|invoice|INSERT|UPDATE |DELETE/i);
  // #684 COACHLINK-02: only learners assigned to this coach are read.
  expect(sql).toContain("FROM coach_assignments a");
  expect(query.mock.calls.at(-1)![1]).toEqual(["2026-11", hash(token)]);

  query.mockRejectedValueOnce(new Error("database unavailable"));
  expect(await coach.summary(token)).toEqual({ kind: "unavailable" });
});

function fixture(result: CoachSummaryResult) {
  const summary = vi.fn().mockResolvedValue(result);
  const application = express();
  mountCoachView(application, { summary });
  const server = listenLoopback(application);
  owned.push(server);
  return { summary, http: async () => request(await server) };
}
const member = `${COOKIE}=${token}`;

it("ROLES-03 Coaching lists each person's hours and status with no billing", async () => {
  const f = fixture({
    kind: "ready",
    value: {
      month: "2026-10",
      today: "2026-11",
      rows: [
        { name: "Ada <Lovelace>", minutes: 90, status: "Submitted" },
        { name: null, minutes: 45, status: "Draft" },
      ],
    },
  });
  const http = await f.http();
  const r = await http.get("/coach?month=2026-10").set("Cookie", member);
  expect(r.status).toBe(200);
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(f.summary).toHaveBeenCalledWith(token, "2026-10");
  expect(r.text).toContain("<h1>Coaching</h1>");
  expect(r.text).toContain("October 2026");
  expect(r.text).toContain(
    "<td>Ada &lt;Lovelace&gt;</td><td>1h 30m</td><td>Submitted</td>",
  );
  expect(r.text).toContain("<td>Name needed</td><td>0h 45m</td><td>Draft</td>");
  expect(r.text).not.toMatch(/\$|CAD|cents|per hour/i);
  expect(r.text).toContain('href="/coach?month=2026-09"');
  expect(r.text).toContain('href="/coach?month=2026-11"');
  expect(r.text).toContain('max="2026-11"');
});

it("ROLES-03 the current month has no next link and an empty month says so", async () => {
  const f = fixture({
    kind: "ready",
    value: { month: "2026-11", today: "2026-11", rows: [] },
  });
  const r = await (await f.http()).get("/coach").set("Cookie", member);
  expect(f.summary).toHaveBeenCalledWith(token, undefined);
  expect(r.text).toContain("No coaching hours saved for this month.");
  expect(r.text).not.toContain('href="/coach?month=2026-12"');
});

it.each([
  [{ kind: "denied" } as const, 403, "Coaching is for coaches"],
  [{ kind: "invalid" } as const, 400, "Choose a month"],
  [{ kind: "unavailable" } as const, 503, "Coaching is unavailable"],
])("ROLES-04 Coaching refuses %o", async (result, status, text) => {
  const f = fixture(result);
  const r = await (await f.http()).get("/coach").set("Cookie", member);
  expect(r.status).toBe(status);
  expect(r.text).toContain(text);
});

it("ROLES-04 Coaching refuses signed-out and malformed requests without a lookup", async () => {
  const f = fixture({ kind: "denied" });
  const http = await f.http();
  expect((await http.get("/coach")).status).toBe(403);
  expect(
    (await http.get("/coach?month=2026-10&x=1").set("Cookie", member)).status,
  ).toBe(403);
  expect(
    (await http.get("/coach?month=a&month=b").set("Cookie", member)).status,
  ).toBe(403);
  expect(f.summary).not.toHaveBeenCalled();
});

it("ROLES-04 Coaching is not mounted without a store", async () => {
  const application = express();
  mountCoachView(application, undefined);
  const server = listenLoopback(application);
  owned.push(server);
  expect((await request(await server).get("/coach")).status).toBe(404);
});
