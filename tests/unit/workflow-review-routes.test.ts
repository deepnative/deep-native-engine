import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { mountWorkflowReviewRoutes } from "../../src/workflow-review-routes.ts";
import type {
  WorkflowReviewStore,
  WorkflowReviewReceipt,
} from "../../src/workflow-review.ts";
import { withLoopback } from "../support/loopback-server.ts";

const receipt: WorkflowReviewReceipt = {
  requestId: "11111111-1111-4111-8111-111111111111",
  workflowId: "WF-001",
  workflowVersion: 1,
  instanceId: "22222222-2222-4222-8222-222222222222",
  revision: 1,
  expiresAt: "2026-10-07T10:00:00.000Z",
  createdAt: "2026-10-07T09:00:00.000Z",
  withdrawnAt: null,
  state: "pending",
};
it.each(["request", "withdraw"] as const)(
  "WFREV-05/06 committed member %s with expired response authority retains original manual recovery",
  async (kind) => {
    const operationId = "33333333-3333-4333-8333-333333333333";
    const committed = vi.fn().mockResolvedValue({
      kind: "applied",
      receipt,
      deadline: performance.now() - 1,
    });
    const port = { [kind]: committed } as unknown as WorkflowReviewStore;
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((_req, res, next) => {
      res.locals.token = "invented-member";
      res.locals.csrf = "invented-csrf";
      next();
    });
    mountWorkflowReviewRoutes(app, port);
    await withLoopback(app, async (server) => {
      const body = {
        csrf: "invented-csrf",
        operationId,
        confirm: "yes",
        ...(kind === "request"
          ? { checked: "original-checked-source" }
          : { requestId: receipt.requestId }),
      };
      const response = await request(server)
        .post(`/workflow-feedback/review/${kind}`)
        .type("form")
        .send(body);
      expect(response.status).toBe(503);
      expect(response.text).toContain(
        `name="operationId" value="${operationId}"`,
      );
      expect(response.text).toContain(
        'action="/workflow-feedback/review/inspect"',
      );
      expect(response.text).toContain(
        `action="/workflow-feedback/review/${kind}"`,
      );
      expect(response.text).not.toContain("data-request-id=");
      expect(response.text).not.toMatch(/type="checkbox"[^>]*checked/);
      expect(committed).toHaveBeenCalledTimes(1);
    });
  },
);

function fixture(missing = false) {
  const deadline = performance.now() + 60000;
  const port = {
    receipt: vi
      .fn<WorkflowReviewStore["receipt"]>()
      .mockResolvedValue({ kind: "ready", deadline, receipt }),
    history: vi.fn<WorkflowReviewStore["history"]>().mockResolvedValue({
      kind: "ready",
      deadline,
      receipts: [receipt],
      next: null,
    }),
    preview: vi.fn<WorkflowReviewStore["preview"]>().mockResolvedValue({
      kind: "ready",
      deadline,
      preview: {
        ...receipt,
        title: "Invented workflow",
        note: "Invented private note <script>",
        checked: "checked-source",
      },
    }),
    request: vi
      .fn<WorkflowReviewStore["request"]>()
      .mockResolvedValue({ kind: "applied", deadline, receipt }),
    withdraw: vi
      .fn<WorkflowReviewStore["withdraw"]>()
      .mockResolvedValue({ kind: "replayed", deadline, receipt }),
    inspect: vi
      .fn<WorkflowReviewStore["inspect"]>()
      .mockResolvedValue({ kind: "ready", deadline, receipt }),
  };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.token = "invented-member";
    res.locals.csrf = "invented-csrf";
    next();
  });
  mountWorkflowReviewRoutes(app, missing ? undefined : port);
  return { app, port };
}
const routes = [
  {
    method: "get",
    path: `/workflow-feedback/review/receipts/${receipt.requestId}`,
    operation: "receipt",
  },
  {
    method: "get",
    path: "/workflow-feedback/review/history",
    operation: "history",
  },
  {
    method: "get",
    path: "/workflow-feedback/WF-001/review",
    operation: "preview",
  },
  {
    method: "post",
    path: "/workflow-feedback/review/request",
    operation: "request",
  },
  {
    method: "post",
    path: "/workflow-feedback/review/inspect",
    operation: "inspect",
  },
  {
    method: "post",
    path: "/workflow-feedback/review/withdraw",
    operation: "withdraw",
  },
] as const;
const validBody = (operation: string) => ({
  csrf: "invented-csrf",
  operationId: "33333333-3333-4333-8333-333333333333",
  ...(operation === "inspect"
    ? {}
    : {
        confirm: "yes",
        ...(operation === "request"
          ? { checked: "checked-source" }
          : { requestId: receipt.requestId }),
      }),
});
it.each(routes)(
  "WFREV member $operation displays only its successful scoped result",
  async ({ method, path, operation }) => {
    const f = fixture();
    await withLoopback(f.app, async (server) => {
      const result = await (
        method === "get"
          ? request(server).get(path)
          : request(server).post(path).type("form").send(validBody(operation))
      ).expect(200);
      expect(f.port[operation]).toHaveBeenCalledTimes(1);
      if (operation === "preview") {
        expect(result.text).toContain("Invented private note &lt;script&gt;");
        expect(result.text).not.toMatch(/type="checkbox"[^>]*checked/);
      } else expect(result.text).not.toContain("Invented private note");
    });
  },
);
it.each(routes)(
  "WFREV member $operation reports absent feature as unavailable",
  async ({ method, path, operation }) => {
    const f = fixture(true);
    await withLoopback(f.app, async (server) => {
      await (
        method === "get"
          ? request(server).get(path)
          : request(server).post(path).type("form").send(validBody(operation))
      ).expect(503);
      expect(f.port[operation]).not.toHaveBeenCalled();
    });
  },
);
it.each(
  routes.flatMap((route) =>
    (["denied", "invalid", "conflict", "unavailable"] as const).map((kind) => ({
      ...route,
      kind,
    })),
  ),
)(
  "WFREV member $operation reports $kind without a private receipt",
  async ({ method, path, operation, kind }) => {
    const f = fixture();
    f.port[operation].mockResolvedValue({ kind });
    await withLoopback(f.app, async (server) => {
      const response = await (
        method === "get"
          ? request(server).get(path)
          : request(server).post(path).type("form").send(validBody(operation))
      ).expect(
        { denied: 403, invalid: 422, conflict: 409, unavailable: 503 }[kind],
      );
      expect(response.text).not.toContain("data-request-id=");
      expect(response.text).not.toContain("Invented private note");
    });
  },
);
it.each(["request", "inspect", "withdraw"] as const)(
  "WFREV member %s rejects malformed forms before dispatch",
  async (operation) => {
    const f = fixture();
    await withLoopback(f.app, async (server) => {
      for (const body of [
        null,
        [],
        { unexpected: "field" },
        { ...validBody(operation), operationId: 7 },
        { ...validBody(operation), extra: "field" },
      ]) {
        await request(server)
          .post(`/workflow-feedback/review/${operation}`)
          .set("Content-Type", "application/json")
          .send(JSON.stringify(body))
          .expect(body === null ? 400 : 422);
      }
      expect(f.port[operation]).not.toHaveBeenCalled();
    });
  },
);
it("WFREV member history accepts an opaque cursor and rejects unknown or repeated query fields", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    await request(server)
      .get("/workflow-feedback/review/history?cursor=opaque")
      .expect(200);
    expect(f.port.history).toHaveBeenCalledWith("invented-member", "opaque");
    await request(server)
      .get("/workflow-feedback/review/history?other=x")
      .expect(422);
    await request(server)
      .get("/workflow-feedback/review/history?cursor=x&cursor=y")
      .expect(422);
    expect(f.port.history).toHaveBeenCalledTimes(1);
  });
});
it("WFREV-06 empty inspection never asserts noncommit or dispatches another write", async () => {
  const f = fixture();
  f.port.inspect.mockResolvedValue({
    kind: "ready",
    deadline: performance.now() + 60000,
    receipt: null,
  });
  await withLoopback(f.app, async (server) => {
    const response = await request(server)
      .post("/workflow-feedback/review/inspect")
      .type("form")
      .send(validBody("inspect"))
      .expect(200);
    expect(response.text).toContain(
      "does not prove an earlier write did not commit",
    );
    expect(f.port.request).not.toHaveBeenCalled();
    expect(f.port.withdraw).not.toHaveBeenCalled();
  });
});
it.each(["before", "during"] as const)(
  "WFREV-05 private preview expiry %s rendering withholds text",
  async (boundary) => {
    const f = fixture();
    f.port.preview.mockResolvedValue({
      kind: "ready",
      deadline: 10,
      preview: {
        ...receipt,
        title: "Invented workflow",
        note: "Private withheld note",
        checked: "checked",
      },
    });
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(boundary === "before" ? 11 : 9)
      .mockReturnValue(11);
    try {
      await withLoopback(f.app, async (server) => {
        const response = await request(server)
          .get("/workflow-feedback/WF-001/review")
          .expect(403);
        expect(response.text).not.toContain("Private withheld note");
      });
    } finally {
      clock.mockRestore();
    }
  },
);
it.each(["request", "withdraw"] as const)(
  "WFREV-05 committed member %s expiry during rendering preserves manual recovery",
  async (operation) => {
    const f = fixture();
    f.port[operation].mockResolvedValue({
      kind: "applied",
      deadline: 10,
      receipt,
    });
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(9)
      .mockReturnValue(11);
    try {
      await withLoopback(f.app, async (server) => {
        const result = await request(server)
          .post(`/workflow-feedback/review/${operation}`)
          .type("form")
          .send(validBody(operation))
          .expect(503);
        expect(result.text).toContain(
          'action="/workflow-feedback/review/inspect"',
        );
        expect(result.text).not.toContain("data-request-id=");
      });
    } finally {
      clock.mockRestore();
    }
  },
);
