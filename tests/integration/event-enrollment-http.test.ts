import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { eventEnrollmentStore } from "../../src/event-enrollments.ts";
import type { EventPreview } from "../../src/events.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
const pool = testPool(),
  db = store(pool),
  origin = "http://127.0.0.1:3000",
  secret = "invented-event-http";
const event: EventPreview = {
  id: "invented-http-event",
  version: 1,
  status: "current",
  title: "Invented <event> & rehearsal",
  description: "Sample only",
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
  catalog: [event],
});
const application = app(db, { origin, secret, eventEnrollments: events });
beforeAll(() => migrate(pool));
beforeEach(() =>
  pool.query("TRUNCATE principals,private_event_inventory CASCADE"),
);
afterAll(() => pool.end());
async function member(
  background: "technical" | "professional" | "explorer" = "explorer",
) {
  const token = randomBytes(32).toString("hex");
  await db.create(token, {
    background,
    goal: "everyday",
    timezone: "America/Toronto",
  });
  return token;
}
function get(token: string, path: string) {
  return withLoopback(application, (server) =>
    request(server)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
}
function post(
  token: string,
  path: string,
  fields: Record<string, string>,
  requestOrigin = origin,
) {
  return withLoopback(application, (server) =>
    request(server)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", requestOrigin)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf: csrf(token, secret), ...fields }),
  );
}
const base = `/events/${event.id}/1`;
it.each(["technical", "professional", "explorer"] as const)(
  "lets %s deliberately enroll, reload, withdraw and retain only own receipts",
  async (background) => {
    const owner = await member(background),
      other = await member(background),
      operation = randomUUID();
    const preview = await get(owner, base + "/rehearsal");
    expect(preview.status).toBe(200);
    expect(preview.text).toContain("Invented &lt;event&gt; &amp; rehearsal");
    expect(preview.text).toContain("GMT-04:00");
    expect(preview.text).toContain("GMT-05:00");
    expect(preview.text).toContain('name="synthetic"');
    const begun = await post(owner, base + "/enroll", {
      synthetic: "yes",
      operation_id: operation,
    });
    expect(begun.status).toBe(303);
    const location = begun.headers.location as string;
    expect(location).toBe(`/events/registrations/${operation}`);
    const saved = await get(owner, location);
    expect(saved.status).toBe(200);
    expect(saved.text).toContain("Registered for the local rehearsal.");
    expect((await get(other, location)).status).toBe(404);
    expect(
      (await post(other, location + "/withdraw", { confirm: "yes" })).status,
    ).toBe(404);
    expect(
      (
        await post(other, base + "/enroll", {
          synthetic: "yes",
          operation_id: randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(
      (await post(owner, location + "/withdraw", { confirm: "yes" })).status,
    ).toBe(303);
    expect((await get(owner, location)).text).toContain(
      "Registration withdrawn.",
    );
    expect((await get(owner, "/events/registrations")).text).toContain(
      location,
    );
    expect((await get(other, "/events/registrations")).text).not.toContain(
      operation,
    );
    expect(
      (
        await post(other, base + "/enroll", {
          synthetic: "yes",
          operation_id: randomUUID(),
        })
      ).status,
    ).toBe(303);
  },
);
it("refuses malformed confirmation, extra fields, foreign Origin and invalid CSRF without writing", async () => {
  const token = await member(),
    operation = randomUUID();
  const invalidFields: Record<string, string>[] = [
    { operation_id: operation },
    { operation_id: "not-an-id", synthetic: "yes" },
    { operation_id: operation, synthetic: "yes", attendee: "someone-else" },
  ];
  for (const fields of invalidFields) {
    expect((await post(token, base + "/enroll", fields)).status).toBe(422);
  }
  expect(
    (
      await post(
        token,
        base + "/enroll",
        { operation_id: operation, synthetic: "yes" },
        "https://foreign.invalid",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await post(token, base + "/enroll", {
        operation_id: operation,
        synthetic: "yes",
        csrf: "invalid",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int count FROM private_event_enrollments",
      )
    ).rows[0].count,
  ).toBe(0);
});
it("refuses missing event versions and invalid history cursors without disclosing receipts", async () => {
  const token = await member();
  for (const path of [
    "/events/unknown/1/rehearsal",
    "/events/invented-http-event/0/rehearsal",
    "/events/registrations/not-an-id",
    "/events/registrations?after=bad",
    "/events/registrations?unexpected=yes",
  ])
    expect((await get(token, path)).status).toBe(404);
});
