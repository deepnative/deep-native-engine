import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  deterministicRegistry,
  type AdapterResult,
} from "../../src/adapters.ts";
import { app } from "../../src/app.ts";
import { evidenceStore, type ObjectStorage } from "../../src/evidence.ts";
import {
  invoiceReconciliationStore,
  readInvoiceReconciliation,
  type InvoiceReconciliationResult,
} from "../../src/invoice-reconciliation.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { COOKIE } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #123 RECON-15..19 for metered test AI requests. Only the AI boundary is stubbed.
// The default deterministic usage settles at 42 points against a 157-point estimate.
const SOURCE = "Invented source for private local practice";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  ledger = syntheticLedger(pool),
  data = new Map<string, Buffer>(),
  objects: ObjectStorage = {
    put: async (key, value) => {
      data.set(key, value);
    },
    get: async (key) => {
      const value = data.get(key);
      if (!value) throw Error("Synthetic source absent");
      return value;
    },
    remove: async (key) => {
      data.delete(key);
    },
  },
  registry = deterministicRegistry({}, "test"),
  execute = vi.fn(registry.adapter("ai", "test").execute),
  local = localAiConsentStore(pool, objects, {
    mode: "test",
    adapter: () => ({ ...registry.adapter("ai", "test"), execute }),
  }),
  evidence = evidenceStore(pool, objects, "synthetic-request-recon-secret"),
  report = invoiceReconciliationStore(pool),
  application = app(members, {
    origin: "http://127.0.0.1:3000",
    secret: "native-request-reconciliation-test",
    mode: "test",
    invoiceReconciliation: report,
  }),
  path = "/operator/invoice-reconciliation";
let admin: string;

const value = (r: InvoiceReconciliationResult) => {
  expect(r.kind).toBe("ready");
  if (r.kind !== "ready") throw Error("Expected report");
  return r.value;
};
const requests = async () => value(await report.snapshot(admin)).aiRequests;
const get = (url: string, token?: string) =>
  withLoopback(application, (s) => {
    const r = request(s).get(url).set("Host", "127.0.0.1:3000");
    return token ? r.set("Cookie", `${COOKIE}=${token}`) : r;
  });
const staff = async (role: "platform_admin" | "operator") => {
  const token = randomBytes(32).toString("hex");
  await auth.provisionStaff(token, role, new Date(Date.now() + 3_600_000));
  return token;
};
async function permitted() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Synthetic member unavailable");
  const uploaded = await evidence.upload(token, {
    name: "Invented-request.txt",
    mediaType: "text/plain",
    data: Buffer.from(SOURCE),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (uploaded.kind !== "created") throw Error("Synthetic upload unavailable");
  await evidence.transitionQuarantine(uploaded.id, "clean");
  const permission = await local.grant(token, uploaded.id);
  if (permission.kind !== "granted") throw Error("Synthetic grant unavailable");
  await ledger.grant(session.learner.id, "study_requests", 1, randomUUID(), {
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const queued = await local.enqueueMetered(
    token,
    permission.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  return {
    token,
    id: session.learner.id,
    receiptId: permission.receiptId,
    jobId: queued.jobId,
  };
}
const stubUsage = (usage: unknown) =>
  execute.mockImplementationOnce(
    async (...args) =>
      ({
        ...(await registry.adapter("ai", "test").execute(...args)),
        usage,
      }) as AdapterResult,
  );
async function settled(usage?: { inputTokens: number; outputTokens: number }) {
  const owner = await permitted();
  if (usage) stubUsage(usage);
  expect((await local.run(owner.token, owner.jobId)).kind).toBe("completed");
  return owner;
}

beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, cohorts CASCADE");
  await pool.query(
    "INSERT INTO local_ai_control(singleton,paused) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET paused=false",
  );
  data.clear();
  execute.mockReset();
  execute.mockImplementation(registry.adapter("ai", "test").execute);
  admin = await staff("platform_admin");
});
afterAll(() => pool.end());

it("RECON-15 no metered test AI requests gives an empty section with zero points", async () => {
  expect(await requests()).toMatchObject({
    status: "empty",
    requests: 0,
    estimatedPoints: 0,
    actualPoints: 0,
    mismatches: 0,
  });
  const page = await get(path, admin);
  expect(page.status).toBe(200);
  expect(page.text).toContain("Metered test AI requests · Test data");
  expect(page.text).toContain("No metered test AI requests to compare.");
});

it("RECON-16 estimated and actual cost stay apart, and an open estimate is never actual", async () => {
  await settled();
  await permitted();
  expect(await requests()).toMatchObject({
    status: "consistent",
    requests: 2,
    estimated: 2,
    noEstimate: 0,
    estimatedPoints: 314,
    settled: 1,
    settledEstimatePoints: 157,
    actualPoints: 42,
    openEstimatePoints: 157,
    reservedUnits: 1,
    consumedUnits: 1,
    releasedUnits: 0,
  });
  const page = await get(path, admin);
  expect(page.text).toContain("Simulated points at invented rates, not money");
  expect(page.text).not.toMatch(/CAD 0\.42|CAD 1\.57/);
});

it("RECON-17 requests above and below their estimate are counted apart, never netted", async () => {
  await settled();
  await settled({ inputTokens: 4000, outputTokens: 4000 });
  expect(await requests()).toMatchObject({
    settled: 2,
    actualPoints: 3642,
    settledEstimatePoints: 314,
    aboveEstimate: 1,
    abovePoints: 3443,
    belowEstimate: 1,
    belowPoints: 115,
  });
});

it("RECON-18 held and released units are not mismatches; a unit consumed without a cost is", async () => {
  const held = await permitted();
  stubUsage(undefined);
  expect((await local.run(held.token, held.jobId)).kind).toBe("unavailable");
  const released = await permitted();
  expect(await local.withdraw(released.token, released.receiptId)).toBe(true);
  expect(await requests()).toMatchObject({
    status: "consistent",
    requests: 2,
    heldUnknown: 1,
    reservedUnits: 1,
    releasedUnits: 1,
    consumedUnits: 0,
    mismatches: 0,
  });

  const stray = await permitted();
  const { reservation } = (
    await pool.query<{ reservation: string }>(
      "SELECT reservation_id AS reservation FROM local_ai_test_unit_jobs WHERE job_id=$1",
      [stray.jobId],
    )
  ).rows[0]!;
  await ledger.consume(stray.id, reservation, `recon-18:${randomUUID()}`);
  expect(await requests()).toMatchObject({
    status: "discrepancies",
    consumedWithoutActual: 1,
    actualWithoutConsumed: 0,
    mismatches: 1,
  });
  const page = await get(path, admin);
  expect(page.text).toContain("Unit used with no settled cost");
});

it("RECON-18 a settled cost whose unit is not consumed is a mismatch", async () => {
  const owner = await settled();
  const client = await pool.connect();
  try {
    // Models a faulty repair: the guard that keeps these in step is bypassed
    // only inside this rolled-back transaction.
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE synthetic_entitlement_reservations DISABLE TRIGGER USER",
    );
    await client.query(
      "UPDATE synthetic_entitlement_reservations SET state='reserved' WHERE id=(SELECT reservation_id FROM local_ai_test_unit_jobs WHERE job_id=$1)",
      [owner.jobId],
    );
    expect((await readInvoiceReconciliation(client)).aiRequests).toMatchObject(
      {
        status: "discrepancies",
        actualWithoutConsumed: 1,
        consumedWithoutActual: 0,
        mismatches: 1,
      },
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

it("RECON-19 denial shows no points, and reading names nobody and changes nothing", async () => {
  const owner = await settled();
  for (const token of [await staff("operator"), owner.token, undefined]) {
    const page = await get(path, token);
    expect(page.status).toBe(403);
    expect(page.text).not.toContain("points");
  }
  const counts = () =>
    pool.query(
      `SELECT (SELECT count(*) FROM ai_usage_settlements) AS settled,
              (SELECT string_agg(state,',' ORDER BY id) FROM synthetic_entitlement_reservations) AS units,
              (SELECT string_agg(status,',' ORDER BY id) FROM adapter_jobs) AS jobs`,
    );
  const before = (await counts()).rows;
  const page = await get(path, admin);
  expect(page.status).toBe(200);
  expect((await counts()).rows).toEqual(before);
  for (const id of [owner.id, owner.jobId, owner.receiptId])
    expect(page.text).not.toContain(id);
  expect(page.text).not.toContain(SOURCE);
});
