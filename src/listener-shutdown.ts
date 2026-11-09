import type { Server, ServerResponse as Response } from "node:http";
import type { Socket } from "node:net";

/**
 * Tracks connections that are not handling a request.
 *
 * On Node 24, `server.close()` closes keep-alive connections that are idle
 * between requests, but a connection that never sent a request (a browser's
 * speculative preconnect) or is sending only part of one keeps the close pending.
 * `close()` also stops the header-timeout checks, so nothing ends it. The
 * returned function destroys only those connections. Requests already being
 * handled are untouched and finish normally.
 */
export function unstartedConnections(server: Server): () => void {
  const open = new Set<Socket>(),
    busy = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
  });
  server.on("request", (request: { socket: Socket }, response: Response) => {
    const socket = request.socket;
    busy.add(socket);
    // Between keep-alive requests the connection can start another request.
    response.once("close", () => busy.delete(socket));
  });
  return () => {
    for (const socket of open) if (!busy.has(socket)) socket.destroy();
  };
}
