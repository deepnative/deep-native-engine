import { expect, it, vi } from "vitest";
import { postgresArchiveTools } from "../support/postgres-archive-tools.ts";

const database = `dne_test_${"a".repeat(32)}`;
const fixture = () =>
  new URL(`postgresql://dne:synthetic-secret@127.0.0.1:54329/${database}`);
const result = (overrides: Record<string, unknown> = {}) => ({
  pid: 1,
  output: [null, Buffer.from(""), Buffer.from("")],
  signal: null,
  status: 0,
  stdout: Buffer.from(""),
  stderr: Buffer.from(""),
  ...overrides,
});

it("uses host PostgreSQL clients only when Docker CLI is absent and confines the connection", () => {
  const run = vi.fn((command: string) =>
    command === "docker"
      ? result({ status: null, error: { code: "ENOENT" } })
      : result(),
  );
  const tools = postgresArchiveTools(fixture(), run);
  expect(tools.mode).toBe("host");
  tools.execute("pg_dump", ["--username=dne", `--dbname=${database}`]);
  expect(run.mock.calls[1]![0]).toBe("pg_dump");
  const call = run.mock.calls[1] as unknown as [
    string,
    string[],
    { env: NodeJS.ProcessEnv },
  ];
  expect(call[1]).toEqual([
    "--host=127.0.0.1",
    "--port=54329",
    "--username=dne",
    `--dbname=${database}`,
  ]);
  expect(call[2].env).toMatchObject({
    PGHOST: "127.0.0.1",
    PGPORT: "54329",
    PGUSER: "dne",
    PGPASSWORD: "synthetic-secret",
    PGSSLMODE: "disable",
  });
  expect(call[1].join(" ")).not.toContain("synthetic-secret");
  tools.execute("pg_dump", ["--version"]);
  expect((run.mock.calls[2] as unknown as [string, string[]])[1]).toEqual([
    "--version",
  ]);
  expect(() => tools.execute("pg_restore", ["--dbname=dne_dev"])).toThrow(
    /generated test database/,
  );
  expect(() => tools.execute("pg_dump", [])).toThrow(/generated test database/);
  expect(run).toHaveBeenCalledTimes(3);
});

it("keeps Docker Compose behavior when its CLI is available", () => {
  const run = vi.fn(() => result());
  const tools = postgresArchiveTools(fixture(), run);
  expect(tools.mode).toBe("compose");
  const archive = Buffer.from("synthetic archive");
  tools.execute("pg_restore", [`--dbname=${database}`], archive);
  const call = run.mock.calls[1] as unknown as [
    string,
    string[],
    { input: Buffer; env?: NodeJS.ProcessEnv },
  ];
  expect(call[0]).toBe("docker");
  expect(call[1]).toEqual([
    "compose",
    "exec",
    "-T",
    "postgres",
    "pg_restore",
    `--dbname=${database}`,
  ]);
  expect(call[2].input).toBe(archive);
  expect(call[2].env).toBeUndefined();
});

it("fails closed for a broken Docker CLI or an untrusted fixture", () => {
  expect(() =>
    postgresArchiveTools(
      fixture(),
      vi.fn(() => result({ status: 1 })),
    ),
  ).toThrow(/Docker client probe failed/);
  const unsafe = new URL("postgresql://dne:secret@remote.example:5432/dne_dev");
  const run = vi.fn(() => result());
  expect(() => postgresArchiveTools(unsafe, run)).toThrow(/generated loopback/);
  expect(run).not.toHaveBeenCalled();
});

const isolated = () => ({
  container: "b".repeat(64),
  volume: `dne-verify-${"c".repeat(32)}`,
  claim: "DNE-2026-10-14-513-isolated-verification-codex-root",
});
const isolatedFixture = () => {
  const url = fixture();
  url.port = "64329";
  return url;
};
const containerRecord = () => ({
  id: isolated().container,
  image:
    "postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873",
  running: true,
  owner: "gate",
  claim: isolated().claim,
  ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "64329" }] },
  mounts: [
    {
      Type: "volume",
      Name: isolated().volume,
      Destination: "/var/lib/postgresql",
      RW: true,
    },
  ],
});
const volumeRecord = () => ({
  name: isolated().volume,
  driver: "local",
  options: null,
  owner: "gate",
  claim: isolated().claim,
});
function isolatedRunner(
  container: unknown = containerRecord(),
  volume: unknown = volumeRecord(),
) {
  return vi.fn((_command: string, args: string[]) =>
    result({
      stdout: Buffer.from(
        args[0] === "inspect"
          ? JSON.stringify(container)
          : args[0] === "volume"
            ? JSON.stringify(volume)
            : "",
      ),
    }),
  );
}

it("ISO-01 uses only the attested dedicated container for binary archive transport", () => {
  const run = isolatedRunner();
  const creation = isolated();
  const tools = postgresArchiveTools(isolatedFixture(), run, creation);
  creation.container = "d".repeat(64);
  expect(tools.mode).toBe("container");
  expect(run.mock.calls[1]![1].at(-1)).toBe(isolated().container);
  expect(run.mock.calls[2]![1].at(-1)).toBe(isolated().volume);
  const archive = Buffer.from([0, 255, 10, 128]);
  tools.execute(
    "pg_restore",
    ["--username=dne", `--dbname=${database}`],
    archive,
  );
  const call = run.mock.calls[3] as unknown as [
    string,
    string[],
    { input: Buffer; stdio: string[]; timeout: number; maxBuffer: number },
  ];
  expect(call[0]).toBe("docker");
  expect(call[1]).toEqual([
    "exec",
    "-i",
    isolated().container,
    "pg_restore",
    "--username=dne",
    `--dbname=${database}`,
  ]);
  expect(call[2].input).toBe(archive);
  expect(call[2].stdio).toEqual(["pipe", "pipe", "pipe"]);
  expect(call[2].timeout).toBe(30_000);
  expect(call[2].maxBuffer).toBe(32 * 1024 * 1024);
  expect(call[1].join(" ")).not.toContain("synthetic-secret");
  tools.execute("pg_dump", ["--version"]);
  expect(run.mock.calls[4]![1]).toEqual([
    "exec",
    "-i",
    isolated().container,
    "pg_dump",
    "--version",
  ]);
  expect(() => tools.execute("pg_restore", ["--dbname=dne_dev"])).toThrow(
    /generated test database/,
  );
  expect(run).toHaveBeenCalledTimes(5);
});

it.each([
  { ...containerRecord(), id: "d".repeat(64) },
  { ...containerRecord(), running: false },
  { ...containerRecord(), image: "postgres:18-alpine" },
  { ...containerRecord(), owner: "preview" },
  { ...containerRecord(), claim: "another-worker" },
  { ...containerRecord(), ports: {} },
  {
    ...containerRecord(),
    ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "64329" }] },
  },
  {
    ...containerRecord(),
    ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54329" }] },
  },
  {
    ...containerRecord(),
    ports: {
      "5432/tcp": [
        { HostIp: "127.0.0.1", HostPort: "64329" },
        { HostIp: "127.0.0.1", HostPort: "64329" },
      ],
    },
  },
  { ...containerRecord(), ports: { ...containerRecord().ports, "80/tcp": [] } },
  { ...containerRecord(), mounts: [] },
  {
    ...containerRecord(),
    mounts: [{ ...containerRecord().mounts[0], Name: "foreign-volume" }],
  },
  {
    ...containerRecord(),
    mounts: [{ ...containerRecord().mounts[0], Type: "tmpfs" }],
  },
  {
    ...containerRecord(),
    mounts: [{ ...containerRecord().mounts[0], RW: false }],
  },
  {
    ...containerRecord(),
    mounts: [...containerRecord().mounts, ...containerRecord().mounts],
  },
  null,
])(
  "ISO-02 rejects an unattested container before archive execution %#",
  (record) => {
    const run = isolatedRunner(record);
    expect(() =>
      postgresArchiveTools(isolatedFixture(), run, isolated()),
    ).toThrow(/Owned verification container/);
    expect(run.mock.calls.some((call) => call[1][0] === "exec")).toBe(false);
  },
);

it.each([
  { ...volumeRecord(), name: "foreign-volume" },
  { ...volumeRecord(), driver: "remote" },
  { ...volumeRecord(), options: { device: "/foreign" } },
  { ...volumeRecord(), owner: "preview" },
  { ...volumeRecord(), claim: "another-worker" },
  null,
])(
  "ISO-02 rejects an unattested volume before archive execution %#",
  (record) => {
    const run = isolatedRunner(containerRecord(), record);
    expect(() =>
      postgresArchiveTools(isolatedFixture(), run, isolated()),
    ).toThrow(/Owned verification container/);
    expect(run.mock.calls.some((call) => call[1][0] === "exec")).toBe(false);
  },
);

it("ISO-02 fails closed for invalid identity, broken inspection or absent Docker without fallback", () => {
  const run = isolatedRunner();
  expect(() =>
    postgresArchiveTools(isolatedFixture(), run, {
      ...isolated(),
      container: "--bad",
    }),
  ).toThrow(/Owned verification container/);
  expect(run).not.toHaveBeenCalled();
  expect(() =>
    postgresArchiveTools(isolatedFixture(), run, { ...isolated(), volume: "" }),
  ).toThrow(/Owned verification container/);
  expect(() =>
    postgresArchiveTools(isolatedFixture(), run, { ...isolated(), claim: "" }),
  ).toThrow(/Owned verification container/);
  expect(run).not.toHaveBeenCalled();
  const missing = vi.fn(() =>
    result({ status: null, error: { code: "ENOENT" } }),
  );
  expect(() =>
    postgresArchiveTools(isolatedFixture(), missing, isolated()),
  ).toThrow(/Docker client probe failed/);
  expect(missing).toHaveBeenCalledTimes(1);
  for (const response of [
    result({ status: 1 }),
    result({ stdout: Buffer.from("private malformed inspection") }),
  ]) {
    const broken = vi.fn((_command: string, args: string[]) =>
      args[0] === "--version" ? result() : response,
    );
    expect(() =>
      postgresArchiveTools(isolatedFixture(), broken, isolated()),
    ).toThrow(/^Owned verification container could not be attested\.$/);
    expect(broken.mock.calls.some((call) => call[1][0] === "exec")).toBe(false);
  }
  expect(() => postgresArchiveTools(isolatedFixture(), run)).toThrow(
    /generated loopback/,
  );
});
