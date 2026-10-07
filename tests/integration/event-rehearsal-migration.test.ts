import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { eventEnrollmentStore } from "../../src/event-enrollments.ts";
import { eventRehearsalStore } from "../../src/event-rehearsals.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { EVENT_PREVIEWS } from "../../src/events.ts";
import { rehearsalSnapshot } from "../../src/event-rehearsal-values.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool);
const migration = () =>
  readFile(
    new URL(
      "../../migrations/063-private-event-rehearsal.sql",
      import.meta.url,
    ),
    "utf8",
  );
beforeAll(() => migrate(pool));
beforeEach(() =>
  pool.query("TRUNCATE principals,private_event_inventory CASCADE"),
);
afterAll(() => pool.end());
it("REHSCHED-07/08 upgrades populated version62 without changing existing static inventory or owned registrations and reapplies", async () => {
  await pool.query(
    "DROP TABLE private_event_rehearsal_operations,private_event_rehearsals,private_event_rehearsal_admission CASCADE; DELETE FROM schema_migrations WHERE version=63",
  );
  try {
    const member = randomBytes(32).toString("hex"),
      id = randomUUID(),
      event = EVENT_PREVIEWS.find((e) => e.localRegistration === true)!;
    await members.create(member, { background: "technical", goal: "everyday" });
    // The pre-upgrade consumer resolves only repository content and never touches the absent scheduling tables.
    const enrollments = eventEnrollmentStore(pool, {
      mode: "test",
      enabled: true,
      catalog: EVENT_PREVIEWS,
    });
    expect(
      await enrollments.enroll(member, event.id, event.version, id),
    ).toEqual({ kind: "enrolled", receiptId: id });
    const beforeInventory = (
      await pool.query("SELECT * FROM private_event_inventory")
    ).rows;
    const beforeEnrollment = (
      await pool.query("SELECT * FROM private_event_enrollments")
    ).rows;
    await pool.query(await migration());
    await pool.query(await migration());
    expect(
      (await pool.query("SELECT * FROM private_event_inventory")).rows,
    ).toEqual(beforeInventory);
    expect(
      (await pool.query("SELECT * FROM private_event_enrollments")).rows,
    ).toEqual(beforeEnrollment);
    expect(
      (await pool.query("SELECT * FROM private_event_rehearsals")).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT version FROM schema_migrations WHERE version=63",
        )
      ).rows,
    ).toEqual([{ version: 63 }]);
    expect((await enrollments.receipt(member, id))?.id).toBe(id);
  } finally {
    await pool.query(await migration());
  }
});
it("REHSCHED-07 rejects snapshot and operation mutation while keeping immutable saved facts through migration reapplication", async () => {
  const token = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    token,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const snapshot = rehearsalSnapshot({
    templateId: "local-registration-rehearsal",
    templateVersion: 1,
    startsAt: new Date(Date.now() + 3600000).toISOString(),
  })!;
  const key = randomUUID(),
    saved = await eventRehearsalStore(pool, {
      mode: "test",
      writes: true,
      registration: true,
    }).schedule(token, key, snapshot);
  expect(saved.kind).toBe("ready");
  const tables = [
    "private_event_inventory",
    "private_event_rehearsals",
    "private_event_rehearsal_operations",
  ];
  const before = await Promise.all(
    tables.map(
      async (table) => (await pool.query(`SELECT * FROM ${table}`)).rows,
    ),
  );
  await expect(
    pool.query("UPDATE private_event_rehearsals SET template_digest=$1", [
      "0".repeat(64),
    ]),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("DELETE FROM private_event_rehearsals"),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query(
      "UPDATE private_event_rehearsal_operations SET checked_snapshot='{}'::jsonb",
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("DELETE FROM private_event_rehearsal_operations"),
  ).rejects.toThrow("retained");
  await pool.query(await migration());
  await pool.query(await migration());
  expect(
    await Promise.all(
      tables.map(
        async (table) => (await pool.query(`SELECT * FROM ${table}`)).rows,
      ),
    ),
  ).toEqual(before);
});
