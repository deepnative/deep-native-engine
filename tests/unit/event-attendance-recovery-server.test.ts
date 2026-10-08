import { test, expect } from "vitest";
import { connect, type Socket } from "node:net";
import { Pool } from "pg";
import { startAttendanceRecoveryServer } from "../support/event-attendance-recovery-server.ts";

async function preconnect(origin: string) {
  const url = new URL(origin);
  const socket = connect(Number(url.port), url.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function promptly(pending: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const action of ["pause", "close"] as const) {
  test(`attendance fault fixture ${action} releases an owned browser preconnection without an HTTP request`, async () => {
    // Listener lifecycle only: no database request, authority or product fault.
    const pool = new Pool({ host: "127.0.0.1", port: 1, database: "not_used" });
    const running = await startAttendanceRecoveryServer(pool);
    let socket: Socket | undefined;
    let pending: Promise<void> | undefined;
    let completed: boolean;
    try {
      socket = await preconnect(running.origin);
      await expect.poll(() => running.connections()).toBe(1);
      pending = running[action]();
      completed = await promptly(pending);
    } finally {
      socket?.destroy();
      await pending;
      if (action === "pause" || !pending) await running.close();
      await pool.end();
    }
    expect(completed).toBe(true);
  });
}
