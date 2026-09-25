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

const options = (input?: Buffer): SpawnSyncOptions => ({
  input,
  maxBuffer: 32 * 1024 * 1024,
  timeout: 30_000,
  stdio: ["pipe", "pipe", "pipe"],
});

export function postgresArchiveTools(
  fixture: URL,
  runCommand: Runner = spawnSync,
) {
  if (
    fixture.protocol !== "postgresql:" ||
    fixture.hostname !== "127.0.0.1" ||
    fixture.port !== "54329" ||
    fixture.username !== "dne" ||
    !/^\/dne_test_[a-f0-9]{32}$/.test(fixture.pathname) ||
    fixture.search ||
    fixture.hash
  )
    throw new Error(
      "Restore tools require the generated loopback test fixture.",
    );

  const probe = runCommand("docker", ["--version"], options());
  const mode =
    (probe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? "host"
      : "compose";
  if (mode === "compose" && probe.status !== 0)
    throw new Error("Docker client probe failed; restore tools unavailable.");

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
        : ["compose", "exec", "-T", "postgres", tool, ...args];
    return runCommand(command, commandArgs, {
      ...options(input),
      ...(mode === "host" ? { env: hostEnvironment } : {}),
    });
  }
  return { mode, execute };
}
