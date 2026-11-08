import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { unstartedConnections } from "../../src/listener-shutdown.ts";

// L189 hung for 57.5s at an in-test runtime restart. On Node 24 a connection
// that has not sent a full request keeps server.close() pending with no
// timeout, which is what a browser's speculative preconnect looks like.

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.closeAllConnections();
});

async function listening(
  handler: Parameters<typeof createServer>[1] = (_req, res) => res.end("ok"),
) {
  const server = createServer(handler);
  servers.push(server);
  const closeUnstarted = unstartedConnections(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const socket = async (data?: string) => {
    const client = connect(port, "127.0.0.1");
    await once(client, "connect");
    if (data !== undefined) client.write(data);
    return client;
  };
  const close = () =>
    new Promise<number>((resolve, reject) => {
      const started = Date.now();
      server.close((error) =>
        error ? reject(error) : resolve(Date.now() - started),
      );
      closeUnstarted();
    });
  return { server, socket, close };
}

const settled = (client: Socket) =>
  client.destroyed ? Promise.resolve() : once(client, "close");
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

it("SHUTDOWN-01: a connection that never sent a request no longer holds close open", async () => {
  const { socket, close } = await listening();
  const preconnect = await socket();
  await settle();
  expect(await close()).toBeLessThan(1000);
  await settled(preconnect);
});

it("SHUTDOWN-02: a connection with only part of a request no longer holds close open", async () => {
  const { socket, close } = await listening();
  const partial = await socket("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n");
  await settle();
  expect(await close()).toBeLessThan(1000);
  await settled(partial);
});

it("SHUTDOWN-03: a request already being handled still gets its whole response", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { socket, close } = await listening((_req, res) => {
    void gate.then(() => res.end("finished"));
  });
  const client = await socket(
    "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
  );
  let received = "";
  client.on("data", (chunk: Buffer) => (received += chunk.toString()));
  await settle();
  const closing = close();
  release();
  await settled(client);
  expect(received).toMatch(/^HTTP\/1\.1 200/);
  expect(received).toContain("finished");
  expect(await closing).toBeLessThan(1000);
});

it("SHUTDOWN-04: a keep-alive connection between requests is closed and later sockets are tracked", async () => {
  const { socket, close } = await listening();
  const kept = await socket("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  await once(kept, "data");
  const gone = await socket();
  gone.destroy();
  await settle();
  expect(await close()).toBeLessThan(1000);
  await settled(kept);
});

it("SHUTDOWN-05: a connection dropped before its response finishes is not tracked again", async () => {
  const { socket, close } = await listening((req, res) => {
    req.socket.destroy();
    res.end("late");
  });
  const dropped = await socket("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  await settled(dropped);
  await settle();
  expect(await close()).toBeLessThan(1000);
});
