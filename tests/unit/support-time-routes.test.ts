import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { mountSupportRequestRoutes } from "../../src/support-request-routes.ts";
import { disabledSupportRequestStore } from "../../src/support-requests.ts";
import type { MemberSupportTimeStore } from "../../src/support-time.ts";
import { withLoopback } from "../support/loopback-server.ts";
const id = "11111111-1111-4111-8111-111111111111",
  allocationId = "22222222-2222-4222-8222-222222222222",
  grantId = "33333333-3333-4333-8333-333333333333",
  key = "44444444-4444-4444-8444-444444444444",
  token = "trusted-session";
const scope = { requestId: id, allocationId, grantId };
const receipt = {
  allocationId,
  ceiling: 20,
  state: "allocated" as const,
  held: 20,
  consumed: 0,
  released: 0,
  supportMinutes: 0,
  preparationMinutes: 0,
};
const form = {
  csrf: "trusted-csrf",
  allocationId,
  grantId,
  idempotencyKey: key,
  confirm: "yes",
};
const record = {
  ...form,
  supportStart: "2026-10-03T01:00:00.000Z",
  supportEnd: "2026-10-03T01:10:00.000Z",
  preparationStart: "",
  preparationEnd: "",
};
function fixture(enabled = true) {
  const time = {
    writesEnabled: true,
    allocate: vi
      .fn<MemberSupportTimeStore["allocate"]>()
      .mockResolvedValue({ kind: "applied", receipt }),
    cancel: vi
      .fn<MemberSupportTimeStore["cancel"]>()
      .mockResolvedValue({ kind: "applied", receipt }),
    begin: vi
      .fn<MemberSupportTimeStore["begin"]>()
      .mockResolvedValue({ kind: "applied", receipt }),
    record: vi
      .fn<MemberSupportTimeStore["record"]>()
      .mockResolvedValue({ kind: "applied", receipt }),
    grant: vi.fn<MemberSupportTimeStore["grant"]>(),
    revoke: vi.fn<MemberSupportTimeStore["revoke"]>(),
    receipt: vi.fn<MemberSupportTimeStore["receipt"]>(),
    operatorWorklist: vi
      .fn<MemberSupportTimeStore["operatorWorklist"]>()
      .mockResolvedValue({
        kind: "ready",
        value: { items: [], nextCursor: null },
      }),
    operatorDetail: vi
      .fn<MemberSupportTimeStore["operatorDetail"]>()
      .mockResolvedValue({
        kind: "ready",
        value: { ...receipt, ...scope, canBegin: true, canRecord: false },
      }),
  };
  const host = express();
  host.use(express.urlencoded({ extended: false }));
  host.use((_req, res, next) => {
    res.locals.token = token;
    res.locals.csrf = "trusted-csrf";
    next();
  });
  mountSupportRequestRoutes(host, {
    ...disabledSupportRequestStore(),
    ...(enabled ? { time } : {}),
  });
  return {
    time,
    get: (path: string) =>
      withLoopback(host, (server) => request(server).get(path)),
    post: (path: string, body?: Record<string, unknown>) =>
      withLoopback(host, (server) =>
        body
          ? request(server).post(path).type("form").send(body)
          : request(server).post(path),
      ),
  };
}
const href = `/operator/support-time/${id}?allocation=${allocationId}&grant=${grantId}`;
it("loads only bounded exact-granted receipts without invoking a mutation", async () => {
  const f = fixture();
  expect((await f.get("/operator/support-time?after=opaque")).status).toBe(200);
  expect(f.time.operatorWorklist).toHaveBeenCalledWith(token, "opaque");
  expect((await f.get(href)).status).toBe(200);
  expect(f.time.operatorDetail).toHaveBeenCalledWith(token, scope);
  expect(f.time.begin).not.toHaveBeenCalled();
});
it.each([
  "/operator/support-time?after=a&after=b",
  "/operator/support-time?owner=forged",
  `/operator/support-time/invalid?allocation=${allocationId}&grant=${grantId}`,
  `/operator/support-time/${id}?allocation=invalid&grant=${grantId}`,
  `/operator/support-time/${id}?allocation=${allocationId}&grant=invalid`,
  `${href}&owner=forged`,
])(
  "rejects malformed or forged navigation %s before reading staff records",
  async (path) => {
    const f = fixture();
    expect((await f.get(path)).status).toBe(400);
    expect(f.time.operatorDetail).not.toHaveBeenCalled();
    expect(f.time.operatorWorklist).not.toHaveBeenCalled();
  },
);
it.each(["denied", "unavailable"] as const)(
  "maps %s reads to a failure instead of an empty successful grant list",
  async (kind) => {
    const f = fixture();
    f.time.operatorWorklist.mockResolvedValue({ kind });
    f.time.operatorDetail.mockResolvedValue({ kind });
    expect((await f.get("/operator/support-time")).status).toBe(
      kind === "denied" ? 403 : 503,
    );
    expect((await f.get(href)).status).toBe(kind === "denied" ? 403 : 503);
  },
);
it.each(["begin", "record"] as const)(
  "requires the original exact scope and explicit %s confirmation",
  async (action) => {
    const f = fixture(),
      valid = action === "begin" ? form : record;
    for (const change of [
      { csrf: undefined },
      { grantId: "bad" },
      { allocationId: "bad" },
      { idempotencyKey: "bad" },
      { confirm: "no" },
      { actorId: "forged" },
    ])
      expect(
        (
          await f.post(`/operator/support-time/${id}/${action}`, {
            ...valid,
            ...change,
          })
        ).status,
      ).toBe(422);
    expect(
      (
        await f.post(
          `/operator/support-time/${id}/${action}?actor=forged`,
          valid,
        )
      ).status,
    ).toBe(422);
    expect(
      (await f.post(`/operator/support-time/invalid/${action}`, valid)).status,
    ).toBe(422);
    expect(
      (await f.post(`/operator/support-time/${id}/${action}`)).status,
    ).toBe(422);
    expect(f.time[action]).not.toHaveBeenCalled();
  },
);
it("keeps UTC input canonical and rejects missing or normalized-invalid timestamps before recording", async () => {
  const f = fixture();
  for (const change of [
    { supportStart: undefined },
    { supportStart: "2026-10-03T01:00:00Z" },
    { supportStart: "2026-02-30T01:00:00.000Z" },
    { supportEnd: "invalid" },
    { preparationStart: undefined },
    { preparationEnd: "invalid" },
  ])
    expect(
      (
        await f.post(`/operator/support-time/${id}/record`, {
          ...record,
          ...change,
        })
      ).status,
    ).toBe(422);
  expect(f.time.record).not.toHaveBeenCalled();
});
it("submits confirmed begin once and redirects to its exact persisted receipt", async () => {
  const f = fixture(),
    response = await f.post(`/operator/support-time/${id}/begin`, form);
  expect(response.status).toBe(303);
  expect(response.headers.location).toBe(href);
  expect(f.time.begin).toHaveBeenCalledExactlyOnceWith(token, scope, key);
});
it.each([false, true])(
  "passes parsed support and preparation=%s intervals to the authorized boundary",
  async (prep) => {
    const f = fixture(),
      preparationStart = "2026-10-03T01:10:00.000Z",
      preparationEnd = "2026-10-03T01:15:00.000Z";
    const response = await f.post(`/operator/support-time/${id}/record`, {
      ...record,
      ...(prep ? { preparationStart, preparationEnd } : {}),
    });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(href);
    expect(f.time.record).toHaveBeenCalledExactlyOnceWith(token, scope, key, {
      supportStart: new Date(record.supportStart),
      supportEnd: new Date(record.supportEnd),
      preparationStart: prep ? new Date(preparationStart) : null,
      preparationEnd: prep ? new Date(preparationEnd) : null,
    });
  },
);
it.each([
  "denied",
  "unavailable",
  "withdrawn",
  "conflict",
  "insufficient",
] as const)(
  "withholds successful begin/record navigation for %s",
  async (kind) => {
    const f = fixture();
    for (const action of ["begin", "record"] as const) {
      f.time[action].mockResolvedValue({ kind });
      expect(
        (
          await f.post(
            `/operator/support-time/${id}/${action}`,
            action === "begin" ? form : record,
          )
        ).status,
      ).toBe(
        {
          denied: 403,
          unavailable: 503,
          withdrawn: 410,
          conflict: 409,
          insufficient: 409,
        }[kind],
      );
    }
  },
);
it("withholds mutation success after an unexpected store failure and never retries", async () => {
  const f = fixture();
  f.time.record.mockRejectedValue(Error("Private database diagnostic"));
  const response = await f.post(`/operator/support-time/${id}/record`, record);
  expect(response.status).toBe(503);
  expect(response.text).toContain("Nothing is retried automatically");
  expect(response.text).not.toContain("Private database diagnostic");
  expect(response.text).toContain('href="/operator/support-time"');
  expect(f.time.record).toHaveBeenCalledTimes(1);
});
it("requires a bounded whole ceiling and explicit member confirmation before holding minutes", async () => {
  const f = fixture(),
    valid = {
      csrf: "trusted-csrf",
      idempotencyKey: key,
      ceiling: "20",
      confirm: "yes",
    };
  for (const change of [
    { csrf: undefined },
    { idempotencyKey: "bad" },
    { ceiling: undefined },
    { ceiling: "0" },
    { ceiling: "121" },
    { ceiling: "1.5" },
    { ceiling: "01" },
    { confirm: "no" },
    { memberId: "forged" },
  ])
    expect(
      (await f.post(`/support/${id}/time/allocate`, { ...valid, ...change }))
        .status,
    ).toBe(422);
  expect(
    (await f.post(`/support/${id}/time/allocate?owner=forged`, valid)).status,
  ).toBe(422);
  expect((await f.post("/support/invalid/time/allocate", valid)).status).toBe(
    422,
  );
  expect(f.time.allocate).not.toHaveBeenCalled();
  const response = await f.post(`/support/${id}/time/allocate`, valid);
  expect(response.status).toBe(303);
  expect(response.headers.location).toBe(`/support/${id}`);
  expect(f.time.allocate).toHaveBeenCalledExactlyOnceWith(token, id, key, 20);
});
it.each([
  "denied",
  "unavailable",
  "withdrawn",
  "conflict",
  "insufficient",
] as const)(
  "handles allocation/cancellation %s without falsely showing applied success",
  async (kind) => {
    const f = fixture();
    f.time.allocate.mockResolvedValue({ kind });
    f.time.cancel.mockResolvedValue({ kind });
    const code = {
      denied: 403,
      unavailable: 503,
      withdrawn: 410,
      conflict: 409,
      insufficient: 409,
    }[kind];
    expect(
      (
        await f.post(`/support/${id}/time/allocate`, {
          csrf: "trusted-csrf",
          idempotencyKey: key,
          ceiling: "20",
          confirm: "yes",
        })
      ).status,
    ).toBe(code);
    expect(
      (
        await f.post(`/support/${id}/time/${allocationId}/cancel`, {
          csrf: "trusted-csrf",
          confirm: "yes",
        })
      ).status,
    ).toBe(code);
  },
);
it("requires deliberate cancellation of the exact owned unstarted allocation", async () => {
  const f = fixture(),
    path = `/support/${id}/time/${allocationId}/cancel`,
    valid = { csrf: "trusted-csrf", confirm: "yes" };
  for (const change of [
    { csrf: undefined },
    { confirm: "no" },
    { memberId: "forged" },
  ])
    expect((await f.post(path, { ...valid, ...change })).status).toBe(422);
  for (const bad of [
    `${path}?owner=forged`,
    `/support/invalid/time/${allocationId}/cancel`,
    `/support/${id}/time/invalid/cancel`,
  ])
    expect((await f.post(bad, valid)).status).toBe(422);
  expect(f.time.cancel).not.toHaveBeenCalled();
  const response = await f.post(path, valid);
  expect(response.status).toBe(303);
  expect(response.headers.location).toBe(`/support/${id}`);
  expect(f.time.cancel).toHaveBeenCalledExactlyOnceWith(
    token,
    id,
    allocationId,
  );
});
it("does not confer time routes on a provider that lacks time support", async () => {
  const f = fixture(false);
  for (const path of ["/operator/support-time", href])
    expect((await f.get(path)).status).toBe(403);
  for (const path of [
    `/operator/support-time/${id}/begin`,
    `/operator/support-time/${id}/record`,
    `/support/${id}/time/allocate`,
    `/support/${id}/time/${allocationId}/cancel`,
  ])
    expect((await f.post(path, form)).status).toBe(403);
  expect(f.time.allocate).not.toHaveBeenCalled();
  expect(f.time.begin).not.toHaveBeenCalled();
});
