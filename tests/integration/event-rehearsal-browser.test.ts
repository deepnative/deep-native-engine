import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import type { Pool, PoolClient } from "pg";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { eventEnrollmentStore } from "../../src/event-enrollments.ts";
import { eventRehearsalStore } from "../../src/event-rehearsals.ts";
import { memberEventCatalog } from "../../src/member-event-catalog.ts";
import { eventCancellationStore } from "../../src/event-cancellations.ts";
import { EVENT_PREVIEWS } from "../../src/events.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { hash } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool);
const origin = "http://127.0.0.1:3000",
  secret = "invented-rehearsal-first-red";
const application = app(members, {
  origin,
  secret,
  mode: "test",
  localStaffEntry: true,
  staffEntry: staffEntryStore(pool),
  eventRegistration: true,
  localEventAdmin: true,
  eventRehearsals: eventRehearsalStore(pool, {
    mode: "test",
    writes: true,
    registration: true,
  }),
  memberEvents: memberEventCatalog(pool, "test"),
  eventEnrollments: eventEnrollmentStore(pool, { mode: "test", enabled: true }),
  eventCancellations: eventCancellationStore(pool, {
    mode: "test",
    writes: true,
    registration: true,
  }),
});
const get = (path: string, cookie = "") =>
  withLoopback(application, (server) =>
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
const cookieFrom = (result: request.Response, name: string) => {
  const value = (result.headers["set-cookie"] as unknown as string[])
    ?.find((v) => v.startsWith(name + "="))
    ?.split(";")[0];
  if (!value) throw Error("Missing invented fixture cookie");
  return value;
};
const formCsrf = (html: string) => {
  const value = /name="csrf" value="([a-f0-9]{64})"/.exec(html)?.[1];
  if (!value) throw Error("Missing form integrity fixture");
  return value;
};
function formFields(html: string, action: string) {
  const form = new RegExp(
    `<form\\b[^>]*action="${action}"[^>]*>([\\s\\S]*?)</form>`,
  ).exec(html)?.[1];
  if (!form) throw Error("Expected invented fixture form missing");
  const entities: Record<string, string> = {
    amp: "&",
    quot: '"',
    lt: "<",
    gt: ">",
    "#39": "'",
  };
  return Object.fromEntries(
    [...form.matchAll(/<input\b[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g)]
      .filter((match) => match[1] !== "confirm")
      .map((match) => [
        match[1]!,
        match[2]!.replace(
          /&(amp|quot|lt|gt|#39);/g,
          (_whole, entity: string) => entities[entity]!,
        ),
      ]),
  );
}
beforeAll(() => migrate(pool));
beforeEach(() =>
  pool.query("TRUNCATE principals,private_event_inventory CASCADE"),
);
afterAll(() => pool.end());
async function signIn(token: string) {
  const entry = await get("/staff/sign-in");
  const signed = await post(
    "/staff/sign-in",
    cookieFrom(entry, "dne_staff_entry"),
    {
      csrf: formCsrf(entry.text),
      credential: token,
    },
  );
  expect(signed.status).toBe(303);
  return cookieFrom(signed, "dne_staff");
}
async function checkedSchedule(token: string, selected: string) {
  const checked = await post("/operator/event-rehearsals/check", selected, {
    csrf: csrf(token, secret),
    templateId: "local-registration-rehearsal",
    templateVersion: "1",
    startsAt: new Date(Date.now() + 3600000).toISOString(),
  });
  expect(checked.status).toBe(200);
  return formFields(checked.text, "/operator/event-rehearsals/schedule");
}
it.each(["operator", "reviewer", "moderator", "editor", "coach"] as const)(
  "REHSCHED-05 %s cannot schedule or inspect an administrator's rehearsal",
  async (role) => {
    const token = randomBytes(32).toString("hex");
    await auth.provisionStaff(token, role, new Date(Date.now() + 3600000));
    const selected = await signIn(token);
    expect((await get("/operator/event-rehearsals", selected)).status).toBe(
      403,
    );
    const instruction = {
      csrf: csrf(token, secret),
      templateId: "local-registration-rehearsal",
      templateVersion: "1",
      startsAt: new Date(Date.now() + 3600000).toISOString(),
    };
    expect(
      (await post("/operator/event-rehearsals/check", selected, instruction))
        .status,
    ).toBe(403);
    expect(
      (
        await post("/operator/event-rehearsals/inspect", selected, {
          ...instruction,
          key: randomUUID(),
        })
      ).status,
    ).toBe(403);
    expect(
      (await pool.query("SELECT id FROM private_event_rehearsals")).rows,
    ).toEqual([]);
  },
);
it("REHSCHED-04/05 rejects changed snapshots and cross-origin forms without creating schedules", async () => {
  const token = randomBytes(32).toString("hex");
  await auth.provisionStaff(
    token,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const selected = await signIn(token),
    original = await checkedSchedule(token, selected);
  expect(
    (await get("/operator/event-rehearsals", `${selected}; ${selected}`))
      .status,
  ).toBe(403);
  const changes: Record<string, string>[] = [
    { title: "Untrusted content" },
    { capacity: "2" },
    { templateVersion: "01" },
    { templateDigest: "0".repeat(64) },
    { startsAt: "2030-01-01" },
    { extra: "unexpected" },
  ];
  for (const changed of changes)
    expect(
      (
        await post("/operator/event-rehearsals/schedule", selected, {
          ...original,
          confirm: "yes",
          ...changed,
        })
      ).status,
    ).toBe(422);
  expect(
    (
      await post("/operator/event-rehearsals/schedule", selected, {
        ...original,
        confirm: "yes",
        csrf: "invalid",
      })
    ).status,
  ).toBe(403);
  for (const [host, suppliedOrigin] of [
    ["example.invalid", origin],
    ["127.0.0.1:3000", "https://example.invalid"],
  ]) {
    const denied = await withLoopback(application, (server) =>
      request(server)
        .post("/operator/event-rehearsals/schedule")
        .set("Host", host!)
        .set("Origin", suppliedOrigin!)
        .set("Cookie", selected)
        .type("form")
        .send({ ...original, confirm: "yes" }),
    );
    expect(denied.status).toBe(403);
  }
  expect(
    (await pool.query("SELECT id FROM private_event_rehearsals")).rows,
  ).toEqual([]);
});
it.each(["revoked", "expired", "role-replaced"])(
  "REHSCHED-05 %s authority after checking cannot confirm or inspect",
  async (state) => {
    const token = randomBytes(32).toString("hex");
    await auth.provisionStaff(
      token,
      "platform_admin",
      new Date(Date.now() + 3600000),
    );
    const selected = await signIn(token),
      original = await checkedSchedule(token, selected);
    if (state === "role-replaced")
      await pool.query(
        "UPDATE staff_profiles SET role='operator' WHERE principal_id=(SELECT id FROM principals WHERE token_hash=$1)",
        [hash(token)],
      );
    else
      await pool.query(
        state === "revoked"
          ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE token_hash=$1"
          : "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
        [hash(token)],
      );
    expect(
      (
        await post("/operator/event-rehearsals/schedule", selected, {
          ...original,
          confirm: "yes",
        })
      ).status,
    ).toBe(403);
    expect(
      (await post("/operator/event-rehearsals/inspect", selected, original))
        .status,
    ).toBe(403);
    expect(
      (await pool.query("SELECT id FROM private_event_rehearsals")).rows,
    ).toEqual([]);
  },
);
it("REHSCHED-06 actual successful COMMIT with lost reply retains manual exact-key recovery and only one schedule", async () => {
  const token = randomBytes(32).toString("hex");
  await auth.provisionStaff(
    token,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const selected = await signIn(token),
    original = await checkedSchedule(token, selected);
  let lost = false,
    commits = 0;
  const faultPool = {
    connect: async () => {
      const real = await pool.connect();
      return new Proxy(real, {
        get(target, property) {
          if (property === "query")
            return async (sql: string, values?: unknown[]) => {
              const result = await target.query(sql, values);
              if (sql === "COMMIT") {
                commits++;
                if (!lost) {
                  lost = true;
                  throw Error(
                    "Invented lost reply after successful PostgreSQL COMMIT",
                  );
                }
              }
              return result;
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
    eventRehearsals: eventRehearsalStore(faultPool, {
      mode: "test",
      writes: true,
      registration: true,
    }),
  });
  const uncertain = await post(
    "/operator/event-rehearsals/schedule",
    selected,
    { ...original, confirm: "yes" },
    uncertainApp,
  );
  expect(uncertain.status).toBe(503);
  expect(lost).toBe(true);
  expect(commits).toBe(1);
  expect(uncertain.text).toContain("may already have committed");
  expect(uncertain.text).not.toContain(`?key=${original.key}`);
  const recovery = formFields(
    uncertain.text,
    "/operator/event-rehearsals/schedule",
  );
  expect(recovery).toEqual(original);
  expect(
    /type="checkbox"[^>]*name="confirm"[^>]*>/.exec(uncertain.text)?.[0],
  ).not.toMatch(/\bchecked\b/);
  const inspected = await post(
    "/operator/event-rehearsals/inspect",
    selected,
    formFields(uncertain.text, "/operator/event-rehearsals/inspect"),
  );
  expect(inspected.status).toBe(200);
  expect(inspected.text).toContain("This invented rehearsal is saved");
  expect(inspected.text).not.toContain(original.key);
  const repeated = await post(
    "/operator/event-rehearsals/schedule",
    selected,
    { ...recovery, confirm: "yes" },
    uncertainApp,
  );
  expect(repeated.status).toBe(200);
  expect(commits).toBe(2);
  expect(
    (await pool.query("SELECT id FROM private_event_rehearsals")).rows,
  ).toHaveLength(1);
  expect(
    (
      await pool.query(
        "SELECT idempotency_key FROM private_event_rehearsal_operations",
      )
    ).rows,
  ).toEqual([{ idempotency_key: original.key }]);
});
it.each(["technical", "professional", "explorer"] as const)(
  "REHSCHED-01/02 %s existing registration and selected staff work pass; selected administrator opens dated rehearsal scheduling entry",
  async (background) => {
    const member = randomBytes(32).toString("hex"),
      admin = randomBytes(32).toString("hex"),
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
    const event = EVENT_PREVIEWS.find(
      (e) => e.localRegistration === true && e.status === "current",
    )!;
    const enrolled = await post(
      `/events/${event.id}/${event.version}/enroll`,
      `${COOKIE}=${member}`,
      { csrf: csrf(member, secret), synthetic: "yes", operation_id: operation },
    );
    expect(enrolled.status, "Delivered member enrollment must still work").toBe(
      303,
    );
    expect(
      (await get(`/events/registrations/${operation}`, `${COOKIE}=${member}`))
        .status,
    ).toBe(200);
    const entry = await get("/staff/sign-in");
    expect(entry.status).toBe(200);
    const signed = await post(
      "/staff/sign-in",
      cookieFrom(entry, "dne_staff_entry"),
      { csrf: formCsrf(entry.text), credential: admin },
    );
    expect(signed.status, "Delivered staff browser entry must still work").toBe(
      303,
    );
    const selected = cookieFrom(signed, "dne_staff");
    expect(
      (await get("/operator/event-cancellations", selected)).status,
      "Delivered selected administrator cancellation entry must still work",
    ).toBe(200);
    const scheduling = await get("/operator/event-rehearsals", selected);
    expect(
      scheduling.status,
      "A selected administrator needs a dated invented rehearsal scheduling screen",
    ).toBe(200);
    expect(scheduling.text).toContain("Schedule a private rehearsal");
    const startsAt = new Date(Date.now() + 3600000).toISOString();
    const checked = await post("/operator/event-rehearsals/check", selected, {
      ...formFields(scheduling.text, "/operator/event-rehearsals/check"),
      startsAt,
    });
    expect(checked.status).toBe(200);
    const confirmation = /type="checkbox"[^>]*name="confirm"[^>]*>/.exec(
      checked.text,
    )?.[0];
    expect(confirmation).toBeTruthy();
    expect(confirmation).not.toMatch(/\bchecked\b/);
    const original = formFields(
      checked.text,
      "/operator/event-rehearsals/schedule",
    );
    expect(
      (await post("/operator/event-rehearsals/schedule", selected, original))
        .status,
    ).toBe(422);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM private_event_rehearsals",
        )
      ).rows[0].n,
    ).toBe(0);
    const saved = await post("/operator/event-rehearsals/schedule", selected, {
      ...original,
      confirm: "yes",
    });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(original.key);
    const target = /href="(\/events\/(local-rehearsal-[a-f0-9-]{36})\/1)"/.exec(
      saved.text,
    );
    expect(target).toBeTruthy();
    if (!target) throw Error("Saved invented event link missing");
    const memberCookie = `${COOKIE}=${member}`;
    const discovery = await get("/events", memberCookie);
    expect(discovery.status).toBe(200);
    expect(discovery.text).toContain(target[1]!);
    const detail = await get(target[1]!, memberCookie);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain(target[2]!);
    const newReceipt = randomUUID();
    const joined = await post(`${target[1]}/enroll`, memberCookie, {
      csrf: csrf(member, secret),
      synthetic: "yes",
      operation_id: newReceipt,
    });
    expect(joined.status).toBe(303);
    const retained = await get(
      `/events/registrations/${newReceipt}`,
      memberCookie,
    );
    expect(retained.status).toBe(200);
    expect(retained.text).toContain("Registered for the local rehearsal.");
    expect(retained.text).toContain(target[2]!);
  },
);
