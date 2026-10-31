import express from "express";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";

function origin(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing listener");
  return `http://127.0.0.1:${address.port}`;
}
function connections(server: Server) {
  return new Promise<number>((resolve, reject) =>
    server.getConnections((error, count) =>
      error ? reject(error) : resolve(count),
    ),
  );
}

it.each(["preconnect", "unfinished-http"] as const)(
  "TEST-SERVER-CLOSE-01 fixture cleanup closes an accepted %s without client cooperation and preserves another listener",
  async (kind) => {
    const application = express();
    application.get("/", (_req, res) => res.send("Independent owned fixture"));
    const server = await listenLoopback(express()),
      other = await listenLoopback(application);
    let client: Socket | undefined,
      accepted: Socket | undefined,
      closing: Promise<void> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(server.address()).toMatchObject({
        address: "127.0.0.1",
        family: "IPv4",
      });
      const connected = once(server, "connection");
      client = createConnection(
        Number(new URL(origin(server)).port),
        "127.0.0.1",
      );
      // Socket errors during forced fixture shutdown are expected, never unhandled.
      client.on("error", () => {});
      [accepted] = (await connected) as [Socket];
      if (kind === "unfinished-http") {
        const received = once(accepted, "data");
        client.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n");
        await received;
      }
      expect(await connections(server)).toBe(1);
      const disconnected = once(client, "close");
      closing = closeLoopback(server);
      const finished = await Promise.race([
        closing.then(() => true),
        new Promise<boolean>((resolve) => {
          deadline = setTimeout(() => resolve(false), 1000);
        }),
      ]);
      expect(
        finished,
        "An accepted browser connection must not hold fixture teardown open",
      ).toBe(true);
      await disconnected;
      expect(server.listening).toBe(false);
      expect(await connections(server)).toBe(0);
      expect(await (await fetch(origin(other))).text()).toBe(
        "Independent owned fixture",
      );
    } finally {
      clearTimeout(deadline);
      client?.destroy();
      accepted?.destroy();
      await (closing ?? closeLoopback(server));
      await closeLoopback(other);
    }
  },
);
