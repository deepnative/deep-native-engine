import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";

const pool = testPool(),
  members = store(pool),
  support = supportRequestStore(pool),
  ledger = syntheticLedger(pool);
const origin = "http://127.0.0.1:3000",
  secret = "synthetic-support-time-http";
let server: Server;
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
  server = await listenLoopback(
    app(members, { origin, secret, supportRequests: support }),
  );
});
afterEach(async () => closeLoopback(server));
afterAll(async () => pool.end());

it("holds exactly the explicitly confirmed existing support test minutes and reloads without a second reservation for every audience", async () => {
  for (const [background, goal] of [
    ["explorer", "everyday"],
    ["professional", "work"],
    ["technical", "build"],
  ] as const) {
    const token = randomBytes(32).toString("hex");
    await members.create(token, { background, goal });
    const session = await members.session(token);
    if (session.kind !== "active") throw Error("Invented member missing");
    const memberId = session.learner.id;
    const grant = await ledger.grant(
      memberId,
      "support_minutes",
      20,
      randomUUID(),
      {
        startsAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    );
    const intake = await support.create(token, {
      idempotencyKey: randomUUID(),
      subject: `Invented ${background} support`,
      body: "Invented sample, no real staff service.",
    });
    if (!("receipt" in intake)) throw Error("Invented request missing");
    const path = `/support/${intake.receipt.requestId}/time/allocate`,
      key = randomUUID();
    const form = {
      csrf: csrf(token, secret),
      idempotencyKey: key,
      ceiling: "20",
      confirm: "yes",
    };
    const post = () =>
      request(server)
        .post(path)
        .set("Host", "127.0.0.1:3000")
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${token}`)
        .type("form")
        .send(form);
    await request(server)
      .get(`/support/${intake.receipt.requestId}`)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`)
      .expect(200);
    expect(
      (
        await pool.query(
          "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
          [grant],
        )
      ).rows,
    ).toEqual([{ available: 20, reserved: 0, consumed: 0 }]);
    const saved = await post();
    const observed = (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [grant],
      )
    ).rows[0];
    expect(
      saved.status,
      `Owner-confirmed allocation must persist a usable saved receipt; observed balance ${JSON.stringify(observed)}`,
    ).toBe(303);
    expect(saved.headers.location).toBe(`/support/${intake.receipt.requestId}`);
    const location = saved.headers.location;
    if (!location) throw Error("Missing persisted allocation receipt location");
    const receipt = await request(server)
      .get(location)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`);
    expect(receipt.status).toBe(200);
    expect(receipt.headers["cache-control"]).toContain("no-store");
    expect(receipt.text).toContain("20 support test minutes held");
    expect((await post()).status).toBe(303);
    expect(
      (
        await pool.query(
          "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
          [grant],
        )
      ).rows,
    ).toEqual([{ available: 0, reserved: 20, consumed: 0 }]);
    const reservations = (
      await pool.query(
        "SELECT r.quantity,r.state FROM synthetic_entitlement_reservations r WHERE r.grant_id=$1",
        [grant],
      )
    ).rows;
    expect(reservations).toHaveLength(20);
    expect(
      reservations.every((r) => r.quantity === 1 && r.state === "reserved"),
    ).toBe(true);
    const events = (
      await pool.query(
        "SELECT operation,count(*)::integer n,sum(quantity)::integer units FROM synthetic_entitlement_events WHERE grant_id=$1 GROUP BY operation ORDER BY operation",
        [grant],
      )
    ).rows;
    expect(events).toEqual([
      { operation: "grant", n: 1, units: 20 },
      { operation: "reserve", n: 20, units: 20 },
    ]);
  }
});

it("serializes competing owner allocations for the last unit and rejects changed keys and foreign sessions", async () => {
  const token = randomBytes(32).toString("hex"),
    foreign = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  await members.create(foreign, { background: "technical", goal: "build" });
  const member = await members.session(token);
  if (member.kind !== "active" || !support.time)
    throw Error("Missing invented support fixture");
  await ledger.grant(member.learner.id, "support_minutes", 1, randomUUID(), {
    startsAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const created = await support.create(token, {
      idempotencyKey: randomUUID(),
      subject: `Invented request ${i}`,
      body: "Private fixture",
    });
    if (!("receipt" in created)) throw Error("Missing request");
    ids.push(created.receipt.requestId);
  }
  const keys = [randomUUID(), randomUUID()];
  expect(
    await support.time.allocate(foreign, ids[0]!, randomUUID(), 1),
  ).toEqual({ kind: "denied" });
  expect(await support.time.receipt(foreign, ids[0]!)).toEqual({
    kind: "denied",
  });
  const results = await Promise.all(
    ids.map((id, i) => support.time!.allocate(token, id, keys[i]!, 1)),
  );
  expect(results.map((r) => r.kind).sort()).toEqual([
    "applied",
    "insufficient",
  ]);
  const winner = results.findIndex((r) => r.kind === "applied");
  const replay = await support.time.allocate(
    token,
    ids[winner]!,
    keys[winner]!,
    1,
  );
  expect(replay.kind).toBe("replayed");
  expect(
    await support.time.allocate(token, ids[winner]!, keys[winner]!, 2),
  ).toEqual({ kind: "conflict" });
  expect(
    await support.time.allocate(token, ids[winner]!, randomUUID(), 1),
  ).toEqual({ kind: "conflict" });
  expect(await support.withdraw(token, ids[winner]!)).toEqual({
    kind: "withdrawn",
  });
  const withdrawn = await support.time.allocate(
    token,
    ids[winner]!,
    keys[winner]!,
    1,
  );
  expect(withdrawn.kind).toBe("replayed");
  if (!("receipt" in withdrawn)) throw Error("Missing replay receipt");
  expect(withdrawn.receipt).toMatchObject({
    state: "cancelled",
    held: 0,
    released: 1,
    consumed: 0,
  });
  expect(
    await support.time.allocate(token, ids[winner]!, randomUUID(), 1),
  ).toEqual({ kind: "withdrawn" });
  const detail = await support.memberDetail(token, ids[winner]!);
  expect(detail.kind).toBe("ready");
  if (detail.kind !== "ready") throw Error("Missing withdrawn detail");
  expect(detail.value.body).toBeNull();
  expect(detail.value.supportTime).toMatchObject({
    state: "cancelled",
    held: 0,
    released: 1,
  });
});

it("requires the member's explicit bounded confirmation and rejects forged fields without holding minutes", async () => {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "professional", goal: "work" });
  const member = await members.session(token);
  if (member.kind !== "active") throw Error("Missing member");
  const created = await support.create(token, {
    idempotencyKey: randomUUID(),
    subject: "Invented consent check",
    body: "Private sample",
  });
  if (!("receipt" in created)) throw Error("Missing request");
  const grant = await ledger.grant(
    member.learner.id,
    "support_minutes",
    20,
    randomUUID(),
    {
      startsAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  );
  const path = `/support/${created.receipt.requestId}/time/allocate`;
  const valid = {
    csrf: csrf(token, secret),
    idempotencyKey: randomUUID(),
    ceiling: "20",
    confirm: "yes",
  };
  for (const fields of [
    { ...valid, confirm: "no" },
    { ...valid, ceiling: "0" },
    { ...valid, ceiling: "121" },
    { ...valid, ceiling: "1.5" },
    { ...valid, grantId: grant },
    { ...valid, memberId: member.learner.id },
  ]) {
    await request(server)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send(fields)
      .expect(422);
  }
  await request(server)
    .post(path)
    .set("Host", "127.0.0.1:3000")
    .set("Origin", origin)
    .set("Cookie", `${COOKIE}=${token}`)
    .type("form")
    .send({ ...valid, csrf: "forged" })
    .expect(403);
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [grant],
      )
    ).rows,
  ).toEqual([{ available: 20, reserved: 0, consumed: 0 }]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM support_time_allocations WHERE member_id=$1",
        [member.learner.id],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});
