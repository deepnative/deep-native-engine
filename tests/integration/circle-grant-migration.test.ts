import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { circleDiscussionStore } from "../../src/circle-discussion.ts";
import { circleGrantAdminStore } from "../../src/circle-grant-admin.ts";
import { migrate } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
beforeAll(() => migrate(pool));
afterAll(() => pool.end());
it("CIRADM-06/08 additive exact-scope audit index preserves populated055 records and history across index removal/reapplication", async () => {
  const admin = randomBytes(32).toString("hex"),
    target = randomBytes(32).toString("hex"),
    auth = authorizationStore(pool),
    expires = new Date(Date.now() + 3600000);
  await auth.provisionStaff(admin, "platform_admin", expires);
  const staffId = await auth.provisionStaff(target, "moderator", expires),
    scope = { staffId, circleId: "everyday-ai" },
    legacy = circleDiscussionStore(pool, "invented-index");
  const granted = await legacy.grantModerator(
    admin,
    staffId,
    scope.circleId,
    randomUUID(),
    new Date(+expires - 1000),
  );
  expect(granted.kind).toBe("ready");
  if (granted.kind !== "ready") throw Error("Missing populated055 fixture");
  const snapshot = async () => ({
    grants: (
      await pool.query(
        "SELECT * FROM preview_circle_moderator_grants WHERE staff_id=$1",
        [staffId],
      )
    ).rows,
    audit: (
      await pool.query(
        "SELECT * FROM preview_circle_grant_audit WHERE staff_id=$1 ORDER BY id",
        [staffId],
      )
    ).rows,
  });
  const before = await snapshot();
  // Simulate the populated old schema and index-only rollback in this owned test DB.
  await pool.query("DROP INDEX preview_circle_grant_audit_scope_idx");
  await pool.query("DELETE FROM schema_migrations WHERE version=61");
  const backend = circleGrantAdminStore(pool, "invented-index", {
    mode: "test",
    writes: false,
    discussion: false,
  });
  const oldHistory = await backend.history(admin, scope);
  expect(oldHistory.kind).toBe("ready");
  if (oldHistory.kind !== "ready") throw Error("Missing retained history");
  expect(oldHistory.value.items).toHaveLength(1);
  const migration = await readFile(
    new URL(
      "../../migrations/061-circle-grant-audit-scope.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await pool.query(migration);
  await pool.query(migration);
  expect(await snapshot()).toEqual(before);
  expect(
    (
      await pool.query(
        "SELECT indexdef FROM pg_indexes WHERE indexname='preview_circle_grant_audit_scope_idx'",
      )
    ).rows[0].indexdef,
  ).toContain("(staff_id, circle_id, grant_id, id)");
  expect(
    (await pool.query("SELECT version FROM schema_migrations WHERE version=61"))
      .rows,
  ).toEqual([{ version: 61 }]);
  const current = await backend.history(admin, scope);
  expect(current.kind).toBe("ready");
  if (current.kind === "ready")
    expect(current.value.items).toEqual(oldHistory.value.items);
  await pool.query("DELETE FROM principals WHERE id=$1", [staffId]);
  const absent = await backend.history(admin, scope);
  expect(absent.kind).toBe("ready");
  if (absent.kind === "ready")
    expect(absent.value.items).toMatchObject([
      { source: "absent", grantId: granted.value.id },
    ]);
});
