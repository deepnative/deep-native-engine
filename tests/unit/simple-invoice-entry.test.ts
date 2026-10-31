import { expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";

it("OFFPUR-01/07 a signed-in learner can open the native purchase entry without a finance-provider account", async () => {
  const store = {
    session: vi.fn().mockResolvedValue({
      kind: "active",
      expiresAt: new Date(Date.now() + 60_000),
      learner: {
        id: "11111111-1111-4111-8111-111111111111",
        background: "explorer",
        goal: "everyday",
      },
    }),
  } as unknown as Store;
  const server = await listenLoopback(
    app(store, {
      origin: "http://127.0.0.1:3000",
      secret: "test",
      mode: "test",
    }),
  );
  try {
    const response = await request(server)
      .get("/account/purchases")
      .set("Host", "127.0.0.1:3000");
    expect(response.status).toBe(200);
    expect(response.text).toContain("Courses and invoices");
    expect(response.text).toContain("No payable offer is configured");
    expect(response.text).not.toContain("Zoho");
  } finally {
    await closeLoopback(server);
  }
});
