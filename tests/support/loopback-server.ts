import { once } from "node:events";
import type { Server } from "node:http";
import type { app } from "../../src/app.ts";

export async function listenLoopback(
  application: ReturnType<typeof app>,
): Promise<Server> {
  const server = application.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

export async function closeLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function withLoopback<T>(
  application: ReturnType<typeof app>,
  run: (server: Server) => PromiseLike<T>,
): Promise<T> {
  const server = await listenLoopback(application);
  try {
    return await run(server);
  } finally {
    await closeLoopback(server);
  }
}
