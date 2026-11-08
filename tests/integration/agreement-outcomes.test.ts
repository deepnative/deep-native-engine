import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { agreementOutcomesStore } from "../../src/agreement-outcomes.ts";
import { app } from "../../src/app.ts";
import { COOKIE } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { disabledTrackStore } from "../../src/track-readiness.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #123 AGREE: course agreement outcomes over real PostgreSQL, invented data only.
const pool = testPool(),
  members = store(pool),
  outcomes = agreementOutcomesStore(pool);

beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(() => pool.end());

async function member(name: string) {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member missing");
  return { token, id: session.learner.id, name };
}
async function staff(role: "platform_admin" | "operator" | "coach") {
  const token = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    token,
    role,
    new Date(Date.now() + 86_400_000),
  );
  return token;
}

type Outcome = "waiting" | "withdrawn" | "active" | "cancelled";
async function agreement(
  owner: { id: string; name: string },
  outcome: Outcome,
  sample: boolean | null,
) {
  const id = randomUUID(),
    accepted = outcome === "active" || outcome === "cancelled";
  const terms = {
    cadence: "one_time",
    courses: [{ id: "ZAG-001", version: 1, amountCents: 43210 }],
    ...(sample === null ? {} : { sample }),
  };
  await pool.query(
    `INSERT INTO simple_invoice_plans(id,owner_id,workspace_id,terms,state,accepted_at,recipient_name,recipient_email)
     VALUES($1,$2,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      owner.id,
      terms,
      outcome === "waiting"
        ? "offered"
        : outcome === "withdrawn"
          ? "cancelled"
          : outcome,
      accepted ? new Date() : null,
      accepted ? owner.name : null,
      accepted ? `${owner.name.replaceAll(" ", ".")}@example.invalid` : null,
    ],
  );
  return id;
}

it("AGREE-01/02/03/05 counts real and test agreements apart, keeping withdrawn and cancelled ones in their denominators", async () => {
  const token = await staff("platform_admin");
  const empty = await outcomes.snapshot(token);
  expect(empty).toMatchObject({
    kind: "ready",
    value: {
      real: { offered: 0, accepted: 0, firstOffered: null, consistent: true },
      test: { offered: 0, consistent: true },
    },
  });
  const [a, b, c] = [
    await member("Invented Agreement One"),
    await member("Invented Agreement Two"),
    await member("Invented Agreement Three"),
  ];
  await agreement(a, "active", false);
  await agreement(a, "withdrawn", false);
  await agreement(b, "cancelled", false);
  await agreement(b, "waiting", false);
  await agreement(c, "active", true);
  // Terms that don't say are treated as a test, never as real.
  await agreement(c, "waiting", null);
  const result = await outcomes.snapshot(token);
  if (result.kind !== "ready") throw Error("Expected a snapshot");
  expect(result.value.real).toMatchObject({
    offered: 4,
    accepted: 2,
    waiting: 1,
    withdrawn: 1,
    active: 1,
    cancelled: 1,
    consistent: true,
  });
  expect(result.value.test).toMatchObject({
    offered: 2,
    accepted: 1,
    waiting: 1,
    withdrawn: 0,
    active: 1,
    cancelled: 0,
    consistent: true,
  });
  const { firstOffered, lastOffered, firstAccepted } = result.value.real;
  expect(firstOffered).toBeInstanceOf(Date);
  expect(+lastOffered!).toBeGreaterThanOrEqual(+firstOffered!);
  expect(firstAccepted).toBeInstanceOf(Date);
  expect(result.value.asOf).toBeInstanceOf(Date);
  // A deleted account's agreements go with it.
  await pool.query("DELETE FROM principals WHERE id=$1", [b.id]);
  const after = await outcomes.snapshot(token);
  expect(after).toMatchObject({
    kind: "ready",
    value: { real: { offered: 2, accepted: 1, cancelled: 0 } },
  });
});

it("AGREE-06/07 only a platform administrator sees figures, uncached, and never member details", async () => {
  const owner = await member("Invented Private Name");
  const id = await agreement(owner, "active", false);
  const tokens = {
    admin: await staff("platform_admin"),
    operator: await staff("operator"),
    coach: await staff("coach"),
    member: owner.token,
  };
  const application = app(members, {
    origin: "http://127.0.0.1:3000",
    secret: "invented-agreement-integration-test",
    mode: "test",
    tracks: disabledTrackStore(),
    agreementOutcomes: outcomes,
  });
  const read = (token?: string, path = "/operator/course-agreements") =>
    withLoopback(application, (s) => {
      const r = request(s).get(path).set("Host", "127.0.0.1:3000");
      return token ? r.set("Cookie", `${COOKIE}=${token}`) : r;
    });
  const shown = await read(tokens.admin);
  expect(shown.status).toBe(200);
  expect(shown.headers["cache-control"]).toBe("no-store");
  expect(shown.text).toMatch(/data-field="real.acceptance">1 of 1 \(100%\)/);
  for (const secret of [
    id,
    owner.id,
    owner.name,
    "Invented.Private.Name@example.invalid",
    "432.10",
    "43210",
    "ZAG-001",
  ])
    expect(shown.text).not.toContain(secret);
  for (const token of [
    tokens.operator,
    tokens.coach,
    tokens.member,
    undefined,
  ]) {
    const refused = await read(token);
    expect(refused.status).toBe(403);
    expect(refused.headers["cache-control"]).toBe("no-store");
    expect(refused.text).not.toMatch(/ of \d+ \(/);
  }
  expect(
    (await read(tokens.admin, "/operator/course-agreements?x=1")).status,
  ).toBe(400);
});
