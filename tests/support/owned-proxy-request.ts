import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

export const OWNED_PROXY_IDLE_MS = 4_000;
export const OWNED_PROXY_TEST_MS = 30_000;

export class OwnedProxyStall extends Error {}

export interface OwnedProxyResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: () => Promise<string>;
}
export interface OwnedProxyOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function attempt(
  url: string,
  options: OwnedProxyOptions,
  idleMs: number,
): Promise<OwnedProxyResponse> {
  return new Promise((resolve, reject) => {
    let connected = false,
      responded = false;
    // Each probe is an independent real HTTP request, not a pooled socket
    // that nginx may close while an old worker drains during reload.
    const request = httpRequest(
      url,
      { ...options, agent: false },
      (response) => {
        responded = true;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            text: async () => Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("socket", (socket) => {
      socket.once("connect", () => {
        connected = true;
      });
    });
    request.on("error", reject);
    request.setTimeout(idleMs, () =>
      request.destroy(
        new OwnedProxyStall(
          `Owned proxy request stalled for ${idleMs} ms: connected=${connected} responded=${responded}.`,
        ),
      ),
    );
    request.end(options.body);
  });
}

/**
 * #650: an idle stall in the local Docker connection path is retried once on a
 * new connection and reported. Any answer from the proxy, a refused connection
 * or a second stall is returned or thrown unchanged, so a proxy that really
 * hangs still fails with the socket state instead of a bare test timeout.
 */
export async function ownedProxyRequest(
  url: string,
  options: OwnedProxyOptions = {},
  idleMs = OWNED_PROXY_IDLE_MS,
): Promise<OwnedProxyResponse> {
  try {
    return await attempt(url, options, idleMs);
  } catch (error) {
    if (!(error instanceof OwnedProxyStall)) throw error;
    console.warn(`${error.message} Retrying once on a new connection.`);
    return attempt(url, options, idleMs);
  }
}
