import express from "express";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { mountStudyUnitFixtureRoutes } from "../../src/study-unit-fixture-routes.ts";
import type { StudyUnitFixtureStore } from "../../src/study-unit-fixtures.ts";
import { withLoopback } from "../support/loopback-server.ts";
const base = "/member/test-unit-request",
  staff = "/operator/study-test-units";
const id = "11111111-1111-4111-8111-111111111111",
  key = "22222222-2222-4222-8222-222222222222";
const credential = "c".repeat(64),
  cookie = `dne_staff=${credential}`;
const at = new Date("2030-01-01T12:00:00.000Z");
const receipt = {
  id,
  policy: "browser-study-fixture-v1" as const,
  administratorId: id,
  createdAt: at,
  expiresAt: new Date(+at + 1800000),
  grantId: null,
  issuedAt: null,
  grantExpiresAt: null,
  withdrawnAt: null,
};
const requestScope = {
  policy: "browser-study-fixture-v1" as const,
  administratorId: id,
  memberExpiresAt: new Date(+at + 3600000).toISOString(),
  administratorExpiresAt: new Date(+at + 3600000).toISOString(),
  checkedAt: at.toISOString(),
  expiresAt: new Date(+at + 1800000).toISOString(),
};
const issueScope = {
  policy: "browser-study-fixture-v1" as const,
  requestId: id,
  requestExpiresAt: receipt.expiresAt.toISOString(),
  checkedAt: at.toISOString(),
  expiresAt: new Date(+at + 900000).toISOString(),
};
function ready<T>(value: T) {
  return {
    kind: "ready" as const,
    value,
    observedAt: at,
    deadline: performance.now() + 60000,
  };
}
function payload(kind: "request" | "issue" | "withdraw") {
  return {
    csrf: "b".repeat(64),
    kind,
    key,
    checked: JSON.stringify(
      kind === "request"
        ? requestScope
        : kind === "issue"
          ? issueScope
          : { requestId: id },
    ),
    confirm: "yes",
  };
}
function fixture(
  options: Parameters<typeof mountStudyUnitFixtureRoutes>[2] = {},
  missing = false,
  includeCsrf = true,
) {
  const member = vi.fn<StudyUnitFixtureStore["member"]>().mockResolvedValue({
    kind: "ready",
    value: { receipt: null, creationEnabled: true },
    observedAt: new Date("2026-10-08T13:00:00Z"),
    deadline: performance.now() + 60000,
  });
  const port = {
    member,
    administrator: vi
      .fn<StudyUnitFixtureStore["administrator"]>()
      .mockResolvedValue(ready({ reference: id, creationEnabled: true })),
    checkRequest: vi
      .fn<StudyUnitFixtureStore["checkRequest"]>()
      .mockResolvedValue(ready(requestScope)),
    checkIssue: vi
      .fn<StudyUnitFixtureStore["checkIssue"]>()
      .mockResolvedValue(ready(issueScope)),
    request: vi
      .fn<StudyUnitFixtureStore["request"]>()
      .mockResolvedValue(ready(receipt)),
    issue: vi
      .fn<StudyUnitFixtureStore["issue"]>()
      .mockResolvedValue(ready(receipt)),
    withdraw: vi
      .fn<StudyUnitFixtureStore["withdraw"]>()
      .mockResolvedValue(ready(receipt)),
    inspect: vi
      .fn<StudyUnitFixtureStore["inspect"]>()
      .mockResolvedValue(ready(receipt)),
    permission: vi.fn<StudyUnitFixtureStore["permission"]>(),
  };
  const application = express();
  application.use(express.json());
  application.use(express.urlencoded({ extended: false }));
  application.use((_req, res, next) => {
    res.locals.token = "a".repeat(64);
    if (includeCsrf) res.locals.csrf = "b".repeat(64);
    next();
  });
  mountStudyUnitFixtureRoutes(application, missing ? undefined : port, {
    mode: "test",
    localStaffEntry: true,
    ...options,
  });
  return { application, member, port };
}
afterEach(() => vi.restoreAllMocks());
it("TESTISSUE-01 GET delegates only the owning credential and renders a deliberate request without writes", async () => {
  const f = fixture();
  const response = await withLoopback(f.application, (s) =>
    request(s).get(base).expect(200),
  );
  expect(response.text).toContain("Review request");
  expect(f.member).toHaveBeenCalledExactlyOnceWith("a".repeat(64));
});
it.each([
  ["denied", 403],
  ["invalid", 422],
  ["conflict", 409],
  ["unavailable", 503],
] as const)(
  "TESTISSUE-03 %s result discloses no successful request",
  async (kind, status) => {
    const f = fixture();
    f.member.mockResolvedValue({ kind });
    const response = await withLoopback(f.application, (s) =>
      request(s).get(base).expect(status),
    );
    expect(response.text).not.toContain("Review request");
    expect(response.text).not.toContain("a".repeat(64));
  },
);
it("TESTISSUE-06 thrown private database diagnostics become generic unavailable without automatic write recovery", async () => {
  const f = fixture();
  f.member.mockRejectedValue(Error("private database diagnostic marker"));
  const response = await withLoopback(f.application, (s) =>
    request(s).get(base).expect(503),
  );
  expect(response.text).not.toContain("private database diagnostic marker");
  expect(response.text).not.toContain("Inspect original operation");
});
it("TESTISSUE-03 a reader whose original native lifetime already ended cannot render the request", async () => {
  const f = fixture();
  f.member.mockResolvedValue({
    kind: "ready",
    value: { receipt: null, creationEnabled: true },
    observedAt: new Date(),
    deadline: -1,
  });
  const response = await withLoopback(f.application, (s) =>
    request(s).get(base).expect(403),
  );
  expect(response.text).not.toContain("Review request");
});
it("TESTISSUE-03 lifetime expiry during synchronous rendering discards the generated member form", async () => {
  const f = fixture();
  const deadline = performance.now() + 60000;
  f.member.mockResolvedValue({
    kind: "ready",
    value: {
      receipt: null,
      get creationEnabled() {
        vi.spyOn(performance, "now").mockReturnValue(deadline + 1);
        return true;
      },
    },
    observedAt: new Date(),
    deadline,
  });
  const response = await withLoopback(f.application, (s) =>
    request(s).get(base).expect(403),
  );
  expect(response.text).not.toContain("Review request");
});
it("TESTISSUE-03 nonfinite lifetime cannot authorize a successful response", async () => {
  const f = fixture();
  f.member.mockResolvedValue({
    kind: "ready",
    value: { receipt: null, creationEnabled: true },
    observedAt: new Date(),
    deadline: NaN,
  });
  await withLoopback(f.application, (s) => request(s).get(base).expect(403));
});

it.each([{ mode: "live" as const }, { localStaffEntry: false }])(
  "TESTISSUE-08 disabled staff configuration %j cannot reach staff authority",
  async (options) => {
    const f = fixture(options);
    await withLoopback(f.application, (s) =>
      request(s).get(staff).set("Cookie", cookie).expect(404),
    );
    expect(f.port.administrator).not.toHaveBeenCalled();
  },
);
it("TESTISSUE-08 absent feature store denies local paths without fallback", async () => {
  const f = fixture({}, true);
  await withLoopback(f.application, (s) => request(s).get(base).expect(404));
  expect(f.member).not.toHaveBeenCalled();
});
it.each([
  "",
  "dne_staff=bad",
  `dne_session=${credential}`,
  `${cookie}; ${cookie}`,
])(
  "TESTISSUE-02 invalid selected staff cookie %s cannot escalate",
  async (selected) => {
    const f = fixture();
    await withLoopback(f.application, (s) =>
      request(s).get(staff).set("Cookie", selected).expect(403),
    );
    expect(f.port.administrator).not.toHaveBeenCalled();
  },
);
it("TESTISSUE-02 normal staff read exposes only its own noncredential reference", async () => {
  const f = fixture();
  const result = await withLoopback(f.application, (s) =>
    request(s).get(staff).set("Cookie", cookie).expect(200),
  );
  expect(result.text).toContain(id);
  expect(result.text).not.toContain(credential);
  expect(f.port.administrator).toHaveBeenCalledExactlyOnceWith(credential);
});
it.each(["request", "issue", "withdraw"] as const)(
  "TESTISSUE-01/02/05 %s check shows an unchecked exact instruction and does not perform its write",
  async (kind) => {
    const f = fixture();
    f.member.mockResolvedValue(ready({ receipt, creationEnabled: true }));
    const path = kind === "issue" ? staff : base;
    const fields = {
      csrf: "b".repeat(64),
      ...(kind === "request" ? { administratorId: id } : { requestId: id }),
    };
    const result = await withLoopback(f.application, (s) =>
      request(s)
        .post(path + (kind === "withdraw" ? "/withdraw/check" : "/check"))
        .set("Cookie", cookie)
        .send(fields)
        .expect(200),
    );
    expect(result.text).toContain(
      'type="checkbox" name="confirm" value="yes" required',
    );
    expect(result.text).not.toContain('value="yes" checked');
    expect(f.port[kind]).not.toHaveBeenCalled();
  },
);
it.each(["request", "issue", "withdraw"] as const)(
  "TESTISSUE-01/02/05 confirmed %s forwards exactly its original instruction/key and selected actor",
  async (kind) => {
    const f = fixture();
    const path = kind === "issue" ? staff : base;
    await withLoopback(f.application, (s) =>
      request(s)
        .post(`${path}/${kind}`)
        .set("Cookie", cookie)
        .send(payload(kind))
        .expect(200),
    );
    expect(f.port[kind]).toHaveBeenCalledExactlyOnceWith(
      kind === "issue" ? credential : "a".repeat(64),
      key,
      kind === "request" ? requestScope : kind === "issue" ? issueScope : id,
    );
  },
);
it.each(["request", "issue", "withdraw"] as const)(
  "TESTISSUE-06 unavailable %s retains original inspection but never dispatches recovery",
  async (kind) => {
    const f = fixture();
    f.port[kind].mockResolvedValue({ kind: "unavailable" });
    const path = kind === "issue" ? staff : base;
    const result = await withLoopback(f.application, (s) =>
      request(s)
        .post(`${path}/${kind}`)
        .set("Cookie", cookie)
        .send(payload(kind))
        .expect(503),
    );
    expect(result.text).toContain("Inspect original operation");
    expect(result.text).toContain(key);
    expect(f.port.inspect).not.toHaveBeenCalled();
    expect(f.port[kind]).toHaveBeenCalledTimes(1);
  },
);
it.each(["request", "issue", "withdraw"] as const)(
  "TESTISSUE-06 %s inspection recovers a saved receipt or asks for deliberate same-key confirmation without writes",
  async (kind) => {
    const f = fixture();
    const path = kind === "issue" ? staff : base;
    const scope: Record<string, string> = { ...payload(kind) };
    delete scope.confirm;
    await withLoopback(f.application, async (s) => {
      const first = await request(s)
        .post(`${path}/inspect`)
        .set("Cookie", cookie)
        .send(scope)
        .expect(200);
      expect(first.text).toContain("Saved local test fixture");
      f.port.inspect.mockResolvedValue(ready(null));
      const missing = await request(s)
        .post(`${path}/inspect`)
        .set("Cookie", cookie)
        .send(scope)
        .expect(200);
      expect(missing.text).toContain("Original operation has no saved receipt");
      expect(missing.text).toContain(key);
      expect(missing.text).not.toContain('value="yes" checked');
    });
    expect(f.port[kind]).not.toHaveBeenCalled();
  },
);
it.each([null, { ...receipt, id: key }, { ...receipt, withdrawnAt: at }])(
  "TESTISSUE-05 missing, foreign or already withdrawn source %j cannot offer withdrawal",
  async (source) => {
    const f = fixture();
    f.member.mockResolvedValue(
      ready({ receipt: source, creationEnabled: true }),
    );
    await withLoopback(f.application, (s) =>
      request(s)
        .post(base + "/withdraw/check")
        .send({ csrf: "b".repeat(64), requestId: id })
        .expect(403),
    );
    expect(f.port.withdraw).not.toHaveBeenCalled();
  },
);
it("TESTISSUE-03 withdrawal check preserves a denied reader without leaking receipt details", async () => {
  const f = fixture();
  f.member.mockResolvedValue({ kind: "denied" });
  await withLoopback(f.application, (s) =>
    request(s)
      .post(base + "/withdraw/check")
      .send({ csrf: "b".repeat(64), requestId: id })
      .expect(403),
  );
});
for (const kind of ["request", "issue", "withdraw"] as const)
  it(`TESTISSUE-03 ${kind} rejects missing confirmation, changed kind, malformed references/JSON and arbitrary fields before write`, async () => {
    const f = fixture(),
      exact = payload(kind),
      path = kind === "issue" ? staff : base;
    const invalid = [
      {},
      { ...exact, confirm: undefined },
      { ...exact, confirm: "no" },
      { ...exact, key: "bad" },
      { ...exact, checked: 42 },
      { ...exact, checked: "x".repeat(4097) },
      { ...exact, checked: "{invalid" },
      { ...exact, checked: "{}" },
      { ...exact, kind: "unknown" },
      { ...exact, kind: kind === "request" ? "withdraw" : "request" },
      { ...exact, quantity: 300 },
      { ...exact, checked: JSON.stringify({ requestId: "bad" }) },
    ];
    await withLoopback(f.application, async (s) => {
      for (const fields of invalid)
        await request(s)
          .post(`${path}/${kind}`)
          .set("Cookie", cookie)
          .send(fields)
          .expect(422);
    });
    expect(f.port[kind]).not.toHaveBeenCalled();
  });
it.each([base + "/check", staff + "/check", base + "/withdraw/check"])(
  "TESTISSUE-03 %s rejects empty scope, invalid IDs and injected selectors",
  async (path) => {
    const f = fixture();
    await withLoopback(f.application, async (s) => {
      await request(s).post(path).set("Cookie", cookie).send({}).expect(422);
      await request(s)
        .post(path)
        .set("Cookie", cookie)
        .send({
          csrf: "csrf",
          ...(path === base + "/check"
            ? { administratorId: "bad" }
            : { requestId: "bad" }),
        })
        .expect(422);
      await request(s)
        .post(path + "?member=other")
        .set("Cookie", cookie)
        .send({})
        .expect(422);
    });
  },
);
it("TESTISSUE-03 inspection cannot switch actor namespace or include a write confirmation", async () => {
  const f = fixture();
  await withLoopback(f.application, async (s) => {
    await request(s)
      .post(base + "/inspect")
      .send(payload("request"))
      .expect(422);
    await request(s)
      .post(base + "/inspect")
      .send({})
      .expect(422);
    const issue: Record<string, string> = { ...payload("issue") };
    delete issue.confirm;
    await request(s)
      .post(base + "/inspect")
      .send(issue)
      .expect(422);
    const member: Record<string, string> = { ...payload("request") };
    delete member.confirm;
    await request(s)
      .post(staff + "/inspect")
      .set("Cookie", cookie)
      .send(member)
      .expect(422);
  });
  expect(f.port.inspect).not.toHaveBeenCalled();
});
it.each(["request", "issue", "withdraw"] as const)(
  "TESTISSUE-05 expired %s write acknowledgement remains uncertain with original inspection",
  async (kind) => {
    const f = fixture(),
      path = kind === "issue" ? staff : base;
    f.port[kind].mockResolvedValue({ ...ready(receipt), deadline: -1 });
    const result = await withLoopback(f.application, (s) =>
      request(s)
        .post(`${path}/${kind}`)
        .set("Cookie", cookie)
        .send(payload(kind))
        .expect(503),
    );
    expect(result.text).toContain("Inspect original operation");
    expect(result.text).not.toContain("Saved local test fixture");
  },
);

it("TESTISSUE-06 generic failure can render without a saved CSRF or original instruction", async () => {
  const f = fixture({}, false, false);
  f.member.mockResolvedValue({ kind: "unavailable" });
  const response = await withLoopback(f.application, (s) =>
    request(s).get(base).expect(503),
  );
  expect(response.text).not.toContain('name="csrf"');
  expect(response.text).not.toContain("Inspect original operation");
});
it("TESTISSUE-05 expiry during write-receipt rendering discards success and retains original same-key inspection", async () => {
  const f = fixture(),
    deadline = performance.now() + 60000;
  f.port.request.mockResolvedValue({
    ...ready({
      ...receipt,
      get id() {
        vi.spyOn(performance, "now").mockReturnValue(deadline + 1);
        return id;
      },
    }),
    deadline,
  });
  const response = await withLoopback(f.application, (s) =>
    request(s)
      .post(base + "/request")
      .send(payload("request"))
      .expect(503),
  );
  expect(response.text).not.toContain("Saved local test fixture");
  expect(response.text).toContain("Inspect original operation");
  expect(response.text).toContain(key);
  expect(f.port.request).toHaveBeenCalledTimes(1);
});
