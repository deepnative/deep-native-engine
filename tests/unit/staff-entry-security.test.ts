import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import type { StaffEntryResult } from "../../src/staff-entry.ts";
import { STAFF_ROLES } from "../../src/authorization.ts";
import { entryNonce, entryCsrf } from "../../src/staff-entry-integrity.ts";
import { COOKIE } from "../../src/session.ts";
import { disabledCatalogStore } from "../../src/catalog.ts";
import { disabledSupportRequestStore } from "../../src/support-requests.ts";
import { disabledTrackStore } from "../../src/track-readiness.ts";
import { disabledMetricsStore } from "../../src/metrics.ts";
import { disabledLedgerReconciliationStore } from "../../src/ledger-reconciliation.ts";
import { disabledCircleDiscussionStore } from "../../src/circle-discussion.ts";
import { disabledProposalStore } from "../../src/proposals.ts";
import { disabledManualObservationStore } from "../../src/manual-observations.ts";
import { disabledLocalAiHoldInspectionStore } from "../../src/local-ai-hold-inspection.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
const origin = "http://127.0.0.1:3000",
  host = "127.0.0.1:3000",
  secret = "synthetic-staff-routes",
  credential = "a".repeat(64),
  legacy = "b".repeat(64);
let server: Server;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await closeLoopback(server);
});
async function fixture(
  extra: Partial<Parameters<typeof app>[1]> = {},
  full = false,
) {
  const admit = vi
    .fn<() => Promise<StaffEntryResult>>()
    .mockImplementation(async () => ({
      kind: "ready",
      role: "operator",
      deadline: performance.now() + 60000,
    }));
  const create = vi.fn(),
    session = vi.fn().mockResolvedValue({ kind: "missing" });
  const options: Parameters<typeof app>[1] = {
    origin,
    secret,
    mode: "test",
    localStaffEntry: true,
    staffEntry: { admit },
    ...(full
      ? {
          catalog: disabledCatalogStore(),
          reviewerWorklist: { list: vi.fn() },
          supportRequests: {
            ...disabledSupportRequestStore(),
            time: {
              writesEnabled: false,
              allocate: vi.fn(),
              cancel: vi.fn(),
              begin: vi.fn(),
              record: vi.fn(),
              grant: vi.fn(),
              revoke: vi.fn(),
              receipt: vi.fn(),
              operatorWorklist: vi.fn(),
              operatorDetail: vi.fn(),
            },
          },
          tracks: disabledTrackStore(),
          metrics: disabledMetricsStore(),
          ledgerReconciliation: disabledLedgerReconciliationStore(),
          localHoldInspection: disabledLocalAiHoldInspectionStore(),
          localHoldInspectionReads: true,
          proposals: disabledProposalStore(),
          circleDiscussionEnabled: true,
          circleDiscussion: disabledCircleDiscussionStore(),
          localAiControl: { current: vi.fn(), read: vi.fn(), set: vi.fn() },
          manualObservations: disabledManualObservationStore(),
        }
      : {}),
    ...extra,
  };
  server = await listenLoopback(
    app({ create, session } as unknown as Store, options),
  );
  return { admit, create, session };
}
const get = (path: string, cookie = "") =>
  request(server).get(path).set("Host", host).set("Cookie", cookie);
function post(
  path: string,
  fields: Record<string, unknown> = {},
  cookie?: string,
  source = origin,
) {
  const nonce = entryNonce(secret);
  return request(server)
    .post(path)
    .set("Host", host)
    .set("Origin", source)
    .set("Cookie", cookie ?? `dne_staff_entry=${nonce}`)
    .type("form")
    .send({ csrf: entryCsrf(nonce, secret), ...fields });
}
const fields = (text: string) =>
  text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
it.each(STAFF_ROLES)(
  "STAFF-01-ROLES renders truthful %s tools from current database role only",
  async (role) => {
    const f = await fixture({}, true);
    f.admit.mockImplementation(async () => ({
      kind: "ready",
      role,
      deadline: performance.now() + 60000,
    }));
    const r = await get("/staff", `dne_staff=${credential}`).expect(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const expected = {
      coach: [],
      editor: ["/editor/library"],
      reviewer: ["/editor/library", "/review/worklist"],
      operator: [
        "/operator/support",
        "/operator/support-time",
        "/operator/experts",
        "/operator/metrics",
        "/operator/ledger-reconciliation",
        "/operator/local-ai-holds",
      ],
      moderator: ["/moderate/proposals", "/moderate/circles/"],
      platform_admin: [
        "/operator/support",
        "/operator/support-time",
        "/operator/experts",
        "/operator/metrics",
        "/operator/ledger-reconciliation",
        "/moderate/proposals",
        "/moderate/circles/",
        "/operator/local-ai",
        "/operator/test-receipts",
      ],
    }[role];
    for (const path of expected) expect(r.text).toContain(`href="${path}`);
    if (role === "coach") expect(r.text).toContain("No browser tools");
    if (role !== "editor" && role !== "reviewer")
      expect(r.text).not.toContain('href="/editor/library"');
    if (role !== "operator")
      expect(r.text).not.toContain('href="/operator/local-ai-holds"');
    if (role !== "platform_admin")
      expect(r.text).not.toContain('href="/operator/local-ai"');
    expect(r.text).not.toContain(credential);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.session).not.toHaveBeenCalled();
  },
);
it("STAFF-01-ROLES omits unavailable tools and allows only already established legacy entry when explicit state is absent", async () => {
  const f = await fixture();
  const r = await get("/staff", `${COOKIE}=${legacy}`).expect(200);
  expect(r.text).toContain("No browser tools");
  expect(f.admit).toHaveBeenCalledWith(legacy);
  await get("/staff", `${COOKIE}=${legacy}; dne_staff=signed-out`).expect(403);
  await get("/staff").expect(403);
  expect(f.admit).toHaveBeenCalledTimes(1);
});
it("STAFF-01-ROLES support without optional test-effort capability advertises only the available request tool", async () => {
  await fixture({ supportRequests: disabledSupportRequestStore() });
  const r = await get("/staff", `dne_staff=${credential}`).expect(200);
  expect(r.text).toContain('href="/operator/support"');
  expect(r.text).not.toContain('href="/operator/support-time"');
});
it("STAFF-01-ROLES enabled circle flag without a discussion capability does not advertise unavailable moderation", async () => {
  const f = await fixture({ circleDiscussionEnabled: true });
  f.admit.mockImplementation(async () => ({
    kind: "ready",
    role: "moderator",
    deadline: performance.now() + 60000,
  }));
  const r = await get("/staff", `dne_staff=${credential}`).expect(200);
  expect(r.text).not.toContain('href="/moderate/circles/');
});
it.each([
  { localStaffEntry: false },
  { localStaffEntry: undefined },
  { mode: "live" as const },
])(
  "STAFF-05-OFF disabled or live entry never invokes admission",
  async (options) => {
    const f = await fixture(options);
    for (const path of ["/staff", "/staff/sign-in", "/staff/sign-out"]) {
      await get(path).expect(404);
      await post(path, { credential }).expect(404);
    }
    expect(f.admit).not.toHaveBeenCalled();
  },
);
it("STAFF-01-ENTRY admits through the secret form with only a separate HttpOnly Strict staff cookie and fixed redirect", async () => {
  const f = await fixture();
  const form = await get("/staff/sign-in").expect(200);
  const nonce = (form.headers["set-cookie"] as unknown as string[])[0]!.split(
    ";",
  )[0]!;
  const signed = await request(server)
    .post("/staff/sign-in")
    .set("Host", host)
    .set("Origin", origin)
    .set("Cookie", `${COOKIE}=${legacy}; ${nonce}`)
    .type("form")
    .send({ csrf: fields(form.text), credential })
    .expect(303)
    .expect("Location", "/staff");
  const cookies = (signed.headers["set-cookie"] as unknown as string[]).join(
    " ",
  );
  expect(cookies).toContain(`dne_staff=${credential}`);
  expect(cookies).toContain("HttpOnly");
  expect(cookies).toContain("SameSite=Strict");
  expect(cookies).not.toContain(COOKIE + "=");
  expect(signed.text).not.toContain(credential);
  expect(f.admit).toHaveBeenCalledWith(credential);
  expect(f.create).not.toHaveBeenCalled();
});
it("STAFF-05-INTEGRITY denies malformed/duplicated/unexpected fields, nonce, Origin and Host without admitting or clearing staff", async () => {
  const f = await fixture();
  for (const payload of [
    { credential: "bad" },
    { credential: [credential, credential] },
    { credential, role: "platform_admin" },
    { credential, redirect: "https://evil.invalid" },
    { credential, csrf: ["a", "b"] },
    { credential, csrf: "bad" },
  ]) {
    const r = await post("/staff/sign-in", payload).expect(403);
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.text).not.toContain(credential);
  }
  for (const cookie of [
    "",
    "dne_staff_entry=bad",
    `dne_staff_entry=${entryNonce("wrong")}`,
    `dne_staff_entry=${entryNonce(secret)}; dne_staff_entry=${entryNonce(secret)}`,
    `dne_staff=${credential}; dne_staff=${credential}`,
  ])
    await post("/staff/sign-in", { credential }, cookie).expect(403);
  await post(
    "/staff/sign-in",
    { credential },
    undefined,
    "https://evil.invalid",
  ).expect(403);
  await post("/staff/sign-in", { credential }).unset("Origin").expect(403);
  await post("/staff/sign-in", { credential })
    .set("Host", "evil.invalid")
    .expect(403);
  await post("/staff/sign-out", { credential }).expect(403);
  await post(
    "/staff/sign-out",
    { csrf: "forged" },
    `dne_staff=${credential}`,
  ).expect(403);
  await post("/staff/sign-in", { credential: "a".repeat(17000) }).expect(413);
  expect(f.admit).not.toHaveBeenCalled();
});
it("STAFF-03-AMBIGUITY refuses relevant raw-cookie ambiguity and arbitrary entry query fields", async () => {
  const f = await fixture();
  for (const cookie of [
    `dne_staff=${credential}; dne_staff=${credential}`,
    `dne_staff=${credential}; dne_staff=${legacy}`,
    "dne_staff=malformed",
    "dne_staff=%xx",
    "dne_staff_entry=a; dne_staff_entry=a",
  ]) {
    await get("/staff/sign-in", cookie).expect(403);
    await get("/staff", cookie).expect(403);
  }
  await get("/staff/sign-in?role=admin").expect(403);
  expect(f.admit).not.toHaveBeenCalled();
});
it.each(["denied", "unavailable", "throw", "late"])(
  "STAFF-03-SECRETS STAFF-06-EXPIRY %s result emits no credential/private portal output",
  async (kind) => {
    const f = await fixture();
    f.admit.mockImplementation(async () => {
      if (kind === "throw") throw Error(credential + "PRIVATE-ERROR");
      return kind === "late"
        ? {
            kind: "ready",
            role: "platform_admin",
            deadline: performance.now() - 1,
          }
        : { kind: kind as "denied" | "unavailable" };
    });
    for (const r of [
      await post("/staff/sign-in", { credential }),
      await get("/staff", `dne_staff=${credential}`),
    ]) {
      expect(r.status).toBe(kind === "denied" || kind === "late" ? 403 : 503);
      expect(r.text).not.toContain(credential);
      expect(r.text).not.toContain("PRIVATE-ERROR");
      expect(r.text).not.toContain("Platform administrator");
      expect(
        (r.headers["set-cookie"] as unknown as string[] | undefined)?.some(
          (c) => c.startsWith("dne_staff="),
        ) ?? false,
      ).toBe(false);
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  },
);
it("STAFF-06-FAULTS missing admission port is unavailable and signout still works", async () => {
  await fixture({ staffEntry: undefined });
  await post("/staff/sign-in", { credential }).expect(503);
  await get("/staff", `dne_staff=${credential}`).expect(503);
  await post("/staff/sign-out").expect(303);
});
it("STAFF-04-RECOVERY clears expired/revoked authority locally without admission, preserves learner and allows explicit re-entry", async () => {
  const f = await fixture();
  f.admit.mockResolvedValueOnce({ kind: "denied" });
  await get("/staff", `dne_staff=${credential}`).expect(403);
  const form = await get(
    "/staff/sign-in",
    `${COOKIE}=${legacy}; dne_staff=${credential}`,
  ).expect(200);
  const nonce = (form.headers["set-cookie"] as unknown as string[])[0]!.split(
    ";",
  )[0]!;
  const out = await request(server)
    .post("/staff/sign-out")
    .set("Host", host)
    .set("Origin", origin)
    .set("Cookie", `${COOKIE}=${legacy}; dne_staff=${credential}; ${nonce}`)
    .type("form")
    .send({ csrf: fields(form.text) })
    .expect(303);
  expect(
    (out.headers["set-cookie"] as unknown as string[]).some((c) =>
      c.startsWith(COOKIE + "="),
    ),
  ).toBe(false);
  expect(f.admit).toHaveBeenCalledTimes(1);
  await post(
    "/staff/sign-in",
    { credential },
    `dne_staff=signed-out; dne_staff_entry=${entryNonce(secret)}`,
  ).expect(403);
  const fresh = entryNonce(secret);
  await request(server)
    .post("/staff/sign-in")
    .set("Host", host)
    .set("Origin", origin)
    .set("Cookie", `dne_staff=signed-out; dne_staff_entry=${fresh}`)
    .type("form")
    .send({ credential, csrf: entryCsrf(fresh, secret) })
    .expect(303);
});
it("STAFF-01-ENTRY preserves secure-cookie handling for an HTTPS configured origin", async () => {
  await fixture({ origin: "https://127.0.0.1:3000" });
  const form = await get("/staff/sign-in").expect(200);
  expect((form.headers["set-cookie"] as unknown as string[])[0]).toContain(
    "Secure",
  );
  const nonce = (form.headers["set-cookie"] as unknown as string[])[0]!.split(
    ";",
  )[0]!;
  await request(server)
    .post("/staff/sign-in")
    .set("Host", host)
    .set("Origin", "https://127.0.0.1:3000")
    .set("Cookie", nonce)
    .type("form")
    .send({ credential, csrf: fields(form.text) })
    .expect(303);
});
