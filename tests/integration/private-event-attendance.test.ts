import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import type { Pool, PoolClient } from "pg";
import { app } from "../../src/app.ts";
import { eventAttendanceStore } from "../../src/event-attendance.ts";
import { start } from "../../src/runtime.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { eventRehearsalStore } from "../../src/event-rehearsals.ts";
import { rehearsalSnapshot } from "../../src/event-rehearsal-values.ts";
import { eventEnrollmentStore } from "../../src/event-enrollments.ts";
import { COOKIE } from "../../src/session.ts";
import { STAFF_COOKIE } from "../../src/staff-entry-selection.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
let running: Awaited<ReturnType<typeof start>> | undefined;
let privateRoot: string | undefined;
beforeAll(async () => {
  await migrate(pool);
  await pool.query("TRUNCATE principals,private_event_inventory CASCADE");
  privateRoot = await mkdtemp(join(tmpdir(), "dne490-behavior-private-"));
  running = await start({
    DNE_APP_MODE: "test",
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: privateRoot,
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_EVENT_REGISTRATION: "enabled",
    DNE_LOCAL_EVENT_ADMIN: "enabled",
    DNE_EVENT_ATTENDANCE: "enabled",
  });
});
afterAll(async () => {
  try {
    await running?.close();
  } finally {
    await pool.end();
    if (privateRoot) await rm(privateRoot, { recursive: true });
  }
});
it("ATTEND-01/03 owning registered member opens deliberate observation permission without inferred attendance", async () => {
  const member = randomBytes(32).toString("hex");
  const administrator = randomBytes(32).toString("hex");
  const members = store(pool);
  await members.create(member, {
    background: "professional",
    goal: "work",
    timezone: "America/Toronto",
  });
  const instant = (
    await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now;
  await authorizationStore(pool).provisionStaff(
    administrator,
    "platform_admin",
    new Date(+instant + 3600000),
  );
  const rehearsals = eventRehearsalStore(pool, {
    mode: "test",
    writes: true,
    registration: true,
  });
  const snapshot = rehearsalSnapshot({
    templateId: "local-registration-rehearsal",
    templateVersion: 1,
    startsAt: new Date(+instant + 180000).toISOString(),
  });
  expect(snapshot).not.toBeNull();
  const scheduled = await rehearsals.schedule(
    administrator,
    randomUUID(),
    snapshot,
  );
  expect(scheduled.kind).toBe("ready");
  if (scheduled.kind !== "ready")
    throw new Error("Valid invented rehearsal fixture required");
  const registration = await eventEnrollmentStore(pool, {
    mode: "test",
    enabled: true,
  }).enroll(member, scheduled.value.receipt.eventId, 1, randomUUID());
  expect(registration.kind).toBe("enrolled");
  if (!("receiptId" in registration))
    throw new Error("Valid owning registration fixture required");
  const receiptPath = `/events/registrations/${registration.receiptId}`;
  const get = (path: string) =>
    request(running!.server)
      .get(path)
      .set("Host", new URL(running!.origin).host)
      .set("Cookie", `${COOKIE}=${member}`);
  // Honest delivered enrollment baseline: exact owned receipt is already readable.
  const existing = await get(receiptPath);
  expect(existing.status).toBe(200);
  expect(existing.text).toContain("Registered for the local rehearsal.");
  // Missing product behavior is the enabled normal-runtime attendance interface,
  // not a module-import error, a fake clock or an invalid enrollment fixture.
  const permission = await get(receiptPath + "/attendance");
  expect(permission.status).toBe(200);
  expect(permission.text).toContain("No observation recorded");
  expect(permission.text).toContain("Check attendance permission");
  expect(permission.text).toMatch(/name="administratorId"/);
  expect(permission.text).not.toMatch(/type="checkbox"[^>]*checked/);
  expect(existing.text).toContain(`${receiptPath}/attendance`);
  const administratorPage = await request(running!.server)
    .get("/operator/event-attendance")
    .set("Host", new URL(running!.origin).host)
    .set("Cookie", `${STAFF_COOKIE}=${administrator}`);
  expect(administratorPage.status).toBe(200);
  expect(administratorPage.text).toContain("Your own administrator reference");
  expect(administratorPage.text).not.toContain(administrator);
  const reference = /<code[^>]*>([a-f0-9-]{36})<\/code>/.exec(
    administratorPage.text,
  )![1]!;
  const formValue = (html: string, name: string) => {
    const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
    if (value === undefined) throw Error("Normal checked form field required");
    return value
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
  };
  const post = (path: string, body: Record<string, string>) =>
    request(running!.server)
      .post(path)
      .set("Host", new URL(running!.origin).host)
      .set("Origin", running!.origin)
      .set("Cookie", `${COOKIE}=${member}`)
      .type("form")
      .send(body);
  const preview = await post(`${receiptPath}/attendance/check`, {
    csrf: formValue(permission.text, "csrf"),
    administratorId: reference,
  });
  expect(preview.status).toBe(200);
  expect(preview.text).toContain("Confirm attendance permission");
  expect(preview.text).not.toMatch(/type="checkbox"[^>]*checked/);
  const original = {
    csrf: formValue(preview.text, "csrf"),
    key: formValue(preview.text, "key"),
    checked: formValue(preview.text, "checked"),
  };
  expect(
    (await post(`${receiptPath}/attendance/permit`, original)).status,
  ).toBe(422);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_attendance_permissions",
      )
    ).rows[0].n,
  ).toBe(0);
  const accepted = await post(`${receiptPath}/attendance/permit`, {
    ...original,
    confirm: "yes",
  });
  expect(accepted.status).toBe(200);
  expect(accepted.text).toContain("Exact finite attendance permission saved");
  const inspected = await post(`${receiptPath}/attendance/recover`, {
    ...original,
    kind: "permit",
  });
  expect(inspected.status).toBe(200);
  expect(inspected.text).toContain("Exact finite attendance permission saved");
  expect(inspected.text).toContain(original.key);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_attendance_operations",
      )
    ).rows[0].n,
  ).toBe(1);
  const receipt = await get(`${receiptPath}/attendance`);
  expect(receipt.status).toBe(200);
  expect(receipt.text).toContain("Permission saved until");
  expect(receipt.text).toContain("No observation recorded");
  const withdrawal = {
    csrf: formValue(receipt.text, "csrf"),
    key: formValue(receipt.text, "key"),
    checked: formValue(receipt.text, "checked"),
    confirm: "yes",
  };
  expect(
    (
      await request(running!.server)
        .post(`${receiptPath}/attendance/withdraw`)
        .set("Host", new URL(running!.origin).host)
        .set("Origin", "https://foreign.example")
        .set("Cookie", `${COOKIE}=${member}`)
        .type("form")
        .send(withdrawal)
    ).status,
  ).toBe(403);
  let lost = false;
  const uncertainPool = {
    connect: async () => {
      const client = await pool.connect();
      let withdrawalWritten = false;
      return new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return async (sql: string, values?: unknown[]) => {
              const result = await target.query(sql, values);
              if (/UPDATE private_event_attendance_permissions/.test(sql))
                withdrawalWritten = true;
              if (sql === "COMMIT" && withdrawalWritten && !lost) {
                lost = true;
                throw Error("Invented lost reply after real withdrawal COMMIT");
              }
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
  } as unknown as Pool;
  const recoveryOrigin = "http://127.0.0.1:3000";
  const uncertainApp = app(members, {
    mode: "test",
    origin: recoveryOrigin,
    secret: "invented-attendance-recovery-secret",
    eventAttendance: eventAttendanceStore(uncertainPool, {
      mode: "test",
      enabled: true,
      registration: true,
    }),
  });
  const recoveryGet = () =>
    request(uncertainApp)
      .get(`${receiptPath}/attendance`)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${member}`);
  const recoveryPost = (path: string, body: Record<string, string>) =>
    request(uncertainApp)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", recoveryOrigin)
      .set("Cookie", `${COOKIE}=${member}`)
      .type("form")
      .send(body);
  // The first connection is a read; simulate loss only for the deliberate write below.
  const current = await recoveryGet();
  expect(current.status).toBe(200);
  expect(lost).toBe(false);
  const uncertainBody = {
    ...withdrawal,
    csrf: formValue(current.text, "csrf"),
  };
  const missingReply = await recoveryPost(
    `${receiptPath}/attendance/withdraw`,
    uncertainBody,
  );
  expect(missingReply.status).toBe(503);
  expect(lost).toBe(true);
  expect(missingReply.text).toContain("Inspect original result");
  expect(missingReply.text).not.toMatch(/type="checkbox"[^>]*checked/);
  expect(formValue(missingReply.text, "key")).toBe(withdrawal.key);
  const recovered = await recoveryPost(`${receiptPath}/attendance/recover`, {
    csrf: formValue(missingReply.text, "csrf"),
    key: formValue(missingReply.text, "key"),
    checked: formValue(missingReply.text, "checked"),
    kind: formValue(missingReply.text, "kind"),
  });
  expect(recovered.status).toBe(200);
  expect(recovered.text).toContain("Attendance permission withdrawn");
  const withdrawn = await recoveryPost(
    `${receiptPath}/attendance/withdraw`,
    uncertainBody,
  );
  expect(withdrawn.status).toBe(200);
  expect((await get(`${receiptPath}/attendance`)).text).toContain(
    "Attendance sharing withdrawn",
  );
  const history = await get("/events/attendance");
  expect(history.status).toBe(200);
  expect(history.text).toContain("My private attendance history");
  expect(history.text).toContain(`${receiptPath}/attendance`);
  expect(history.text).toContain("No observation recorded");
  expect((await get("/events/attendance?after=forged")).status).toBe(422);
  const exported = await get("/api/member/export");
  expect(exported.status).toBe(200);
  expect(exported.body.version).toBe("local-member-records-v25");
  expect(exported.body.records.eventAttendancePermissions).toHaveLength(1);
  expect(exported.body.records.eventAttendancePermissions[0]).toMatchObject({
    registrationId: registration.receiptId,
    attribution: "Local platform administrator",
  });
  expect(exported.body.records.eventAttendanceObservations).toEqual([]);
  expect(exported.text).not.toContain(reference);
  expect(exported.text).not.toContain(administrator);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_attendance_observations",
      )
    ).rows[0].n,
  ).toBe(0);
});
