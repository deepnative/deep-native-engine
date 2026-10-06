import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { hash, migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { eventEnrollmentStore } from "../../src/event-enrollments.ts";
import { eventCancellationStore } from "../../src/event-cancellations.ts";
import type { EventPreview } from "../../src/events.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  scope = { eventId: "invented-cancelled-event", eventVersion: 1 };
const event: EventPreview = {
  id: scope.eventId,
  version: 1,
  status: "current",
  title: "Invented event",
  description: "Invented only",
  agenda: ["Compare invented notes"],
  goals: ["everyday"],
  domainTags: [],
  itRoles: [],
  startsAt: "2030-11-03T05:30:00.000Z",
  endsAt: "2030-11-03T06:30:00.000Z",
  fixtureCapacity: 1,
  localRegistration: true,
};
const cancellation = (
  writes = true,
  catalog: readonly EventPreview[] = [event],
) =>
  eventCancellationStore(pool, {
    mode: "test",
    writes,
    registration: true,
    catalog,
  });
const fresh = () => randomBytes(32).toString("hex");
beforeAll(() => migrate(pool));
beforeEach(() =>
  pool.query("TRUNCATE principals,private_event_inventory CASCADE"),
);
afterAll(() => pool.end());
async function admin() {
  const token = fresh(),
    id = await auth.provisionStaff(
      token,
      "platform_admin",
      new Date(Date.now() + 3600000),
    );
  return { token, id };
}
it("EVCANCEL-02/03 administrator cancels an enrolled version and member reads a retained cancellation separate from voluntary withdrawal", async () => {
  const owner = fresh(),
    a = await admin();
  await members.create(owner, { background: "professional", goal: "everyday" });
  const events = eventEnrollmentStore(pool, {
      mode: "test",
      enabled: true,
      catalog: [event],
    }),
    id = randomUUID();
  expect((await events.enroll(owner, event.id, 1, id)).kind).toBe("enrolled");
  const result = await cancellation().cancel(a.token, scope, randomUUID());
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Missing cancellation result");
  expect(
    await events.receipt(owner, id),
    "Existing owned receipt must now project cancellation without becoming withdrawn",
  ).toMatchObject({
    id,
    withdrawnAt: null,
    cancelledAt: result.value.receipt.cancelledAt,
  });
  expect(await events.withdraw(owner, id)).toBe("withdrawn");
  expect(await events.receipt(owner, id)).toMatchObject({
    id,
    cancelledAt: result.value.receipt.cancelledAt,
    withdrawnAt: expect.any(Date),
  });
  expect((await events.enroll(owner, event.id, 1, randomUUID())).kind).toBe(
    "unavailable",
  );
});
it("EVCANCEL-06/08 recovers only the creator's exact key while paused or retired, denies foreign-key payloads and new historical writes", async () => {
  const a = await admin(),
    b = await admin(),
    key = randomUUID(),
    service = cancellation();
  const created = await service.cancel(a.token, scope, key);
  expect(created.kind).toBe("ready");
  if (created.kind !== "ready") throw Error("Missing cancellation");
  const paused = cancellation(false, [{ ...event, status: "retired" }]);
  expect(await paused.cancel(a.token, scope, key)).toMatchObject({
    kind: "ready",
    value: { replayed: true, receipt: created.value.receipt },
  });
  expect(await paused.inspectOperation(a.token, scope, key)).toMatchObject({
    kind: "ready",
    value: created.value.receipt,
  });
  expect(await paused.inspect(b.token, scope)).toMatchObject({
    kind: "ready",
    value: created.value.receipt,
  });
  expect(await paused.cancel(a.token, scope, randomUUID())).toEqual({
    kind: "unavailable",
  });
  expect(await service.cancel(b.token, scope, key)).toEqual({
    kind: "conflict",
  });
  expect(
    await service.cancel(a.token, { ...scope, eventVersion: 2 }, key),
  ).toEqual({ kind: "conflict" });
  expect(
    await service.inspectOperation(a.token, scope, randomUUID()),
  ).toMatchObject({ kind: "ready", value: null });
  expect(
    (await pool.query("SELECT id FROM private_event_cancellations")).rows,
  ).toEqual([{ id: created.value.receipt.id }]);
});
it("EVCANCEL-02/06/07 materializes absent inventory atomically, keeps one canonical cancellation across keys and preserves it after actor erasure", async () => {
  const a = await admin(),
    key = randomUUID();
  expect(await cancellation(false).cancel(a.token, scope, key)).toEqual({
    kind: "unavailable",
  });
  expect(
    (await pool.query("SELECT event_id FROM private_event_inventory")).rows,
  ).toEqual([]);
  const created = await cancellation().cancel(a.token, scope, key);
  expect(created.kind).toBe("ready");
  if (created.kind !== "ready") throw Error("Missing invented cancellation");
  expect(
    await cancellation().cancel(a.token, scope, randomUUID()),
  ).toMatchObject({
    kind: "ready",
    value: { replayed: false, receipt: created.value.receipt },
  });
  expect(
    (
      await pool.query(
        "SELECT action FROM private_event_cancellation_operations ORDER BY action",
      )
    ).rows,
  ).toEqual([{ action: "already-cancelled" }, { action: "cancelled" }]);
  expect(
    await cancellation(true, [{ ...event, fixtureCapacity: 2 }]).cancel(
      a.token,
      scope,
      randomUUID(),
    ),
  ).toEqual({ kind: "conflict" });
  await pool.query("DELETE FROM principals WHERE id=$1", [a.id]);
  const b = await admin();
  expect(await cancellation().inspect(b.token, scope)).toMatchObject({
    kind: "ready",
    value: created.value.receipt,
  });
  expect(await cancellation().cancel(b.token, scope, key)).toEqual({
    kind: "conflict",
  });
  expect(
    (
      await pool.query(
        "SELECT actor_id FROM private_event_cancellation_operations",
      )
    ).rows,
  ).toEqual([{ actor_id: null }, { actor_id: null }]);
});

it("EVCANCEL-03/07 exports only owned cancelled registrations and keeps canonical cancellation after member erasure", async () => {
  const owner = fresh(),
    other = fresh(),
    a = await admin();
  await members.create(owner, { background: "professional", goal: "everyday" });
  await members.create(other, { background: "explorer", goal: "everyday" });
  const events = eventEnrollmentStore(pool, {
    mode: "test",
    enabled: true,
    catalog: [event],
  });
  const id = randomUUID();
  expect((await events.enroll(owner, event.id, 1, id)).kind).toBe("enrolled");
  const cancelled = await cancellation().cancel(a.token, scope, randomUUID());
  if (cancelled.kind !== "ready") throw Error("Missing cancellation");
  const exports = memberExportStore(pool);
  const own = await exports.exportOwned(owner);
  if (own.kind !== "ready") throw Error("Missing owned export");
  expect(
    JSON.parse(JSON.stringify(own.payload.records.eventEnrollments)),
  ).toEqual([
    expect.objectContaining({
      id,
      cancelledAt: cancelled.value.receipt.cancelledAt.toISOString(),
      withdrawnAt: null,
    }),
  ]);
  const foreign = await exports.exportOwned(other);
  if (foreign.kind !== "ready") throw Error("Missing other export");
  expect(foreign.payload.records.eventEnrollments).toEqual([]);
  expect(JSON.stringify(own.payload)).not.toContain(a.id);
  const session = await members.session(owner);
  if (session.kind !== "active") throw Error("Missing owned member session");
  await members.remove(session.learner.id);
  expect(await events.receipt(owner, id)).toBeNull();
  expect(await cancellation().inspect(a.token, scope)).toMatchObject({
    kind: "ready",
    value: cancelled.value.receipt,
  });
  expect((await events.enroll(other, event.id, 1, randomUUID())).kind).toBe(
    "unavailable",
  );
});

it("EVCANCEL-03/07 legacy signed cursor and bounded history preserve 105 withdrawn registration IDs after cancellation", async () => {
  const owner = fresh(),
    foreign = fresh(),
    a = await admin();
  await members.create(owner, { background: "technical", goal: "build" });
  await members.create(foreign, { background: "explorer", goal: "everyday" });
  const events = eventEnrollmentStore(pool, {
    mode: "test",
    enabled: true,
    catalog: [event],
  });
  const ids: string[] = [];
  for (let i = 0; i < 105; i++) {
    const id = randomUUID();
    expect((await events.enroll(owner, event.id, event.version, id)).kind).toBe(
      "enrolled",
    );
    expect(await events.withdraw(owner, id)).toBe("withdrawn");
    ids.push(id);
  }
  ids.sort();
  const secret = randomBytes(32),
    exporter = memberExportStore(pool, secret);
  const initial = await exporter.exportOwned(owner);
  expect(initial.kind).toBe("ready");
  if (initial.kind !== "ready") throw Error("Missing owned export");
  expect(initial.payload.page.complete).toBe(false);
  expect(initial.payload.page.recordCount).toBeLessThanOrEqual(100);
  const initialCursor = initial.payload.page.nextCursor!;
  // Existing cursor-v2 signing and section32 primary-key ordering must keep
  // their meaning. This encodes that retained prior-format contract explicitly.
  const body = Buffer.from(
    JSON.stringify([2, 32, [ids[49]], 2, Date.now() + 60000]),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(hash(owner))
    .update(".")
    .update(body)
    .digest("base64url");
  const legacyCursor = body + "." + signature;
  const cancelled = await cancellation().cancel(a.token, scope, randomUUID());
  if (cancelled.kind !== "ready") throw Error("Missing cancellation");
  const continued = await exporter.exportOwned(owner, initialCursor);
  expect(continued.kind).toBe("ready");
  if (continued.kind !== "ready") throw Error("Missing continuation");
  expect(continued.payload.page.complete).toBe(true);
  expect(continued.payload.records.eventEnrollments).toHaveLength(5);
  const legacy = await exporter.exportOwned(owner, legacyCursor);
  expect(legacy.kind).toBe("ready");
  if (legacy.kind !== "ready") throw Error("Missing legacy continuation");
  expect(legacy.payload.records.eventEnrollments!.map((row) => row.id)).toEqual(
    ids.slice(50),
  );
  expect(
    legacy.payload.records.eventEnrollments!.every(
      (row) =>
        row.withdrawnAt instanceof Date &&
        +new Date(row.cancelledAt as Date) ===
          +cancelled.value.receipt.cancelledAt,
    ),
  ).toBe(true);
  expect(await exporter.exportOwned(foreign, legacyCursor)).toEqual({
    kind: "denied",
  });
  expect(JSON.stringify(legacy)).not.toContain(a.id);
  expect(JSON.stringify(legacy)).not.toContain("idempotency");
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const history = await events.history(owner, cursor);
    if (!history) throw Error("Missing owned history");
    expect(history.items.length).toBeLessThanOrEqual(20);
    for (const row of history.items) {
      seen.push(row.id);
      expect(row.withdrawnAt).toBeInstanceOf(Date);
      expect(row.cancelledAt).toEqual(cancelled.value.receipt.cancelledAt);
    }
    cursor = history.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual(ids);
  expect((await events.history(foreign))?.items).toEqual([]);
}, 30000);
it("EVCANCEL-06 concurrent different keys share one canonical cancelled version", async () => {
  const a = await admin(),
    b = await admin(),
    keys = [randomUUID(), randomUUID()];
  const results = await Promise.all([
    cancellation().cancel(a.token, scope, keys[0]!),
    cancellation().cancel(b.token, scope, keys[1]!),
  ]);
  expect(results.every((result) => result.kind === "ready")).toBe(true);
  const receipts = results.map((result) => {
    if (result.kind !== "ready") throw Error("Missing concurrent receipt");
    return result.value.receipt.id;
  });
  expect(new Set(receipts).size).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int count FROM private_event_cancellations",
      )
    ).rows[0].count,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int count FROM private_event_cancellation_operations",
      )
    ).rows[0].count,
  ).toBe(2);
});
