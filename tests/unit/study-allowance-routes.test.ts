import { expect, it, vi } from "vitest";
import type { Server } from "node:http";
import request from "supertest";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import type { StudyAllowanceStore } from "../../src/study-allowances.ts";
import { COOKIE } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
import type { ApplicationMode } from "../../src/adapters.ts";

const owner = "a".repeat(64);
const key = "22222222-2222-4222-8222-222222222222";
const at = new Date("2030-01-15T12:00:00.000Z");
const period = {
  start: new Date("2030-01-01T00:00:00.000Z"),
  end: new Date("2030-02-01T00:00:00.000Z"),
};
const policy = {
  version: "study-allowance-test-v1",
  category: "study_requests" as const,
  periodLimit: 5,
  period: "utc_calendar_month" as const,
  eligibility: "current_member_explicit_claim" as const,
  grantSource: "test_configuration" as const,
  rateEstimateVersion: null,
  spendState: "test" as const,
};
const claim = {
  id: "11111111-1111-4111-8111-111111111111",
  policyVersion: policy.version,
  quantity: 5,
  periodStart: period.start,
  periodEnd: period.end,
  createdAt: at,
  available: 4,
  reserved: 0,
  consumed: 1,
  expired: 0,
};
function ready<T>(value: T, deadline = performance.now() + 60000) {
  return { kind: "ready" as const, value, observedAt: at, deadline };
}
function view(overrides = {}) {
  return ready({
    policy,
    period,
    claim: null,
    creationEnabled: true,
    ...overrides,
  });
}
function application(
  stores: {
    member?: StudyAllowanceStore["member"];
    claim?: StudyAllowanceStore["claim"];
  },
  mode: ApplicationMode = "test",
) {
  const member = vi.fn<StudyAllowanceStore["member"]>(
    stores.member ?? (async () => view()),
  );
  const claimStore = vi.fn<StudyAllowanceStore["claim"]>(
    stores.claim ?? (async () => ready(claim)),
  );
  const server = app(
    {
      session: vi.fn().mockResolvedValue({ kind: "anonymous" }),
    } as unknown as Store,
    {
      origin: "http://127.0.0.1:3000",
      secret: "synthetic-route-test",
      mode,
      studyAllowances: { member, claim: claimStore },
    } as Parameters<typeof app>[1],
  );
  return { server, member, claimStore };
}
const path = "/member/study-allowance";
const get = (server: Server, url = path) =>
  request(server)
    .get(url)
    .set("Host", "127.0.0.1:3000")
    .set("Cookie", `${COOKIE}=${owner}`);
async function csrf(listener: ReturnType<typeof app>) {
  const page = await get(listener);
  const match = /name="csrf" value="([^"]+)"/.exec(page.text);
  if (!match) throw Error(`Expected a claim form: ${page.text}`);
  return match[1]!;
}
const post = (
  server: Server,
  token: string,
  fields: Record<string, string> = {},
) =>
  request(server)
    .post(`${path}/claim`)
    .set("Host", "127.0.0.1:3000")
    .set("Origin", "http://127.0.0.1:3000")
    .set("Cookie", `${COOKIE}=${owner}`)
    .type("form")
    .send({
      csrf: token,
      key,
      policyVersion: policy.version,
      periodStart: period.start.toISOString(),
      confirm: "yes",
      ...fields,
    });

it("ALLOW-01 shows the exact policy, an unticked confirmation and no claim on opening", async () => {
  const { server, member, claimStore } = application({});
  await withLoopback(server, async (listener) => {
    const response = await get(listener);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.text).toContain("study-allowance-test-v1");
    expect(response.text).toContain("5 study requests");
    expect(response.text).toContain("each calendar month");
    expect(response.text).toContain('type="checkbox" name="confirm"');
    expect(response.text).not.toMatch(/type="checkbox"[^>]* checked/);
    expect(member).toHaveBeenCalledWith(owner);
    expect(claimStore).not.toHaveBeenCalled();
  });
});

it("ALLOW-02 passes the exact confirmed instruction, then returns to the page", async () => {
  const { server, claimStore } = application({});
  await withLoopback(server, async (listener) => {
    const token = await csrf(listener);
    const response = await post(listener, token);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(path);
    expect(claimStore).toHaveBeenCalledWith(owner, key, {
      policyVersion: policy.version,
      periodStart: period.start.toISOString(),
    });
  });
});

it.each([
  ["no confirmation", { confirm: "no" }],
  ["a malformed key", { key: "not-a-key" }],
  ["a malformed version", { policyVersion: "premium-unlimited" }],
  ["a malformed period", { periodStart: "soon" }],
])("ALLOW-06 refuses %s before reaching the store", async (_name, fields) => {
  const { server, claimStore } = application({});
  await withLoopback(server, async (listener) => {
    const response = await post(listener, await csrf(listener), fields);
    expect(response.status).toBe(422);
    expect(claimStore).not.toHaveBeenCalled();
  });
});

it("ALLOW-06 refuses an unexpected field and a query string", async () => {
  const { server, claimStore, member } = application({});
  await withLoopback(server, async (listener) => {
    const token = await csrf(listener);
    expect((await post(listener, token, { quantity: "100000" })).status).toBe(
      422,
    );
    expect(claimStore).not.toHaveBeenCalled();
    member.mockClear();
    expect((await get(listener, `${path}?quantity=9`)).status).toBe(422);
    expect(member).not.toHaveBeenCalled();
  });
});

it.each([
  ["denied", 403],
  ["invalid", 422],
  ["conflict", 409],
  ["unavailable", 503],
] as const)(
  "ALLOW-06 reports a %s claim without claiming success",
  async (kind, status) => {
    const { server } = application({ claim: async () => ({ kind }) });
    await withLoopback(server, async (listener) => {
      const response = await post(listener, await csrf(listener));
      expect(response.status).toBe(status);
      expect(response.text).not.toContain("Claimed");
    });
  },
);

it("ALLOW-03 tells a member a lost reply can be checked without risking a second allowance", async () => {
  const { server } = application({
    claim: async () => ({ kind: "unavailable" }),
  });
  await withLoopback(server, async (listener) => {
    const response = await post(listener, await csrf(listener));
    expect(response.text).toContain("may already have been saved");
    expect(response.text).toContain("never adds a second");
  });
});

it("ALLOW-06 withholds a read and a write outcome once authority has lapsed", async () => {
  const lapsed = performance.now() - 1;
  const { server, claimStore } = application({
    member: async () => ready(view().value, lapsed),
  });
  await withLoopback(server, async (listener) => {
    expect((await get(listener)).status).toBe(403);
  });
  const writing = application({ claim: async () => ready(claim, lapsed) });
  await withLoopback(writing.server, async (listener) => {
    const response = await post(listener, await csrf(listener));
    expect(response.status).toBe(503);
  });
  expect(claimStore).not.toHaveBeenCalled();
});

it("ALLOW-06 gives a safe answer when the store throws", async () => {
  const reading = application({
    member: async () => {
      throw Error("offline");
    },
  });
  await withLoopback(reading.server, async (listener) => {
    expect((await get(listener)).status).toBe(503);
  });
  const writing = application({
    claim: async () => {
      throw Error("offline");
    },
  });
  await withLoopback(writing.server, async (listener) => {
    const response = await post(listener, await csrf(listener));
    expect(response.status).toBe(503);
  });
});

it("ALLOW-06 has no route in live mode or without a store", async () => {
  const live = application({}, "live");
  await withLoopback(live.server, async (listener) => {
    expect((await get(listener)).status).toBe(404);
    expect(live.member).not.toHaveBeenCalled();
  });
  const absent = app(
    {
      session: vi.fn().mockResolvedValue({ kind: "anonymous" }),
    } as unknown as Store,
    {
      origin: "http://127.0.0.1:3000",
      secret: "synthetic-route-test",
      mode: "test",
    } as Parameters<typeof app>[1],
  );
  await withLoopback(absent, async (listener) => {
    expect((await get(listener)).status).toBe(404);
  });
});

it("ALLOW-06 denies a read the store refuses, without showing the policy", async () => {
  const { server } = application({ member: async () => ({ kind: "denied" }) });
  await withLoopback(server, async (listener) => {
    const response = await get(listener);
    expect(response.status).toBe(403);
    expect(response.text).not.toContain("study-allowance-test-v1");
  });
});
