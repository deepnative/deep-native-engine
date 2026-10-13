import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { csrf } from "../../src/session.ts";
import { mountSupportTimeGrantRoutes } from "../../src/support-time-grant-routes.ts";
import { withLoopback } from "../support/loopback-server.ts";
const origin = "http://127.0.0.1:3000",
  host = "127.0.0.1:3000",
  secret = "invented",
  token = "a".repeat(64),
  base = "/operator/support-time-grants";
const id = "11111111-1111-4111-8111-111111111111",
  operatorId = "22222222-2222-4222-8222-222222222222",
  operationId = "33333333-3333-4333-8333-333333333333",
  grantId = "44444444-4444-4444-8444-444444444444";
const refs = { requestId: id, allocationId: id, operatorId },
  input = {
    ...refs,
    operationId,
    startsAt: "2090-01-01T00:00:00.000Z",
    expiresAt: "2090-01-01T01:00:00.000Z",
  };
const checkPayload = { ...refs, csrf: csrf(token, secret) },
  grantPayload = { ...input, csrf: csrf(token, secret), confirm: "yes" },
  revokePayload = {
    grantId,
    operationId,
    csrf: csrf(token, secret),
    confirm: "yes",
  },
  recoverPayload = { operationId, csrf: csrf(token, secret) };
function fixture(
  options: Partial<Parameters<typeof mountSupportTimeGrantRoutes>[2]> & {
    missing?: boolean;
  } = {},
) {
  const row = {
      ...refs,
      grantId,
      role: "operator",
      allocationState: "allocated",
      ceiling: 20,
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
      createdAt: input.startsAt,
      revokedAt: null,
      state: "active",
      sourceAvailable: true,
      canRevoke: true,
    },
    deadline = performance.now() + 60000;
  const port = {
    open: vi
      .fn()
      .mockResolvedValue({ kind: "ready", creationEnabled: true, deadline }),
    check: vi.fn().mockResolvedValue({
      kind: "ready",
      check: {
        ...refs,
        role: "operator",
        ceiling: 20,
        allocationState: "allocated",
        authorityExpiresAt: input.expiresAt,
      },
      deadline,
    }),
    grant: vi.fn().mockResolvedValue({ kind: "applied", row, deadline }),
    history: vi.fn().mockResolvedValue({
      kind: "ready",
      rows: [row],
      next: null,
      deadline,
    }),
    exact: vi.fn().mockResolvedValue({ kind: "ready", row, deadline }),
    recover: vi.fn().mockResolvedValue({ kind: "ready", row, deadline }),
    revoke: vi.fn().mockResolvedValue({
      kind: "applied",
      row,
      deadline,
      revocation: { revocationReceiptId: id, outcome: "revoked" },
    }),
    recoverRevocation: vi.fn().mockResolvedValue({
      kind: "ready",
      row,
      deadline,
      revocation: { revocationReceiptId: id, outcome: "revoked" },
    }),
  };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  mountSupportTimeGrantRoutes(app, options.missing ? undefined : port, {
    origin,
    secret,
    mode: "test",
    administration: "enabled",
    localStaffEntry: true,
    ...options,
  });
  return { app, port, row, deadline };
}
const get = (
  s: Parameters<typeof request>[0],
  path: string,
  cookie = `dne_staff=${token}`,
) => request(s).get(path).set("Host", host).set("Cookie", cookie);
const post = (s: Parameters<typeof request>[0], path: string, body: object) =>
  request(s)
    .post(path)
    .set("Host", host)
    .set("Cookie", `dne_staff=${token}`)
    .set("Origin", origin)
    .type("form")
    .send(body);
const cases = [
  ["open", "get", base, {}],
  ["check", "post", base + "/check", checkPayload],
  ["grant", "post", base + "/grant", grantPayload],
  ["history", "get", base + "/history", {}],
  ["exact", "get", base + "/" + grantId, {}],
  ["recover", "post", base + "/recover", recoverPayload],
  ["recoverRevocation", "post", base + "/recover-revoke", recoverPayload],
  ["revoke", "post", base + "/revoke", revokePayload],
] as const;
it("SUPPORT-GRANT-01/02/04/06 current forms, own history, exact grant and original operations are rendered without visible replay identities", async () => {
  const f = fixture();
  await withLoopback(f.app, async (s) => {
    for (const [, method, path, payload] of cases) {
      const response = await (
        method === "get" ? get(s, path) : post(s, path, payload)
      )
        .expect(200)
        .expect("Cache-Control", "no-store");
      expect(response.text).not.toContain(`>${operationId}<`);
      expect(response.text).not.toContain(token);
    }
    await get(s, base + "/history?after=cursor").expect(200);
    expect(f.port.history).toHaveBeenLastCalledWith(token, "cursor");
    f.port.grant.mockResolvedValue({
      kind: "replayed",
      row: f.row,
      deadline: f.deadline,
    });
    await post(s, base + "/grant", grantPayload).expect(200);
    for (const kind of ["applied", "replayed"]) {
      f.port.revoke.mockResolvedValue({
        kind,
        row: f.row,
        deadline: f.deadline,
        revocation: { outcome: "unchanged", revocationReceiptId: id },
      });
      const response = await post(s, base + "/revoke", revokePayload).expect(
        200,
      );
      expect(response.text).toContain("Original revocation outcome: unchanged");
    }
  });
});
it.each([
  { missing: true },
  { administration: undefined },
  { administration: "disabled" as const },
  { localStaffEntry: false },
  { mode: "live" as const },
])("SUPPORT-GRANT-05 gates unavailable environment %j", async (options) => {
  const f = fixture(options);
  await withLoopback(f.app, async (s) => {
    await get(s, base).expect(404);
    expect(f.port.open).not.toHaveBeenCalled();
  });
});
it.each([
  "",
  `dne_session=${token}`,
  "dne_staff=bad",
  "dne_staff=signed-out",
  `dne_staff=${token}; dne_staff=${token}`,
])(
  "SUPPORT-GRANT-05 rejects absent/invalid selected staff identity %s",
  async (cookie) => {
    const f = fixture();
    await withLoopback(f.app, async (s) => {
      await get(s, base, cookie).expect(403);
      expect(f.port.open).not.toHaveBeenCalled();
    });
  },
);
it("SUPPORT-GRANT-05 rejects Host and POST origin/media/CSRF violations before writer", async () => {
  const f = fixture();
  await withLoopback(f.app, async (s) => {
    await request(s)
      .get(base)
      .set("Host", "other.invalid")
      .set("Cookie", `dne_staff=${token}`)
      .expect(403);
    for (const change of ["origin", "media", "csrf"]) {
      const req = request(s)
        .post(base + "/grant")
        .set("Host", host)
        .set("Cookie", `dne_staff=${token}`)
        .set("Origin", change === "origin" ? "http://other.invalid" : origin);
      await (change === "media" ? req.type("json") : req.type("form"))
        .send({
          ...grantPayload,
          csrf: change === "csrf" ? "bad" : grantPayload.csrf,
        })
        .expect(403);
    }
    expect(f.port.grant).not.toHaveBeenCalled();
  });
});
it.each(cases)(
  "SUPPORT-GRANT-05 %s rejects query additions and sanitized store denial",
  async (method, verb, path, payload) => {
    const f = fixture();
    await withLoopback(f.app, async (s) => {
      await (
        verb === "get"
          ? get(s, path + "?extra=x")
          : post(s, path + "?extra=x", payload)
      ).expect(422);
      f.port[method].mockResolvedValue({ kind: "denied" });
      await (verb === "get" ? get(s, path) : post(s, path, payload)).expect(
        403,
      );
      f.port[method].mockRejectedValue(Error("PRIVATE-DIAGNOSTIC"));
      const response = await (
        verb === "get" ? get(s, path) : post(s, path, payload)
      ).expect(503);
      expect(response.text).not.toContain("PRIVATE-DIAGNOSTIC");
      if (method === "grant" || method === "revoke") {
        expect(response.text).toContain(
          `name="operationId" value="${operationId}"`,
        );
        expect(response.text).not.toMatch(/name="confirm"[^>]*checked/);
      }
    });
  },
);
it("SUPPORT-GRANT-05 rejects incomplete confirmations, malformed exact identifiers and excessive continuation", async () => {
  const f = fixture();
  await withLoopback(f.app, async (s) => {
    const invalid: [string, object][] = [
      ["check", {}],
      ["check", { ...checkPayload, allocationId: "bad" }],
      ["grant", {}],
      ["grant", { ...grantPayload, confirm: "no" }],
      ["grant", { ...grantPayload, startsAt: "bad" }],
      ["revoke", {}],
      ["revoke", { ...revokePayload, confirm: "no" }],
      ["revoke", { ...revokePayload, grantId: "bad" }],
      ["recover", {}],
      ["recover", { ...recoverPayload, operationId: "bad" }],
      ["recover-revoke", { ...recoverPayload, operationId: "bad" }],
    ];
    for (const [path, payload] of invalid)
      await post(s, base + "/" + path, {
        csrf: csrf(token, secret),
        ...payload,
      }).expect(422);
    await get(s, base + "/history?after=" + "x".repeat(1025)).expect(422);
  });
});
it("SUPPORT-GRANT-06 unavailable writes retain only original payload; conflict is409 and absent recovery remains unknown", async () => {
  const f = fixture();
  await withLoopback(f.app, async (s) => {
    for (const kind of ["invalid", "conflict", "unavailable"]) {
      f.port.grant.mockResolvedValue({ kind });
      const response = await post(s, base + "/grant", grantPayload).expect(
        kind === "invalid" ? 422 : kind === "conflict" ? 409 : 503,
      );
      expect(response.text.includes("Retry this exact permission")).toBe(
        kind === "unavailable",
      );
    }
    f.port.revoke.mockResolvedValue({ kind: "unavailable" });
    expect(
      (await post(s, base + "/revoke", revokePayload).expect(503)).text,
    ).toContain("Retry this exact revocation");
    for (const method of ["recover", "recoverRevocation"] as const) {
      f.port[method].mockResolvedValue({
        kind: "absent",
        deadline: f.deadline,
      });
      const response = await post(
        s,
        base + (method === "recover" ? "/recover" : "/recover-revoke"),
        recoverPayload,
      ).expect(200);
      expect(response.text).toContain(
        "does not establish that no write committed",
      );
    }
    f.port.exact.mockResolvedValue({ kind: "absent", deadline: f.deadline });
    await get(s, base + "/" + grantId).expect(403);
  });
});
it("SUPPORT-GRANT-05/06 withholds projection after authority ends at synchronous HTTP acceptance", async () => {
  const f = fixture();
  await withLoopback(f.app, async (s) => {
    for (const deadline of [NaN, 0]) {
      f.port.open.mockResolvedValue({
        kind: "ready",
        creationEnabled: true,
        deadline,
      });
      const denied = await get(s, base).expect(403);
      expect(denied.text).not.toContain("Check exact references");
      f.port.grant.mockResolvedValue({ kind: "applied", row: f.row, deadline });
      const unknown = await post(s, base + "/grant", grantPayload).expect(503);
      expect(unknown.text).toContain("Retry this exact permission");
      expect(unknown.text).not.toContain("data-support-time-grant-reference");
    }
  });
});
