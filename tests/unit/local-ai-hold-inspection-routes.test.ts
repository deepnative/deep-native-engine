import { expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import type { ApplicationMode } from "../../src/adapters.ts";
import { COOKIE } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
import {
  disabledLocalAiHoldInspectionStore,
  type LocalAiHoldInspectionStore,
} from "../../src/local-ai-hold-inspection.ts";
const token = "a".repeat(64),
  jobId = "11111111-1111-4111-8111-111111111111";
const item = {
  jobId,
  state: "needs-reconciliation" as const,
  status: "needs_reconciliation" as const,
  createdAt: "2026-10-05T12:00:00.000Z",
  updatedAt: "2026-10-05T12:01:00.000Z",
  leaseUntil: null,
  unitState: "reserved" as const,
  policy: "deterministic-request-test-v1" as const,
  promptTemplateVersion: "local-simulation-v1" as const,
  modelContractVersion: "deterministic-local-v1" as const,
};
function fixture(mode: ApplicationMode = "test") {
  const session = vi.fn<Store["session"]>().mockResolvedValue({ kind: "new" });
  const list = vi
    .fn<LocalAiHoldInspectionStore["list"]>()
    .mockResolvedValue({ kind: "ready", items: [item], next: null });
  const detail = vi
    .fn<LocalAiHoldInspectionStore["detail"]>()
    .mockResolvedValue({ kind: "ready", value: item });
  const application = app({ session } as unknown as Store, {
    origin: "http://127.0.0.1:3000",
    secret: "invented-hold-route-secret",
    mode,
    localHoldInspection: {
      ...disabledLocalAiHoldInspectionStore(),
      list,
      detail,
    },
  });
  const get = (path = "/operator/local-ai-holds", actor = token) =>
    withLoopback(application, (server) =>
      request(server)
        .get(path)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${actor}`),
    );
  return { get, list, detail, session };
}
it.each(["demo", "test"] as const)(
  "renders the assigned %s worklist and detail without member or source lookups",
  async (mode) => {
    const f = fixture(mode);
    const list = await f.get();
    expect(list.status).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    expect(list.text).toContain(jobId);
    expect(list.text).toContain("outcome unconfirmed");
    expect(list.text).not.toContain("<form");
    expect(list.text).not.toContain(token);
    expect(f.list).toHaveBeenCalledExactlyOnceWith(token, undefined);
    const detail = await f.get(`/operator/local-ai-holds/${jobId}`);
    expect(detail.status).toBe(200);
    expect(detail.headers["cache-control"]).toBe("no-store");
    expect(f.detail).toHaveBeenCalledExactlyOnceWith(token, jobId);
    expect(f.session).not.toHaveBeenCalled();
  },
);
it("never invokes inspection in live mode", async () => {
  const f = fixture("live");
  expect((await f.get()).status).toBe(404);
  expect((await f.get(`/operator/local-ai-holds/${jobId}`)).status).toBe(404);
  expect(f.list).not.toHaveBeenCalled();
  expect(f.detail).not.toHaveBeenCalled();
});
it.each([
  "?member_id=other",
  "?source=foreign",
  "?after=a&after=b",
  "?unexpected=1",
])("rejects malformed or additional query %s before lookup", async (query) => {
  const f = fixture();
  expect((await f.get(`/operator/local-ai-holds${query}`)).status).toBe(400);
  expect(f.list).not.toHaveBeenCalled();
});
it.each(["denied", "invalid", "unavailable"] as const)(
  "reports %s without exposing a private payload",
  async (kind) => {
    const f = fixture();
    f.list.mockResolvedValue({ kind });
    const response = await f.get();
    expect(response.status).toBe(
      kind === "denied" ? 403 : kind === "invalid" ? 400 : 503,
    );
    expect(response.text).not.toContain(jobId);
    expect(response.text).not.toContain(token);
    expect(response.headers["cache-control"]).toBe("no-store");
  },
);
it("contains unexpected inspection errors without printing their message", async () => {
  const f = fixture();
  f.list.mockRejectedValue(Error("PRIVATE-PROVIDER-DIAGNOSTIC"));
  f.detail.mockRejectedValue(Error("PRIVATE-SOURCE-DIAGNOSTIC"));
  const list = await f.get(),
    detail = await f.get(`/operator/local-ai-holds/${jobId}`);
  expect(list.status).toBe(503);
  expect(detail.status).toBe(503);
  expect(list.text).not.toContain("PRIVATE-PROVIDER-DIAGNOSTIC");
  expect(detail.text).not.toContain("PRIVATE-SOURCE-DIAGNOSTIC");
});
it("does not render unexpected fields returned by a compromised inspection port", async () => {
  const f = fixture();
  const contaminated = {
    ...item,
    rawSource: "PRIVATE-UNEXPECTED-SOURCE",
    memberId: "PRIVATE-UNEXPECTED-IDENTITY",
  };
  f.list.mockResolvedValue({
    kind: "ready",
    items: [contaminated],
    next: null,
  });
  const response = await f.get();
  expect(response.status).toBe(200);
  expect(response.text).not.toContain("PRIVATE-UNEXPECTED-SOURCE");
  expect(response.text).not.toContain("PRIVATE-UNEXPECTED-IDENTITY");
});

it.each(["denied", "invalid", "unavailable"] as const)(
  "withholds %s detail snapshots",
  async (kind) => {
    const f = fixture();
    f.detail.mockResolvedValue({ kind });
    const response = await f.get(`/operator/local-ai-holds/${jobId}`);
    expect(response.status).toBe(
      kind === "denied" ? 403 : kind === "invalid" ? 400 : 503,
    );
    expect(response.text).not.toContain(jobId);
  },
);
it("rejects detail query filters without lookup and passes the scalar list continuation", async () => {
  const f = fixture();
  expect(
    (await f.get(`/operator/local-ai-holds/${jobId}?member=other`)).status,
  ).toBe(400);
  expect(f.detail).not.toHaveBeenCalled();
  expect((await f.get("/operator/local-ai-holds?after=invented")).status).toBe(
    200,
  );
  expect(f.list).toHaveBeenCalledWith(token, "invented");
});
it("renders empty pages, continuation and truthful expired/terminal snapshots with escaped metadata", async () => {
  const f = fixture();
  f.list.mockResolvedValue({ kind: "ready", items: [], next: "invented?&" });
  let response = await f.get();
  expect(response.text).toContain("No currently assigned unconfirmed request");
  expect(response.text).toContain("after=invented%3F%26");
  f.detail.mockResolvedValue({
    kind: "ready",
    value: { ...item, state: "expired-claim", leaseUntil: "<invented>" },
  });
  response = await f.get(`/operator/local-ai-holds/${jobId}`);
  expect(response.text).toContain("Expired claim: outcome unconfirmed");
  expect(response.text).toContain("&lt;invented&gt;");
  f.detail.mockResolvedValue({
    kind: "ready",
    value: {
      ...item,
      state: "not-unconfirmed",
      status: "succeeded",
      unitState: "consumed",
    },
  });
  response = await f.get(`/operator/local-ai-holds/${jobId}`);
  expect(response.text).toContain("No longer an unconfirmed started hold");
  expect(response.text).toContain("consumed");
});
