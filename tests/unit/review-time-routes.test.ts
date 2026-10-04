import express from "express";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
const servers: Server[] = [];
async function http(application: ReturnType<typeof express>) {
  const server = await listenLoopback(application);
  servers.push(server);
  return request(server);
}
afterEach(async () => {
  for (const server of servers.splice(0)) await closeLoopback(server);
});
import { mountReviewTimeRoutes } from "../../src/review-time-routes.ts";
import type { reviewTimeStore } from "../../src/review-time-store.ts";
import type { SampleFeedbackStore } from "../../src/sample-feedback.ts";
const id = "11111111-1111-4111-8111-111111111111";
it("keeps a paused owner's receipt and cancellation usable without exposing allocation controls", async () => {
  const receipt = {
    allocationId: id,
    state: "allocated",
    held: 20,
    consumed: 0,
    released: 0,
    sourceAvailable: true,
  };
  const store = {
    receipt: vi.fn().mockResolvedValue({ kind: "applied", receipt }),
    cancel: vi.fn().mockResolvedValue({ kind: "applied", receipt }),
    allocate: vi.fn(),
  } as unknown as ReturnType<typeof reviewTimeStore>;
  const feedback = {
    owner: vi.fn().mockResolvedValue({ kind: "ready" }),
  } as unknown as SampleFeedbackStore;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.token = "owner-token";
    res.locals.csrf = "csrf-value";
    next();
  });
  mountReviewTimeRoutes(app, store, feedback, false);
  const form = await (await http(app)).get(`/evidence/${id}/review-allocation`);
  expect(form.status).toBe(200);
  expect(form.text).toContain("allocations are paused");
  expect(form.text).not.toContain('name="ceiling"');
  const read = await (await http(app)).get(`/review-minutes/${id}`);
  expect(read.status).toBe(200);
  expect(read.text).toContain("Cancel unused allocation");
  expect(store.receipt).toHaveBeenCalledWith("owner-token", id);
  const cancel = await (await http(app)).post(`/review-minutes/${id}/cancel`);
  expect(cancel.status).toBe(303);
  expect(cancel.headers.location).toBe(`/review-minutes/${id}`);
  expect(store.cancel).toHaveBeenCalledWith("owner-token", id);
  expect(store.allocate).not.toHaveBeenCalled();
});

it.each(["returned", "thrown"])(
  "preserves an uncertain %s allocation for explicit same-key reconciliation",
  async (failure) => {
    const allocate = vi.fn();
    if (failure === "returned")
      allocate.mockResolvedValue({ kind: "unavailable" });
    else allocate.mockRejectedValue(Error("private driver diagnostic"));
    const store = { allocate } as unknown as ReturnType<typeof reviewTimeStore>;
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((_req, res, next) => {
      res.locals.token = "owner-token";
      res.locals.csrf = "fresh-csrf";
      next();
    });
    mountReviewTimeRoutes(app, store, {} as SampleFeedbackStore, true);
    const response = await (
      await http(app)
    )
      .post(`/evidence/${id}/review-allocation`)
      .type("form")
      .send({ operationId: id, ceiling: "20" });
    expect(response.status).toBe(503);
    expect(response.text).toContain(`name="operationId" value="${id}"`);
    expect(response.text).toContain('name="ceiling" value="20"');
    expect(response.text).toContain("Reconcile this same allocation");
    expect(response.text).toContain('href="/review-minutes"');
    expect(response.text).not.toContain("private driver diagnostic");
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(allocate).toHaveBeenCalledWith("owner-token", id, id, 20);
  },
);

function routeFixture() {
  const receipt = {
    allocationId: id,
    state: "allocated",
    held: 20,
    consumed: 0,
    released: 0,
    sourceAvailable: true,
  };
  const store = {
    allocate: vi.fn().mockResolvedValue({ kind: "applied", receipt }),
    receipt: vi.fn().mockResolvedValue({ kind: "applied", receipt }),
    cancel: vi.fn().mockResolvedValue({ kind: "applied", receipt }),
    history: vi
      .fn()
      .mockResolvedValue({ kind: "ready", receipts: [], next: null }),
  };
  const feedback = { owner: vi.fn().mockResolvedValue({ kind: "ready" }) };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.token = "owner";
    res.locals.csrf = "csrf";
    next();
  });
  mountReviewTimeRoutes(
    app,
    store as unknown as ReturnType<typeof reviewTimeStore>,
    feedback as unknown as SampleFeedbackStore,
    true,
  );
  return { app, store, feedback, receipt };
}
it("offers explicit bounded allocation and redirects successful and replayed requests to the same receipt", async () => {
  const f = routeFixture();
  const page = await (
    await http(f.app)
  ).get(`/evidence/${id}/review-allocation`);
  expect(page.status).toBe(200);
  expect(page.text).toContain('min="1" max="120"');
  for (const kind of ["applied", "replayed"]) {
    f.store.allocate.mockResolvedValue({ kind, receipt: f.receipt });
    const result = await (
      await http(f.app)
    )
      .post(`/evidence/${id}/review-allocation`)
      .send({ operationId: id, ceiling: "20" });
    expect(result.status).toBe(303);
    expect(result.headers.location).toBe(`/review-minutes/${id}`);
  }
});
it.each([
  {},
  { operationId: 1, ceiling: "20" },
  { operationId: "bad", ceiling: "20" },
  { operationId: id, ceiling: 20 },
  { operationId: id, ceiling: "0" },
  { operationId: id, ceiling: "1.5" },
  { operationId: id, ceiling: ["20"] },
])("rejects malformed allocation without a write: %j", async (body) => {
  const f = routeFixture();
  expect(
    (
      await (
        await http(f.app)
      )
        .post(`/evidence/${id}/review-allocation`)
        .send(body)
    ).status,
  ).toBe(404);
  expect(f.store.allocate).not.toHaveBeenCalled();
});
it.each(["denied", "conflict", "insufficient", "unavailable"])(
  "maps %s allocation failures without inventing a receipt",
  async (kind) => {
    const f = routeFixture();
    f.store.allocate.mockResolvedValue({ kind } as never);
    const result = await (
      await http(f.app)
    )
      .post(`/evidence/${id}/review-allocation`)
      .send({ operationId: id, ceiling: "20" });
    expect(result.status).toBe(
      kind === "denied" ? 404 : kind === "unavailable" ? 503 : 409,
    );
    expect(result.headers.location).toBeUndefined();
    expect(result.text.includes("Reconcile this same allocation")).toBe(
      kind === "unavailable",
    );
  },
);
it.each(["receipt", "cancel"] as const)(
  "handles unavailable and denied %s without exposing records",
  async (method) => {
    const f = routeFixture();
    for (const kind of ["denied", "unavailable"]) {
      f.store[method].mockResolvedValue({ kind } as never);
      const result =
        method === "receipt"
          ? await (await http(f.app)).get(`/review-minutes/${id}`)
          : await (await http(f.app)).post(`/review-minutes/${id}/cancel`);
      expect(result.status).toBe(kind === "denied" ? 404 : 503);
      expect(result.text).not.toContain("Reserved</dt>");
    }
  },
);
it("does not offer cancellation for completed or reconciliation receipts and labels erased sources", async () => {
  const f = routeFixture();
  for (const state of ["completed", "needs_reconciliation"]) {
    f.store.receipt.mockResolvedValue({
      kind: "applied",
      receipt: { ...f.receipt, state, sourceAvailable: false },
    });
    const result = await (await http(f.app)).get(`/review-minutes/${id}`);
    expect(result.status).toBe(200);
    expect(result.text).not.toContain("Cancel unused allocation");
    expect(result.text).toContain("accounting metadata only");
  }
});
it("renders owned history and a continuation without accepting foreign filters", async () => {
  const f = routeFixture();
  let result = await (await http(f.app)).get("/review-minutes");
  expect(result.text).toContain("No review allocations yet");
  f.store.history.mockResolvedValue({
    kind: "ready",
    receipts: [f.receipt],
    next: id,
  } as never);
  result = await (await http(f.app)).get(`/review-minutes?after=${id}`);
  expect(result.status).toBe(200);
  expect(result.text).toContain("Next receipts");
  expect(result.text).toContain("consumed 0, returned 0");
  expect(f.store.history).toHaveBeenLastCalledWith("owner", id);
  for (const query of ["member=foreign", "after=a&after=b"]) {
    const denied = await (await http(f.app)).get(`/review-minutes?${query}`);
    expect(denied.status).toBe(404);
  }
  f.store.history.mockResolvedValue({ kind: "denied" } as never);
  expect((await (await http(f.app)).get("/review-minutes")).status).toBe(404);
});
it("withholds allocation forms when the source is denied and hides thrown read diagnostics", async () => {
  const f = routeFixture();
  f.feedback.owner.mockResolvedValue({ kind: "denied" });
  expect(
    (await (await http(f.app)).get(`/evidence/${id}/review-allocation`)).status,
  ).toBe(404);
  f.store.receipt.mockRejectedValue(Error("private source text"));
  const result = await (await http(f.app)).get(`/review-minutes/${id}`);
  expect(result.status).toBe(503);
  expect(result.text).not.toContain("private source text");
  expect(result.text).not.toContain("Reconcile this same allocation");
});
