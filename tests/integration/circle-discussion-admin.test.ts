import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { migrate } from "../../src/store.ts";
import { circleDiscussionStore } from "../../src/circle-discussion.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
afterAll(async () => pool.end());
async function command(root: string, args: string[], enabled = "enabled") {
  const child = spawn(
    process.execPath,
    ["src/support-admin-main.ts", ...args],
    {
      env: {
        ...process.env,
        DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
        DNE_APP_MODE: "test",
        DNE_PRIVATE_STORAGE_ROOT: root,
        DNE_CIRCLE_DISCUSSION: enabled,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "",
    err = "";
  child.stdout.on("data", (data) => {
    out += data;
  });
  child.stderr.on("data", (data) => {
    err += data;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, out, err };
}
it("bootstraps private synthetic moderator credentials and manages an exact audited circle grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "dne443-admin-"));
  try {
    const paused = await command(root, ["circle-bootstrap"], "disabled");
    expect(paused.code).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::integer n FROM principals")).rows[0]
        .n,
    ).toBe(0);
    const boot = await command(root, ["circle-bootstrap"]);
    expect(
      boot.code,
      "The circle-purpose grant must be usable through a trusted private local instruction",
    ).toBe(0);
    expect(boot.err).toBe("");
    const directory = join(root, "support-admin"),
      admin = JSON.parse(await readFile(join(directory, "admin.json"), "utf8")),
      moderator = JSON.parse(
        await readFile(join(directory, "moderator.json"), "utf8"),
      );
    for (const name of ["admin.json", "moderator.json"])
      expect((await lstat(join(directory, name))).mode & 0o777).toBe(0o600);
    expect(moderator.role).toBe("moderator");
    expect(boot.out + boot.err).not.toContain(admin.token);
    expect(boot.out + boot.err).not.toContain(moderator.token);
    const discussion = circleDiscussionStore(
      pool,
      "invented-admin-test-secret",
    );
    expect(
      (await discussion.moderationQueue(moderator.token, "everyday-ai")).kind,
    ).toBe("denied");
    await writeFile(
      join(directory, "grant.json"),
      JSON.stringify({
        circleId: "everyday-ai",
        idempotencyKey: randomUUID(),
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "invalid.json"),
      JSON.stringify({
        circleId: "everyday-ai",
        idempotencyKey: randomUUID(),
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
        purpose: "unapproved-scope",
      }),
      { mode: 0o600 },
    );
    expect((await command(root, ["circle-grant", "invalid.json"])).code).toBe(
      1,
    );
    const granted = await command(root, ["circle-grant", "grant.json"]);
    expect(granted.code).toBe(0);
    const receipt = JSON.parse(granted.out);
    expect(receipt).toMatchObject({
      status: "complete",
      action: "circle-grant",
    });
    expect(receipt.grantId).toMatch(/^[a-f0-9-]{36}$/);
    expect((await command(root, ["circle-grant", "grant.json"])).out).toBe(
      granted.out,
    );
    expect(
      (await discussion.moderationQueue(moderator.token, "everyday-ai")).kind,
    ).toBe("ready");
    await writeFile(
      join(directory, "revoke.json"),
      JSON.stringify({ circleId: "everyday-ai", grantId: receipt.grantId }),
      { mode: 0o600 },
    );
    const revoked = await command(
      root,
      ["circle-revoke", "revoke.json"],
      "disabled",
    );
    expect(revoked.code).toBe(0);
    expect((await command(root, ["circle-revoke", "revoke.json"])).code).toBe(
      0,
    );
    expect(
      (await discussion.moderationQueue(moderator.token, "everyday-ai")).kind,
    ).toBe("denied");
    expect(
      (
        await pool.query(
          "SELECT action FROM preview_circle_grant_audit WHERE grant_id=$1 ORDER BY id",
          [receipt.grantId],
        )
      ).rows,
    ).toEqual([{ action: "created" }, { action: "revoked" }]);
    for (const output of [granted, revoked]) {
      expect(output.out + output.err).not.toContain(admin.token);
      expect(output.out + output.err).not.toContain(moderator.token);
    }
    expect((await command(root, ["circle-bootstrap"])).code).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::integer n FROM principals")).rows[0]
        .n,
    ).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
