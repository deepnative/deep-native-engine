import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { mountWorkflowReviewStaffRoutes } from "../../src/workflow-review-staff-routes.ts";
import type {
  WorkflowReviewStaffStore,
  WorkflowReviewGrant,
} from "../../src/workflow-review-staff.ts";
import { csrf } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
const token = "a".repeat(64),
  secret = "invented-workflow-staff-route-secret",
  origin = "http://localhost";
const id = "11111111-1111-4111-8111-111111111111",
  moderatorId = "22222222-2222-4222-8222-222222222222",
  operationId = "33333333-3333-4333-8333-333333333333";
const startsAt = "2026-10-07T09:00:00.000Z",
  expiresAt = "2026-10-07T10:00:00.000Z";
const grant = {
  grantId: id,
  requestId: id,
  moderatorId,
  startsAt,
  expiresAt,
  revokedAt: null,
  state: "recorded",
} as const satisfies WorkflowReviewGrant;
const base = "/operator/workflow-reviews",
  read = "/moderate/workflow-reviews";
function fixture(
  options: {
    missing?: boolean;
    mode?: "test" | "live";
    localStaffEntry?: boolean;
  } = {},
) {
  const deadline = performance.now() + 60000;
  const port = {
    entry: vi.fn<WorkflowReviewStaffStore["entry"]>().mockResolvedValue({
      kind: "ready",
      deadline,
      actorId: moderatorId,
      startsAt,
      endsAt: expiresAt,
      expiresAt,
      enabled: true,
    }),
    check: vi.fn<WorkflowReviewStaffStore["check"]>().mockResolvedValue({
      kind: "ready",
      deadline,
      requestId: id,
      moderatorId,
      workflowId: "WF-001",
      workflowVersion: 1,
      revision: 1,
      startsAt,
      expiresAt,
      checked: "fixed-checked-instruction",
    }),
    assign: vi
      .fn<WorkflowReviewStaffStore["assign"]>()
      .mockResolvedValue({ kind: "applied", deadline, grant }),
    revoke: vi.fn<WorkflowReviewStaffStore["revoke"]>().mockResolvedValue({
      kind: "replayed",
      deadline,
      grant: { ...grant, revokedAt: startsAt },
    }),
    receipt: vi.fn<WorkflowReviewStaffStore["receipt"]>().mockResolvedValue({
      kind: "ready",
      deadline,
      grant: { ...grant, state: "scheduled" },
    }),
    inspect: vi
      .fn<WorkflowReviewStaffStore["inspect"]>()
      .mockResolvedValue({ kind: "ready", deadline, grant }),
    list: vi.fn<WorkflowReviewStaffStore["list"]>().mockResolvedValue({
      kind: "ready",
      deadline,
      entries: [
        {
          grantId: id,
          workflowId: "WF-001",
          workflowVersion: 1,
          revision: 1,
          startsAt,
          expiresAt,
        },
      ],
      next: "opaque + / continuation",
    }),
    read: vi.fn<WorkflowReviewStaffStore["read"]>().mockResolvedValue({
      kind: "ready",
      deadline,
      workflowId: "WF-001",
      workflowVersion: 1,
      revision: 1,
      startsAt,
      expiresAt,
      note: "Invented private note <script>",
    }),
  };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  mountWorkflowReviewStaffRoutes(app, options.missing ? undefined : port, {
    origin,
    secret,
    mode: "test",
    localStaffEntry: true,
    ...options,
  });
  return { app, port };
}
const routes = [
  { method: "get", path: base, operation: "entry" },
  {
    method: "get",
    path: "/moderate/workflow-review-reference",
    operation: "entry",
  },
  { method: "post", path: `${base}/check`, operation: "check" },
  { method: "post", path: `${base}/assign`, operation: "assign" },
  { method: "post", path: `${base}/revoke`, operation: "revoke" },
  { method: "post", path: `${base}/inspect`, operation: "inspect" },
  { method: "get", path: `${base}/receipts/${id}`, operation: "receipt" },
  { method: "get", path: read, operation: "list" },
  { method: "get", path: `${read}/${id}`, operation: "read" },
] as const;
const body = (operation: string) => ({
  csrf: csrf(token, secret),
  ...(operation === "check"
    ? { requestId: id, moderatorId, startsAt, expiresAt }
    : operation === "inspect"
      ? { operationId }
      : {
          operationId,
          confirm: "yes",
          ...(operation === "assign"
            ? { checked: "fixed-checked-instruction" }
            : { grantId: id }),
        }),
});
function call(
  server: Parameters<typeof request>[0],
  route: (typeof routes)[number],
) {
  const r =
    route.method === "get"
      ? request(server).get(route.path)
      : request(server)
          .post(route.path)
          .set("Origin", origin)
          .type("form")
          .send(body(route.operation));
  return r.set("Host", "localhost").set("Cookie", `dne_staff=${token}`);
}
it.each(routes)(
  "WFREV staff $operation route $path shows scoped success without sharing a directory",
  async (route) => {
    const f = fixture();
    await withLoopback(f.app, async (server) => {
      const result = await call(server, route).expect(200);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(f.port[route.operation]).toHaveBeenCalledTimes(1);
      if (route.operation === "read")
        expect(result.text).toContain("Invented private note &lt;script&gt;");
      else expect(result.text).not.toContain("Invented private note");
      if (route.operation === "list")
        expect(result.text).toContain(
          encodeURIComponent("opaque + / continuation"),
        );
      expect(result.text).not.toMatch(/type="checkbox"[^>]*checked/);
    });
  },
);
it.each(
  routes.flatMap((route) =>
    ["denied", "invalid", "conflict", "unavailable"].map((kind) => ({
      ...route,
      kind: kind as "denied" | "invalid" | "conflict" | "unavailable",
    })),
  ),
)("WFREV staff $operation $kind handback withholds content", async (route) => {
  const f = fixture();
  f.port[route.operation].mockResolvedValue({ kind: route.kind });
  await withLoopback(f.app, async (server) => {
    const result = await call(server, route).expect(
      { denied: 403, invalid: 422, conflict: 409, unavailable: 503 }[
        route.kind
      ],
    );
    expect(result.text).not.toContain("data-grant-id=");
    expect(result.text).not.toContain("Invented private note");
    if (
      route.kind === "unavailable" &&
      ["assign", "revoke"].includes(route.operation)
    ) {
      expect(result.text).toContain(
        `name="operationId" value="${operationId}"`,
      );
      expect(result.text).toContain(`action="${base}/inspect"`);
      expect(result.text).toContain(`action="${base}/${route.operation}"`);
    }
  });
});
it.each([
  { missing: true },
  { localStaffEntry: false },
  { mode: "live" as const },
])(
  "WFREV-08 disabled or live staff feature %j never dispatches",
  async (options) => {
    const f = fixture(options);
    await withLoopback(f.app, async (server) => {
      for (const route of routes) {
        await call(server, route).expect(404);
        expect(f.port[route.operation]).not.toHaveBeenCalled();
      }
    });
  },
);
it.each([
  undefined,
  "dne_staff=invalid",
  "dne_staff=signed-out",
  `dne_staff=${token}; dne_staff=${token}`,
  "dne_staff=%zz",
])(
  "WFREV-03 selected credential %s denies before staff dispatch",
  async (cookie) => {
    const f = fixture();
    await withLoopback(f.app, async (server) => {
      let r = request(server).get(read).set("Host", "localhost");
      if (cookie) r = r.set("Cookie", cookie);
      await r.expect(403);
      expect(f.port.list).not.toHaveBeenCalled();
    });
  },
);
it("WFREV-08 wrong Host or Origin, missing CSRF and JSON writes deny without mutation", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    await request(server)
      .get(base)
      .set("Host", "other.invalid")
      .set("Cookie", `dne_staff=${token}`)
      .expect(403);
    for (const setup of ["origin", "csrf", "json"]) {
      let r = request(server)
        .post(`${base}/assign`)
        .set("Host", "localhost")
        .set("Cookie", `dne_staff=${token}`)
        .set("Origin", setup === "origin" ? "http://other.invalid" : origin);
      r =
        setup === "json"
          ? r.send(body("assign"))
          : r.type("form").send({
              ...body("assign"),
              ...(setup === "csrf" ? { csrf: "wrong" } : {}),
            });
      await r.expect(403);
    }
    expect(f.port.entry).not.toHaveBeenCalled();
    expect(f.port.assign).not.toHaveBeenCalled();
  });
});
it.each(["check", "assign", "revoke", "inspect"] as const)(
  "WFREV staff %s malformed forms never dispatch",
  async (operation) => {
    const f = fixture();
    await withLoopback(f.app, async (server) => {
      for (const values of [
        { csrf: csrf(token, secret) },
        { ...body(operation), extra: "unknown" },
        { ...body(operation), operationId: ["x", "y"] },
      ]) {
        await request(server)
          .post(`${base}/${operation}`)
          .set("Host", "localhost")
          .set("Cookie", `dne_staff=${token}`)
          .set("Origin", origin)
          .type("form")
          .send(values)
          .expect(422);
      }
      expect(f.port[operation]).not.toHaveBeenCalled();
    });
  },
);
it("WFREV-02 reference-only check still generates a freshly checked finite interval", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    await request(server)
      .post(`${base}/check`)
      .set("Host", "localhost")
      .set("Cookie", `dne_staff=${token}`)
      .set("Origin", origin)
      .type("form")
      .send({ csrf: csrf(token, secret), requestId: id, moderatorId })
      .expect(200);
    expect(f.port.check).toHaveBeenCalledWith(
      token,
      id,
      moderatorId,
      undefined,
    );
  });
});
it("WFREV-07 empty worklist and original inspection do not assert a write never committed", async () => {
  const f = fixture(),
    deadline = performance.now() + 60000;
  f.port.list.mockResolvedValue({
    kind: "ready",
    deadline,
    entries: [],
    next: null,
  });
  f.port.inspect.mockResolvedValue({ kind: "ready", deadline, grant: null });
  await withLoopback(f.app, async (server) => {
    const list = await call(server, routes[7]).expect(200);
    expect(list.text).toContain("No currently permitted exact assignments");
    const inspect = await call(server, routes[5]).expect(200);
    expect(inspect.text).toContain("does not prove the write was uncommitted");
    expect(f.port.assign).not.toHaveBeenCalled();
    expect(f.port.revoke).not.toHaveBeenCalled();
    await request(server)
      .get(`${read}?cursor=opaque`)
      .set("Host", "localhost")
      .set("Cookie", `dne_staff=${token}`)
      .expect(200);
    expect(f.port.list).toHaveBeenLastCalledWith(token, "opaque");
    for (const query of ["other=x", "cursor=x&cursor=y"])
      await request(server)
        .get(`${read}?${query}`)
        .set("Host", "localhost")
        .set("Cookie", `dne_staff=${token}`)
        .expect(422);
    expect(f.port.list).toHaveBeenCalledTimes(2);
  });
});
it("WFREV-08 paused new assignments preserves administrator recovery and revocation controls", async () => {
  const f = fixture();
  f.port.entry.mockResolvedValue({
    kind: "ready",
    deadline: performance.now() + 60000,
    actorId: moderatorId,
    startsAt,
    endsAt: expiresAt,
    expiresAt,
    enabled: false,
  });
  await withLoopback(f.app, async (server) => {
    const r = await call(server, routes[0]).expect(200);
    expect(r.text).toContain("assignments are paused");
    expect(r.text).not.toContain(`action="${base}/check"`);
    expect(r.text).toContain(`action="${base}/revoke"`);
    expect(r.text).toContain(`action="${base}/inspect"`);
  });
});
it.each(["assign", "revoke"] as const)(
  "WFREV-05 committed staff %s expiry retains manual original instruction",
  async (operation) => {
    const f = fixture();
    f.port[operation].mockResolvedValue({
      kind: "applied",
      deadline: performance.now() - 1,
      grant,
    });
    await withLoopback(f.app, async (server) => {
      const route = routes.find((r) => r.operation === operation)!;
      const result = await call(server, route).expect(503);
      expect(result.text).toContain(
        `name="operationId" value="${operationId}"`,
      );
      expect(result.text).not.toContain("data-grant-id=");
    });
  },
);
it.each(["before", "during"] as const)(
  "WFREV-05 permitted note expiry %s rendering withholds private text",
  async (boundary) => {
    const f = fixture();
    f.port.read.mockResolvedValue({
      kind: "ready",
      deadline: 10,
      workflowId: "WF-001",
      workflowVersion: 1,
      revision: 1,
      startsAt,
      expiresAt,
      note: "Private withheld note",
    });
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(boundary === "before" ? 11 : 9)
      .mockReturnValue(11);
    try {
      await withLoopback(f.app, async (server) => {
        const result = await call(server, routes[8]).expect(403);
        expect(result.text).not.toContain("Private withheld note");
      });
    } finally {
      clock.mockRestore();
    }
  },
);
it.each(["assign", "revoke"] as const)(
  "WFREV-05 committed staff %s authority expiring during rendering retains original key",
  async (operation) => {
    const f = fixture();
    f.port[operation].mockResolvedValue({
      kind: "applied",
      deadline: 10,
      grant,
    });
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(9)
      .mockReturnValue(11);
    try {
      await withLoopback(f.app, async (server) => {
        const result = await call(
          server,
          routes.find((r) => r.operation === operation)!,
        ).expect(503);
        expect(result.text).toContain(
          `name="operationId" value="${operationId}"`,
        );
        expect(result.text).not.toContain("data-grant-id=");
      });
    } finally {
      clock.mockRestore();
    }
  },
);
it.each([null, startsAt])(
  "WFREV-06 legacy receipt without projected state remains truthful about revocation %s",
  async (revokedAt) => {
    const f = fixture();
    const { state: _state, ...legacy } = grant;
    void _state;
    f.port.revoke.mockResolvedValue({
      kind: "replayed",
      deadline: performance.now() + 60000,
      grant: { ...legacy, revokedAt },
    });
    await withLoopback(f.app, async (server) => {
      const response = await call(server, routes[4]).expect(200);
      expect(response.text).toContain(
        `Assignment status: ${revokedAt ? "revoked" : "recorded"}`,
      );
    });
  },
);
it.each([
  { operation: "assign", change: { checked: "x".repeat(2049) } },
  { operation: "assign", change: { operationId: "not-original-key" } },
  { operation: "revoke", change: { operationId: "not-original-key" } },
  { operation: "revoke", change: { grantId: "not-grant" } },
] as const)(
  "WFREV-06 $operation does not reflect an unbounded or malformed recovery instruction",
  async ({ operation, change }) => {
    const f = fixture();
    f.port[operation].mockResolvedValue({ kind: "unavailable" });
    await withLoopback(f.app, async (server) => {
      const response = await request(server)
        .post(`${base}/${operation}`)
        .set("Host", "localhost")
        .set("Origin", origin)
        .set("Cookie", `dne_staff=${token}`)
        .type("form")
        .send({ ...body(operation), ...change })
        .expect(503);
      expect(response.text).not.toContain(`action="${base}/inspect"`);
      expect(response.text).not.toContain('name="checked"');
    });
  },
);
