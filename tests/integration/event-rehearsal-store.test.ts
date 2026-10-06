import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store, hash } from "../../src/store.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { memberEventCatalog } from "../../src/member-event-catalog.ts";
import { eventEnrollmentStore } from "../../src/event-enrollments.ts";
import { eventCancellationStore } from "../../src/event-cancellations.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { eventRehearsalStore } from "../../src/event-rehearsals.ts";
import { eventCatalogReader } from "../../src/event-catalog.ts";
import {
  rehearsalSnapshot,
  REHEARSAL_TEMPLATE,
} from "../../src/event-rehearsal-values.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  auth = authorizationStore(pool);
const members = store(pool);
const enabled = eventRehearsalStore(pool, {
  mode: "test",
  writes: true,
  registration: true,
});
const paused = eventRehearsalStore(pool, {
  mode: "test",
  writes: false,
  registration: true,
});
const fresh = () => randomBytes(32).toString("hex");
const snapshot = (delay = 600000) =>
  rehearsalSnapshot({
    templateId: REHEARSAL_TEMPLATE.id,
    templateVersion: 1,
    startsAt: new Date(Date.now() + delay).toISOString(),
  })!;
async function admin() {
  const token = fresh();
  await auth.provisionStaff(
    token,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  return token;
}
beforeAll(() => migrate(pool));
beforeEach(() =>
  pool.query("TRUNCATE principals,private_event_inventory CASCADE"),
);
afterAll(() => pool.end());
it.each(["technical", "professional", "explorer"] as const)(
  "REHSCHED-02/03 %s can register for the dated snapshot, retain cancellation and separately withdraw",
  async (background) => {
    const token = await admin(),
      checked = snapshot();
    const created = await enabled.schedule(token, randomUUID(), checked);
    expect(created.kind).toBe("ready");
    if (created.kind !== "ready")
      throw Error("Invented scheduling unavailable");
    const scope = { eventId: created.value.receipt.eventId, eventVersion: 1 };
    const member = fresh(),
      peer = fresh();
    for (const credential of [member, peer])
      await members.create(credential, {
        background,
        goal: "everyday",
        timezone: "America/Toronto",
      });
    const reader = eventCatalogReader();
    const registrations = eventEnrollmentStore(pool, {
      mode: "test",
      enabled: true,
      catalogReader: reader,
    });
    const cancellations = eventCancellationStore(pool, {
      mode: "test",
      writes: true,
      registration: true,
      catalogReader: reader,
    });
    expect(await registrations.preview(member, scope.eventId, 1)).toMatchObject(
      {
        canEnroll: true,
        remaining: 1,
        event: {
          id: scope.eventId,
          startsAt: checked.startsAt,
          endsAt: checked.endsAt,
        },
      },
    );
    const id = randomUUID();
    expect(await registrations.enroll(member, scope.eventId, 1, id)).toEqual({
      kind: "enrolled",
      receiptId: id,
    });
    expect(await registrations.receipt(peer, id)).toBeNull();
    const cancelled = await cancellations.cancel(token, scope, randomUUID(), {
      title: checked.title,
      startsAt: checked.startsAt,
      endsAt: checked.endsAt,
      capacity: checked.capacity,
    });
    expect(cancelled.kind).toBe("ready");
    if (cancelled.kind !== "ready")
      throw Error("Invented cancellation unavailable");
    expect(await registrations.receipt(member, id)).toMatchObject({
      id,
      eventId: scope.eventId,
      cancelledAt: cancelled.value.receipt.cancelledAt,
      withdrawnAt: null,
    });
    expect(await registrations.history(member)).toMatchObject({
      items: [
        {
          id,
          eventId: scope.eventId,
          cancelledAt: cancelled.value.receipt.cancelledAt,
          withdrawnAt: null,
        },
      ],
    });
    expect(await registrations.preview(peer, scope.eventId, 1)).toMatchObject({
      canEnroll: false,
    });
    expect(
      await registrations.enroll(peer, scope.eventId, 1, randomUUID()),
    ).toEqual({ kind: "unavailable" });
    expect(await registrations.withdraw(member, id)).toBe("withdrawn");
    const retained = await registrations.receipt(member, id);
    expect(retained?.cancelledAt).toEqual(cancelled.value.receipt.cancelledAt);
    expect(retained?.withdrawnAt).toBeInstanceOf(Date);
  },
);
it("REHSCHED-01/02 atomically schedules an immutable dated event, shared exact snapshot and canonical own receipt", async () => {
  const token = await admin(),
    key = randomUUID(),
    checked = snapshot();
  const result = await enabled.schedule(token, key, checked);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready")
    throw Error("Invented scheduling result unavailable");
  expect(result.value.replayed).toBe(false);
  const receipt = result.value.receipt;
  expect(receipt.eventId).toBe(`local-rehearsal-${receipt.id}`);
  expect(receipt.eventVersion).toBe(1);
  expect(receipt.startsAt.toISOString()).toBe(checked.startsAt);
  expect(receipt.endsAt.toISOString()).toBe(checked.endsAt);
  expect(Object.keys(receipt).sort()).toEqual(
    [
      "id",
      "eventId",
      "eventVersion",
      "title",
      "startsAt",
      "endsAt",
      "scheduledAt",
    ].sort(),
  );
  expect(await enabled.receipt(token, receipt.id)).toMatchObject({
    kind: "ready",
    value: receipt,
  });
  const event = await eventCatalogReader().find(pool, receipt.eventId, 1);
  expect(event).toMatchObject({
    id: receipt.eventId,
    title: checked.title,
    startsAt: checked.startsAt,
    endsAt: checked.endsAt,
    fixtureCapacity: 1,
    localRegistration: true,
  });
  expect(
    (await eventCatalogReader().list(pool)).some(
      (e) => e.id === receipt.eventId,
    ),
  ).toBe(true);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_cancellation_state WHERE event_id=$1",
        [receipt.eventId],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("REHSCHED-06/08 recovers the same operation when new scheduling is paused without creating a new event", async () => {
  const token = await admin(),
    key = randomUUID(),
    checked = snapshot();
  const original = await enabled.schedule(token, key, checked);
  expect(original.kind).toBe("ready");
  if (original.kind !== "ready")
    throw Error("Invented scheduling result unavailable");
  expect(await paused.schedule(token, key, checked)).toMatchObject({
    kind: "ready",
    value: { receipt: original.value.receipt, replayed: true },
  });
  expect(await paused.inspectOperation(token, key, checked)).toMatchObject({
    kind: "ready",
    value: original.value.receipt,
  });
  expect(await paused.schedule(token, randomUUID(), checked)).toEqual({
    kind: "unavailable",
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_rehearsals",
      )
    ).rows[0].n,
  ).toBe(1);
});
it("REHSCHED-05/06 denies another creator and a changed instruction while keeping the original canonical schedule", async () => {
  const token = await admin(),
    foreign = await admin(),
    key = randomUUID(),
    checked = snapshot();
  const original = await enabled.schedule(token, key, checked);
  expect(original.kind).toBe("ready");
  if (original.kind !== "ready")
    throw Error("Invented scheduling result unavailable");
  expect(await enabled.schedule(foreign, key, checked)).toEqual({
    kind: "conflict",
  });
  expect(await enabled.inspectOperation(foreign, key, checked)).toEqual({
    kind: "conflict",
  });
  expect(
    await enabled.receipt(foreign, original.value.receipt.id),
  ).toMatchObject({ kind: "ready", value: null });
  expect(await enabled.schedule(token, key, snapshot(700000))).toEqual({
    kind: "conflict",
  });
  expect(
    await enabled.inspectOperation(token, randomUUID(), checked),
  ).toMatchObject({ kind: "ready", value: null });
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_rehearsals",
      )
    ).rows[0].n,
  ).toBe(1);
});
it("REHSCHED-04 rejects early and distant dates without leaving inventory, scheduling or operation rows", async () => {
  const token = await admin();
  for (const checked of [
    snapshot(-1000),
    snapshot(60000),
    snapshot(31 * 86400000),
  ])
    expect(await enabled.schedule(token, randomUUID(), checked)).toEqual({
      kind: "invalid",
    });
  for (const table of [
    "private_event_inventory",
    "private_event_rehearsals",
    "private_event_rehearsal_operations",
  ])
    expect(
      (await pool.query(`SELECT count(*)::integer n FROM ${table}`)).rows[0].n,
    ).toBe(0);
});
it("REHSCHED-07 member export excludes scheduling authority and erasure removes only owned registrations", async () => {
  const token = await admin(),
    key = randomUUID(),
    checked = snapshot();
  const created = await enabled.schedule(token, key, checked);
  if (created.kind !== "ready") throw Error("Invented schedule unavailable");
  const member = fresh(),
    peer = fresh();
  for (const credential of [member, peer])
    await members.create(credential, {
      background: "professional",
      goal: "everyday",
    });
  const registrations = eventEnrollmentStore(pool, {
    mode: "test",
    enabled: true,
  });
  const id = randomUUID();
  expect(
    await registrations.enroll(member, created.value.receipt.eventId, 1, id),
  ).toEqual({ kind: "enrolled", receiptId: id });
  const exported = await memberExportStore(pool).exportOwned(member);
  expect(exported.kind).toBe("ready");
  if (exported.kind !== "ready")
    throw Error("Invented owned export unavailable");
  expect(exported.payload.records.eventEnrollments).toMatchObject([
    {
      id,
      eventId: created.value.receipt.eventId,
      withdrawnAt: null,
      cancelledAt: null,
    },
  ]);
  expect(JSON.stringify(exported.payload)).not.toContain(key);
  expect(JSON.stringify(exported.payload)).not.toContain(token);
  expect(exported.payload.page.recordCount).toBeLessThanOrEqual(100);
  const session = await members.session(member);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  await members.remove(session.learner.id);
  expect(await memberExportStore(pool).exportOwned(member)).toEqual({
    kind: "denied",
  });
  expect(
    (
      await pool.query("SELECT id FROM private_event_enrollments WHERE id=$1", [
        id,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (await pool.query("SELECT id FROM private_event_rehearsals")).rows,
  ).toHaveLength(1);
  expect(
    await memberEventCatalog(pool, "test").find(
      peer,
      created.value.receipt.eventId,
      1,
    ),
  ).toMatchObject({
    kind: "ready",
    value: { id: created.value.receipt.eventId },
  });
});
it("REHSCHED-07 administrator erasure removes actor linkage but reserves the original key and retains catalog facts", async () => {
  const token = await admin(),
    key = randomUUID(),
    checked = snapshot();
  const created = await enabled.schedule(token, key, checked);
  if (created.kind !== "ready") throw Error("Invented schedule unavailable");
  await pool.query("DELETE FROM principals WHERE token_hash=$1", [hash(token)]);
  expect(
    (
      await pool.query(
        "SELECT idempotency_key,actor_id FROM private_event_rehearsal_operations",
      )
    ).rows,
  ).toEqual([{ idempotency_key: key, actor_id: null }]);
  const other = await admin();
  expect(await enabled.schedule(other, key, checked)).toEqual({
    kind: "conflict",
  });
  expect(await enabled.inspectOperation(other, key, checked)).toEqual({
    kind: "conflict",
  });
  expect(await enabled.receipt(other, created.value.receipt.id)).toMatchObject({
    kind: "ready",
    value: null,
  });
  expect(
    await eventCatalogReader().find(pool, created.value.receipt.eventId, 1),
  ).toMatchObject({ id: created.value.receipt.eventId });
  expect(
    (await pool.query("SELECT id FROM private_event_rehearsals")).rows,
  ).toHaveLength(1);
});
it("REHSCHED-07 pages all 102 retained dated registrations, excludes foreign ownership and denies continuation after erasure", async () => {
  const token = await admin(),
    member = fresh(),
    peer = fresh(),
    checked = snapshot();
  for (const credential of [member, peer])
    await members.create(credential, {
      background: "explorer",
      goal: "everyday",
    });
  const registrations = eventEnrollmentStore(pool, {
    mode: "test",
    enabled: true,
  });
  const cancellations = eventCancellationStore(pool, {
    mode: "test",
    writes: true,
    registration: true,
  });
  const expected: string[] = [];
  for (let index = 0; index < 102; index++) {
    const created = await enabled.schedule(token, randomUUID(), checked);
    if (created.kind !== "ready")
      throw Error("Invented retained schedule unavailable");
    const scope = { eventId: created.value.receipt.eventId, eventVersion: 1 },
      id = randomUUID();
    expect(await registrations.enroll(member, scope.eventId, 1, id)).toEqual({
      kind: "enrolled",
      receiptId: id,
    });
    expect(
      (
        await cancellations.cancel(token, scope, randomUUID(), {
          title: checked.title,
          startsAt: checked.startsAt,
          endsAt: checked.endsAt,
          capacity: 1,
        })
      ).kind,
    ).toBe("ready");
    if (index % 2 === 0)
      expect(await registrations.withdraw(member, id)).toBe("withdrawn");
    expected.push(id);
  }
  const exporter = memberExportStore(
      pool,
      Buffer.from("synthetic-rehearsal-export-secret"),
    ),
    found: string[] = [];
  let cursor: string | undefined,
    retainedCursor: string | undefined,
    pages = 0;
  do {
    const exported = await exporter.exportOwned(member, cursor);
    if (exported.kind !== "ready")
      throw Error("Owned dated history page unavailable");
    expect(exported.payload.page.recordCount).toBeLessThanOrEqual(100);
    for (const row of exported.payload.records.eventEnrollments ?? []) {
      expect(row.cancelledAt).not.toBeNull();
      found.push(String(row.id));
    }
    expect(JSON.stringify(exported.payload)).not.toContain(token);
    cursor = exported.payload.page.nextCursor ?? undefined;
    if (cursor) {
      retainedCursor = cursor;
      expect(await exporter.exportOwned(peer, cursor)).toEqual({
        kind: "denied",
      });
    }
    expect(++pages).toBeLessThan(10);
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  expect(found.sort()).toEqual(expected.sort());
  expect(new Set(found).size).toBe(102);
  expect(retainedCursor).toBeDefined();
  const session = await members.session(member);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  await members.remove(session.learner.id);
  expect(await exporter.exportOwned(member, retainedCursor)).toEqual({
    kind: "denied",
  });
  expect(
    (await pool.query("SELECT id FROM private_event_enrollments")).rows,
  ).toHaveLength(0);
  expect(
    (await pool.query("SELECT id FROM private_event_rehearsals")).rows,
  ).toHaveLength(102);
}, 30000);
