import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { lstat, readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { migrate } from "./store.ts";
import { authorizationStore } from "./authorization.ts";
import { circleDiscussionStore } from "./circle-discussion.ts";
import { supportRequestStore } from "./support-requests.ts";
import { localAiHoldInspectionStore } from "./local-ai-hold-inspection.ts";

let pool: Pool | undefined;
let failed = false;
let result: Record<string, unknown> = { status: "failed" };
try {
  const args = process.argv.slice(2);
  const circleBootstrap = args.length === 1 && args[0] === "circle-bootstrap";
  const bootstrap =
    args.length === 1 && (args[0] === "bootstrap" || circleBootstrap);
  const circleCommand = [
    "circle-bootstrap",
    "circle-grant",
    "circle-revoke",
  ].includes(args[0] ?? "");
  const identities = circleBootstrap
    ? ([
        ["admin.json", "platform_admin"],
        ["moderator.json", "moderator"],
      ] as const)
    : ([
        ["admin.json", "platform_admin"],
        ["operator.json", "operator"],
      ] as const);
  if (
    !bootstrap &&
    !(
      args.length === 2 &&
      [
        "grant",
        "revoke",
        "time-grant",
        "time-revoke",
        "circle-grant",
        "circle-revoke",
        "hold-grant",
        "hold-revoke",
      ].includes(args[0]!) &&
      /^[a-zA-Z0-9_-]+\.json$/.test(args[1]!)
    )
  )
    throw Error("Invalid local support command.");
  const settings = config(process.env);
  if (
    circleCommand &&
    args[0] !== "circle-revoke" &&
    !settings.circleDiscussion
  )
    throw Error("Circle sandbox sharing is disabled.");
  const root = join(settings.privateStorageRoot, "support-admin");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await lstat(root);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o777) !== 0o700 ||
    directory.uid !== process.getuid!() ||
    (await realpath(root)) !== root
  )
    throw Error("Private support directory unavailable.");
  async function privateJson(name: string): Promise<Record<string, unknown>> {
    const path = join(root, name),
      info = await lstat(path);
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== 0o600 ||
      info.uid !== process.getuid!()
    )
      throw Error("Private input unavailable.");
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > 8192)
      throw Error("Private input unavailable.");
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("Invalid private input.");
    return value as Record<string, unknown>;
  }
  if (bootstrap) {
    for (const [name] of identities) {
      try {
        await lstat(join(root, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw Error("Existing credentials must be preserved.");
    }
  }
  pool = new Pool({
    connectionString: settings.databaseUrl,
    application_name: "deep-native-local-support-admin",
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  pool.on("error", () => {
    failed = true;
  });
  await migrate(pool);
  if (bootstrap) {
    const auth = authorizationStore(pool),
      expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    for (const [name, role] of identities) {
      const token = randomBytes(32).toString("hex");
      const id = await auth.provisionStaff(token, role, expiresAt);
      await writeFile(
        join(root, name),
        JSON.stringify({
          id,
          token,
          role,
          expiresAt: expiresAt.toISOString(),
        }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    }
    result = {
      status: "complete",
      action: args[0],
      expiresAt: expiresAt.toISOString(),
    };
  } else {
    const input = await privateJson(args[1]!),
      admin = await privateJson("admin.json");
    if (typeof admin.token !== "string" || !/^[a-f0-9]{64}$/.test(admin.token))
      throw Error("Private credentials unavailable.");
    const support = supportRequestStore(pool, undefined, {
      timeWrites: settings.supportTimeWrites,
    });
    if (args[0] === "hold-grant" || args[0] === "hold-revoke") {
      const holds = localAiHoldInspectionStore(pool, {
        mode: settings.mode,
        enabled: settings.localHoldInspectionReads,
      });
      if (args[0] === "hold-grant") {
        const operator = await privateJson("operator.json");
        if (
          Object.keys(input).length !== 4 ||
          Object.keys(input).some(
            (key) =>
              !["jobId", "idempotencyKey", "startsAt", "expiresAt"].includes(
                key,
              ),
          ) ||
          typeof input.jobId !== "string" ||
          typeof input.idempotencyKey !== "string" ||
          typeof input.startsAt !== "string" ||
          typeof input.expiresAt !== "string" ||
          typeof operator.id !== "string"
        )
          throw Error("Invalid hold inspection grant instruction.");
        const applied = await holds.grant(
          admin.token,
          input.jobId,
          operator.id,
          new Date(input.startsAt),
          new Date(input.expiresAt),
          input.idempotencyKey,
        );
        if (applied.kind !== "applied" && applied.kind !== "replayed")
          throw Error("Hold inspection grant not confirmed.");
        result = {
          status: "complete",
          action: args[0],
          grantId: applied.grantId,
        };
      } else {
        if (
          Object.keys(input).length !== 1 ||
          typeof input.grantId !== "string"
        )
          throw Error("Invalid hold inspection revocation instruction.");
        const applied = await holds.revoke(admin.token, input.grantId);
        if (applied.kind !== "applied" && applied.kind !== "replayed")
          throw Error("Hold inspection revocation not confirmed.");
        result = { status: "complete", action: args[0] };
      }
    } else if (args[0] === "circle-grant" || args[0] === "circle-revoke") {
      if (typeof input.circleId !== "string")
        throw Error("Invalid circle instruction.");
      const circles = circleDiscussionStore(
        pool,
        settings.secret,
        settings.circleDiscussion,
      );
      if (args[0] === "circle-grant") {
        if (
          Object.keys(input).some(
            (key) => !["circleId", "idempotencyKey", "expiresAt"].includes(key),
          ) ||
          typeof input.idempotencyKey !== "string" ||
          typeof input.expiresAt !== "string"
        )
          throw Error("Invalid circle grant instruction.");
        const staff = await privateJson("moderator.json");
        if (typeof staff.id !== "string")
          throw Error("Private moderator credentials unavailable.");
        const granted = await circles.grantModerator(
          admin.token,
          staff.id,
          input.circleId,
          input.idempotencyKey,
          new Date(input.expiresAt),
        );
        if (granted.kind !== "ready")
          throw Error("Circle grant not confirmed.");
        result = {
          status: "complete",
          action: args[0],
          grantId: granted.value.id,
        };
      } else {
        if (
          Object.keys(input).length !== 2 ||
          typeof input.grantId !== "string"
        )
          throw Error("Invalid circle revocation instruction.");
        if (
          (
            await circles.revokeModerator(
              admin.token,
              input.circleId,
              input.grantId,
            )
          ).kind !== "ready"
        )
          throw Error("Circle revocation not confirmed.");
        result = { status: "complete", action: args[0] };
      }
    } else if (args[0] === "grant" || args[0] === "time-grant") {
      const timeGrant = args[0] === "time-grant";
      const staff = await privateJson("operator.json");
      if (
        Object.keys(input).some(
          (key) =>
            ![
              "requestId",
              "idempotencyKey",
              "startsAt",
              "expiresAt",
              ...(timeGrant ? ["allocationId"] : []),
            ].includes(key),
        ) ||
        typeof input.requestId !== "string" ||
        typeof input.idempotencyKey !== "string" ||
        typeof input.startsAt !== "string" ||
        typeof input.expiresAt !== "string" ||
        typeof staff.id !== "string" ||
        (timeGrant && typeof input.allocationId !== "string")
      )
        throw Error("Invalid grant instruction.");
      const grantInput = {
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        staffId: staff.id,
        role: "operator" as const,
        startsAt: new Date(input.startsAt),
        expiresAt: new Date(input.expiresAt),
      };
      const granted = timeGrant
        ? await support.time!.grant(admin.token, {
            ...grantInput,
            allocationId: input.allocationId as string,
          })
        : await support.grant(admin.token, grantInput);
      if (granted.kind !== "created" && granted.kind !== "replayed")
        throw Error("Grant not confirmed.");
      result = {
        status: "complete",
        action: args[0],
        grantId: granted.grantId,
      };
    } else {
      if (Object.keys(input).length !== 1 || typeof input.grantId !== "string")
        throw Error("Invalid revocation instruction.");
      const revoked =
        args[0] === "time-revoke"
          ? await support.time!.revoke(admin.token, input.grantId)
          : await support.revoke(admin.token, input.grantId);
      if (revoked.kind !== "revoked" && revoked.kind !== "already-revoked")
        throw Error("Revocation not confirmed.");
      result = { status: "complete", action: args[0] };
    }
  }
} catch {
  failed = true;
} finally {
  if (pool)
    await pool.end().catch(() => {
      failed = true;
    });
}
// Never print tokens, instruction keys, configuration or exception/member text.
if (failed) {
  console.error(JSON.stringify({ status: "failed" }));
  process.exitCode = 1;
} else console.info(JSON.stringify(result));
