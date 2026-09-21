import { afterEach, it, expect, vi } from "vitest";
const start = vi.hoisted(() => vi.fn());
vi.mock("../../src/runtime.ts", () => ({ start }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  process.exitCode = 0;
});
it("fails startup clearly without printing connection credentials", async () => {
  start.mockRejectedValueOnce(new Error("secret"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../../src/main.ts");
  expect(process.exitCode).toBe(1);
  expect(error).toHaveBeenCalledWith(
    "Preview startup failed. Check the local database and configuration.",
  );
});
it.each([false, true])(
  "gracefully handles shutdown once (failure=%s)",
  async (failure) => {
    const close = failure
      ? vi.fn().mockRejectedValue(new Error("secret"))
      : vi.fn().mockResolvedValue(undefined);
    start.mockResolvedValueOnce({ close });
    const callbacks: Record<string, () => void> = {};
    vi.spyOn(process, "once").mockImplementation(((
      event: string,
      callback: () => void,
    ) => {
      callbacks[event] = callback;
      return process;
    }) as typeof process.once);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await import("../../src/main.ts");
    callbacks.SIGTERM!();
    callbacks.SIGINT!();
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    expect(process.exitCode ?? 0).toBe(failure ? 1 : 0);
  },
);
