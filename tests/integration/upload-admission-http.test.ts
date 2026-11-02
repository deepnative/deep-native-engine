import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request as httpRequest, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { uploadAdmissionStore } from "../../src/upload-admission.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
let running: Awaited<ReturnType<typeof start>>, root: string;

function environment() {
  return {
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: root,
  };
}
async function member() {
  const token = randomBytes(32).toString("hex");
  await store(pool).create(token, { background: "explorer", goal: "everyday" });
  const page = await request(running.server)
    .get("/evidence")
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${token}`)
    .expect(200);
  return {
    token,
    csrf: page.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!,
  };
}
function upload(
  target: Awaited<ReturnType<typeof start>>,
  caller: { token: string; csrf: string },
  name: string,
) {
  return request(target.server)
    .post("/api/evidence")
    .set("Host", new URL(target.origin).host)
    .set("Origin", target.origin)
    .set("Cookie", `${COOKIE}=${caller.token}`)
    .set("X-CSRF-Token", caller.csrf)
    .set("Content-Type", "text/plain")
    .set("X-Evidence-Name", name)
    .set("X-Evidence-Rights", "confirmed")
    .set("X-Evidence-Scopes", "private-review")
    .send(`Invented evidence sample ${name}.`);
}
async function savedCount() {
  return Number(
    (
      await pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM evidence_objects",
      )
    ).rows[0]!.n,
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dne315-admission-"));
  running = await start(environment());
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE principals,cohorts,upload_admission_windows,upload_admission_leases,upload_admission_denials CASCADE",
  );
});
afterAll(async () => {
  await running?.close();
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});

it("ADMIT-02 refuses a member's eleventh upload in the window before reading the body", async () => {
  const caller = await member();
  for (let i = 1; i <= 10; i++)
    expect((await upload(running, caller, `burst-${i}.txt`)).status).toBe(201);
  const before = await readdir(root, { recursive: true });
  const refused = await upload(running, caller, "burst-11.txt");
  expect(refused.status).toBe(429);
  expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
  expect(refused.headers["cache-control"]).toContain("no-store");
  expect(refused.body).toEqual({
    error: "too_many_uploads",
    retryAfterSeconds: Number(refused.headers["retry-after"]),
    action: expect.stringMatching(/^Wait \d+ seconds?, then upload again\./),
  });
  expect(await savedCount()).toBe(10);
  expect(await readdir(root, { recursive: true })).toEqual(before);
});

// Sends headers and part of a body, keeping the upload in progress.
function heldUpload(caller: { token: string; csrf: string }, name: string) {
  const body = `Invented evidence sample ${name}.`;
  const response = new Promise<number>((resolve, reject) => {
    held = httpRequest(
      {
        host: "127.0.0.1",
        port: (running.server.address() as AddressInfo).port,
        method: "POST",
        path: "/api/evidence",
        headers: {
          Host: new URL(running.origin).host,
          Origin: running.origin,
          Cookie: `${COOKIE}=${caller.token}`,
          "X-CSRF-Token": caller.csrf,
          "Content-Type": "text/plain",
          "Content-Length": String(body.length),
          "X-Evidence-Name": name,
          "X-Evidence-Rights": "confirmed",
          "X-Evidence-Scopes": "private-review",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    ).on("error", reject);
    held.write(body.slice(0, 5));
  });
  const writer = held!;
  return { response, finish: () => writer.end(body.slice(5)) };
}
let held: ClientRequest | undefined;
async function leases() {
  return Number(
    (
      await pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM upload_admission_leases WHERE expires_at>clock_timestamp()",
      )
    ).rows[0]!.n,
  );
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error("Condition not reached");
}

it("ADMIT-01 saves ordinary API and form uploads with the existing checks", async () => {
  const caller = await member();
  const api = await upload(running, caller, "ordinary.txt");
  expect(api.status).toBe(201);
  expect(api.body).toMatchObject({ kind: "created", state: "pending" });
  const form = await request(running.server)
    .post("/evidence")
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", `${COOKIE}=${caller.token}`)
    .type("form")
    .send({
      csrf: caller.csrf,
      name: "form-sample.txt",
      sample: "An invented form sample.",
      rights_confirmed: "yes",
      private_review_consent: "yes",
    });
  expect(form.status).toBe(303);
  expect(await savedCount()).toBe(2);
  expect(await leases()).toBe(0);
});

it("ADMIT-02 refuses a member's form upload over budget and keeps the typed text", async () => {
  const caller = await member();
  for (let i = 1; i <= 10; i++)
    expect((await upload(running, caller, `form-burst-${i}.txt`)).status).toBe(
      201,
    );
  const refused = await request(running.server)
    .post("/evidence")
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", `${COOKIE}=${caller.token}`)
    .type("form")
    .send({
      csrf: caller.csrf,
      name: "kept-title.txt",
      sample: "Invented text the member typed.",
      rights_confirmed: "yes",
      private_review_consent: "yes",
    });
  expect(refused.status).toBe(429);
  expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
  expect(refused.text).toMatch(/Wait \d+ seconds?, then upload again\./);
  expect(refused.text).toContain("kept-title.txt");
  expect(refused.text).toContain("Invented text the member typed.");
  expect(await savedCount()).toBe(10);
});

it("ADMIT-03 bounds a member's concurrent uploads and recovers when one finishes", async () => {
  const caller = await member();
  const first = heldUpload(caller, "slow-1.txt");
  await until(async () => (await leases()) === 1);
  const second = heldUpload(caller, "slow-2.txt");
  await until(async () => (await leases()) === 2);
  const third = await upload(running, caller, "third.txt");
  expect(third.status).toBe(429);
  expect(third.headers["retry-after"]).toBe("5");
  expect(third.body).toMatchObject({ error: "upload_in_progress" });
  first.finish();
  expect(await first.response).toBe(201);
  await until(async () => (await leases()) === 1);
  expect((await upload(running, caller, "after.txt")).status).toBe(201);
  second.finish();
  expect(await second.response).toBe(201);
  expect(await savedCount()).toBe(3);
});

it("ADMIT-03 ignores leases left behind by a stopped instance once they expire", async () => {
  const caller = await member();
  const stale = await pool.query(
    `INSERT INTO upload_admission_leases(id,principal_id,expires_at)
     SELECT gen_random_uuid(),id,clock_timestamp()-interval '1 second'
     FROM principals, generate_series(1,2) WHERE token_hash=encode(sha256($1::bytea),'hex')`,
    [caller.token],
  );
  expect(stale.rowCount).toBe(2);
  expect((await upload(running, caller, "after-crash.txt")).status).toBe(201);
});

it("ADMIT-04 counts members separately and ignores forwarding or workspace headers", async () => {
  const first = await member();
  const second = await member();
  for (let i = 1; i <= 10; i++)
    expect((await upload(running, first, `own-${i}.txt`)).status).toBe(201);
  expect((await upload(running, second, "other.txt")).status).toBe(201);
  const spoofed = await upload(running, first, "spoofed.txt")
    .set("X-Forwarded-For", "203.0.113.9")
    .set("Forwarded", "for=203.0.113.9")
    .set("X-Real-IP", "203.0.113.9")
    .set("X-Workspace-Id", "00000000-0000-0000-0000-000000000000");
  expect(spoofed.status).toBe(429);
  expect(await savedCount()).toBe(11);
});

it("ADMIT-05 bounds signed-out callers before the body is read without touching member budgets", async () => {
  const anonymous = () =>
    request(running.server)
      .post("/api/evidence")
      .set("Host", new URL(running.origin).host)
      .set("Origin", running.origin)
      .set("Content-Type", "text/plain")
      .send("Invented anonymous bytes.");
  for (let i = 1; i <= 20; i++) expect((await anonymous()).status).toBe(403);
  const refused = await anonymous();
  expect(refused.status).toBe(429);
  expect(refused.body).toMatchObject({ error: "too_many_uploads" });
  const invalidSession = await anonymous().set(
    "Cookie",
    `${COOKIE}=${"0".repeat(64)}`,
  );
  expect(invalidSession.status).toBe(429);
  expect((await upload(running, await member(), "member.txt")).status).toBe(
    201,
  );
});

it("ADMIT-06 keeps a member refused on a restarted or second instance", async () => {
  const caller = await member();
  for (let i = 1; i <= 10; i++)
    expect((await upload(running, caller, `before-${i}.txt`)).status).toBe(201);
  const second = await start(environment());
  try {
    const refused = await upload(second, caller, "second-instance.txt");
    expect(refused.status).toBe(429);
  } finally {
    await second.close();
  }
  const restarted = await start(environment());
  try {
    expect((await upload(restarted, caller, "restarted.txt")).status).toBe(429);
  } finally {
    await restarted.close();
  }
  expect(await savedCount()).toBe(10);
});

it("ADMIT-07 fails closed with a fixed operator message when the limiter does not answer", async () => {
  const caller = await member();
  const blocker = await pool.connect();
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await blocker.query("SELECT pg_advisory_lock(315085)");
    const refused = await upload(running, caller, "while-unavailable.txt");
    expect(refused.status).toBe(503);
    expect(refused.headers["retry-after"]).toBe("60");
    expect(refused.body).toEqual({
      error: "uploads_unavailable",
      retryAfterSeconds: 60,
      action:
        "Uploads are temporarily unavailable. Try again in a minute. Saved evidence is unchanged.",
    });
    expect(errors.mock.calls).toEqual([
      ["Upload admission unavailable; uploads are refused."],
    ]);
  } finally {
    errors.mockRestore();
    await blocker.query("SELECT pg_advisory_unlock(315085)");
    blocker.release();
  }
  expect(await savedCount()).toBe(0);
  expect((await upload(running, caller, "recovered.txt")).status).toBe(201);
});

it("ADMIT-07 reports an unreachable limiter database as unavailable", async () => {
  const unreachable = new Pool({
    host: "127.0.0.1",
    port: 9,
    connectionTimeoutMillis: 500,
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(
      await uploadAdmissionStore(unreachable).admit("a".repeat(64)),
    ).toEqual({ kind: "unavailable" });
    expect(errors).toHaveBeenCalledWith(
      "Upload admission unavailable; uploads are refused.",
    );
  } finally {
    errors.mockRestore();
    await unreachable.end();
  }
});

it("ADMIT-08 accepts the member again after the window passes", async () => {
  const caller = await member();
  for (let i = 1; i <= 10; i++)
    expect((await upload(running, caller, `window-${i}.txt`)).status).toBe(201);
  expect((await upload(running, caller, "refused.txt")).status).toBe(429);
  await pool.query(
    "UPDATE upload_admission_windows SET window_start=window_start-interval '10 minutes'",
  );
  expect((await upload(running, caller, "next-window.txt")).status).toBe(201);
  expect(await savedCount()).toBe(11);
});

it("ADMIT-09 records only hourly counts by reason and applies retention", async () => {
  const caller = await member();
  for (let i = 1; i <= 10; i++)
    expect((await upload(running, caller, `signal-${i}.txt`)).status).toBe(201);
  expect((await upload(running, caller, "denied-1.txt")).status).toBe(429);
  expect((await upload(running, caller, "denied-2.txt")).status).toBe(429);
  const signal = await uploadAdmissionStore(pool).denials();
  expect(signal).toEqual([
    { hourStart: expect.any(Date), reason: "member_rate", denied: 2 },
  ]);
  expect(
    (
      await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='upload_admission_denials' ORDER BY ordinal_position`,
      )
    ).rows.map((row) => row.column_name),
  ).toEqual(["hour_start", "reason", "denied"]);
  await pool.query(
    `INSERT INTO upload_admission_windows(pool,principal_id,window_start,admitted)
     VALUES('global',NULL,clock_timestamp()-interval '2 days',3);
     INSERT INTO upload_admission_denials(hour_start,reason,denied)
     VALUES(date_trunc('hour',clock_timestamp()-interval '31 days'),'global_rate',4);
     INSERT INTO upload_admission_leases(id,principal_id,expires_at)
     VALUES(gen_random_uuid(),NULL,clock_timestamp()-interval '1 minute')`,
  );
  expect((await upload(running, await member(), "purge.txt")).status).toBe(201);
  const remaining = await pool.query<{ old: string }>(
    `SELECT (SELECT count(*) FROM upload_admission_windows WHERE window_start<clock_timestamp()-interval '1 day')
          +(SELECT count(*) FROM upload_admission_denials WHERE hour_start<clock_timestamp()-interval '30 days')
          +(SELECT count(*) FROM upload_admission_leases WHERE expires_at<clock_timestamp()) AS old`,
  );
  expect(Number(remaining.rows[0]!.old)).toBe(0);
  const owned = `SELECT count(*) AS n FROM upload_admission_windows w
     JOIN principals p ON p.id=w.principal_id
     WHERE p.token_hash=encode(sha256($1::bytea),'hex')`;
  const before = await pool.query<{ n: string }>(owned, [caller.token]);
  expect(Number(before.rows[0]!.n)).toBe(1);
  const memberRows = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM upload_admission_windows WHERE pool='member'",
  );
  await pool.query(
    "DELETE FROM principals WHERE token_hash=encode(sha256($1::bytea),'hex')",
    [caller.token],
  );
  expect(
    Number(
      (
        await pool.query<{ n: string }>(
          "SELECT count(*) AS n FROM upload_admission_windows WHERE pool='member'",
        )
      ).rows[0]!.n,
    ),
  ).toBe(Number(memberRows.rows[0]!.n) - 1);
});
