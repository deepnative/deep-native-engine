import express from "express";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { mountCircleGrantRoutes } from "../../src/circle-grant-routes.ts";
import { CIRCLES } from "../../src/circles.ts";
import type {
  CircleGrantAdminStore,
  CircleGrantResult,
  RetainedCircleGrant,
} from "../../src/circle-grant-values.ts";
import { withLoopback } from "../support/loopback-server.ts";

const base = "/operator/circle-grants";
const reference = "/moderate/circle-reference";
const token = "b".repeat(64);
const staffId = "22222222-2222-4222-8222-222222222222";
const grantId = "33333333-3333-4333-8333-333333333333";
const key = "44444444-4444-4444-8444-444444444444";
const circleId = CIRCLES[0]!.id;
const at = new Date("2026-10-06T12:00:00.000Z");
const expiresAt = "2026-10-07T12:00:00.000Z";
const scope = { staffId, circleId };
const record: RetainedCircleGrant = {
  ...scope,
  source: "retained",
  grantId,
  role: "moderator",
  purpose: "circle-discussion-test-v1",
  createdBy: staffId,
  startsAt: at,
  createdAt: at,
  expiresAt: new Date(expiresAt),
  revokedAt: null,
  state: "current",
};
function ready<T>(value: T): CircleGrantResult<T> {
  return {
    kind: "ready",
    value,
    observedAt: at,
    deadline: performance.now() + 60000,
  };
}
function fixture(
  options: Parameters<typeof mountCircleGrantRoutes>[2] = {},
  missing = false,
) {
  const port = {
    admin: vi.fn<CircleGrantAdminStore["admin"]>().mockResolvedValue(
      ready({
        reference: {
          staffId,
          role: "platform_admin",
          expiresAt: new Date(expiresAt),
        },
        creationEnabled: true,
      }),
    ),
    reference: vi
      .fn<CircleGrantAdminStore["reference"]>()
      .mockResolvedValue(
        ready({ staffId, role: "moderator", expiresAt: new Date(expiresAt) }),
      ),
    check: vi.fn<CircleGrantAdminStore["check"]>().mockResolvedValue(
      ready({
        ...scope,
        role: "moderator",
        expiresAt: new Date(expiresAt),
        creationEnabled: true,
      }),
    ),
    create: vi
      .fn<CircleGrantAdminStore["create"]>()
      .mockResolvedValue(ready(record)),
    inspect: vi
      .fn<CircleGrantAdminStore["inspect"]>()
      .mockResolvedValue(ready(record)),
    history: vi
      .fn<CircleGrantAdminStore["history"]>()
      .mockResolvedValue(
        ready({ ...scope, observedAt: at, items: [record], nextCursor: null }),
      ),
    revoke: vi
      .fn<CircleGrantAdminStore["revoke"]>()
      .mockResolvedValue(ready({ ...record, revokedAt: at, state: "revoked" })),
  };
  // This isolated mount tests its own boundary. Real app Host/Origin/CSRF
  // enforcement is exercised separately through the integration server.
  const application = express();
  application.use(express.json());
  application.use(express.urlencoded({ extended: false }));
  application.use((_req, res, next) => {
    res.locals.csrf = "invented-selected-csrf";
    next();
  });
  mountCircleGrantRoutes(application, missing ? undefined : port, {
    localStaffEntry: true,
    localCircleAdmin: true,
    circleDiscussionEnabled: true,
    mode: "test",
    ...options,
  });
  return { application, port };
}
const payload = () => ({
  ...scope,
  idempotencyKey: key,
  expiresAt,
  confirm: "yes",
  csrf: "invented-selected-csrf",
});
afterEach(() => vi.restoreAllMocks());

it.each([{ localStaffEntry: false }, { mode: "live" as const }])(
  "CIRADM-08 absent local capability %j never calls a store",
  async (options) => {
    const f = fixture(options);
    await withLoopback(f.application, (s) =>
      request(s).get(base).set("Cookie", `dne_staff=${token}`).expect(404),
    );
    expect(f.port.admin).not.toHaveBeenCalled();
  },
);
it("CIRADM-08 absent store cannot expose either route family", async () => {
  const f = fixture({}, true);
  await withLoopback(f.application, async (s) => {
    for (const path of [base, reference])
      await request(s)
        .get(path)
        .set("Cookie", `dne_staff=${token}`)
        .expect(404);
  });
});
it.each([
  "",
  `dne_session=${token}`,
  "dne_staff=signed-out",
  "dne_staff=bad",
  `dne_staff=${token}; dne_staff=${token}`,
])(
  "CIRADM-05 raw selected cookie %s cannot fall back to legacy authority",
  async (cookie) => {
    const f = fixture();
    await withLoopback(f.application, (s) =>
      request(s).get(base).set("Cookie", cookie).expect(403),
    );
    expect(f.port.admin).not.toHaveBeenCalled();
  },
);
it("CIRADM-01 selected reference and admin home show no credential and propagate CSRF", async () => {
  const f = fixture();
  await withLoopback(f.application, async (s) => {
    const home = await request(s)
      .get(base)
      .set("Cookie", `dne_staff=${token}`)
      .expect(200);
    expect(home.text).toContain("invented-selected-csrf");
    expect(home.text).not.toContain(token);
    const own = await request(s)
      .get(reference)
      .set("Cookie", `dne_staff=${token}`)
      .expect(200);
    expect(own.text).toContain(staffId);
    expect(own.text).not.toContain(token);
  });
  expect(f.port.admin).toHaveBeenCalledWith(token);
  expect(f.port.reference).toHaveBeenCalledWith(token);
});
it.each([base, reference])(
  "CIRADM-05 GET %s refuses client authority/query fields",
  async (path) => {
    const f = fixture();
    await withLoopback(f.application, (s) =>
      request(s)
        .get(path + "?role=platform_admin")
        .set("Cookie", `dne_staff=${token}`)
        .expect(422),
    );
    expect(f.port.admin).not.toHaveBeenCalled();
    expect(f.port.reference).not.toHaveBeenCalled();
  },
);
it.each([staffId, "self"])(
  "CIRADM-01 exact check %s returns unchecked fixed-purpose confirmation",
  async (target) => {
    const f = fixture();
    const r = await withLoopback(f.application, (s) =>
      request(s)
        .post(base + "/check")
        .set("Cookie", `dne_staff=${token}`)
        .send({ staffId: target, circleId, csrf: "invented-selected-csrf" })
        .expect(200),
    );
    expect(f.port.check).toHaveBeenCalledWith(token, target, circleId);
    expect(r.text).toContain("circle-discussion-test-v1");
    expect(r.text).not.toMatch(/type="checkbox"[^>]*\bchecked\b/);
  },
);
it.each([
  { staffId: "bad", circleId },
  { staffId, circleId: "foreign" },
  { staffId, circleId, role: "platform_admin" },
  { staffId: [staffId, staffId], circleId },
])(
  "CIRADM-05 invalid exact check %j never reaches privileged lookup",
  async (body) => {
    const f = fixture();
    await withLoopback(f.application, (s) =>
      request(s)
        .post(base + "/check")
        .set("Cookie", `dne_staff=${token}`)
        .send(body)
        .expect(422),
    );
    expect(f.port.check).not.toHaveBeenCalled();
  },
);
it("CIRADM-02 confirmed creation passes only exact immutable instruction", async () => {
  const f = fixture();
  const r = await withLoopback(f.application, (s) =>
    request(s)
      .post(base + "/create")
      .set("Cookie", `dne_staff=${token}`)
      .send(payload())
      .expect(200),
  );
  expect(f.port.create).toHaveBeenCalledExactlyOnceWith(token, {
    ...scope,
    idempotencyKey: key,
    expiresAt: new Date(expiresAt),
  });
  expect(r.text).toContain(key);
  expect(r.text).toContain(grantId);
  expect(r.text).not.toContain(token);
});
it.each([{ confirm: "no" }, { confirm: "" }])(
  "CIRADM-02 unchecked %j never creates",
  async (changes) => {
    const f = fixture();
    await withLoopback(f.application, (s) =>
      request(s)
        .post(base + "/create")
        .set("Cookie", `dne_staff=${token}`)
        .send({ ...payload(), ...changes })
        .expect(403),
    );
    expect(f.port.create).not.toHaveBeenCalled();
  },
);
it.each([
  { staffId: "self" },
  { circleId: "foreign" },
  { idempotencyKey: "bad" },
  { expiresAt: "2026-10-07T12:00:00Z" },
  { extra: "role" },
  { expiresAt: "x".repeat(201) },
])(
  "CIRADM-05 invalid creation %j is rejected before writing",
  async (changes) => {
    const f = fixture();
    await withLoopback(f.application, (s) =>
      request(s)
        .post(base + "/create")
        .set("Cookie", `dne_staff=${token}`)
        .send({ ...payload(), ...changes })
        .expect(422),
    );
    expect(f.port.create).not.toHaveBeenCalled();
  },
);
it.each(["denied", "invalid", "conflict", "unavailable"] as const)(
  "CIRADM-04 %s preserves truthful response without a retry",
  async (kind) => {
    const f = fixture();
    f.port.create.mockResolvedValue({ kind });
    const r = await withLoopback(f.application, (s) =>
      request(s)
        .post(base + "/create")
        .set("Cookie", `dne_staff=${token}`)
        .send(payload())
        .expect(
          { denied: 403, invalid: 422, conflict: 409, unavailable: 503 }[kind],
        ),
    );
    expect(f.port.create).toHaveBeenCalledTimes(1);
    if (kind === "unavailable") {
      expect(r.text).toContain(key);
      expect(r.text).toContain(expiresAt);
      expect(r.text).toContain('target="_blank"');
      expect(r.text).not.toMatch(/type="checkbox"[^>]*\bchecked\b/);
    } else expect(r.text).not.toContain(key);
  },
);
it("CIRADM-04 thrown create preserves original protected recovery and hides internal error", async () => {
  const f = fixture();
  f.port.create.mockRejectedValue(
    new Error("invented-private-database-detail"),
  );
  const r = await withLoopback(f.application, (s) =>
    request(s)
      .post(base + "/create")
      .set("Cookie", `dne_staff=${token}`)
      .send(payload())
      .expect(503),
  );
  expect(r.text).toContain(key);
  expect(r.text).not.toContain("invented-private-database-detail");
  expect(f.port.create).toHaveBeenCalledTimes(1);
});
it.each([{ localCircleAdmin: false }, { circleDiscussionEnabled: false }])(
  "CIRADM-08 paused writes %j retain structural reads and exact revoke",
  async (options) => {
    const f = fixture(options);
    await withLoopback(f.application, async (s) => {
      const home = await request(s)
        .get(base)
        .set("Cookie", `dne_staff=${token}`)
        .expect(200);
      expect(home.text).toContain("paused");
      const check = await request(s)
        .post(base + "/check")
        .set("Cookie", `dne_staff=${token}`)
        .send(scope)
        .expect(200);
      expect(check.text).toContain("paused");
      await request(s)
        .post(base + "/create")
        .set("Cookie", `dne_staff=${token}`)
        .send(payload())
        .expect(403);
      await request(s)
        .post(base + "/inspect")
        .set("Cookie", `dne_staff=${token}`)
        .send({ ...scope, lookupKind: "key", lookupValue: key })
        .expect(200);
      await request(s)
        .post(base + "/history")
        .set("Cookie", `dne_staff=${token}`)
        .send(scope)
        .expect(200);
      await request(s)
        .post(base + "/revoke")
        .set("Cookie", `dne_staff=${token}`)
        .send({ ...scope, grantId, confirm: "yes" })
        .expect(200);
    });
    expect(f.port.create).not.toHaveBeenCalled();
  },
);
it.each(["key", "grant"] as const)(
  "CIRADM-04 protected exact %s inspection can show unknown without mutation",
  async (kind) => {
    const f = fixture();
    f.port.inspect.mockResolvedValue(ready(null));
    const value = kind === "key" ? key : grantId;
    const r = await withLoopback(f.application, (s) =>
      request(s)
        .post(base + "/inspect")
        .set("Cookie", `dne_staff=${token}`)
        .send({ ...scope, lookupKind: kind, lookupValue: value })
        .expect(200),
    );
    expect(f.port.inspect).toHaveBeenCalledExactlyOnceWith(token, scope, {
      kind,
      value,
    });
    expect(r.text).toContain("does not prove");
    expect(r.text.includes(key)).toBe(kind === "key");
    expect(f.port.create).not.toHaveBeenCalled();
  },
);
it("CIRADM-06 history forwards only explicit exact-scope continuation", async () => {
  const f = fixture();
  await withLoopback(f.application, async (s) => {
    for (const after of [undefined, "signed-continuation"])
      await request(s)
        .post(base + "/history")
        .set("Cookie", `dne_staff=${token}`)
        .send({ ...scope, ...(after === undefined ? {} : { after }) })
        .expect(200);
  });
  expect(f.port.history.mock.calls).toEqual([
    [token, scope, undefined],
    [token, scope, "signed-continuation"],
  ]);
});
it("CIRADM-03 exact revocation is never implicit", async () => {
  const f = fixture();
  await withLoopback(f.application, async (s) => {
    await request(s)
      .post(base + "/revoke")
      .set("Cookie", `dne_staff=${token}`)
      .send({ ...scope, grantId })
      .expect(403);
    await request(s)
      .post(base + "/revoke")
      .set("Cookie", `dne_staff=${token}`)
      .send({ ...scope, grantId, confirm: "yes" })
      .expect(200);
  });
  expect(f.port.revoke).toHaveBeenCalledExactlyOnceWith(token, scope, grantId);
});
it.each([
  ["inspect", { ...scope, lookupKind: "other", lookupValue: key }],
  ["inspect", { ...scope, lookupKind: "key", lookupValue: "bad" }],
  [
    "inspect",
    { ...scope, lookupKind: "key", lookupValue: key, staffId: "bad" },
  ],
  ["history", { ...scope, after: ["a", "b"] }],
  ["history", { ...scope, circleId: "foreign" }],
  ["revoke", { ...scope, grantId: "bad", confirm: "yes" }],
  ["revoke", { ...scope, grantId, staffId: "bad", confirm: "yes" }],
] as const)(
  "CIRADM-05 malformed %s body refuses lookup/write",
  async (path, body) => {
    const f = fixture();
    await withLoopback(f.application, (s) =>
      request(s)
        .post(`${base}/${path}`)
        .set("Cookie", `dne_staff=${token}`)
        .send(body)
        .expect(422),
    );
    expect(f.port.inspect).not.toHaveBeenCalled();
    expect(f.port.history).not.toHaveBeenCalled();
    expect(f.port.revoke).not.toHaveBeenCalled();
  },
);
it.each(["check", "create", "inspect", "history", "revoke"])(
  "CIRADM-05 %s refuses key/cursor or authority in URL",
  async (path) => {
    const f = fixture();
    await withLoopback(f.application, (s) =>
      request(s)
        .post(`${base}/${path}?key=${key}`)
        .set("Cookie", `dne_staff=${token}`)
        .send(payload())
        .expect(422),
    );
    for (const fn of Object.values(f.port)) expect(fn).not.toHaveBeenCalled();
  },
);
it.each(["admin", "create"] as const)(
  "CIRADM-05 %s expiry before rendering withholds stale success",
  async (method) => {
    const f = fixture();
    const value =
      method === "admin"
        ? {
            reference: {
              staffId,
              role: "platform_admin" as const,
              expiresAt: new Date(expiresAt),
            },
            creationEnabled: true,
          }
        : record;
    const result = {
      kind: "ready" as const,
      value,
      observedAt: at,
      deadline: -1,
    };
    if (method === "admin")
      f.port.admin.mockResolvedValue(
        result as Awaited<ReturnType<CircleGrantAdminStore["admin"]>>,
      );
    else
      f.port.create.mockResolvedValue(
        result as Awaited<ReturnType<CircleGrantAdminStore["create"]>>,
      );
    await withLoopback(f.application, (s) =>
      method === "admin"
        ? request(s).get(base).set("Cookie", `dne_staff=${token}`).expect(403)
        : request(s)
            .post(base + "/create")
            .set("Cookie", `dne_staff=${token}`)
            .send(payload())
            .expect(503),
    );
  },
);
it.each(["admin", "create"] as const)(
  "CIRADM-05 %s expiry during rendering withholds response without repeating store",
  async (method) => {
    const f = fixture();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const date = new Date(expiresAt);
    vi.spyOn(date, "toISOString").mockImplementation(() => {
      clock.mockReturnValue(101);
      return expiresAt;
    });
    if (method === "admin")
      f.port.admin.mockResolvedValue({
        kind: "ready",
        value: {
          reference: { staffId, role: "platform_admin", expiresAt: date },
          creationEnabled: true,
        },
        observedAt: at,
        deadline: 100,
      });
    else
      f.port.create.mockResolvedValue({
        kind: "ready",
        value: { ...record, expiresAt: date },
        observedAt: at,
        deadline: 100,
      });
    await withLoopback(f.application, (s) =>
      method === "admin"
        ? request(s).get(base).set("Cookie", `dne_staff=${token}`).expect(403)
        : request(s)
            .post(base + "/create")
            .set("Cookie", `dne_staff=${token}`)
            .send(payload())
            .expect(503),
    );
    expect(f.port[method]).toHaveBeenCalledTimes(1);
  },
);
it("CIRADM-05 nonfinite authority and thrown readonly lookup never disclose the reference", async () => {
  const f = fixture();
  f.port.reference.mockResolvedValue({
    kind: "ready",
    value: { staffId, role: "moderator", expiresAt: new Date(expiresAt) },
    observedAt: at,
    deadline: NaN,
  });
  await withLoopback(f.application, async (s) => {
    const r = await request(s)
      .get(reference)
      .set("Cookie", `dne_staff=${token}`)
      .expect(403);
    expect(r.text).not.toContain(staffId);
    f.port.reference.mockRejectedValue(new Error("invented-internal-detail"));
    const error = await request(s)
      .get(reference)
      .set("Cookie", `dne_staff=${token}`)
      .expect(503);
    expect(error.text).not.toContain("invented-internal-detail");
  });
});
