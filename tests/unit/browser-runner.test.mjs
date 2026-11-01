import { setImmediate } from "node:timers";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("pg", () => ({ Pool: vi.fn() }));
vi.mock("../../scripts/integration-runner.mjs", () => ({
  testLaneCount: () => 4,
  controlUrl: vi.fn(() => new URL("postgresql://invented@127.0.0.1/postgres")),
  createLaneDatabase: vi.fn(),
  dropLaneDatabase: vi.fn(),
}));
import { spawn, spawnSync } from "node:child_process";
import { Pool } from "pg";
import {
  createLaneDatabase,
  dropLaneDatabase,
} from "../../scripts/integration-runner.mjs";
import { runBrowsers } from "../../scripts/browser-runner.mjs";
const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  vi.mocked(spawnSync).mockReturnValue({ status: 0 });
  const root = mkdtempSync(path.join(tmpdir(), "browser-runner-test-"));
  roots.push(root);
  vi.mocked(Pool).mockImplementation(function () {
    return { on: vi.fn(), end: vi.fn(async () => {}) };
  });
  let index = 0;
  vi.mocked(createLaneDatabase).mockImplementation(async () => ({
    name: `dne_test_${String(++index).repeat(32)}`,
    oid: String(index),
    marker: "invented-owned",
  }));
  vi.mocked(dropLaneDatabase).mockResolvedValue(undefined);
  const children = [];
  vi.mocked(spawn).mockImplementation(() => {
    const child = new EventEmitter();
    child.kill = vi.fn();
    children.push(child);
    return child;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { root, children };
}
it("SPEED04 launches all browser shards with distinct databases, storage and loopback servers before merging original blobs", async () => {
  const { root, children } = fixture();
  const run = runBrowsers(root);
  await vi.waitFor(() => expect(children).toHaveLength(4));
  const calls = vi.mocked(spawn).mock.calls;
  for (const key of [
    "DNE_TEST_DATABASE_URL",
    "DNE_TEST_PRIVATE_STORAGE_ROOT",
    "DNE_E2E_ORIGIN",
    "PLAYWRIGHT_BLOB_OUTPUT_FILE",
  ])
    expect(new Set(calls.map((call) => call[2].env[key])).size).toBe(4);
  calls.forEach((call, index) => {
    expect(call[1]).toContain(`--shard=${index + 1}/4`);
    expect(call[1]).toContain("--reporter=blob");
    expect(call[2].env.DNE_E2E_ORIGIN).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
  expect(dropLaneDatabase).not.toHaveBeenCalled();
  for (const child of children.slice()) child.emit("close", 0, null);
  await vi.waitFor(() => expect(children).toHaveLength(5));
  expect(vi.mocked(spawn).mock.calls[4][1]).toContain("merge-reports");
  children[4].emit("close", 0, null);
  expect(await run).toBe(0);
  expect(dropLaneDatabase).toHaveBeenCalledTimes(4);
  expect(
    JSON.parse(readFileSync(path.join(root, "artifacts/browser-shards.json")))
      .lanes,
  ).toHaveLength(4);
});
it.each(["shard", "merge", "packaging"])(
  "SPEED04 fails closed on an original %s failure",
  async (stage) => {
    const { root, children } = fixture();
    if (stage === "packaging")
      vi.mocked(spawnSync).mockReturnValue({ status: 1 });
    const run = runBrowsers(root);
    await vi.waitFor(() => expect(children).toHaveLength(4));
    children
      .slice()
      .forEach((child, index) =>
        child.emit("close", stage === "shard" && index === 0 ? 1 : 0, null),
      );
    if (stage !== "shard") {
      await vi.waitFor(() => expect(children).toHaveLength(5));
      children[4].emit("close", stage === "merge" ? 1 : 0, null);
    }
    expect(await run).toBe(1);
    expect(dropLaneDatabase).toHaveBeenCalledTimes(4);
  },
);
it("SPEED04 retains owned resources until every interrupted browser process closes", async () => {
  const { root, children } = fixture();
  const before = new Set(process.listeners("SIGTERM"));
  const run = runBrowsers(root);
  await vi.waitFor(() => expect(children).toHaveLength(4));
  process.listeners("SIGTERM").find((listener) => !before.has(listener))();
  for (const child of children)
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  children.slice(0, 3).forEach((child) => child.emit("close", null, "SIGTERM"));
  await new Promise((resolve) => setImmediate(resolve));
  expect(dropLaneDatabase).not.toHaveBeenCalled();
  children[3].emit("close", null, "SIGTERM");
  expect(await run).toBe(1);
  expect(dropLaneDatabase).toHaveBeenCalledTimes(4);
});
