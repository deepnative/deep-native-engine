import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { migrate, store, type Learner } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { postgresArchiveTools } from "../support/postgres-archive-tools.ts";

function checked(
  result: ReturnType<ReturnType<typeof postgresArchiveTools>["execute"]>,
) {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
    throw new Error("PostgreSQL 18 restore client unavailable.");
  if (result.status !== 0 || result.stderr.length !== 0)
    throw new Error(
      "Synthetic PostgreSQL restore tool failed; raw diagnostics suppressed.",
    );
  return result.stdout;
}
function digest(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function tableManifest(pool: Pool) {
  const names = (
    await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  const manifest = [];
  for (const { tablename } of names) {
    const quoted = `"${tablename.replaceAll('"', '""')}"`;
    const rows = (
      await pool.query(
        `SELECT to_jsonb(t) AS value FROM public.${quoted} t ORDER BY to_jsonb(t)::text`,
      )
    ).rows;
    manifest.push({
      table: tablename,
      rows: rows.length,
      digest: digest(JSON.stringify(rows)),
    });
  }
  return manifest;
}
async function objectManifest(root: string) {
  const entries = [];
  for (const key of (await readdir(root)).sort()) {
    const file = join(root, key);
    const info = await stat(file);
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o077).toBe(0);
    entries.push({
      key,
      bytes: info.size,
      digest: digest(await readFile(file)),
    });
  }
  return entries;
}

it("restores only a synthetic snapshot into a new database and preserves private evidence boundaries", async () => {
  await rm("artifacts/restore-drill.json", { force: true });
  const configured = process.env.DNE_TEST_DATABASE_URL;
  if (!configured)
    throw new Error(
      "Restore rehearsal requires the isolated integration fixture.",
    );
  const url = new URL(configured);
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "54329" ||
    url.username !== "dne" ||
    url.search ||
    url.hash ||
    !/^\/dne_test_[a-f0-9]{32}$/.test(url.pathname)
  )
    throw new Error(
      "Restore rehearsal requires the repository loopback Compose test fixture.",
    );
  const { mode: toolMode, execute: postgres } = postgresArchiveTools(url);
  const admin = new Pool({ connectionString: url.toString() });
  const owned: string[] = [];
  const pools: Pool[] = [];
  const root = await mkdtemp(join(tmpdir(), "dne-synthetic-restore-"));
  const sourceObjects = join(root, "source");
  const snapshotObjects = join(root, "snapshot");
  const targetObjects = join(root, "restored");
  let report;
  let cleanupFailed: boolean;
  try {
    async function freshDatabase() {
      // Names are generated here, never accepted from a caller or archive.
      const name = `dne_test_${randomBytes(16).toString("hex")}`;
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      owned.push(name);
      const connection = new URL(url);
      connection.pathname = `/${name}`;
      const pool = new Pool({ connectionString: connection.toString() });
      pools.push(pool);
      return { name, pool };
    }
    const source = await freshDatabase();
    const target = await freshDatabase();
    expect(source.name).not.toBe(target.name);
    await migrate(source.pool);
    const db = store(source.pool);
    const members: Array<{ token: string; learner: Learner }> = [];
    for (const [background, goal] of [
      ["explorer", "everyday"],
      ["professional", "work"],
      ["technical", "build"],
    ] as const) {
      const token = randomBytes(32).toString("hex");
      await db.create(token, { background, goal });
      const session = await db.session(token);
      if (session.kind !== "active")
        throw new Error("Synthetic restore member setup failed.");
      members.push({ token, learner: session.learner });
      await db.save(session.learner.id, {
        instruction: `Synthetic ${background} snapshot instruction.`,
        verification: "Compare the invented source with its result.",
        complete: false,
      });
    }
    const owner = members[0]!;
    const access = authorizationStore(source.pool);
    const adminToken = randomBytes(32).toString("hex");
    const reviewerToken = randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 3_600_000);
    const adminId = await access.provisionStaff(
      adminToken,
      "platform_admin",
      expiry,
    );
    const reviewerId = await access.provisionStaff(
      reviewerToken,
      "reviewer",
      expiry,
    );
    const grant = await access.grantAssignment(
      adminId,
      reviewerId,
      owner.learner.id,
      "reviewer",
      "synthetic restore review",
      expiry,
    );
    const evidence = evidenceStore(
      source.pool,
      fileObjectStorage(sourceObjects),
      "synthetic-restore-only",
    );
    const bytes = Buffer.from("Invented private restore evidence.");
    const item = await evidence.upload(owner.token, {
      name: "synthetic.txt",
      mediaType: "text/plain",
      data: bytes,
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    });
    if (item.kind !== "created")
      throw new Error("Synthetic restore evidence setup failed.");
    expect(await evidence.transitionQuarantine(item.id, "clean")).toBe(true);
    expect(await evidence.submitForReview(owner.token, item.id)).toBe(true);
    await evidence.addDerivative(
      item.id,
      "text-extract",
      Buffer.from("Invented derived text."),
    );
    expect(await access.revokeAssignment(adminId, grant)).toBe(true);

    const dumpVersion = checked(postgres("pg_dump", ["--version"]))
      .toString()
      .trim();
    const restoreVersion = checked(postgres("pg_restore", ["--version"]))
      .toString()
      .trim();
    expect(dumpVersion).toMatch(/^pg_dump \(PostgreSQL\) 18\.\d+$/);
    expect(restoreVersion).toMatch(/^pg_restore \(PostgreSQL\) 18\.\d+$/);
    // The test owns every writer. Database and object capture are quiescent.
    const snapshotAt = new Date().toISOString();
    const captureStart = performance.now();
    const expectedTables = await tableManifest(source.pool);
    const archive = checked(
      postgres("pg_dump", [
        "--username=dne",
        "--no-password",
        "--format=custom",
        `--dbname=${source.name}`,
      ]),
    );
    await cp(sourceObjects, snapshotObjects, { recursive: true });
    const expectedObjects = await objectManifest(snapshotObjects);
    expect(expectedObjects).toHaveLength(2);
    const captureMs = performance.now() - captureStart;
    await db.save(owner.learner.id, {
      instruction: "Synthetic write after the captured snapshot.",
      verification: "This newer draft must remain only in the source.",
      complete: false,
    });

    const restoreArgs = [
      "--username=dne",
      "--no-password",
      "--format=custom",
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      `--dbname=${target.name}`,
    ];
    for (const invalidArchive of [
      Buffer.from("not a PostgreSQL archive"),
      archive.subarray(0, archive.length - 8),
    ]) {
      const invalid = postgres("pg_restore", restoreArgs, invalidArchive);
      expect(invalid.error).toBeUndefined();
      expect(invalid.status).not.toBe(0);
      expect(await tableManifest(target.pool)).toEqual([]);
    }
    const restoreStart = performance.now();
    checked(postgres("pg_restore", restoreArgs, archive));
    await cp(snapshotObjects, targetObjects, { recursive: true });
    const restoreMs = performance.now() - restoreStart;
    const validationStart = performance.now();
    expect(await tableManifest(target.pool)).toEqual(expectedTables);
    expect(await objectManifest(targetObjects)).toEqual(expectedObjects);
    expect((await stat(targetObjects)).mode & 0o077).toBe(0);
    await migrate(target.pool);
    await migrate(target.pool);
    expect(await tableManifest(target.pool)).toEqual(expectedTables);
    const recovered = store(target.pool);
    for (const member of members) {
      expect(await recovered.session(member.token)).toEqual(
        await db.session(member.token),
      );
      expect(await recovered.progress(member.learner.id)).toMatchObject({
        instruction: `Synthetic ${member.learner.background} snapshot instruction.`,
      });
    }
    const recoveredAccess = authorizationStore(target.pool);
    expect(
      await recoveredAccess.readWorkspace(owner.token, owner.learner.id),
    ).toMatchObject({ kind: "allowed", via: "member" });
    for (const outsider of [members[1]!.token, reviewerToken])
      expect(
        await recoveredAccess.readWorkspace(outsider, owner.learner.id),
      ).toEqual({ kind: "denied" });
    const recoveredEvidence = evidenceStore(
      target.pool,
      fileObjectStorage(targetObjects),
      "synthetic-restore-only",
    );
    for (const outsider of [members[1]!.token, reviewerToken])
      expect(await recoveredEvidence.issueDownload(outsider, item.id)).toEqual({
        kind: "denied",
      });
    const link = await recoveredEvidence.issueDownload(owner.token, item.id);
    if (link.kind !== "issued")
      throw new Error("Restored owner download was denied.");
    expect(
      await recoveredEvidence.download(owner.token, item.id, link.capability),
    ).toMatchObject({ kind: "allowed", data: bytes });
    expect(
      await recoveredEvidence.destinationAllowed(
        item.id,
        "community-publication",
      ),
    ).toBe(false);
    await recovered.save(owner.learner.id, {
      instruction: "Synthetic verified write after recovery.",
      verification: "Confirm the restored database remains usable.",
      complete: true,
    });
    expect(await recovered.progress(owner.learner.id)).toMatchObject({
      instruction: "Synthetic verified write after recovery.",
      completed_at: expect.any(Date),
    });
    expect(await recoveredEvidence.remove(owner.token, item.id)).toBe(true);
    expect(
      await recoveredEvidence.download(owner.token, item.id, link.capability),
    ).toEqual({ kind: "denied" });
    expect(await objectManifest(targetObjects)).toEqual([]);
    expect(await objectManifest(sourceObjects)).toEqual(expectedObjects);
    expect(await db.progress(owner.learner.id)).toMatchObject({
      instruction: "Synthetic write after the captured snapshot.",
    });
    const validationMs = performance.now() - validationStart;
    const revision = spawnSync("git", ["rev-parse", "HEAD", "HEAD^{tree}"], {
      encoding: "utf8",
    });
    if (revision.status !== 0)
      throw new Error("Restore report revision unavailable.");
    const [commit, tree] = revision.stdout.trim().split("\n");
    const state = spawnSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    });
    if (state.status !== 0)
      throw new Error("Restore report working tree unavailable.");
    report = {
      scope: "synthetic-local-restore-v1",
      exitStatus: 0,
      snapshotAt,
      revision: { commit, tree, dirty: state.stdout.trim() !== "" },
      node: process.version,
      dumpVersion,
      restoreVersion,
      toolMode,
      fixture: {
        members: members.length,
        tables: expectedTables.length,
        objects: expectedObjects.length,
        archiveBytes: archive.length,
      },
      timingsMs: {
        capture: Math.round(captureMs),
        restore: Math.round(restoreMs),
        validation: Math.round(validationMs),
      },
      recoveryPoint:
        "Quiescent synthetic snapshot only; later source changes deliberately not restored.",
      productionRpoRtoApproved: false,
      invalidArchivesRejected: 2,
      privateAccessVerified: true,
      cleanupCompleted: true,
    };
  } finally {
    // Attempt every owned-resource cleanup even if another cleanup fails.
    const closed = await Promise.allSettled(pools.map((pool) => pool.end()));
    const dropped = await Promise.allSettled(
      owned.map((name) => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
    );
    const removed = await Promise.allSettled([
      admin.end(),
      rm(root, { recursive: true, force: true }),
    ]);
    cleanupFailed = [...closed, ...dropped, ...removed].some(
      (result) => result.status === "rejected",
    );
    if (cleanupFailed)
      console.error(
        "Synthetic restore cleanup failed; acceptance report withheld.",
      );
  }
  if (cleanupFailed)
    throw new Error(
      "Synthetic restore cleanup failed; acceptance report withheld.",
    );
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/restore-drill.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
}, 60_000);
