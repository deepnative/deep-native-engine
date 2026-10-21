import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { store, migrate } from "../../src/store.ts";
import { evidenceStore } from "../../src/evidence.ts";
import { preparedObjectStorage } from "../../src/prepared-sample-storage.ts";
import { preparedSampleStore } from "../../src/prepared-samples.ts";
import {
  PREPARED_SAMPLES,
  PROVIDED_SAMPLE_LABEL,
} from "../../src/prepared-sample-values.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";

const pool = testPool();
const origin = "https://engine.deepnative.io";
const host = new URL(origin).host;
const listeners = new Set<Server>();
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
});
afterEach(async () => {
  for (const server of listeners) await closeLoopback(server);
  listeners.clear();
});
afterAll(async () => pool.end());
const nonce = (text: string) =>
  text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;

async function fixture(
  overrides: { enabled?: boolean; hostedOrigin?: string } = {},
) {
  const raw = {
    put: vi.fn(async () => {
      throw Error("Provided copies must not write arbitrary bytes.");
    }),
    get: vi.fn(async (): Promise<Buffer> => {
      throw Error("Provided copies must resolve their exact source binding.");
    }),
    remove: vi.fn(async () => {
      throw Error("Provided copies must not remove arbitrary files.");
    }),
  };
  const settings = {
    enabled: true,
    mode: "test" as const,
    origin,
    hostedOrigin: origin,
    ...overrides,
  };
  const options = {
    origin,
    hostedOrigin: settings.hostedOrigin,
    mode: "test" as const,
    secret: "native-hosted-provided-only",
    preparedReviewSamples: settings.enabled,
    preparedSamples: preparedSampleStore(pool, settings),
    evidence: evidenceStore(
      pool,
      preparedObjectStorage(pool, raw),
      "native-hosted-provided-only",
    ),
  };
  const server = await listenLoopback(app(store(pool), options));
  listeners.add(server);
  return { server, raw };
}
async function member(
  server: Server,
  background: "technical" | "professional" | "explorer",
  goal: "build" | "work" | "everyday",
) {
  const home = await request(server).get("/").set("Host", host).expect(200);
  const cookie = (home.headers["set-cookie"] as unknown as string[])
    .find((item) => item.startsWith(`${COOKIE}=`))!
    .split(";")[0]!;
  await request(server)
    .post("/start")
    .set("Host", host)
    .set("Origin", origin)
    .set("Cookie", cookie)
    .type("form")
    .send({ csrf: nonce(home.text), background, goal, synthetic: "yes" })
    .expect(303);
  const get = (path: string) =>
    request(server).get(path).set("Host", host).set("Cookie", cookie);
  const page = await get("/evidence").expect(200);
  const csrf = nonce(page.text);
  const post = (path: string, data: Record<string, string> = {}) =>
    request(server)
      .post(path)
      .set("Host", host)
      .set("Origin", origin)
      .set("Cookie", cookie)
      .type("form")
      .send({ csrf, ...data });
  return { cookie, csrf, get, post, page };
}

it.each([
  ["technical", "build"],
  ["professional", "work"],
  ["explorer", "everyday"],
] as const)(
  "HOSTED-07 %s member deliberately copies and reloads an exact provided source at the configured HTTPS address",
  async (background, goal) => {
    const f = await fixture();
    const m = await member(f.server, background, goal);
    expect(m.page.text).toContain('href="/evidence/prepared"');
    const choice = await m.get("/evidence/prepared").expect(200);
    const sample = PREPARED_SAMPLES.find((item) => item.goal === goal)!;
    expect(choice.text).toContain(sample.digest);
    const operationId = randomUUID();
    const input = {
      operationId,
      templateId: sample.id,
      templateVersion: String(sample.version),
      templateDigest: sample.digest,
      providedExample: "yes",
      privateReview: "yes",
    };
    const copy = await m.post("/evidence/prepared", input).expect(200);
    const id = copy.text.match(/data-prepared-evidence="([a-f0-9-]+)"/)![1]!;
    expect(copy.text).toContain(PROVIDED_SAMPLE_LABEL);
    const replay = await m.post("/evidence/prepared", input).expect(200);
    expect(replay.text).toContain(`data-prepared-evidence="${id}"`);
    const reopened = await m.get("/evidence").expect(200);
    expect(reopened.text).toContain(id);
    const download = await m.post(`/evidence/${id}/download`).expect(303);
    const bytes = await m.get(download.headers.location as string).expect(200);
    expect(bytes.text).toBe(sample.text);
    const row = (
      await pool.query(
        "SELECT sha256,quarantine_state,private_review_allowed,community_publication_allowed FROM evidence_objects WHERE id=$1",
        [id],
      )
    ).rows[0];
    expect(row).toEqual({
      sha256: sample.digest,
      quarantine_state: "clean",
      private_review_allowed: true,
      community_publication_allowed: false,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM evidence_review_submissions",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await pool.query("SELECT count(*)::int n FROM assignment_grants"))
        .rows[0].n,
    ).toBe(0);
    expect(f.raw.put).not.toHaveBeenCalled();
    expect(f.raw.get).not.toHaveBeenCalled();
  },
);

it("HOSTED-08 refuses unconfigured, mismatched and disabled hosting without exposing the entry or creating copies", async () => {
  for (const override of [
    { hostedOrigin: undefined },
    { hostedOrigin: "https://other.deepnative.io" },
    { enabled: false },
  ]) {
    const f = await fixture(override);
    const m = await member(f.server, "explorer", "everyday");
    expect(m.page.text).not.toContain('href="/evidence/prepared"');
    await m.get("/evidence/prepared").expect(404);
    await m.post("/evidence/prepared").expect(404);
  }
  expect(
    (await pool.query("SELECT count(*)::int n FROM evidence_objects")).rows[0]
      .n,
  ).toBe(0);
});

it("HOSTED-08 keeps acknowledgements, exact source, Host, Origin, CSRF and member ownership mandatory", async () => {
  const f = await fixture();
  const m = await member(f.server, "explorer", "everyday");
  const sample = PREPARED_SAMPLES[0]!;
  const input = {
    operationId: randomUUID(),
    templateId: sample.id,
    templateVersion: String(sample.version),
    templateDigest: sample.digest,
    providedExample: "yes",
    privateReview: "yes",
  };
  const tamperingCases: Record<string, string>[] = [
    { providedExample: "" },
    { privateReview: "" },
    { templateDigest: "a".repeat(64) },
    { templateVersion: "2" },
    { text: "unapproved bytes" },
  ];
  for (const tampering of tamperingCases)
    await m.post("/evidence/prepared", { ...input, ...tampering }).expect(422);
  await m.post("/evidence/prepared", { ...input, csrf: "bad" }).expect(403);
  for (const [header, value] of [
    ["Host", "other.deepnative.io"],
    ["Origin", "https://other.deepnative.io"],
  ])
    await m.post("/evidence/prepared", input).set(header!, value!).expect(403);
  expect(
    (await pool.query("SELECT count(*)::int n FROM evidence_objects")).rows[0]
      .n,
  ).toBe(0);
  const copy = await m.post("/evidence/prepared", input).expect(200);
  const id = copy.text.match(/data-prepared-evidence="([a-f0-9-]+)"/)![1]!;
  const other = await member(f.server, "professional", "work");
  const denied = await other.post(`/evidence/${id}/download`).expect(403);
  expect(denied.text).not.toContain(sample.digest);
  expect((await other.get("/evidence").expect(200)).text).not.toContain(id);
  expect(f.raw.put).not.toHaveBeenCalled();
  expect(f.raw.get).not.toHaveBeenCalled();
});
