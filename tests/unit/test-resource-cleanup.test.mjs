import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  apply,
  planCleanup,
  parseOptions,
} from "../../scripts/cleanup-test-resources.mjs";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const hoursAgo = (hours) => new Date(NOW - hours * 3600000).toISOString();
const hex = (digit) => digit.repeat(32);
const database = (overrides = {}) => ({
  name: `dne_test_${hex("a")}`,
  oid: "16400",
  marker: `coaching576-${hex("b")}`,
  isTemplate: false,
  connections: 0,
  created: hoursAgo(48),
  sizeBytes: 15000000,
  ...overrides,
});
const container = (overrides = {}) => ({
  id: "c".repeat(64),
  name: "dne-verify-abc123",
  status: "exited",
  startedAt: hoursAgo(60),
  finishedAt: hoursAgo(48),
  labels: {
    "io.deepnative.verification-owner": "gate",
    "io.deepnative.verification-claim": "claude-my-claim",
  },
  mounts: [{ Type: "bind" }],
  ...overrides,
});
const plan = (overrides = {}) =>
  planCleanup({
    databases: [database()],
    containers: [],
    processText: "",
    now: NOW,
    minAgeHours: 24,
    claim: undefined,
    ...overrides,
  });
const reasonFor = (result, name) =>
  result.kept.find((entry) => entry.name === name)?.reason;

describe("LEFTOVER-01 test database selection", () => {
  it("selects an old, unused, generated database", () => {
    const result = plan();
    expect(result.refused).toBeUndefined();
    expect(result.databases.map((entry) => entry.name)).toEqual([
      `dne_test_${hex("a")}`,
    ]);
  });
  it("selects one that has no marker comment", () => {
    expect(plan({ databases: [database({ marker: null })] }).databases).toEqual(
      [expect.objectContaining({ oid: "16400" })],
    );
  });
  it.each([
    ["the development database", { name: "dne_dev" }, "not a generated"],
    ["the maintenance database", { name: "postgres" }, "not a generated"],
    ["a short name", { name: "dne_test_abc" }, "not a generated"],
    ["upper-case hex", { name: `dne_test_${hex("A")}` }, "not a generated"],
    ["an injected name", { name: `dne_test_${hex("a")}"` }, "not a generated"],
    ["a template", { isTemplate: true }, "template"],
    ["an open connection", { connections: 1 }, "in use"],
    ["a recent creation", { created: hoursAgo(2) }, "too recent"],
    ["an unreadable age", { created: null }, "age unknown"],
    ["a human comment", { marker: "keep this for #576" }, "unrecognised"],
  ])("keeps %s", (_label, overrides, reason) => {
    const candidate = database(overrides);
    expect(reasonFor(plan({ databases: [candidate] }), candidate.name)).toMatch(
      reason,
    );
    expect(plan({ databases: [candidate] }).databases).toEqual([]);
  });
  it("keeps a database a running process or container names", () => {
    const result = plan({
      processText: `node server DNE_DATABASE_URL=postgres://x/dne_test_${hex("a")}`,
    });
    expect(result.databases).toEqual([]);
    expect(reasonFor(result, `dne_test_${hex("a")}`)).toMatch("names it");
  });
  it("keeps a database created after a running client started, which may own it", () => {
    const result = plan({
      containers: [
        container({
          name: "dne-verify-later",
          status: "running",
          startedAt: hoursAgo(72),
          finishedAt: null,
        }),
      ],
    });
    expect(result.databases).toEqual([]);
    expect(reasonFor(result, `dne_test_${hex("a")}`)).toMatch(
      "dne-verify-later",
    );
  });
  it("does not treat the shared PostgreSQL server as a client", () => {
    const result = plan({
      containers: [
        container({
          name: "deep-native-engine-postgres-1",
          status: "running",
          startedAt: hoursAgo(72),
          finishedAt: null,
          labels: {},
        }),
      ],
    });
    expect(result.databases).toHaveLength(1);
  });
  it.each(["running", "exited", "created"])(
    "refuses everything while the gate container is %s",
    (status) => {
      const result = plan({
        containers: [container({ name: "dne-gate-active", status })],
      });
      expect(result.refused).toMatch("dne-gate-active");
      expect(result.databases).toEqual([]);
      expect(result.containers).toEqual([]);
    },
  );
});

describe("LEFTOVER-02 verifier container selection", () => {
  const verifiers = (overrides, claim = "claude-my-claim") =>
    plan({ databases: [], containers: [container(overrides)], claim });
  it("selects only this claim's stopped, old, volume-free verifier", () => {
    expect(verifiers({}).containers.map((entry) => entry.id)).toEqual([
      "c".repeat(64),
    ]);
  });
  it("lists but keeps another worker's verifier", () => {
    const result = verifiers({}, "someone-else");
    expect(result.containers).toEqual([]);
    expect(reasonFor(result, "dne-verify-abc123")).toMatch("another claim");
  });
  it("keeps every verifier when no claim is given", () => {
    const result = verifiers({}, null);
    expect(result.containers).toEqual([]);
    expect(reasonFor(result, "dne-verify-abc123")).toMatch("another claim");
  });
  it.each([
    ["a running one", { status: "running", finishedAt: null }, "not stopped"],
    ["a paused one", { status: "paused" }, "not stopped"],
    [
      "the shared PostgreSQL",
      { name: "deep-native-engine-postgres-1" },
      "name",
    ],
    ["a private PostgreSQL", { name: "dne-39-pg" }, "name"],
    ["a preview", { name: "dne-preview-abc123" }, "name"],
    ["an unlabelled one", { labels: {} }, "label"],
    ["one holding a volume", { mounts: [{ Type: "volume" }] }, "volume"],
    ["one stopped recently", { finishedAt: hoursAgo(2) }, "too recent"],
    ["one with no stop time", { finishedAt: null }, "age unknown"],
  ])("keeps %s", (_label, overrides, reason) => {
    const candidate = container(overrides);
    const result = verifiers(overrides);
    expect(result.containers).toEqual([]);
    expect(reasonFor(result, candidate.name)).toMatch(reason);
  });
});

describe("LEFTOVER-03 options", () => {
  it("defaults to a dry run", () => {
    expect(parseOptions([])).toEqual({ apply: false, minAgeHours: 24 });
  });
  it("accepts explicit choices", () => {
    expect(
      parseOptions(["--apply", "--claim", "abc-1", "--min-age-hours", "6"]),
    ).toEqual({ apply: true, claim: "abc-1", minAgeHours: 6 });
  });
  it.each([
    [["--min-age-hours", "0"]],
    [["--min-age-hours", "abc"]],
    [["--claim"]],
    [["--force"]],
  ])("rejects %j", (argv) => {
    expect(() => parseOptions(argv)).toThrow();
  });
});

describe("LEFTOVER-04 applying a plan", () => {
  const selected = { name: `dne_test_${hex("a")}`, oid: "16400" };
  const deps = (overrides = {}) => ({
    gateExists: vi.fn(() => false),
    current: vi.fn(async () => ({ oid: "16400", connections: 0 })),
    drop: vi.fn(async () => {}),
    removeContainer: vi.fn(),
    ...overrides,
  });
  const work = {
    databases: [selected],
    containers: [{ id: "c".repeat(64), name: "dne-verify-abc123" }],
  };
  it("removes each selected resource", async () => {
    const d = deps();
    const outcome = await apply(work, d);
    expect(d.drop).toHaveBeenCalledWith(selected.name);
    expect(d.removeContainer).toHaveBeenCalledWith("c".repeat(64));
    expect(outcome.failures).toEqual([]);
  });
  it("stops before removing anything if a gate started", async () => {
    const d = deps({ gateExists: vi.fn(() => true) });
    const outcome = await apply(work, d);
    expect(d.drop).not.toHaveBeenCalled();
    expect(d.removeContainer).not.toHaveBeenCalled();
    expect(outcome.failures.join()).toMatch("dne-gate-active");
  });
  it.each([
    ["was reconnected", { oid: "16400", connections: 1 }],
    ["was replaced", { oid: "99999", connections: 0 }],
    ["has already gone", undefined],
  ])("leaves a database that %s since planning", async (_label, state) => {
    const d = deps({ current: vi.fn(async () => state) });
    const outcome = await apply({ ...work, containers: [] }, d);
    expect(d.drop).not.toHaveBeenCalled();
    expect(outcome.failures).toHaveLength(1);
  });
  it("reports a refused removal and does not retry or force it", async () => {
    const d = deps({
      drop: vi.fn(async () => {
        throw Error("database is being accessed by other users");
      }),
    });
    const outcome = await apply({ ...work, containers: [] }, d);
    expect(d.drop).toHaveBeenCalledOnce();
    expect(outcome.failures.join()).toMatch(selected.name);
  });
});

describe("LEFTOVER-05 the command stays conservative", () => {
  const source = readFileSync("scripts/cleanup-test-resources.mjs", "utf8");
  it("never forces a removal or touches a volume", () => {
    expect(source).not.toMatch(/WITH \(FORCE\)|pg_terminate_backend/);
    expect(source).not.toMatch(/"rm",\s*"-[a-z]*[fv]/);
    expect(source).not.toMatch(/"volume",\s*"rm"|"prune"/);
  });
});

describe("LEFTOVER-06 browser fixtures clean up after a failed test", () => {
  // A fixture that keeps its database when a test fails leaks one for every
  // failure. The name and marker are already attached to the test report.
  const files = readdirSync("tests/e2e").filter((f) => f.endsWith(".spec.ts"));
  it.each(files)("%s does not tie its drop to the test outcome", (file) => {
    const text = readFileSync(`tests/e2e/${file}`, "utf8");
    expect(text).not.toMatch(
      /if \(completed\)\s*await drop|if \(\s*test\.info\(\)\.status/,
    );
  });
});

describe("LEFTOVER-10 a real signal during a blocking step", () => {
  it("reaches cleanup instead of killing the process", async () => {
    const helper = pathToFileURL("scripts/interruption.mjs").href;
    const script = `
      import { spawnSync } from "node:child_process";
      import { watchInterruption } from ${JSON.stringify(helper)};
      const interruption = watchInterruption();
      try {
        console.log("started");
        spawnSync("sleep", ["1"]);
        await interruption.check();
        console.log("next step ran");
      } catch (error) {
        console.log(error.message);
      } finally {
        console.log("cleanup ran");
        interruption.release();
      }`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    const closed = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    await new Promise((resolve) =>
      child.stdout.on("data", (bytes) => {
        output += bytes;
        if (output.includes("started")) resolve();
      }),
    );
    child.kill("SIGTERM");
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(output).toContain("Verification stopped by SIGTERM");
    expect(output).toContain("cleanup ran");
    expect(output).not.toContain("next step ran");
  });
});

describe("LEFTOVER-11 fixture containers do not orphan image volumes", () => {
  it("removes the Azurite fixture's anonymous volume with its container", () => {
    const text = readFileSync(
      "tests/integration/azure-object-storage.test.ts",
      "utf8",
    );
    expect(text).toContain('docker("rm", "--force", "--volumes", name)');
  });
});
