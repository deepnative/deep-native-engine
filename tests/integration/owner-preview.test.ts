import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { tmpdir } from "node:os";
import { createServer, connect, type Socket } from "node:net";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { testPool } from "../support/database.ts";

const control = testPool();
afterAll(() => control.end());
function previewEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("DNE_")),
  );
  return { ...env, DNE_PREVIEW_CONTROL_URL: process.env.DNE_TEST_DATABASE_URL };
}
function start(controlUrl = process.env.DNE_TEST_DATABASE_URL) {
  const child = spawn(process.execPath, ["scripts/private-preview.mjs"], {
    env: { ...previewEnvironment(), DNE_PREVIEW_CONTROL_URL: controlUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  child.stderr!.on("data", (bytes) => {
    stderr += String(bytes);
  });
  const ready = new Promise<{
    origin: string;
    revision: string;
    tree: string;
    workingTreeModified: boolean;
    staffSetupFile: string;
  }>((resolve, reject) => {
    child.stdout!.on("data", (bytes) => {
      stdout += String(bytes);
      if (stdout.includes("\n")) {
        try {
          resolve(JSON.parse(stdout.slice(0, stdout.indexOf("\n"))));
        } catch {
          reject(new Error("Preview did not emit a safe startup record"));
        }
      }
    });
    child.once("exit", () =>
      reject(
        new Error(
          "Preview exited before ready; inspect retained test diagnostics",
        ),
      ),
    );
    child.once("error", reject);
  });
  return { child, ready, exited, output: () => stdout + stderr };
}
async function staffSession(origin: string, credential: string) {
  const form = await fetch(origin + "/staff/sign-in");
  const entry = form.headers
    .getSetCookie()
    .find((value) => value.startsWith("dne_staff_entry="))!
    .split(";")[0]!;
  const csrf = (await form.text()).match(
    /name="csrf" value="([a-f0-9]+)"/,
  )![1]!;
  const signedIn = await fetch(origin + "/staff/sign-in", {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: entry,
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrf, credential }),
  });
  expect(signedIn.status).toBe(303);
  const staff = signedIn.headers
    .getSetCookie()
    .find((value) => value.startsWith("dne_staff="))!
    .split(";")[0]!;
  return async (path: string) => {
    const response = await fetch(origin + path, {
      headers: { Cookie: staff },
      redirect: "manual",
    });
    return { status: response.status, text: await response.text() };
  };
}
async function stop(child: ChildProcess, exited: Promise<number | null>) {
  child.kill("SIGTERM");
  return exited;
}

it("PREVIEW-01/02 PART-01/02/05/06 starts current-code isolated fixtures, participation tools and normal member pages, then removes only owned resources", async () => {
  const before = (await control.query("SELECT current_database() AS name"))
    .rows[0].name;
  const proc = start();
  let db: Pool | undefined;
  try {
    const ready = await proc.ready;
    expect(ready.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(new URL(ready.origin).port).not.toBe("4317");
    expect(ready.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(ready.tree).toMatch(/^[a-f0-9]{40}$/);
    const metadata = JSON.parse(await readFile(ready.staffSetupFile, "utf8"));
    expect((await stat(ready.staffSetupFile)).mode & 0o777).toBe(0o600);
    expect((await stat(metadata.privateRoot)).mode & 0o777).toBe(0o700);
    const own = new URL(metadata.database).pathname.slice(1);
    expect(own).toMatch(/^dne_test_[a-f0-9]{32}$/);
    expect(own).not.toBe(before);
    db = new Pool({ connectionString: metadata.database });
    expect(
      (await db.query("SELECT count(*)::int n FROM learners")).rows[0].n,
    ).toBe(0);
    expect(
      (await db.query("SELECT count(*)::int n FROM evidence_objects")).rows[0]
        .n,
    ).toBe(0);
    expect(
      (await db.query("SELECT count(*)::int n FROM assignment_grants")).rows[0]
        .n,
    ).toBe(0);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM evidence_review_submissions",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await db.query("SELECT role FROM staff_profiles ORDER BY role")
      ).rows.map((r) => r.role),
    ).toEqual(["editor", "moderator", "platform_admin", "reviewer"]);
    expect(metadata.moderatorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata.moderatorCredential).toMatch(/^[a-f0-9]{64}$/);
    // PART-01: participation tools are enabled, but no activity is seeded.
    for (const table of [
      "preview_circle_memberships",
      "preview_circle_choices",
      "preview_circle_posts",
      "preview_circle_reports",
      "preview_circle_moderator_grants",
      "member_proposals",
      "private_event_rehearsals",
      "private_event_enrollments",
      "private_event_cancellations",
      "private_event_attendance_permissions",
    ])
      expect(
        (await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
        table,
      ).toBe(0);
    expect(
      (
        await db.query(
          "SELECT id,state,requires_qualified_signoff FROM content_versions WHERE state='published'",
        )
      ).rows,
    ).toEqual([
      { id: "DEMO-509", state: "published", requires_qualified_signoff: false },
    ]);
    expect(
      (
        await db.query(
          "SELECT bool_and(state='draft') AS untouched FROM content_versions WHERE requires_qualified_signoff",
        )
      ).rows[0].untouched,
    ).toBe(true);
    const response = await fetch(ready.origin);
    expect(response.status).toBe(200);
    const welcome = await response.text();
    expect(welcome).toContain("Start my learning path");
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const csrf = welcome.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
    const onboarded = await fetch(ready.origin + "/start", {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: cookie,
        Origin: ready.origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf,
        background: "explorer",
        goal: "everyday",
        synthetic: "yes",
      }),
    });
    expect(onboarded.status).toBe(303);
    const memberPage = await fetch(ready.origin + "/learn", {
      headers: { Cookie: cookie },
    });
    expect(memberPage.status).toBe(200);
    expect(await memberPage.text()).toContain(
      "Invented preview: clarify a sample request",
    );
    const samples = await fetch(ready.origin + "/evidence", {
      headers: { Cookie: cookie },
    });
    expect(await samples.text()).toContain("Use a prepared invented sample");
    expect(
      (await db.query("SELECT count(*)::int n FROM learners")).rows[0].n,
    ).toBe(1);
    // PART-02/05: member pages offer discussion and event rehearsal.
    const circles = await fetch(ready.origin + "/circles", {
      headers: { Cookie: cookie },
    });
    expect(await circles.text()).toContain(
      "Invented discussion is available only after a separate circle sharing choice.",
    );
    const events = await fetch(ready.origin + "/events?all=1", {
      headers: { Cookie: cookie },
    });
    expect(await events.text()).toContain(
      "Explicitly labelled local registration rehearsals use invented data only.",
    );
    expect(
      (await db.query("SELECT count(*)::int n FROM staff_profiles")).rows[0].n,
    ).toBe(4);
    // PART-03/04/05: normal staff entry opens enabled tools; no grant exists.
    const admin = await staffSession(
      ready.origin,
      metadata.administratorCredential,
    );
    const grants = await admin("/operator/circle-grants");
    expect(grants.status).toBe(200);
    expect(grants.text).toContain(metadata.administratorId);
    expect(grants.text).not.toContain("paused");
    expect((await admin("/operator/event-rehearsals")).text).toContain(
      "Check a proposed schedule before deliberately confirming it.",
    );
    expect((await admin("/operator/event-cancellations")).text).toContain(
      "Check an exact future opted-in event before confirming cancellation.",
    );
    const moderator = await staffSession(
      ready.origin,
      metadata.moderatorCredential,
    );
    const reference = await moderator("/moderate/circle-reference");
    expect(reference.status).toBe(200);
    expect(reference.text).toContain(metadata.moderatorId);
    expect((await moderator("/moderate/proposals")).status).toBe(200);
    // PART-06: the moderator has no circle grant and no administrator tools.
    expect(
      (await moderator("/moderate/circles/everyday-ai/reports")).status,
    ).toBe(403);
    expect((await moderator("/operator/circle-grants")).status).toBe(403);
    expect(proc.output().includes(metadata.moderatorCredential)).toBe(false);
    expect((await fetch(ready.origin + "/runtime-private.json")).status).toBe(
      404,
    );
    expect(proc.output().includes(metadata.administratorCredential)).toBe(
      false,
    );
    expect(proc.output().includes(metadata.reviewerCredential)).toBe(false);
    expect(proc.output().includes(metadata.database)).toBe(false);
    await db.end();
    db = undefined;
    expect(await stop(proc.child, proc.exited)).toBe(0);
    expect(existsSync(metadata.privateRoot)).toBe(false);
    expect(
      (
        await control.query(
          "SELECT count(*)::int n FROM pg_database WHERE datname=$1",
          [own],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await control.query("SELECT current_database() AS name")).rows[0].name,
    ).toBe(before);
  } finally {
    await db?.end();
    if (proc.child.exitCode === null) await stop(proc.child, proc.exited);
  }
}, 90000);

it("PREVIEW-04 refuses to force-drop its database when a separate connection remains", async () => {
  const proc = start();
  let foreign: Pool | undefined;
  let heldConnection: PoolClient | undefined;
  let privateRoot: string | undefined, own: string | undefined;
  try {
    const ready = await proc.ready;
    const metadata = JSON.parse(await readFile(ready.staffSetupFile, "utf8"));
    privateRoot = metadata.privateRoot;
    own = new URL(metadata.database).pathname.slice(1);
    foreign = new Pool({ connectionString: metadata.database });
    // Keep the foreign connection checked out until explicit recovery. An idle
    // pooled connection otherwise expires after ten seconds under a slow gate.
    heldConnection = await foreign.connect();
    await heldConnection.query("SELECT 1");
    expect(await stop(proc.child, proc.exited)).toBe(1);
    expect(
      (await heldConnection.query("SELECT current_database() AS name")).rows[0]
        .name,
    ).toBe(own);
    expect(existsSync(privateRoot!)).toBe(true);
    const retained = JSON.parse(await readFile(ready.staffSetupFile, "utf8"));
    expect(retained.cleanup).toContain("Cleanup blocked");
    // The held session outlasts the bounded wait; the single DROP refuses.
    expect(retained.cleanupCode).toBe("55006");
    expect(proc.output().includes(metadata.database)).toBe(false);
    expect(proc.output()).toContain("Do not force-drop other connections");
  } finally {
    heldConnection?.release();
    await foreign?.end();
    if (proc.child.exitCode === null) await stop(proc.child, proc.exited);
    // Explicit test-owned recovery after the foreign connection closes. The
    // first cleanup refusal stays evidenced; this is not an automatic retry.
    if (own && /^dne_test_[a-f0-9]{32}$/.test(own))
      await control.query(`DROP DATABASE "${own}"`);
    if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
  }
}, 90000);

it("PREVIEW-04 waits for a slowly closing session before its single ordinary drop", async () => {
  // A loaded gate can leave a just-closed backend alive for longer than
  // PostgreSQL's own five-second DROP wait. Model that with a session that
  // leaves ten seconds after the stop request.
  const proc = start();
  let lingering: Pool | undefined, held: PoolClient | undefined;
  try {
    const ready = await proc.ready;
    const metadata = JSON.parse(await readFile(ready.staffSetupFile, "utf8"));
    const own = new URL(metadata.database).pathname.slice(1);
    lingering = new Pool({ connectionString: metadata.database });
    held = await lingering.connect();
    await held.query("SELECT 1");
    const stopped = stop(proc.child, proc.exited);
    await new Promise((resolve) => setTimeout(resolve, 10000));
    held.release();
    held = undefined;
    await lingering.end();
    lingering = undefined;
    expect(await stopped).toBe(0);
    expect(existsSync(metadata.privateRoot)).toBe(false);
    expect(
      (
        await control.query(
          "SELECT count(*)::int n FROM pg_database WHERE datname=$1",
          [own],
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    held?.release();
    await lingering?.end();
    if (proc.child.exitCode === null) await stop(proc.child, proc.exited);
  }
}, 90000);

it("PREVIEW-03/04 rejects unsafe configuration and cleans failed local resource setup without logging private driver details", async () => {
  const denied = spawnSync(process.execPath, ["scripts/private-preview.mjs"], {
    env: {
      ...previewEnvironment(),
      DNE_PREVIEW_CONTROL_URL:
        "postgresql://synthetic-private-secret@remote.example.invalid/postgres",
    },
    encoding: "utf8",
    timeout: 30000,
  });
  expect(denied.status).toBe(1);
  expect(denied.stderr).toContain("failed at configuration");
  expect(
    (denied.stdout + denied.stderr).includes("synthetic-private-secret"),
  ).toBe(false);
  const badAccount = new URL(process.env.DNE_TEST_DATABASE_URL!);
  badAccount.username = "dne_absent_" + randomBytes(8).toString("hex");
  badAccount.password = "synthetic-private-secret";
  const failed = spawnSync(process.execPath, ["scripts/private-preview.mjs"], {
    env: { ...previewEnvironment(), DNE_PREVIEW_CONTROL_URL: badAccount.href },
    encoding: "utf8",
    timeout: 30000,
  });
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain("failed at resource setup");
  expect(
    (failed.stdout + failed.stderr).includes("synthetic-private-secret"),
  ).toBe(false);
  expect(
    (await readdir(tmpdir())).filter((name) =>
      name.startsWith(`dne-owner-preview-${failed.pid}-`),
    ),
  ).toEqual([]);
  const exposed = spawnSync(process.execPath, ["scripts/private-preview.mjs"], {
    env: { ...previewEnvironment(), TMPDIR: join(process.cwd(), "public") },
    encoding: "utf8",
    timeout: 30000,
  });
  expect(exposed.status).toBe(1);
  expect(exposed.stderr).toContain("failed at private storage");
  expect(
    (await readdir("public")).filter((name) =>
      name.startsWith(`dne-owner-preview-${exposed.pid}-`),
    ),
  ).toEqual([]);
}, 90000);

it("PREVIEW-04 retains an owned recovery record when PostgreSQL committed CREATE but its acknowledgement was lost", async () => {
  const target = new URL(process.env.DNE_TEST_DATABASE_URL!);
  const sockets = new Set<Socket>();
  let droppedReply = false;
  const proxy = createServer((client) => {
    const upstream = connect({
      host: target.hostname,
      port: Number(target.port || 5432),
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    let buffered: Buffer = Buffer.alloc(0);
    upstream.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 5) {
        const size = buffered.readUInt32BE(1) + 1;
        if (buffered.length < size) return;
        const message = buffered.subarray(0, size);
        buffered = buffered.subarray(size);
        // This is a real PostgreSQL CommandComplete after its CREATE committed,
        // not a mocked transaction result. Lose exactly its first wire reply.
        if (
          !droppedReply &&
          message[0] === 67 &&
          message.subarray(5).toString() === "CREATE DATABASE\0"
        ) {
          droppedReply = true;
          client.destroy();
          upstream.destroy();
          return;
        }
        client.write(message);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (!address || typeof address === "string")
    throw Error("Missing owned fault fixture listener");
  const viaProxy = new URL(target);
  viaProxy.hostname = "127.0.0.1";
  viaProxy.port = String(address.port);
  const before = new Set(await readdir(tmpdir()));
  const proc = start(viaProxy.href);
  let privateRoot: string | undefined, own: string | undefined;
  try {
    // Rejecting readiness is the expected fault outcome; retain the first failure.
    await expect(proc.ready).rejects.toThrow("exited before ready");
    expect(await proc.exited).toBe(1);
    expect(droppedReply).toBe(true);
    const retained = (await readdir(tmpdir())).filter(
      (name) =>
        name.startsWith(`dne-owner-preview-${proc.child.pid}-`) &&
        !before.has(name),
    );
    expect(retained.length).toBe(1);
    privateRoot = join(tmpdir(), retained[0]!);
    const record = JSON.parse(
      await readFile(join(privateRoot, "runtime-private.json"), "utf8"),
    );
    own = new URL(record.database).pathname.slice(1);
    expect(record.cleanup).toContain("acknowledgement is incomplete");
    expect(
      (
        await control.query(
          "SELECT count(*)::int n FROM pg_database WHERE datname=$1",
          [own],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(proc.output()).toContain("Owned cleanup is blocked");
    expect(proc.output().includes(record.database)).toBe(false);
  } finally {
    if (proc.child.exitCode === null) await stop(proc.child, proc.exited);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
    // The test witnessed the commit at its controlled wire boundary. Explicitly
    // clean this test-owned database after preserving the refusal evidence.
    if (own && /^dne_test_[a-f0-9]{32}$/.test(own))
      await control.query(`DROP DATABASE "${own}"`);
    if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
  }
}, 90000);
