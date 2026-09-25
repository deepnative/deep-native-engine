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
