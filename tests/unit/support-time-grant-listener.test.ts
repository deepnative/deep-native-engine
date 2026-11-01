import { once } from "node:events";
import { connect } from "node:net";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { startSupportTimeGrantRecoveryServer } from "../support/support-time-grant-recovery-server.ts";

it("closes its owned incomplete HTTP connection after the recovery scenario finishes", async () => {
  const pool = new Pool();
  const listener = await startSupportTimeGrantRecoveryServer(pool);
  const at = new URL(listener.origin);
  const socket = connect(Number(at.port), at.hostname);
  await once(socket, "connect");
  const accepted = once(socket, "data");
  socket.write(
    "POST /staff/sign-in HTTP/1.1\r\nHost: 127.0.0.1\r\nExpect: 100-continue\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 1000\r\n\r\n",
  );
  expect(String((await accepted)[0])).toContain("100 Continue");
  let closing: Promise<void> | undefined;
  try {
    closing = listener.close();
    expect(
      await Promise.race([closing.then(() => true), setTimeout(500, false)]),
    ).toBe(true);
  } finally {
    socket.destroy();
    await closing;
    await pool.end();
  }
});
