import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process";

type Tool = "pg_dump" | "pg_restore";
type Runner = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer>;
type OwnedVerificationContainer = {
  container: string;
  volume: string;
  claim: string;
};
const pinnedImage =
  "postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
const attestationFailure = () =>
  new Error("Owned verification container could not be attested.");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw attestationFailure();
  return value as Record<string, unknown>;
}

const options = (input?: Buffer): SpawnSyncOptions => ({
  input,
  maxBuffer: 32 * 1024 * 1024,
  timeout: 30_000,
  stdio: ["pipe", "pipe", "pipe"],
});

export function postgresArchiveTools(
  fixture: URL,
  runCommand: Runner = spawnSync,
  requestedOwned?: OwnedVerificationContainer,
) {
  // Later caller mutation must not redirect a tool away from the attested ID.
  const owned = requestedOwned ? { ...requestedOwned } : undefined;
  if (
    fixture.protocol !== "postgresql:" ||
    fixture.hostname !== "127.0.0.1" ||
    (!owned && fixture.port !== "54329") ||
    !/^[1-9][0-9]{0,4}$/.test(fixture.port) ||
    Number(fixture.port) > 65535 ||
    fixture.username !== "dne" ||
    !/^\/dne_test_[a-f0-9]{32}$/.test(fixture.pathname) ||
    fixture.search ||
    fixture.hash
  )
    throw new Error(
      "Restore tools require the generated loopback test fixture.",
    );

  if (
    owned &&
    (!/^[a-f0-9]{64}$/.test(owned.container) ||
      !/^dne-verify-[a-f0-9]{32}$/.test(owned.volume) ||
      !/^DNE-[A-Za-z0-9-]{1,120}$/.test(owned.claim))
  )
    throw attestationFailure();

  const probe = runCommand("docker", ["--version"], options());
  const mode = owned
    ? "container"
    : (probe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? "host"
      : "compose";
  if (mode !== "host" && (probe.status !== 0 || probe.error))
    throw new Error("Docker client probe failed; restore tools unavailable.");

  if (owned) {
    // Compare the caller's exact creation record, never discover ownership by
    // prefix. Inspect only nonsecret fields; do not capture container env/logs.
    const inspect = (args: string[]) => {
      const result = runCommand("docker", args, options());
      if (result.status !== 0 || result.error) throw attestationFailure();
      try {
        return record(JSON.parse(result.stdout.toString("utf8")));
      } catch {
        throw attestationFailure();
      }
    };
    const container = inspect([
      "inspect",
      "--type",
      "container",
      "--format",
      '{"id":{{json .Id}},"image":{{json .Config.Image}},"running":{{json .State.Running}},"owner":{{json (index .Config.Labels "io.deepnative.verification-owner")}},"claim":{{json (index .Config.Labels "io.deepnative.verification-claim")}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}}}',
      owned.container,
    ]);
    const ports = record(container.ports);
    const bindings = ports["5432/tcp"];
    const mounts = container.mounts;
    if (
      container.id !== owned.container ||
      container.image !== pinnedImage ||
      container.running !== true ||
      container.owner !== "gate" ||
      container.claim !== owned.claim ||
      Object.keys(ports).length !== 1 ||
      !Array.isArray(bindings) ||
      bindings.length !== 1 ||
      !Array.isArray(mounts) ||
      mounts.length !== 1
    )
      throw attestationFailure();
    const binding = record(bindings[0]);
    const mount = record(mounts[0]);
    if (
      binding.HostIp !== "127.0.0.1" ||
      binding.HostPort !== fixture.port ||
      mount.Type !== "volume" ||
      mount.Name !== owned.volume ||
      mount.Destination !== "/var/lib/postgresql" ||
      mount.RW !== true
    )
      throw attestationFailure();
    const volume = inspect([
      "volume",
      "inspect",
      "--format",
      '{"name":{{json .Name}},"driver":{{json .Driver}},"options":{{json .Options}},"owner":{{json (index .Labels "io.deepnative.verification-owner")}},"claim":{{json (index .Labels "io.deepnative.verification-claim")}}}',
      owned.volume,
    ]);
    if (
      volume.name !== owned.volume ||
      volume.driver !== "local" ||
      (volume.options !== null &&
        Object.keys(record(volume.options)).length !== 0) ||
      volume.owner !== "gate" ||
      volume.claim !== owned.claim
    )
      throw attestationFailure();
  }

  const hostEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PGHOST: "127.0.0.1",
    PGPORT: "54329",
    PGUSER: "dne",
    PGPASSWORD: decodeURIComponent(fixture.password),
    PGSSLMODE: "disable",
    PGCONNECT_TIMEOUT: "3",
  };
  function execute(tool: Tool, args: string[], input?: Buffer) {
    const database = args.find((arg) => arg.startsWith("--dbname="));
    if (
      !(args.length === 1 && args[0] === "--version") &&
      (!database || !/^--dbname=dne_test_[a-f0-9]{32}$/.test(database))
    )
      throw new Error("Restore tool target must be a generated test database.");
    const command = mode === "host" ? tool : "docker";
    const commandArgs =
      mode === "host"
        ? args.length === 1 && args[0] === "--version"
          ? args
          : ["--host=127.0.0.1", "--port=54329", ...args]
        : owned
          ? ["exec", "-i", owned.container, tool, ...args]
          : ["compose", "exec", "-T", "postgres", tool, ...args];
    return runCommand(command, commandArgs, {
      ...options(input),
      ...(mode === "host" ? { env: hostEnvironment } : {}),
    });
  }
  return { mode, execute };
}
