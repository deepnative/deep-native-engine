import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  config: vi.fn(),
  create: vi.fn(),
  end: vi.fn(),
  sweep: vi.fn(),
  on: vi.fn(),
}));
vi.mock("../../src/config.ts", () => ({ config: fake.config }));
vi.mock("pg", () => ({
  Pool: class {
    constructor(settings: unknown) {
      fake.create(settings);
    }
    end = fake.end;
    on = fake.on;
  },
}));
vi.mock("../../src/ledger.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ledger.ts")>()),
  syntheticLedger: () => ({ sweepExpired: fake.sweep }),
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(process, "argv", "get").mockReturnValue([
    "node",
    "script",
    "--limit",
    "100",
  ]);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake.config.mockReturnValue({ databaseUrl: "synthetic-local-url" });
  fake.create.mockImplementation(() => {});
  fake.end.mockResolvedValue(undefined);
  fake.on.mockImplementation(() => {});
  fake.sweep.mockResolvedValue({ processed: 2, skipped: 1, moreDue: true });
  process.exitCode = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});
async function run() {
  await import("../../src/expiry-sweep-main.ts");
  return {
    out: vi.mocked(console.info).mock.calls,
    err: vi.mocked(console.error).mock.calls,
  };
}
it("reports aggregate success and closes its local database connection", async () => {
  const { out, err } = await run();
  expect(out).toEqual([
    [
      JSON.stringify({
        status: "complete",
        processed: 2,
        skipped: 1,
        moreDue: true,
      }),
    ],
  ]);
  expect(err).toEqual([]);
  expect(process.exitCode).toBe(0);
  expect(fake.sweep).toHaveBeenCalledWith(100);
  expect(fake.end).toHaveBeenCalledOnce();
});
it.each(
  [
    [],
    ["--limit"],
    ["--other", "1"],
    ["--limit", "0"],
    ["--limit", "501"],
    ["--limit", "1.5"],
    ["--limit", "01"],
    ["--limit", "1", "extra"],
  ].map((args) => ({ args })),
)(
  "rejects invalid command arguments %j before opening a database",
  async ({ args }) => {
    vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "script",
      ...args,
    ]);
    const { out, err } = await run();
    expect(out).toEqual([]);
    expect(err).toEqual([
      [
        JSON.stringify({
          status: "failed",
          processed: 0,
          skipped: 0,
          moreDue: null,
        }),
      ],
    ]);
    expect(process.exitCode).toBe(1);
    expect(fake.create).not.toHaveBeenCalled();
  },
);
it.each(["configuration", "constructor", "database"])(
  "suppresses private %s failures",
  async (stage) => {
    const error = new Error("private-url-and-grant-marker");
    if (stage === "configuration")
      fake.config.mockImplementationOnce(() => {
        throw error;
      });
    if (stage === "constructor")
      fake.create.mockImplementationOnce(() => {
        throw error;
      });
    if (stage === "database") fake.sweep.mockRejectedValueOnce(error);
    const { out, err } = await run();
    expect(out).toEqual([]);
    expect(err).toEqual([
      [
        JSON.stringify({
          status: "failed",
          processed: 0,
          skipped: 0,
          moreDue: null,
        }),
      ],
    ]);
    expect(process.exitCode).toBe(1);
  },
);
it("retains partial counts on failure without publishing IDs or exception details", async () => {
  // Import the same reset module instance used by the command's instanceof.
  const { ExpirySweepFailure: Failure } = await import("../../src/ledger.ts");
  fake.sweep.mockRejectedValueOnce(new Failure(1, 2));
  const { out, err } = await run();
  expect(out).toEqual([]);
  expect(err).toEqual([
    [
      JSON.stringify({
        status: "failed",
        processed: 1,
        skipped: 2,
        moreDue: null,
      }),
    ],
  ]);
  expect(process.exitCode).toBe(1);
  expect(fake.end).toHaveBeenCalledOnce();
});
it.each(["shutdown", "idle"])(
  "does not announce success after an %s connection failure",
  async (stage) => {
    if (stage === "shutdown")
      fake.end.mockRejectedValueOnce(new Error("private-marker"));
    if (stage === "idle")
      fake.on.mockImplementationOnce((_event, callback) =>
        callback(new Error("private-marker")),
      );
    const { out, err } = await run();
    expect(out).toEqual([]);
    expect(err).toEqual([
      [
        JSON.stringify({
          status: "failed",
          processed: 2,
          skipped: 1,
          moreDue: null,
        }),
      ],
    ]);
    expect(process.exitCode).toBe(1);
  },
);
