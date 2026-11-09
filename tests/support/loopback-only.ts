import { Server } from "node:net";

// A test server bound to the wildcard address can share its port number with
// another process's 127.0.0.1 listener on macOS. Supertest targets 127.0.0.1,
// so that request reaches the other process (#105, #176). Bare request(app)
// binds this way, and aliased forms keep slipping past searches (#584, #615,
// #702), so every Vitest worker refuses the bind itself.
const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0"]);

function bindsWildcard(args: unknown[]): boolean {
  const [first, second] = args;
  if (typeof first === "object" && first !== null) {
    const options = first as { path?: unknown; port?: unknown; host?: unknown };
    if (options.path !== undefined) return false;
    if ("fd" in options || "_handle" in options) return false;
    return typeof options.host !== "string" || WILDCARD_HOSTS.has(options.host);
  }
  // listen(path) is a local socket; only a numeric port reaches TCP.
  if (typeof first === "string" && !/^\d+$/u.test(first)) return false;
  return typeof second !== "string" || WILDCARD_HOSTS.has(second);
}

const original = Server.prototype.listen as (...args: unknown[]) => Server;
const guard = Symbol.for("dne.loopbackOnlyListen");
const state = Server.prototype as unknown as Record<symbol, unknown>;
if (!state[guard]) {
  state[guard] = true;
  Server.prototype.listen = function listen(this: Server, ...args: unknown[]) {
    if (bindsWildcard(args))
      throw new Error(
        "Test servers must bind 127.0.0.1: use listenLoopback or withLoopback from tests/support/loopback-server.ts, not bare request(app) or listen(port).",
      );
    return original.apply(this, args);
  } as typeof Server.prototype.listen;
}
