import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { lstat, readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { migrate } from "./store.ts";
import { authorizationStore } from "./authorization.ts";
import { supportRequestStore } from "./support-requests.ts";

let pool: Pool | undefined;
let failed = false;
let result: Record<string, unknown> = { status: "failed" };
try {
  const args = process.argv.slice(2);
  const bootstrap = args.length === 1 && args[0] === "bootstrap";
  if (
    !bootstrap &&
    !(
      args.length === 2 &&
      ["grant", "revoke", "time-grant", "time-revoke"].includes(args[0]!) &&
      /^[a-zA-Z0-9_-]+\.json$/.test(args[1]!)
    )
  )
    throw Error("Invalid local support command.");
  const settings = config(process.env);
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
    for (const name of ["admin.json", "operator.json"]) {
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
    for (const [name, role] of [
      ["admin.json", "platform_admin"],
      ["operator.json", "operator"],
    ] as const) {
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
      action: "bootstrap",
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
    if (args[0] === "grant" || args[0] === "time-grant") {
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
