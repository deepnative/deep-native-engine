import { expect, it, vi } from "vitest";
import request from "supertest";
import type { Pool } from "pg";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import { hash } from "../../src/store.ts";
import type { ApplicationMode } from "../../src/adapters.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
import {
  disabledSampleHoldCancellationStore,
  sampleHoldCancellationStore,
  type SampleHoldCancellationStore,
  type StaffCancellation,
  type StaffHeldSample,
} from "../../src/sample-hold-cancellations.ts";
import {
  cancelPath,
  staffCancelFailurePage,
  staffSampleHoldsPage,
} from "../../src/sample-hold-cancellation-views.ts";
import { sampleHoldReceiptPage } from "../../src/views.ts";
import {
  coachPracticeSection,
  coachPracticeState,
} from "../../src/coach-practice-views.ts";

const token = "a".repeat(64),
  secret = "invented-staff-cancel-route-secret",
  origin = "http://127.0.0.1:3000",
  holdId = "11111111-1111-4111-8111-111111111111",
  requestId = "22222222-2222-4222-8222-222222222222",
  slotId = "33333333-3333-4333-8333-333333333333",
  cancellationId = "44444444-4444-4444-8444-444444444444",
  path = cancelPath(holdId);
const held: StaffHeldSample = {
  holdId,
  slotId,
  domain: "education",
  serviceType: "coaching",
  startsAt: new Date("2026-11-12T15:00:00Z"),
  endsAt: new Date("2026-11-12T16:00:00Z"),
  expiresAt: new Date("2026-11-09T15:10:00Z"),
};
const cancellation: StaffCancellation = {
  holdId,
  slotId,
  startsAt: held.startsAt,
  endsAt: held.endsAt,
  reason: "coach-unavailable",
  cancelledAt: new Date("2026-11-09T15:05:00Z"),
  replacementMinutes: 60,
  replacementStartsAt: new Date("2026-11-01T00:00:00Z"),
  replacementExpiresAt: new Date("2026-11-30T00:00:00Z"),
  cancelledByReader: true,
};

function fixture(mode: ApplicationMode = "test") {
  const session = vi.fn<Store["session"]>().mockResolvedValue({ kind: "new" });
  const list = vi
    .fn<SampleHoldCancellationStore["list"]>()
    .mockResolvedValue({ kind: "ready", held: [held], recent: [] });
  const cancel = vi
    .fn<SampleHoldCancellationStore["cancel"]>()
    .mockResolvedValue({ kind: "applied", cancellation });
  const application = app({ session } as unknown as Store, {
    origin,
    secret,
    mode,
    sampleHoldCancellations: { list, cancel },
  });
  const get = (to = "/operator/sample-holds") =>
    withLoopback(application, (server) =>
      request(server)
        .get(to)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${token}`),
    );
  const post = (
    fields: Record<string, unknown> = {
      requestId,
      reason: "coach-unavailable",
    },
    to = path,
    form = { csrf: csrf(token, secret) },
  ) =>
    withLoopback(application, (server) =>
      request(server)
        .post(to)
        .set("Host", "127.0.0.1:3000")
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${token}`)
        .type("form")
        .send({ ...form, ...fields }),
    );
  return { get, post, list, cancel };
}

it("STAFFCANCEL-01 lists held samples with one fresh cancel form each and no member identity", async () => {
  const f = fixture();
  const page = await f.get();
  expect(page.status).toBe(200);
  expect(page.headers["cache-control"]).toBe("no-store");
  expect(page.text).toContain(`Slot ${slotId}`);
  expect(page.text).toContain(`action="${path}"`);
  expect(page.text).toContain("Cancel sample hold as staff");
  expect(page.text).toContain("never bookings");
  expect(page.text).toContain("Members are not named here");
  expect(page.text).toMatch(/name="requestId" value="[0-9a-f-]{36}"/);
  expect(page.text).toContain("No sample hold has been cancelled by staff");
  expect(page.text).not.toContain(token);
  expect(f.list).toHaveBeenCalledExactlyOnceWith(token);
  f.list.mockResolvedValue({
    kind: "ready",
    held: [],
    recent: [{ ...cancellation, cancelledByReader: false }],
  });
  const empty = await f.get();
  expect(empty.text).toContain("No sample hold is currently held");
  expect(empty.text).toContain("by another staff member");
  expect(empty.text).toContain("The coach is unavailable");
  expect(empty.text).not.toContain("<form");
});

it.each([
  ["denied", 403],
  ["unavailable", 503],
] as const)(
  "STAFFCANCEL-06 reports a %s list as %i and discloses nothing",
  async (kind, status) => {
    const f = fixture();
    f.list.mockResolvedValue({ kind });
    const page = await f.get();
    expect(page.status).toBe(status);
    expect(page.text).not.toContain(slotId);
    expect(page.text).not.toContain("<form");
  },
);

it("refuses query parameters on the list", async () => {
  const f = fixture();
  expect((await f.get("/operator/sample-holds?member=x")).status).toBe(400);
  expect(f.list).not.toHaveBeenCalled();
});

it("STAFFCANCEL-01/04 applies a cancellation once and reports a replay without a second credit", async () => {
  const f = fixture();
  const applied = await f.post();
  expect(applied.status).toBe(201);
  expect(applied.text).toContain(
    "Sample hold cancelled. One replacement credit was added.",
  );
  expect(applied.text).toContain("60 test minutes");
  expect(applied.text).toContain(
    `datetime="${cancellation.replacementExpiresAt.toISOString()}"`,
  );
  expect(applied.text).toContain("by you");
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith(
    token,
    holdId,
    requestId,
    "coach-unavailable",
  );
  f.cancel.mockResolvedValue({ kind: "replayed", cancellation });
  const replayed = await f.post();
  expect(replayed.status).toBe(200);
  expect(replayed.text).toContain(
    "This cancellation was already recorded. No second credit was added.",
  );
});

it.each([
  ["stale", 409, "This hold changed since the page was opened"],
  ["ended", 409, "reached the end of its dates"],
  ["conflict", 409, "already used for a different cancellation"],
  ["denied", 403, "need current operator access"],
  ["invalid", 400, "Choose one of the listed reasons"],
  ["unavailable", 503, "could not be confirmed"],
] as const)(
  "STAFFCANCEL-05/06/07 reports a %s cancellation as %i",
  async (kind, status, text) => {
    const f = fixture();
    f.cancel.mockResolvedValue({ kind });
    const page = await f.post();
    expect(page.status).toBe(status);
    expect(page.text).toContain(text);
    expect(page.text).toContain("Nothing");
  },
);

it("STAFFCANCEL-08 refuses extra fields, missing fields, queries and a missing CSRF token before the store", async () => {
  const f = fixture();
  for (const fields of [
    { requestId, reason: "coach-unavailable", memberId: "x" },
    { requestId },
    { reason: "coach-unavailable" },
  ])
    expect((await f.post(fields)).status).toBe(400);
  expect((await f.post(undefined, `${path}?x=1`)).status).toBe(400);
  expect(
    (
      await f.post(
        { requestId, reason: "coach-unavailable" },
        path,
        {} as never,
      )
    ).status,
  ).toBe(403);
  expect(f.cancel).not.toHaveBeenCalled();
});

it("STAFFCANCEL-09 is unavailable on a live site and when no store is configured", async () => {
  const f = fixture("live");
  expect((await f.get()).status).toBe(404);
  expect((await f.post()).status).toBe(404);
  expect(f.list).not.toHaveBeenCalled();
  expect(f.cancel).not.toHaveBeenCalled();
  const bare = app(
    {
      session: vi.fn().mockResolvedValue({ kind: "new" }),
    } as unknown as Store,
    { origin, secret, mode: "test" },
  );
  const page = await withLoopback(bare, (server) =>
    request(server)
      .get("/operator/sample-holds")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
  expect(page.status).toBe(503);
  const disabled = disabledSampleHoldCancellationStore();
  expect(await disabled.list(token)).toEqual({ kind: "unavailable" });
  expect(await disabled.cancel(token, holdId, requestId, "x")).toEqual({
    kind: "unavailable",
  });
});

it("views escape values and offer no back link to a denied reader", () => {
  const html = staffSampleHoldsPage({
    held: [{ ...held, domain: "<b>x</b>" }],
    recent: [],
    csrf: "c",
    requestIds: { [holdId]: requestId },
  });
  expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(staffCancelFailurePage("denied")).not.toContain("Read a fresh list");
  expect(staffCancelFailurePage("stale")).toContain("Read a fresh list");
});

// A fake pool: authority, then the function call, then the read-back.
function fakePool(script: {
  staff?: boolean;
  call?: unknown;
  readBack?: unknown[];
  connectFails?: boolean;
  rollbackFails?: boolean;
}) {
  const released: unknown[] = [];
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql === "ROLLBACK" && script.rollbackFails) throw new Error("gone");
      if (sql.includes("authorized_staff_profiles"))
        return { rows: script.staff === false ? [] : [{ id: "staff-1" }] };
      if (sql.includes("synthetic_slot_holds h\n JOIN synthetic_member"))
        return { rows: [held] };
      if (sql.includes("WHERE c.id=$2"))
        return { rows: script.readBack ?? [cancellation] };
      if (sql.includes("sample_hold_staff_cancellations")) return { rows: [] };
      return { rows: [] };
    }),
    release: vi.fn((error?: unknown) => released.push(error)),
  };
  const pool = {
    connect: vi.fn(async () => {
      if (script.connectFails) throw new Error("no connection");
      return client;
    }),
    query: vi.fn(async (sql: string, values: unknown[]) => {
      queries.push(sql);
      if (script.call instanceof Error) throw script.call;
      expect(values[0]).toBe(hash(token));
      return { rows: script.call === undefined ? [] : [script.call] };
    }),
  };
  return { pool: pool as unknown as Pool, queries, released };
}

it("STAFFCANCEL store lists only for staff and rolls the read back", async () => {
  const ok = fakePool({});
  const store = sampleHoldCancellationStore(ok.pool, { mode: "test" });
  expect(await store.list(token)).toEqual({
    kind: "ready",
    held: [held],
    recent: [],
  });
  expect(ok.queries).toContain("ROLLBACK");
  expect(ok.released).toEqual([undefined]);
  expect(
    await sampleHoldCancellationStore(fakePool({ staff: false }).pool, {
      mode: "test",
    }).list(token),
  ).toEqual({ kind: "denied" });
  expect(await store.list("not-a-token")).toEqual({ kind: "denied" });
  expect(
    await sampleHoldCancellationStore(fakePool({ connectFails: true }).pool, {
      mode: "test",
    }).list(token),
  ).toEqual({ kind: "unavailable" });
  const broken = fakePool({ rollbackFails: true });
  expect(
    await sampleHoldCancellationStore(broken.pool, { mode: "test" }).list(
      token,
    ),
  ).toEqual({ kind: "unavailable" });
  expect(broken.released[0]).toBeInstanceOf(Error);
  expect(
    await sampleHoldCancellationStore(ok.pool, { mode: "live" }).list(token),
  ).toEqual({ kind: "unavailable" });
});

it("STAFFCANCEL store maps the function's outcome and never reports an unread write as denied", async () => {
  const run = (
    script: Parameters<typeof fakePool>[0],
    reason = "coach-unavailable",
  ) =>
    sampleHoldCancellationStore(fakePool(script).pool, { mode: "test" }).cancel(
      token,
      holdId,
      requestId,
      reason,
    );
  expect(
    await run({ call: { cancellation_id: cancellationId, replayed: false } }),
  ).toEqual({ kind: "applied", cancellation });
  expect(
    await run({ call: { cancellation_id: cancellationId, replayed: true } }),
  ).toEqual({ kind: "replayed", cancellation });
  for (const [code, kind] of [
    ["DN001", "invalid"],
    ["DN002", "denied"],
    ["DN004", "stale"],
    ["DN005", "conflict"],
    ["DN006", "ended"],
    ["57014", "unavailable"],
  ])
    expect(
      await run({ call: Object.assign(new Error(code), { code }) }),
    ).toEqual({ kind });
  expect(await run({ call: new Error("no code") })).toEqual({
    kind: "unavailable",
  });
  expect(await run({})).toEqual({ kind: "unavailable" });
  expect(
    await run({
      call: { cancellation_id: cancellationId, replayed: false },
      readBack: [],
    }),
  ).toEqual({ kind: "unavailable" });
  expect(
    await run({
      call: { cancellation_id: cancellationId, replayed: false },
      staff: false,
    }),
  ).toEqual({ kind: "unavailable" });
  expect(await run({}, "free text")).toEqual({ kind: "invalid" });
  const store = sampleHoldCancellationStore(fakePool({}).pool, {
    mode: "test",
  });
  expect(await store.cancel("x", holdId, requestId, "member-request")).toEqual({
    kind: "denied",
  });
  expect(await store.cancel(token, "x", requestId, "member-request")).toEqual({
    kind: "invalid",
  });
  expect(await store.cancel(token, holdId, "x", "member-request")).toEqual({
    kind: "invalid",
  });
  expect(
    await sampleHoldCancellationStore(fakePool({}).pool, {
      mode: "live",
    }).cancel(token, holdId, requestId, "member-request"),
  ).toEqual({ kind: "unavailable" });
});

it("STAFFCANCEL-02 the member's receipt names the cancellation, its reason and the replacement dates", () => {
  const receipt = {
    id: requestId,
    slotId,
    domain: "education",
    serviceType: "coaching" as const,
    startsAt: held.startsAt,
    endsAt: held.endsAt,
    expiresAt: held.expiresAt,
    state: "cancelled" as const,
    quantity: 60,
    cancellation: {
      reason: "member-request" as const,
      cancelledAt: "2026-11-09T15:05:00.000Z",
      replacementMinutes: 60,
      replacementStartsAt: "2026-11-01T00:00:00.000Z",
      replacementExpiresAt: "2026-11-30T00:00:00.000Z",
    },
  };
  const html = sampleHoldReceiptPage(receipt, "America/Toronto", "csrf");
  expect(html).toContain("<dd>cancelled by staff</dd>");
  expect(html).toContain(
    "Staff cancelled this sample hold: you asked staff to cancel it.",
  );
  expect(html).toContain('datetime="2026-11-01T00:00:00.000Z"');
  expect(html).toContain('datetime="2026-11-30T00:00:00.000Z"');
  expect(html).not.toContain("Withdraw sample hold");
  expect(
    sampleHoldReceiptPage({
      ...receipt,
      cancellation: { ...receipt.cancellation, reason: "other" as never },
    }),
  ).toContain("no reason was recorded");
  expect(sampleHoldReceiptPage({ ...receipt, cancellation: null })).toContain(
    "Its replacement credit could not be shown",
  );
  const practice = coachPracticeSection(
    coachPracticeState({ grants: [], receipts: [receipt] }),
  );
  expect(practice).toContain("Cancelled by staff, with a replacement credit");
});

it("STAFFCANCEL-08 refuses a header-authenticated post without a form body", async () => {
  const f = fixture();
  const application = app(
    { session: vi.fn().mockResolvedValue({ kind: "new" }) } as unknown as Store,
    {
      origin,
      secret,
      mode: "test",
      sampleHoldCancellations: { list: f.list, cancel: f.cancel },
    },
  );
  const page = await withLoopback(application, (server) =>
    request(server)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .set("x-csrf-token", csrf(token, secret)),
  );
  expect(page.status).toBe(400);
  expect(f.cancel).not.toHaveBeenCalled();
});
