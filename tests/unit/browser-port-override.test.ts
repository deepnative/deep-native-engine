import { readdirSync, readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

// #176: a focused browser run must be able to use its own loopback port, so
// it can't collide with a gate's server on 4317. The default stays 4317.
const configs = [
  "../../playwright.full.config.ts",
  "../../playwright.provisional.config.ts",
  "../../playwright.cross-browser.config.ts",
] as const;
type Loaded = {
  use?: { baseURL?: string };
  webServer?: { url?: string; env?: Record<string, string> };
};
async function load(path: string, origin?: string) {
  vi.resetModules();
  if (origin === undefined) vi.stubEnv("DNE_E2E_ORIGIN", undefined as never);
  else vi.stubEnv("DNE_E2E_ORIGIN", origin);
  return ((await import(path)) as { default: Loaded }).default;
}
afterEach(() => {
  vi.unstubAllEnvs();
});

it.each(configs)(
  "PORT-01 %s serves and browses the overridden loopback origin",
  async (path) => {
    const config = await load(path, "http://127.0.0.1:4399");
    expect(config.use?.baseURL).toBe("http://127.0.0.1:4399");
    expect(config.webServer?.url).toBe("http://127.0.0.1:4399");
    expect(config.webServer?.env?.DNE_PORT).toBe("4399");
  },
);
it.each(configs)("PORT-02 %s keeps 4317 by default", async (path) => {
  const config = await load(path);
  expect(config.use?.baseURL).toBe("http://127.0.0.1:4317");
  expect(config.webServer?.url).toBe("http://127.0.0.1:4317");
  expect(config.webServer?.env?.DNE_PORT).toBe("4317");
});
it("PORT-03 no full-MVP spec hard-codes the default port", () => {
  const directory = new URL("../full-e2e/", import.meta.url);
  const pinned = readdirSync(directory).filter((file) =>
    /127\.0\.0\.1:4317/.test(readFileSync(new URL(file, directory), "utf8")),
  );
  expect(pinned).toEqual([]);
});
