import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { eventCancellationStore } from "../../src/event-cancellations.ts";
import { eventEnrollmentStore } from "../../src/event-enrollments.ts";
import type { Pool, PoolClient } from "pg";
import { EVENT_PREVIEWS } from "../../src/events.ts";
import type { EventPreview } from "../../src/events.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool);
const origin = "http://127.0.0.1:3000",
  secret = "invented-cancellation-red";
const event: EventPreview = {
  id: "invented-cancellation-event",
  version: 1,
  status: "current",
  title: "Invented event cancellation rehearsal",
  description: "Invented data only",
  agenda: ["Compare invented work"],
  goals: ["everyday"],
  domainTags: [],
  itRoles: [],
  startsAt: "2030-11-03T05:30:00.000Z",
  endsAt: "2030-11-03T06:30:00.000Z",
  fixtureCapacity: 1,
  localRegistration: true,
};
const events = eventEnrollmentStore(pool, {
  mode: "test",
  enabled: true,
  catalog: [event, ...EVENT_PREVIEWS],
});
const application = app(members, {
  origin,
  secret,
  mode: "test",
  localStaffEntry: true,
  staffEntry: staffEntryStore(pool),
  eventEnrollments: events,
  eventRegistration: true,
  memberExport: memberExportStore(pool),
  localEventAdmin: true,
  eventCancellations: eventCancellationStore(pool, {
    mode: "test",
    writes: true,
    registration: true,
    catalog: [event, ...EVENT_PREVIEWS],
  }),
});
const fresh = () => randomBytes(32).toString("hex");
const get = (path: string, cookie: string, target = application) =>
  withLoopback(target, (server) =>
    request(server)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", cookie),
  );
const post = (
  path: string,
  cookie: string,
  fields: Record<string, string>,
  target = application,
) =>
  withLoopback(target, (server) =>
    request(server)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", cookie)
      .type("form")
      .send(fields),
  );
const cookieFrom = (res: request.Response, name: string) => {
  const values = res.headers["set-cookie"] as unknown as string[];
  const value = values?.find((v) => v.startsWith(name + "="))?.split(";")[0];
  if (!value) throw Error("Missing invented fixture cookie");
  return value;
};
const formCsrf = (html: string) => {
  const value = /name="csrf" value="([a-f0-9]{64})"/.exec(html)?.[1];
  if (!value) throw Error("Missing fixture form integrity");
  return value;
};
beforeAll(() => migrate(pool));
beforeEach(() =>
  pool.query("TRUNCATE principals,private_event_inventory CASCADE"),
);
afterAll(() => pool.end());
it.each(["technical", "professional", "explorer"] as const)(
  "EVCANCEL-01 %s retained enrollment baseline and current administrator needs cancellation browser entry",
  async (background) => {
    const member = fresh(),
      admin = fresh(),
      operation = randomUUID();
    await members.create(member, {
      background,
      goal: "everyday",
      timezone: "America/Toronto",
    });
    await auth.provisionStaff(
      admin,
      "platform_admin",
      new Date(Date.now() + 3600000),
    );
    const memberCookie = `${COOKIE}=${member}`;
    const enrolled = await post(`/events/${event.id}/1/enroll`, memberCookie, {
      csrf: csrf(member, secret),
      synthetic: "yes",
      operation_id: operation,
    });
    expect(
      enrolled.status,
      "Previously delivered enrollment remains working",
    ).toBe(303);
    const receipt = await get(
      `/events/registrations/${operation}`,
      memberCookie,
    );
    expect(receipt.status).toBe(200);
    expect(receipt.text).toContain("Registered for the local rehearsal.");
    const entry = await get("/staff/sign-in", "");
    expect(entry.status).toBe(200);
    const signed = await post(
      "/staff/sign-in",
      cookieFrom(entry, "dne_staff_entry"),
      { csrf: formCsrf(entry.text), credential: admin },
    );
    expect(
      signed.status,
      "Existing actual staff sign-in is a passing fixture baseline",
    ).toBe(303);
    const selected = cookieFrom(signed, "dne_staff");
    expect((await get("/staff", selected)).status).toBe(200);
    const cancellation = await get("/operator/event-cancellations", selected);
    expect(
      cancellation.status,
      "Current selected administrator needs the missing exact-event cancellation browser entry",
    ).toBe(200);
    expect(cancellation.text).toContain("Event cancellation");
    const checked = await post(
      "/operator/event-cancellations/check",
      selected,
      {
        csrf: formCsrf(cancellation.text),
        eventId: event.id,
        eventVersion: "1",
      },
    );
    expect(checked.status).toBe(200);
    expect(checked.text).toContain(event.title);
    expect(checked.text).toContain(event.startsAt);
    expect(checked.text).not.toContain(
      'name="confirm" value="yes" required checked',
    );
    const key = /name="key" value="([a-f0-9-]{36})"/.exec(checked.text)?.[1];
    if (!key) throw Error("Missing original operation key");
    const fields = {
      csrf: formCsrf(checked.text),
      eventId: event.id,
      eventVersion: "1",
      key,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      capacity: "1",
    };
    const unchecked = await post(
      "/operator/event-cancellations/cancel",
      selected,
      fields,
    );
    expect(unchecked.status).toBe(403);
    expect(
      (await pool.query("SELECT id FROM private_event_cancellations")).rows,
    ).toEqual([]);
    const changed = await post(
      "/operator/event-cancellations/cancel",
      selected,
      { ...fields, confirm: "yes", title: "Changed snapshot" },
    );
    expect(changed.status).toBe(409);
    expect(
      (await pool.query("SELECT id FROM private_event_cancellations")).rows,
    ).toEqual([]);
    const saved = await post("/operator/event-cancellations/cancel", selected, {
      ...fields,
      confirm: "yes",
    });
    expect(saved.status).toBe(200);
    expect(saved.text).toContain("Event cancellation receipt");
    expect(saved.text).toContain("New registrations are closed");
    const own = await get(`/events/registrations/${operation}`, memberCookie);
    expect(own.status).toBe(200);
    expect(own.text).toContain("Event cancelled");
    expect(own.text).toContain("Withdraw registration");
    expect(own.text).not.toContain("Check this version for a new registration");
    expect((await get("/events/registrations", memberCookie)).text).toContain(
      "event cancelled",
    );
    const inspected = await post(
      "/operator/event-cancellations/inspect",
      selected,
      { csrf: formCsrf(saved.text), eventId: event.id, eventVersion: "1", key },
    );
    expect(inspected.status).toBe(200);
    expect(inspected.text).toContain("New registrations are closed");
    expect((await events.preview(member, event.id, 1))?.canEnroll).toBe(false);
    expect(
      (await get(`/events/${event.id}/1/rehearsal`, memberCookie)).text,
    ).toContain("Event cancelled");
    const replay = await post(
      "/operator/event-cancellations/cancel",
      selected,
      { ...fields, confirm: "yes" },
    );
    expect(replay.status).toBe(200);
    expect(
      (await pool.query("SELECT id FROM private_event_cancellations")).rows,
    ).toHaveLength(1);
    const exported = await get("/api/member/export", memberCookie);
    expect(exported.status).toBe(200);
    expect(exported.body.records.eventEnrollments).toEqual([
      expect.objectContaining({
        id: operation,
        cancelledAt: expect.any(String),
        withdrawnAt: null,
      }),
    ]);
  },
);

async function signIn(token: string) {
  const entry = await get("/staff/sign-in", "");
  const signed = await post(
    "/staff/sign-in",
    cookieFrom(entry, "dne_staff_entry"),
    { csrf: formCsrf(entry.text), credential: token },
  );
  expect(signed.status).toBe(303);
  return cookieFrom(signed, "dne_staff");
}
it("EVCANCEL-03 dynamically closes catalog discovery and exact detail while preserving receipts", async () => {
  const member = fresh(),
    admin = fresh(),
    current = EVENT_PREVIEWS.find((e) => e.localRegistration)!;
  await members.create(member, { background: "explorer", goal: "everyday" });
  await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const cookie = `${COOKIE}=${member}`,
    selected = await signIn(admin);
  const before = await get(`/events/${current.id}/${current.version}`, cookie);
  expect(before.text).toContain("Try local registration rehearsal");
  const result = await eventCancellationStore(pool, {
    mode: "test",
    writes: true,
    registration: true,
  }).cancel(
    admin,
    { eventId: current.id, eventVersion: current.version },
    randomUUID(),
  );
  expect(result.kind).toBe("ready");
  const list = await get("/events", cookie),
    detail = await get(`/events/${current.id}/${current.version}`, cookie);
  expect(list.status).toBe(200);
  expect(detail.status).toBe(200);
  expect(list.text).toContain("Event cancelled");
  expect(detail.text).toContain("Event cancelled");
  expect(list.text).not.toContain(
    `/events/${current.id}/${current.version}/rehearsal`,
  );
  expect(detail.text).not.toContain("Try local registration rehearsal");
  expect((await get("/operator/event-cancellations", selected)).text).toContain(
    "Event cancellation",
  );
});
it("EVCANCEL-06 successful COMMIT with lost reply preserves exact unchecked recovery and manual inspection without duplicate cancellation", async () => {
  const admin = fresh();
  await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const selected = await signIn(admin),
    home = await get("/operator/event-cancellations", selected);
  const checked = await post("/operator/event-cancellations/check", selected, {
    csrf: formCsrf(home.text),
    eventId: event.id,
    eventVersion: "1",
  });
  const key = /name="key" value="([a-f0-9-]{36})"/.exec(checked.text)?.[1];
  if (!key) throw Error("Missing original key");
  const instruction = {
    csrf: formCsrf(checked.text),
    eventId: event.id,
    eventVersion: "1",
    key,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    capacity: "1",
    confirm: "yes",
  };
  let lost = false;
  const faultPool = {
    connect: async () => {
      const real = await pool.connect();
      return new Proxy(real, {
        get(target, property) {
          if (property === "query")
            return async (sql: string, values?: unknown[]) => {
              const value = await target.query(sql, values);
              if (sql === "COMMIT" && !lost) {
                lost = true;
                throw Error("Invented successful commit reply loss");
              }
              return value;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
  } as unknown as Pool;
  const uncertainApp = app(members, {
    origin,
    secret,
    mode: "test",
    localStaffEntry: true,
    staffEntry: staffEntryStore(pool),
    localEventAdmin: true,
    eventCancellations: eventCancellationStore(faultPool, {
      mode: "test",
      writes: true,
      registration: true,
      catalog: [event],
    }),
  });
  const uncertain = await post(
    "/operator/event-cancellations/cancel",
    selected,
    instruction,
    uncertainApp,
  );
  expect(uncertain.status).toBe(503);
  expect(lost).toBe(true);
  expect(uncertain.text).toContain("may already have committed");
  expect(uncertain.text).toContain(`name="key" value="${key}" readonly`);
  expect(uncertain.text).toContain('name="confirm" value="yes" required');
  expect(uncertain.text).not.toContain("required checked");
  expect(uncertain.text).not.toContain(`?key=${key}`);
  expect(uncertain.text).toContain(
    'action="/operator/event-cancellations/inspect"',
  );
  expect(
    (await pool.query("SELECT id FROM private_event_cancellations")).rows,
  ).toHaveLength(1);
  const inspected = await post(
    "/operator/event-cancellations/inspect",
    selected,
    {
      csrf: formCsrf(uncertain.text),
      eventId: event.id,
      eventVersion: "1",
      key,
    },
  );
  expect(inspected.status).toBe(200);
  expect(inspected.text).toContain("New registrations are closed");
  const repeated = await post(
    "/operator/event-cancellations/cancel",
    selected,
    instruction,
    uncertainApp,
  );
  expect(repeated.status).toBe(200);
  expect(
    (await pool.query("SELECT id FROM private_event_cancellations")).rows,
  ).toHaveLength(1);
  expect(
    (
      await pool.query(
        "SELECT idempotency_key FROM private_event_cancellation_operations",
      )
    ).rows,
  ).toEqual([{ idempotency_key: key }]);
});
it.each(["operator", "reviewer", "moderator", "editor", "coach"] as const)(
  "EVCANCEL-05 %s cannot administer or inspect cancellation",
  async (role) => {
    const admin = fresh(),
      other = fresh();
    await auth.provisionStaff(
      admin,
      "platform_admin",
      new Date(Date.now() + 3600000),
    );
    await auth.provisionStaff(other, role, new Date(Date.now() + 3600000));
    const saved = await eventCancellationStore(pool, {
      mode: "test",
      writes: true,
      registration: true,
      catalog: [event],
    }).cancel(admin, { eventId: event.id, eventVersion: 1 }, randomUUID());
    if (saved.kind !== "ready") throw Error("Missing invented cancellation");
    const selected = await signIn(other);
    expect((await get("/operator/event-cancellations", selected)).status).toBe(
      403,
    );
    const inspected = await post(
      "/operator/event-cancellations/inspect",
      selected,
      {
        csrf: csrf(other, secret),
        eventId: event.id,
        eventVersion: "1",
        key: "",
      },
    );
    expect(inspected.status).toBe(403);
    expect(inspected.text).not.toContain(saved.value.receipt.id);
    const tried = await post("/operator/event-cancellations/cancel", selected, {
      csrf: csrf(other, secret),
      eventId: event.id,
      eventVersion: "1",
      key: randomUUID(),
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      capacity: "1",
      confirm: "yes",
    });
    expect(tried.status).toBe(403);
    expect(
      (await pool.query("SELECT id FROM private_event_cancellations")).rows,
    ).toHaveLength(1);
  },
);
it("EVCANCEL-05 requires selected staff, exact form integrity and canonical references without member privilege escalation", async () => {
  const member = fresh(),
    admin = fresh();
  await members.create(member, { background: "technical", goal: "build" });
  await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  expect(
    (await get("/operator/event-cancellations", `${COOKIE}=${member}`)).status,
  ).toBe(403);
  const selected = await signIn(admin),
    fields = {
      csrf: csrf(admin, secret),
      eventId: event.id,
      eventVersion: "1",
    };
  expect(
    (await get("/operator/event-cancellations", `${selected}; ${selected}`))
      .status,
  ).toBe(403);
  for (const body of [
    { ...fields, eventVersion: "01" },
    { ...fields, eventVersion: "0" },
    { ...fields, eventId: "UPPER" },
    { ...fields, extra: "unexpected" },
  ])
    expect(
      (await post("/operator/event-cancellations/check", selected, body))
        .status,
    ).toBe(422);
  expect(
    (
      await post("/operator/event-cancellations/check", selected, {
        ...fields,
        csrf: "invalid",
      })
    ).status,
  ).toBe(403);
  const wrongHost = await withLoopback(application, (server) =>
    request(server)
      .post("/operator/event-cancellations/check")
      .set("Host", "example.invalid")
      .set("Origin", origin)
      .set("Cookie", selected)
      .type("form")
      .send(fields),
  );
  const wrongOrigin = await withLoopback(application, (server) =>
    request(server)
      .post("/operator/event-cancellations/check")
      .set("Host", "127.0.0.1:3000")
      .set("Origin", "https://example.invalid")
      .set("Cookie", selected)
      .type("form")
      .send(fields),
  );
  expect(wrongHost.status).toBe(403);
  expect(wrongOrigin.status).toBe(403);
  expect(
    (await pool.query("SELECT id FROM private_event_cancellations")).rows,
  ).toEqual([]);
});
it("EVCANCEL-08 pausing administration keeps historical inspection and cancelled member behavior without new writes", async () => {
  const admin = fresh();
  await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const selected = await signIn(admin),
    key = randomUUID(),
    scope = { eventId: event.id, eventVersion: 1 };
  const active = eventCancellationStore(pool, {
    mode: "test",
    writes: true,
    registration: true,
    catalog: [event],
  });
  const saved = await active.cancel(admin, scope, key);
  if (saved.kind !== "ready") throw Error("Missing invented cancellation");
  const paused = app(members, {
    origin,
    secret,
    mode: "test",
    localStaffEntry: true,
    staffEntry: staffEntryStore(pool),
    eventCancellations: eventCancellationStore(pool, {
      mode: "test",
      writes: false,
      registration: false,
      catalog: [{ ...event, status: "retired" }],
    }),
  });
  const home = await get("/operator/event-cancellations", selected, paused);
  expect(home.status).toBe(200);
  expect(home.text).toContain("New cancellations are paused");
  const inspected = await post(
    "/operator/event-cancellations/inspect",
    selected,
    { csrf: formCsrf(home.text), eventId: event.id, eventVersion: "1", key },
    paused,
  );
  expect(inspected.status).toBe(200);
  expect(inspected.text).toContain(saved.value.receipt.id);
  const instruction = {
    csrf: formCsrf(home.text),
    eventId: event.id,
    eventVersion: "1",
    key,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    capacity: "1",
    confirm: "yes",
  };
  expect(
    (
      await post(
        "/operator/event-cancellations/cancel",
        selected,
        instruction,
        paused,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await post(
        "/operator/event-cancellations/cancel",
        selected,
        { ...instruction, key: randomUUID() },
        paused,
      )
    ).status,
  ).toBe(503);
  expect(
    (
      await pool.query(
        "SELECT idempotency_key FROM private_event_cancellation_operations",
      )
    ).rows,
  ).toEqual([{ idempotency_key: key }]);
});
it("EVCANCEL-05 successful COMMIT followed by authority expiry during release yields uncertain HTTP handback, never stale success", async () => {
  const admin = fresh(),
    actor = await auth.provisionStaff(
      admin,
      "platform_admin",
      new Date(Date.now() + 3600000),
    );
  const selected = await signIn(admin),
    home = await get("/operator/event-cancellations", selected),
    key = randomUUID();
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
    [actor],
  );
  let committed = false,
    expiredDuringRelease = false,
    rollbackAfterCommit = 0;
  const slowReleasePool = {
    connect: async () => {
      const real = await pool.connect();
      return new Proxy(real, {
        get(target, property) {
          if (property === "query")
            return async (sql: string, values?: unknown[]) => {
              if (sql === "ROLLBACK" && committed) rollbackAfterCommit++;
              const result = await target.query(sql, values);
              if (sql === "COMMIT") committed = true;
              return result;
            };
          if (property === "release")
            return (error?: Error) => {
              target.release(error);
              if (committed) {
                Atomics.wait(
                  new Int32Array(new SharedArrayBuffer(4)),
                  0,
                  0,
                  1250,
                );
                expiredDuringRelease = true;
              }
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
  } as unknown as Pool;
  const delayed = app(members, {
    origin,
    secret,
    mode: "test",
    localStaffEntry: true,
    staffEntry: staffEntryStore(pool),
    localEventAdmin: true,
    eventCancellations: eventCancellationStore(slowReleasePool, {
      mode: "test",
      writes: true,
      registration: true,
      catalog: [event],
    }),
  });
  const result = await post(
    "/operator/event-cancellations/cancel",
    selected,
    {
      csrf: formCsrf(home.text),
      eventId: event.id,
      eventVersion: "1",
      key,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      capacity: "1",
      confirm: "yes",
    },
    delayed,
  );
  expect(committed).toBe(true);
  expect(expiredDuringRelease).toBe(true);
  expect(rollbackAfterCommit).toBe(0);
  expect(result.status).toBe(503);
  expect(result.text).toContain("may already have committed");
  expect(result.text).toContain(`name="key" value="${key}" readonly`);
  expect(result.text).not.toContain("New registrations are closed");
  expect(
    (
      await pool.query(
        "SELECT expires_at<=clock_timestamp() expired FROM principals WHERE id=$1",
        [actor],
      )
    ).rows[0].expired,
  ).toBe(true);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int count FROM private_event_cancellations",
      )
    ).rows[0].count,
  ).toBe(1);
  expect(
    (
      await post("/operator/event-cancellations/inspect", selected, {
        csrf: formCsrf(result.text),
        eventId: event.id,
        eventVersion: "1",
        key,
      })
    ).status,
  ).toBe(403);
}, 10000);
