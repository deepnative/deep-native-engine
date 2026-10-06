import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import { STAFF_ROLES } from "../../src/authorization.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";

let server: Server;
afterEach(async () => {
  if (server) await closeLoopback(server);
});
it.each(STAFF_ROLES)(
  "REVADM-01/06 exposes only the current %s assignment navigation without reading private samples",
  async (role) => {
    const sampleAssignments = {
      open: vi.fn(),
      selfReference: vi.fn(),
      check: vi.fn(),
      assign: vi.fn(),
      history: vi.fn(),
      recover: vi.fn(),
      revoke: vi.fn(),
    };
    const options = {
      origin: "http://127.0.0.1:3000",
      secret: "invented-portal-secret",
      localStaffEntry: true,
      sampleAssignmentAdministration: true,
      sampleAssignments,
      staffEntry: {
        admit: vi.fn(async () => ({
          kind: "ready" as const,
          role,
          deadline: performance.now() + 60000,
        })),
      },
    };
    server = await listenLoopback(app({} as Store, options));
    const read = () =>
      request(server)
        .get("/staff")
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `dne_staff=${"a".repeat(64)}`);
    const visible = await read().expect(200);
    expect(visible.text.includes('href="/operator/sample-assignments"')).toBe(
      role === "platform_admin",
    );
    expect(
      visible.text.includes('href="/review/sample-assignment-reference"'),
    ).toBe(role === "reviewer");
    for (const method of Object.values(sampleAssignments))
      expect(method).not.toHaveBeenCalled();
    await closeLoopback(server);
    server = await listenLoopback(
      app({} as Store, { ...options, sampleAssignmentAdministration: false }),
    );
    const disabled = await read().expect(200);
    expect(disabled.text).not.toMatch(
      /href="\/(?:operator\/sample-assignments|review\/sample-assignment-reference)"/,
    );
  },
);
