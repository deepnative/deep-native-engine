import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
let running: Awaited<ReturnType<typeof start>>, storage: string;
beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "dne121-http-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: storage,
    DNE_LOCAL_STAFF_ENTRY: "enabled",
  });
});
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
});
afterAll(async () => {
  await running?.close();
  await pool.end();
  if (storage) await rm(storage, { recursive: true, force: true });
});
it("MR-03 native HTML denies unsupported and changed roles without altering the JSON authorization contract", async () => {
  const credential = randomBytes(32).toString("hex");
  const id = await authorizationStore(pool).provisionStaff(
    credential,
    "operator",
    new Date(Date.now() + 3600000),
  );
  const get = (path: string) =>
    request(running.server)
      .get(path)
      .set("Host", new URL(running.origin).host)
      .set("Cookie", `dne_staff=${credential}`);
  await get("/operator/metrics/report").expect(200);
  await pool.query(
    "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
    [id],
  );
  const denied = await get("/operator/metrics/report").expect(403);
  expect(denied.text).not.toContain('data-metric="members"');
  await get("/operator/metrics").expect(403);
  await get("/operator/metrics/report?background=technical").expect(400);
});
it("MR-01 an administrator can read the retained-learning snapshot as HTML while the existing JSON remains available", async () => {
  const credential = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    credential,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const get = (path: string) =>
    request(running.server)
      .get(path)
      .set("Host", new URL(running.origin).host)
      .set("Cookie", `dne_staff=${credential}`);
  const json = await get("/operator/metrics").expect(200);
  expect(json.body.scope).toBe("synthetic-local-preview");
  const html = await get("/operator/metrics/report").expect(200);
  expect(html.type).toBe("text/html");
  expect(html.text).toContain("Learning and participation snapshot");
  expect(html.text).toContain("No eligible members yet");
  expect(html.text).toContain("Suppressed to protect small groups");
  expect(html.text).toContain('href="/operator/metrics"');
});
