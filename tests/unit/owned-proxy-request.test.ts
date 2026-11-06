import { createServer, type Server, type Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import {
  ownedProxyRequest,
  OwnedProxyStall,
} from "../support/owned-proxy-request.ts";

const OK =
  "HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno";
let server: Server | undefined;
const sockets: Socket[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  sockets.splice(0).forEach((socket) => socket.destroy());
  await new Promise((done) => (server ? server.close(done) : done(undefined)));
  server = undefined;
});
async function listen(answerFrom: number) {
  let connections = 0;
  server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    if (++connections >= answerFrom) socket.once("data", () => socket.end(OK));
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No address");
  return { url: `http://127.0.0.1:${address.port}`, count: () => connections };
}

it("HOSTED-STALL-01 recovers from one stalled connection on a new connection and reports it", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const proxy = await listen(2);
  const response = await ownedProxyRequest(
    proxy.url,
    { method: "POST", body: "invented-form" },
    50,
  );
  expect(response.status).toBe(403);
  expect(proxy.count()).toBe(2);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]![0]).toContain("connected=true responded=false");
});

it("HOSTED-STALL-02 a proxy that keeps hanging still fails, with its socket state", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const proxy = await listen(Number.POSITIVE_INFINITY);
  const failure = await ownedProxyRequest(proxy.url, {}, 50).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(OwnedProxyStall);
  expect(String(failure)).toContain("connected=true responded=false");
  expect(proxy.count()).toBe(2);
});

it("HOSTED-STALL-03 an answer on the first connection is never retried", async () => {
  const warn = vi.spyOn(console, "warn");
  const proxy = await listen(1);
  const response = await ownedProxyRequest(proxy.url, {}, 1000);
  expect(await response.text()).toBe("no");
  expect(proxy.count()).toBe(1);
  expect(warn).not.toHaveBeenCalled();
});

it("HOSTED-STALL-04 a refused connection is not treated as a stall", async () => {
  const warn = vi.spyOn(console, "warn");
  // A reserved port: a just-closed one can be taken by a parallel test's server.
  await expect(
    ownedProxyRequest("http://127.0.0.1:1/", {}, 1000),
  ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  expect(warn).not.toHaveBeenCalled();
});
