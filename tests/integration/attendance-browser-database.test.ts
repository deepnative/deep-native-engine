import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  dropAttendanceBrowserDatabase,
  waitForAttendanceBrowserDatabaseDrain,
} from "../support/attendance-browser-database.ts";
async function fixture() {
  const original = process.env.DNE_TEST_DATABASE_URL;
  if (
    !original ||
    !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(original).pathname)
  )
    throw Error("Generated test database required");
  const name = `dne_test_${randomBytes(16).toString("hex")}`;
  const adminUrl = new URL(original),
    ownUrl = new URL(original);
  adminUrl.pathname = "/postgres";
  ownUrl.pathname = "/" + name;
  const control = new Pool({ connectionString: adminUrl.href });
  await control.query(`CREATE DATABASE "${name}"`);
  const own = new Pool({ connectionString: ownUrl.href });
  await own.query("SELECT pg_backend_pid()");
  const active = await control.query(
    "SELECT COUNT(*)::integer count FROM pg_stat_activity WHERE datname=$1",
    [name],
  );
  expect(active.rows[0].count).toBe(1);
  return { name, control, own };
}

let f: Awaited<ReturnType<typeof fixture>>;
let ended: Promise<void> | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
beforeEach(async () => {
  f = await fixture();
  ended = undefined;
  releaseTimer = undefined;
});
afterEach(async () => {
  if (releaseTimer) clearTimeout(releaseTimer);
  try {
    ended ??= f.own.end();
    await ended;
    await dropAttendanceBrowserDatabase(f.control, f.name);
    expect(
      (
        await f.control.query(
          "SELECT datname FROM pg_database WHERE datname=$1",
          [f.name],
        )
      ).rows,
    ).toHaveLength(0);
  } finally {
    await f.control.end();
  }
});
it("CI-ATTEND-02 waits for the observed owned PostgreSQL session to disconnect before deletion", async () => {
  let disconnected = false;
  releaseTimer = setTimeout(() => {
    ended = f.own.end().then(() => {
      disconnected = true;
    });
    // The lifecycle awaits this same promise; avoid an unobserved rejection
    // if the drain assertion fails before teardown begins.
    void ended.catch(() => {});
  }, 150);
  await waitForAttendanceBrowserDatabaseDrain(f.control, f.name);
  expect(disconnected).toBe(true);
  expect(
    (
      await f.control.query(
        "SELECT datname FROM pg_database WHERE datname=$1",
        [f.name],
      )
    ).rows,
  ).toHaveLength(1);
});
it("CI-ATTEND-02 refuses to drop an owned database whose observed session remains active", async () => {
  await expect(
    dropAttendanceBrowserDatabase(f.control, f.name),
  ).rejects.toThrow("Owned browser database still active; no forced deletion");
  expect(
    (
      await f.control.query(
        "SELECT datname FROM pg_database WHERE datname=$1",
        [f.name],
      )
    ).rows,
  ).toHaveLength(1);
  expect((await f.own.query("SELECT 1 AS retained")).rows[0].retained).toBe(1);
});
it("CI-ATTEND-02 rejects a non-owned database identity before issuing deletion", async () => {
  await expect(
    dropAttendanceBrowserDatabase(f.control, "postgres"),
  ).rejects.toThrow("Generated owned browser database required");
  expect(
    (
      await f.control.query(
        "SELECT datname FROM pg_database WHERE datname=$1",
        [f.name],
      )
    ).rows,
  ).toHaveLength(1);
  expect((await f.own.query("SELECT 1 AS retained")).rows[0].retained).toBe(1);
});
