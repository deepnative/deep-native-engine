import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, it, expect, vi } from "vitest";
const doubles = vi.hoisted(() => ({
  end: vi.fn(),
  migrate: vi.fn(),
  seed: vi.fn(),
  listen: vi.fn(),
  app: vi.fn(),
  recover: vi.fn(),
  pool: undefined as EventEmitter | undefined,
}));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Pool: class extends EventEmitter {
      constructor() {
        super();
        doubles.pool = this;
      }
      end = doubles.end;
    },
  };
});
vi.mock("../../src/store.ts", () => ({
  migrate: doubles.migrate,
  store: vi.fn(),
}));
vi.mock("../../src/app.ts", () => ({
  app: doubles.app,
}));
vi.mock("../../src/catalog.ts", () => ({
  catalogStore: vi.fn(),
  seedDraftPack: doubles.seed,
}));
vi.mock("../../src/deletion-recovery.ts", () => ({
  recoverPendingMemberDeletions: doubles.recover,
}));
import { evidenceCapabilityClock, start } from "../../src/runtime.ts";
const env = {
  DNE_DATABASE_URL:
    "postgresql://localhost/dne_test_0123456789abcdef0123456789abcdef",
  DNE_PORT: "4567",
  DNE_APP_MODE: "test",
};
it("ATTEND-08 runtime attendance creation requires actual local staff entry alongside its explicit flag", async () => {
  server();
  const running = await start({
    ...env,
    DNE_EVENT_ATTENDANCE: "enabled",
    DNE_EVENT_REGISTRATION: "enabled",
    DNE_LOCAL_STAFF_ENTRY: "disabled",
  });
  try {
    const options = doubles.app.mock.calls[0]![1];
    expect(
      await options.eventAttendance.checkPermission("b".repeat(64), {
        registrationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        administratorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).toEqual({ kind: "denied" });
  } finally {
    await running.close();
  }
});
beforeEach(() => {
  vi.clearAllMocks();
  doubles.app.mockImplementation(() => ({ listen: doubles.listen }));
  doubles.end.mockResolvedValue(undefined);
  doubles.migrate.mockResolvedValue(undefined);
  doubles.seed.mockResolvedValue(12);
  doubles.recover.mockResolvedValue({
    examined: 0,
    completed: 0,
    failed: 0,
    nextCursor: null,
  });
});
it("controls only test evidence capabilities with a validated private clock file", () => {
  const root = mkdtempSync(join(tmpdir(), "dne-test-clock-"));
  const file = join(root, ".test-evidence-clock");
  try {
    const clock = evidenceCapabilityClock("test", root, "1");
    expect(Math.abs(clock() - Date.now())).toBeLessThan(1000);
    writeFileSync(file, "1800000000000");
    expect(clock()).toBe(1800000000000);
    expect(evidenceCapabilityClock("demo", root, "1")()).not.toBe(
      1800000000000,
    );
    expect(evidenceCapabilityClock("test", root, undefined)()).not.toBe(
      1800000000000,
    );
    writeFileSync(file, "Infinity");
    expect(clock).toThrow("Invalid test evidence clock.");
    writeFileSync(file, "999999999999999999999");
    expect(clock).toThrow("Invalid test evidence clock.");
    rmSync(file);
    mkdirSync(file);
    expect(clock).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
function server(error?: Error) {
  const address = vi.fn<() => AddressInfo | string | null>().mockReturnValue({
    address: "127.0.0.1",
    family: "IPv4",
    port: 4567,
  });
  const emitter = Object.assign(new EventEmitter(), {
    address,
    listening: false,
  });
  const close = vi.fn((cb: (error?: Error) => void) => {
    emitter.listening = false;
    cb(error);
  });
  doubles.listen.mockImplementation(() => {
    queueMicrotask(() => {
      emitter.listening = true;
      emitter.emit("listening");
    });
    return Object.assign(emitter, { close });
  });
  return { emitter, close, address };
}

it("starts after migration and closes both listener and pool", async () => {
  const s = server();
  const running = await start(env);
  expect(doubles.migrate).toHaveBeenCalledOnce();
  expect(doubles.seed).toHaveBeenCalledOnce();
  expect(doubles.listen).toHaveBeenCalledWith(4567, "127.0.0.1");
  expect(running).toMatchObject({
    port: 4567,
    origin: "http://127.0.0.1:4567",
  });
  await running.close();
  expect(s.close).toHaveBeenCalledOnce();
  expect(doubles.end).toHaveBeenCalledOnce();
});
it("closes the pool when migration or bind fails", async () => {
  doubles.migrate.mockRejectedValueOnce(new Error("migration failed"));
  await expect(start(env)).rejects.toThrow("migration failed");
  expect(doubles.end).toHaveBeenCalledOnce();
  const emitter = new EventEmitter();
  doubles.listen.mockImplementation(() => {
    queueMicrotask(() => emitter.emit("error", new Error("address in use")));
    return emitter;
  });
  await expect(start(env)).rejects.toThrow("address in use");
  expect(doubles.end).toHaveBeenCalledTimes(2);
});
it("still closes the pool after a listener-close failure", async () => {
  server(new Error("already closed"));
  const running = await start(env);
  await expect(running.close()).rejects.toThrow("already closed");
  expect(doubles.end).toHaveBeenCalledOnce();
});
it("closes the pool when draft import fails", async () => {
  doubles.seed.mockRejectedValueOnce(new Error("draft import failed"));
  await expect(start(env)).rejects.toThrow("draft import failed");
  expect(doubles.end).toHaveBeenCalledOnce();
});

it("handles idle database errors without terminating or logging private connection details", async () => {
  server();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const running = await start(env);
    expect(() =>
      doubles.pool!.emit("error", new Error("secret credential")),
    ).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      "Database connection interrupted; retry the request.",
    );
    await running.close();
  } finally {
    log.mockRestore();
  }
});

it("runs bounded deletion recovery without overlap and waits for it at shutdown", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    server();
    let finish!: (value: {
      examined: number;
      completed: number;
      failed: number;
      nextCursor: string;
    }) => void;
    doubles.recover.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = await start(env);
    expect(doubles.recover).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(doubles.recover).toHaveBeenCalledOnce();
    const closing = running.close();
    await Promise.resolve();
    expect(doubles.end).not.toHaveBeenCalled();
    finish({ examined: 1, completed: 0, failed: 1, nextCursor: "cursor" });
    await closing;
    expect(log).toHaveBeenCalledWith(
      "A pending local deletion will be retried.",
    );
    expect(doubles.end).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(doubles.recover).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
    vi.useRealTimers();
  }
});

it("retries a failed deletion scan without logging private errors", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    server();
    doubles.recover.mockRejectedValueOnce(new Error("private storage path"));
    const running = await start(env);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(doubles.recover).toHaveBeenCalledTimes(2);
    expect(doubles.recover.mock.calls[1]?.[2]).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "Pending local deletion recovery is unavailable.",
    );
    await running.close();
  } finally {
    log.mockRestore();
    vi.useRealTimers();
  }
});

it("publishes the actual OS-assigned origin to request options before starting recovery", async () => {
  const s = server();
  s.address.mockReturnValue({
    address: "127.0.0.1",
    family: "IPv4",
    port: 54321,
  });
  let optionsAtRecovery: { port: number; origin: string } | undefined;
  doubles.recover.mockImplementationOnce(async () => {
    const options = doubles.app.mock.calls[0]![1] as {
      port: number;
      origin: string;
    };
    optionsAtRecovery = { port: options.port, origin: options.origin };
    return { examined: 0, completed: 0, failed: 0, nextCursor: null };
  });
  const running = await start({ ...env, DNE_PORT: "0" });
  try {
    expect(doubles.listen).toHaveBeenCalledExactlyOnceWith(0, "127.0.0.1");
    expect(doubles.recover).toHaveBeenCalledOnce();
    expect(optionsAtRecovery).toEqual({
      port: 54321,
      origin: "http://127.0.0.1:54321",
    });
    expect(running).toMatchObject({
      port: 54321,
      origin: "http://127.0.0.1:54321",
    });
  } finally {
    await running.close();
  }
});
it("preserves normalized origin checks for the configured default HTTP port", async () => {
  const s = server();
  s.address.mockReturnValue({ address: "127.0.0.1", family: "IPv4", port: 80 });
  const running = await start({ ...env, DNE_PORT: "80" });
  try {
    expect(doubles.listen).toHaveBeenCalledExactlyOnceWith(80, "127.0.0.1");
    expect(running.origin).toBe("http://127.0.0.1");
    expect(doubles.app.mock.calls[0]![1]).toMatchObject({
      origin: "http://127.0.0.1",
    });
  } finally {
    await running.close();
  }
});
it.each([
  null,
  "unexpected socket path",
  { address: "127.0.0.1", family: "IPv4", port: 0 },
])(
  "closes the bound listener and pool before rejecting an unusable TCP address %j",
  async (address) => {
    const s = server();
    s.address.mockReturnValue(address);
    await expect(start({ ...env, DNE_PORT: "0" })).rejects.toThrow(
      "no bound TCP address",
    );
    expect(s.close).toHaveBeenCalledOnce();
    expect(s.emitter.listening).toBe(false);
    expect(doubles.end).toHaveBeenCalledOnce();
    expect(doubles.recover).not.toHaveBeenCalled();
  },
);
it("still ends the pool if listener cleanup fails after a bound startup failure", async () => {
  const s = server(new Error("listener cleanup failed"));
  s.address.mockImplementationOnce(() => {
    throw new Error("address inspection failed");
  });
  await expect(start(env)).rejects.toThrow("listener cleanup failed");
  expect(s.close).toHaveBeenCalledOnce();
  expect(doubles.end).toHaveBeenCalledOnce();
  expect(doubles.recover).not.toHaveBeenCalled();
});
