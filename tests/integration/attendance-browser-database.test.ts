import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { dropAttendanceBrowserDatabase } from "../support/attendance-browser-database.ts";
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
async function dispose(
  f: Awaited<ReturnType<typeof fixture>>,
  ended: Promise<void>,
) {
  await ended;
  const deadline = Date.now() + 3000;
  while (
    (
      await f.control.query(
        "SELECT COUNT(*)::integer count FROM pg_stat_activity WHERE datname=$1",
        [f.name],
      )
    ).rows[0].count !== 0
  ) {
    if (Date.now() >= deadline)
      throw Error("Fixture connection did not drain; no forced deletion");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await f.control.query(`DROP DATABASE IF EXISTS "${f.name}"`);
  await f.control.end();
}
it("CI-ATTEND-02 waits for the observed owned PostgreSQL session to disconnect before deletion", async () => {
  const f = await fixture();
  let disconnected = false;
  const ended = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      f.own.end().then(() => {
        disconnected = true;
        resolve();
      }, reject);
    }, 150);
  });
  try {
    const outcome = await dropAttendanceBrowserDatabase(f.control, f.name).then(
      () => "dropped",
      () => "refused",
    );
    expect(outcome).toBe("dropped");
    expect(disconnected).toBe(true);
    expect(
      (
        await f.control.query(
          "SELECT datname FROM pg_database WHERE datname=$1",
          [f.name],
        )
      ).rows,
    ).toHaveLength(0);
  } finally {
    await dispose(f, ended);
  }
});
it("CI-ATTEND-02 refuses to drop an owned database whose observed session remains active", async () => {
  const f = await fixture();
  try {
    await expect(
      dropAttendanceBrowserDatabase(f.control, f.name),
    ).rejects.toThrow(
      "Owned browser database still active; no forced deletion",
    );
    expect(
      (
        await f.control.query(
          "SELECT datname FROM pg_database WHERE datname=$1",
          [f.name],
        )
      ).rows,
    ).toHaveLength(1);
    expect((await f.own.query("SELECT 1 AS retained")).rows[0].retained).toBe(
      1,
    );
  } finally {
    await dispose(f, f.own.end());
  }
});

it("CI-ATTEND-02 rejects a non-owned database identity before issuing deletion", async () => {
  const f = await fixture();
  try {
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
    expect((await f.own.query("SELECT 1 AS retained")).rows[0].retained).toBe(
      1,
    );
  } finally {
    await dispose(f, f.own.end());
  }
});
