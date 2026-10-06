import request from "supertest";
import { expect, it, vi } from "vitest";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import type {
  AssignmentResult,
  SupportAssignmentStore,
} from "../../src/support-assignment.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
const origin = "http://127.0.0.1:3000",
  host = "127.0.0.1:3000",
  secret = "invented-assignment-route-test";
const staff = "b".repeat(64),
  learner = "a".repeat(64);
const requestId = "11111111-1111-4111-8111-111111111111",
  staffId = "22222222-2222-4222-8222-222222222222",
  grantId = "33333333-3333-4333-8333-333333333333",
  key = "44444444-4444-4444-8444-444444444444";
const cookie = `${COOKIE}=${learner}; dne_staff=${staff}`,
  base = "/operator/support-assignment";
function ready<T>(value: T): Extract<AssignmentResult<T>, { kind: "ready" }> {
  return {
    kind: "ready",
    value,
    observedAt: new Date(),
    deadline: performance.now() + 60000,
  };
}
function fixture(
  options: {
    localSupportAssignment?: boolean;
    localStaffEntry?: boolean;
    mode?: "live";
    missing?: boolean;
  } = {},
) {
  const port = {
    admin: vi
      .fn<SupportAssignmentStore["admin"]>()
      .mockResolvedValue(ready(null)),
    reference: vi
      .fn<SupportAssignmentStore["reference"]>()
      .mockResolvedValue(
        ready({ staffId, expiresAt: new Date("2026-10-07T12:00:00.000Z") }),
      ),
    check: vi.fn<SupportAssignmentStore["check"]>().mockResolvedValue(
      ready({
        requestId,
        staffId,
        expiresAt: new Date("2026-10-07T12:00:00.000Z"),
      }),
    ),
    assign: vi
      .fn<SupportAssignmentStore["assign"]>()
      .mockResolvedValue(ready({ requestId, grantId, disposition: "created" })),
    history: vi.fn<SupportAssignmentStore["history"]>().mockResolvedValue(
      ready({
        requestId,
        observedAt: new Date(),
        withdrawn: false,
        items: [],
        nextCursor: null,
      }),
    ),
    revoke: vi
      .fn<SupportAssignmentStore["revoke"]>()
      .mockResolvedValue(ready({ requestId, grantId, disposition: "revoked" })),
  };
  const session = vi.fn().mockResolvedValue({ kind: "missing" });
  const admit = vi.fn().mockResolvedValue({
    kind: "ready",
    role: "platform_admin",
    deadline: performance.now() + 60000,
    expiresAt: new Date(Date.now() + 60000),
  });
  const application = app({ create: vi.fn(), session } as unknown as Store, {
    origin,
    secret,
    localStaffEntry: true,
    localSupportAssignment: true,
    ...options,
    supportAssignment: options.missing ? undefined : port,
    staffEntry: { admit },
  });
  return { application, port, session, admit };
}
const payload = () => ({
  csrf: csrf(staff, secret),
  requestId,
  staffId,
  idempotencyKey: key,
  startsAt: "2026-10-06T12:00:00.000Z",
  expiresAt: "2026-10-06T13:00:00.000Z",
  confirm: "yes",
});
it("SUPADM-01 opens exact-reference forms and operator own ID through explicitly selected staff", async () => {
  const f = fixture();
  await withLoopback(f.application, async (s) => {
    const home = await request(s)
      .get(base)
      .set("Host", host)
      .set("Cookie", cookie)
      .expect(200);
    expect(home.headers["cache-control"]).toBe("no-store");
    expect(home.text).toContain("Check exact references");
    expect(f.port.admin).toHaveBeenCalledWith(staff);
    await request(s)
      .get("/OPERATOR/assignment-id/")
      .set("Host", host)
      .set("Cookie", cookie)
      .expect(200);
    expect(f.port.reference).toHaveBeenCalledWith(staff);
    await request(s)
      .get("/staff")
      .set("Host", host)
      .set("Cookie", cookie)
      .expect(200)
      .expect((r) => expect(r.text).toContain("Support request assignments"));
  });
});
it.each([
  { localSupportAssignment: false },
  { localStaffEntry: false },
  { mode: "live" as const },
  { missing: true },
])(
  "SUPADM-08 unavailable configuration %j denies direct routes without store calls",
  async (options) => {
    const f = fixture(options);
    await withLoopback(f.application, async (s) => {
      const r = await request(s)
        .get(base)
        .set("Host", host)
        .set("Cookie", cookie)
        .expect(404);
      expect(r.text).toContain("unavailable in this configuration");
      expect(f.port.admin).not.toHaveBeenCalled();
    });
  },
);
it.each([
  `${COOKIE}=${staff}`,
  `${COOKIE}=${learner}`,
  "dne_staff=signed-out",
  "dne_staff=bad",
  `dne_staff=${staff}; dne_staff=${staff}`,
])(
  "SUPADM-05 does not use ambiguous/legacy staff state %s",
  async (selected) => {
    const f = fixture();
    await withLoopback(f.application, (s) =>
      request(s)
        .get(base)
        .set("Host", host)
        .set("Cookie", selected)
        .expect(403),
    );
    expect(f.port.admin).not.toHaveBeenCalled();
  },
);
it("SUPADM-05 selected staff CSRF cannot be replaced by learner, foreign Origin or Host", async () => {
  const f = fixture();
  await withLoopback(f.application, async (s) => {
    for (const [token, address, hostname] of [
      [csrf(learner, secret), origin, host],
      [csrf(staff, secret), "http://foreign.invalid", host],
      [csrf(staff, secret), origin, "foreign.invalid"],
    ])
      await request(s)
        .post(`${base}/check`)
        .set("Host", hostname!)
        .set("Origin", address!)
        .set("Cookie", cookie)
        .type("form")
        .send({ csrf: token, requestId, staffId })
        .expect(403);
    await request(s)
      .post(`${base}/check`)
      .set("Host", host)
      .set("Origin", origin)
      .set("Cookie", cookie)
      .type("form")
      .send({ csrf: csrf(staff, secret), requestId, staffId })
      .expect(200);
    expect(f.port.check).toHaveBeenCalledTimes(1);
    expect(f.port.check).toHaveBeenCalledWith(staff, requestId, staffId);
    await request(s).get("/learn").set("Host", host).set("Cookie", cookie);
    expect(f.session).toHaveBeenCalledWith(learner);
  });
});
it.each([
  `${base}?role=operator`,
  "/operator/assignment-id?staffId=other",
  `${base}/history?requestId=${requestId}&key=bad`,
  `${base}/history?requestId=${requestId}&key=${key}&after=cursor`,
  `${base}/history?requestId=${requestId}&requestId=${requestId}`,
  `${base}/history?requestId=${requestId}&after=${"x".repeat(201)}`,
  `${base}/history?requestId=bad`,
])(
  "SUPADM-05 rejects invalid read %s before privileged lookup",
  async (path) => {
    const f = fixture();
    await withLoopback(f.application, (s) =>
      request(s).get(path).set("Host", host).set("Cookie", cookie).expect(403),
    );
    expect(f.port.history).not.toHaveBeenCalled();
    expect(f.port.admin).not.toHaveBeenCalled();
    expect(f.port.reference).not.toHaveBeenCalled();
  },
);
it("SUPADM-08 normalizes the ordinary empty optional key and preserves exact continuation/own key", async () => {
  const f = fixture();
  await withLoopback(f.application, async (s) => {
    for (const suffix of ["&key=", "&after=cursor", "&key=" + key])
      await request(s)
        .get(`${base}/history?requestId=${requestId}${suffix}`)
        .set("Host", host)
        .set("Cookie", cookie)
        .expect(200);
  });
  expect(f.port.history.mock.calls).toEqual([
    [staff, requestId, undefined, undefined],
    [staff, requestId, "cursor", undefined],
    [staff, requestId, undefined, key],
  ]);
});
it("SUPADM-02 assigns only the finite confirmed immutable payload and renders its original-key receipt", async () => {
  const f = fixture();
  const r = await withLoopback(f.application, (s) =>
    request(s)
      .post(`${base}/assign`)
      .set("Host", host)
      .set("Origin", origin)
      .set("Cookie", cookie)
      .type("form")
      .send(payload())
      .expect(200),
  );
  expect(f.port.assign).toHaveBeenCalledWith(staff, {
    requestId,
    staffId,
    idempotencyKey: key,
    startsAt: new Date(payload().startsAt),
    expiresAt: new Date(payload().expiresAt),
  });
  expect(r.text).toContain("Support assignment recorded");
  expect(r.text).toContain(key);
  expect(r.text).not.toContain("Retry this exact assignment");
});
it("SUPADM-05 rejects missing confirmation, ambiguous/oversized/authority fields and noncanonical UTC", async () => {
  const f = fixture();
  await withLoopback(f.application, async (s) => {
    for (const changes of [
      { confirm: "no" },
      { requestId: "bad" },
      { actor: staffId },
      { role: "platform_admin" },
      { startsAt: "2026-02-30T12:00:00.000Z" },
      { startsAt: "2026-10-06T12:00:00Z" },
      { expiresAt: payload().startsAt },
      { staffId: "x".repeat(201) },
    ])
      await request(s)
        .post(`${base}/assign`)
        .set("Host", host)
        .set("Origin", origin)
        .set("Cookie", cookie)
        .type("form")
        .send({ ...payload(), ...changes })
        .expect(403);
    const form = new URLSearchParams(payload()).toString();
    await request(s)
      .post(`${base}/assign`)
      .set("Host", host)
      .set("Origin", origin)
      .set("Cookie", cookie)
      .type("form")
      .send(form + "&staffId=" + staffId)
      .expect(403);
    await request(s)
      .post(`${base}/assign?actor=other`)
      .set("Host", host)
      .set("Origin", origin)
      .set("Cookie", cookie)
      .type("form")
      .send(payload())
      .expect(403);
  });
  expect(f.port.assign).not.toHaveBeenCalled();
});
it.each([
  ["denied", 403],
  ["invalid", 422],
  ["conflict", 409],
  ["unavailable", 503],
] as const)(
  "SUPADM-07 projects %s safely with recovery only when permitted",
  async (kind, status) => {
    const f = fixture();
    f.port.assign.mockResolvedValue({ kind });
    const r = await withLoopback(f.application, (s) =>
      request(s)
        .post(`${base}/assign`)
        .set("Host", host)
        .set("Origin", origin)
        .set("Cookie", cookie)
        .type("form")
        .send(payload())
        .expect(status),
    );
    expect(r.text).toContain('role="alert"');
    expect(r.text.includes("Retry this exact assignment")).toBe(
      kind === "unavailable",
    );
    expect(r.text.includes("Inspect saved assignment state")).toBe(
      kind !== "denied",
    );
    expect(r.text).not.toContain(staff);
  },
);
it("SUPADM-07 preserves exact uncertain submission when the port throws without disclosing its error", async () => {
  const f = fixture();
  f.port.assign.mockRejectedValue(Error("PRIVATE_FAILURE_TOKEN"));
  const r = await withLoopback(f.application, (s) =>
    request(s)
      .post(`${base}/assign`)
      .set("Host", host)
      .set("Origin", origin)
      .set("Cookie", cookie)
      .type("form")
      .send(payload())
      .expect(503),
  );
  expect(r.text).not.toContain("PRIVATE_FAILURE_TOKEN");
  expect(r.text).toContain(key);
  expect(r.text).toContain("Retry this exact assignment");
  expect(f.port.assign).toHaveBeenCalledTimes(1);
});
it("SUPADM-06 withholds expired read results and reports possibly committed writes without retry", async () => {
  const f = fixture();
  f.port.reference.mockResolvedValue({
    ...ready({ staffId, expiresAt: new Date() }),
    deadline: NaN,
  });
  f.port.assign.mockResolvedValue({
    ...ready({ requestId, grantId, disposition: "created" as const }),
    deadline: performance.now() - 1,
  });
  await withLoopback(f.application, async (s) => {
    await request(s)
      .get("/operator/assignment-id")
      .set("Host", host)
      .set("Cookie", cookie)
      .expect(403);
    const r = await request(s)
      .post(`${base}/assign`)
      .set("Host", host)
      .set("Origin", origin)
      .set("Cookie", cookie)
      .type("form")
      .send(payload())
      .expect(503);
    expect(r.text).not.toContain("data-assignment-grant");
    expect(r.text).toContain(key);
  });
  expect(f.port.assign).toHaveBeenCalledTimes(1);
});
it("SUPADM-04 exact confirmed revoke returns receipt while malformed or uncertain revoke does not replay", async () => {
  const f = fixture();
  await withLoopback(f.application, async (s) => {
    const post = () =>
      request(s)
        .post(`${base}/revoke`)
        .set("Host", host)
        .set("Origin", origin)
        .set("Cookie", cookie)
        .type("form");
    const body = {
      csrf: csrf(staff, secret),
      requestId,
      grantId,
      confirm: "yes",
    };
    for (const changes of [
      { confirm: "no" },
      { grantId: "bad" },
      { requestId: "bad" },
      { purpose: "other" },
    ])
      await post()
        .send({ ...body, ...changes })
        .expect(403);
    await post().send(body).expect(200);
    expect(f.port.revoke).toHaveBeenCalledWith(staff, requestId, grantId);
    f.port.revoke.mockRejectedValue(Error("PRIVATE_REVOKE_ERROR"));
    const r = await post().send(body).expect(503);
    expect(r.text).toContain("Inspect saved assignment state");
    expect(r.text).not.toContain("PRIVATE_REVOKE_ERROR");
    expect(r.text).not.toContain("Retry this exact assignment");
  });
});
it("SUPADM-07 sanitizes unexpected read failures without mutation recovery", async () => {
  const f = fixture();
  f.port.admin.mockRejectedValue(Error("PRIVATE_READ_ERROR"));
  const r = await withLoopback(f.application, (s) =>
    request(s).get(base).set("Host", host).set("Cookie", cookie).expect(503),
  );
  expect(r.text).not.toContain("PRIVATE_READ_ERROR");
  expect(r.text).not.toContain("Retry this exact assignment");
});
it("SUPADM-05 malformed or ambiguous reference checks deny before content-free eligibility lookup", async () => {
  const f = fixture();
  await withLoopback(f.application, async (s) => {
    const post = (path = `${base}/check`) =>
      request(s)
        .post(path)
        .set("Host", host)
        .set("Origin", origin)
        .set("Cookie", cookie)
        .type("form");
    const body = { csrf: csrf(staff, secret), requestId, staffId };
    for (const changed of [
      { requestId: "not-a-reference" },
      { staffId: "not-a-reference" },
      { role: "platform_admin" },
      { staffId: "x".repeat(201) },
    ])
      await post()
        .send({ ...body, ...changed })
        .expect(403);
    await post(`${base}/check?requestId=${requestId}`).send(body).expect(403);
    await post()
      .send(new URLSearchParams(body).toString() + "&staffId=" + staffId)
      .expect(403);
  });
  expect(f.port.check).not.toHaveBeenCalled();
  expect(f.port.assign).not.toHaveBeenCalled();
});
