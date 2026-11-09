import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { start } from "../../src/runtime.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
let running: Awaited<ReturnType<typeof start>>, storage: string;
beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "dne-export-log-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: storage,
    DNE_LOCAL_STAFF_ENTRY: "enabled",
  });
});
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(async () => {
  await running?.close();
  await pool.end();
  if (storage) await rm(storage, { recursive: true, force: true });
});

async function staff(role: "operator" | "platform_admin" | "coach") {
  const credential = randomBytes(32).toString("hex");
  const id = await authorizationStore(pool).provisionStaff(
    credential,
    role,
    new Date(Date.now() + 3600000),
  );
  return { credential, id };
}
const get = (path: string, credential: string) =>
  request(running.server)
    .get(path)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `dne_staff=${credential}`);
const events = async () =>
  (
    await pool.query<Record<string, unknown>>(
      "SELECT * FROM staff_export_events ORDER BY occurred_at,id",
    )
  ).rows;

it.each(["operator", "platform_admin"] as const)(
  "EXPORTLOG-01 a %s taking the metrics JSON is logged once per download, saying who and nothing else",
  async (role) => {
    const { credential, id } = await staff(role);
    const before = (await events()).length;
    await get("/operator/metrics", credential).expect(200);
    await get("/operator/metrics", credential).expect(200);
    const rows = (await events()).slice(before);
    expect(rows.map((r) => [r.actor_id, r.action])).toEqual([
      [id, "metrics_json"],
      [id, "metrics_json"],
    ]);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "action",
      "actor_id",
      "id",
      "occurred_at",
    ]);
    expect(JSON.stringify(rows)).not.toContain(credential);
  },
);

it("EXPORTLOG-02 a refused download and the on-screen report log nothing", async () => {
  const coach = await staff("coach");
  const operator = await staff("operator");
  const before = (await events()).length;
  await get("/operator/metrics", coach.credential).expect(403);
  await get("/operator/metrics", "f".repeat(64)).expect(403);
  await get("/operator/metrics/report", operator.credential).expect(200);
  expect((await events()).length).toBe(before);
});

it("EXPORTLOG-03 if the log can't be written the JSON isn't sent", async () => {
  const { credential } = await staff("operator");
  await pool.query(`CREATE OR REPLACE FUNCTION invented_export_log_failure() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN RAISE EXCEPTION 'Invented log failure'; END $f$`);
  await pool.query(
    `CREATE TRIGGER invented_export_log_failure BEFORE INSERT ON staff_export_events FOR EACH ROW EXECUTE FUNCTION invented_export_log_failure()`,
  );
  try {
    const response = await get("/operator/metrics", credential);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.text).not.toContain("synthetic-local-preview");
    expect(response.text).not.toContain("Invented log failure");
  } finally {
    await pool.query(
      "DROP TRIGGER invented_export_log_failure ON staff_export_events",
    );
    await pool.query("DROP FUNCTION invented_export_log_failure()");
  }
});

it("EXPORTLOG-04 entries can't be changed and outlast the staff account", async () => {
  const { credential, id } = await staff("operator");
  await get("/operator/metrics", credential).expect(200);
  await expect(
    pool.query("UPDATE staff_export_events SET action='metrics_json'"),
  ).rejects.toThrow(/append-only/);
  await expect(pool.query("DELETE FROM staff_export_events")).rejects.toThrow(
    /append-only/,
  );
  await pool.query("DELETE FROM principals WHERE id=$1", [id]);
  expect((await events()).filter((r) => r.actor_id === id)).toHaveLength(1);
});
