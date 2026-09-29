import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { attemptStore } from "../../src/attempts.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { COOKIE } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

const pool = testPool();
const db = store(pool);
const origin = "http://127.0.0.1:3000";
const secret = "synthetic-attempt-comparison-secret";
const first = "Invented <private> first line\nKeep this line\r\n";
const second = "Invented <private> second line\nKeep this line\r\n";

beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(async () => pool.end());

async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member setup failed");
  return { token, id: session.learner.id };
}

async function fixture() {
  const owner = await member();
  const outsider = await member();
  const auth = authorizationStore(pool);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  const catalog = catalogStore(pool);
  const draft: DraftContent = {
    id: "SYN-960",
    version: 1,
    kind: "assignment",
    origin: "curated",
    title: "Invented comparison assignment",
    body: "Only invented answers.",
    owner: "Synthetic editor",
    sources: "Original invented brief",
    rights: "Owned sample",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites: "None",
    rubric: "Compare against the invented brief.",
    rubricVersion: 1,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, draft.id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, draft.id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, draft.id, 1)).toBe(true);
  expect(await db.chooseAssignment(owner.id, draft.id, 1)).toBe(true);
  const attempts = attemptStore(pool);
  const id = (await attempts.start(owner.token))!;
  expect(await attempts.save(owner.token, id, 1, first)).toBe(true);
  expect(await attempts.submit(owner.token, id, 2)).toBe(true);
  expect(await attempts.revise(owner.token, id)).toBe(true);
  const revision = (await attempts.detail(owner.token, id))!.revision;
  expect(await attempts.save(owner.token, id, revision, second)).toBe(true);
  expect(await attempts.submit(owner.token, id, revision + 1)).toBe(true);
  expect(await catalog.retire(editor, draft.id)).toBe(true);
  return { owner, outsider, reviewer, attempts, id };
}

async function getWithApp(
  application: ReturnType<typeof app>,
  token: string,
  id: string,
  query: string,
) {
  return withLoopback(application, (server) =>
    request(server)
      .get(`/assignments/attempts/${id}/compare${query}`)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
}

function get(token: string, id: string, query: string) {
  return getWithApp(
    app(db, { origin, secret, attempts: attemptStore(pool) }),
    token,
    id,
    query,
  );
}

type RequestStage =
  | "owner"
  | "outsider"
  | "staff"
  | "forged"
  | "invalid-same"
  | "invalid-missing"
  | "invalid-leading-zero"
  | "invalid-duplicate"
  | "revoked"
  | "failed-read"
  | "expired"
  | "deleted";

function transportDiagnostic(stage: RequestStage, error: unknown) {
  const fault =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const parserCodes = [
    "HPE_INVALID_CONSTANT",
    "HPE_INVALID_HEADER_TOKEN",
    "HPE_UNEXPECTED_CONTENT_LENGTH",
  ] as const;
  const connectionCodes = [
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ETIMEDOUT",
  ] as const;
  const code =
    [...parserCodes, ...connectionCodes].find(
      (known) => fault.code === known,
    ) ?? "other";
  const framing =
    code === "HPE_INVALID_CONSTANT"
      ? "start-line"
      : code === "HPE_INVALID_HEADER_TOKEN"
        ? "header"
        : code === "HPE_UNEXPECTED_CONTENT_LENGTH"
          ? "content-length"
          : connectionCodes.some((known) => known === code)
            ? "connection"
            : "unknown";
  const bytesParsed =
    typeof fault.bytesParsed === "number" &&
    Number.isSafeInteger(fault.bytesParsed) &&
    fault.bytesParsed >= 0
      ? fault.bytesParsed
      : "unavailable";
  const rawPacketBytes =
    Buffer.isBuffer(fault.rawPacket) || fault.rawPacket instanceof Uint8Array
      ? fault.rawPacket.byteLength
      : "unavailable";
  return new Error(
    `Comparison request failed: stage=${stage} framing=${framing} code=${code} bytesParsed=${bytesParsed} rawPacketBytes=${rawPacketBytes}`,
  );
}

async function observed<T>(
  stage: RequestStage,
  pending: PromiseLike<T>,
): Promise<T> {
  try {
    return await pending;
  } catch (error) {
    throw transportDiagnostic(stage, error);
  }
}

it("limits a parser failure to fixed request stage and numeric framing metadata", async () => {
  const error = {
    code: "HPE_INVALID_CONSTANT",
    bytesParsed: 7,
    rawPacket: Buffer.from("synthetic private packet words"),
    message: "synthetic private response words",
  };
  let diagnostic: Error | undefined;
  try {
    await observed("owner", Promise.reject(error));
  } catch (caught) {
    diagnostic = caught as Error;
  }
  expect(diagnostic?.message).toContain("stage=owner");
  expect(diagnostic?.message).toContain("framing=start-line");
  expect(diagnostic?.message).toContain("code=HPE_INVALID_CONSTANT");
  expect(diagnostic?.message).toContain("bytesParsed=7");
  expect(diagnostic?.message).toContain("rawPacketBytes=30");
  expect(diagnostic?.message).not.toContain("private");
  expect(diagnostic?.message).not.toContain("synthetic");
  expect(diagnostic?.message).not.toContain("packet words");
  expect(diagnostic?.cause).toBeUndefined();
});

it("compares only retained owner snapshots after retirement without writing or exposing a draft", async () => {
  const { owner, outsider, reviewer, attempts, id } = await fixture();
  const before = await attempts.detail(owner.token, id);
  const response = await observed(
    "owner",
    get(owner.token, id, "?from=2&to=1"),
  );
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.text).toContain("From submission 2");
  expect(response.text).toContain("To submission 1");
  expect(response.text).toContain("Invented &lt;private&gt; first line");
  expect(response.text).toContain("Invented &lt;private&gt; second line");
  expect(response.text).toContain("&#13;\n");
  expect(response.text).not.toContain("Invented <private>");
  expect(response.text).not.toContain("approved by a reviewer");
  expect(await attempts.detail(owner.token, id)).toEqual(before);
  const foreign = await observed(
    "outsider",
    get(outsider.token, id, "?from=1&to=2"),
  );
  expect(foreign.status).toBe(404);
  expect(foreign.text).not.toContain("Invented &lt;private&gt;");
  const staff = await observed("staff", get(reviewer, id, "?from=1&to=2"));
  expect(staff.status).toBe(303);
  expect(staff.text).not.toContain("Invented &lt;private&gt;");
  const forged = await observed(
    "forged",
    get(owner.token, randomUUID(), "?from=1&to=2"),
  );
  expect(forged.status).toBe(404);
  expect(forged.text).not.toContain("Invented &lt;private&gt;");
  for (const [stage, query] of [
    ["invalid-same", "?from=1&to=1"],
    ["invalid-missing", "?from=1&to=3"],
    ["invalid-leading-zero", "?from=01&to=2"],
    ["invalid-duplicate", "?from=1&from=2&to=2"],
  ] as const) {
    const invalid = await observed(stage, get(owner.token, id, query));
    expect(invalid.status).toBe(422);
    expect(invalid.text).not.toContain("Invented &lt;private&gt;");
  }
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [owner.id],
  );
  const revoked = await observed(
    "revoked",
    get(owner.token, id, "?from=1&to=2"),
  );
  expect(revoked.status).not.toBe(200);
  expect(revoked.text).not.toContain("Invented &lt;private&gt;");
});

it("fails closed on expired, deleted and failed snapshot reads", async () => {
  const { owner, attempts, id } = await fixture();
  const failing = getWithApp(
    app(db, {
      origin,
      secret,
      attempts: {
        ...attempts,
        detail: async () => {
          throw new Error("synthetic private database secret");
        },
      },
    }),
    owner.token,
    id,
    "?from=1&to=2",
  );
  const unavailable = await observed("failed-read", failing);
  expect(unavailable.status).toBe(503);
  expect(unavailable.text).not.toContain("synthetic private database secret");
  expect(unavailable.text).not.toContain("Invented &lt;private&gt;");
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE id=$1",
    [owner.id],
  );
  const expired = await observed(
    "expired",
    get(owner.token, id, "?from=1&to=2"),
  );
  expect(expired.status).not.toBe(200);
  expect(expired.text).not.toContain("Invented &lt;private&gt;");
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP+interval '1 day' WHERE id=$1",
    [owner.id],
  );
  expect(await attempts.remove(owner.token, id)).toBe(true);
  const deleted = await observed(
    "deleted",
    get(owner.token, id, "?from=1&to=2"),
  );
  expect(deleted.status).toBe(404);
  expect(deleted.text).not.toContain("Invented &lt;private&gt;");
});
