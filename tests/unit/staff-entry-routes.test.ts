import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import { disabledCatalogStore } from "../../src/catalog.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
const origin = "http://127.0.0.1:3000",
  host = "127.0.0.1:3000",
  secret = "invented-staff-test";
const learner = "a".repeat(64),
  staff = "b".repeat(64);
let server: Server;
afterEach(async () => {
  if (server) await closeLoopback(server);
});
function fixture() {
  const create = vi.fn(),
    session = vi.fn().mockResolvedValue({ kind: "missing" });
  const staffList = vi.fn().mockResolvedValue([]);
  const admit = vi.fn().mockResolvedValue({
    kind: "ready",
    role: "operator",
    deadline: performance.now() + 60000,
    expiresAt: new Date(Date.now() + 60000),
  });
  const set = vi.fn().mockResolvedValue(true);
  const options = {
    origin,
    secret,
    localStaffEntry: true,
    staffEntry: { admit },
    catalog: { ...disabledCatalogStore(), staffList },
    localAiControl: {
      current: vi.fn().mockResolvedValue("enabled"),
      read: vi.fn().mockResolvedValue({ paused: false }),
      set,
    },
  };
  return {
    application: app({ create, session } as unknown as Store, options),
    create,
    session,
    staffList,
    admit,
    set,
  };
}
it("STAFF-01-ENTRY opens a secret staff form and independent nonce without a learner account", async () => {
  const f = fixture();
  server = await listenLoopback(f.application);
  const r = await request(server)
    .get("/staff/sign-in")
    .set("Host", host)
    .expect(200);
  expect(r.text).toContain('type="password"');
  expect(r.text).toContain('name="credential"');
  expect(r.text).toMatch(/name="csrf" value="[a-f0-9]{64}"/);
  expect((r.headers["set-cookie"] as unknown as string[]).join(" ")).toContain(
    "dne_staff_entry=",
  );
  expect(
    (r.headers["set-cookie"] as unknown as string[]).join(" "),
  ).not.toContain(COOKIE + "=");
  expect(f.create).not.toHaveBeenCalled();
  expect(f.session).not.toHaveBeenCalled();
});
it("STAFF-04-SIGNOUT signed-out state denies actual uppercase trailing-slash staff aliases without legacy fallback", async () => {
  const f = fixture();
  server = await listenLoopback(f.application);
  await request(server)
    .get("/EDITOR/library/")
    .set("Host", host)
    .set("Cookie", `${COOKIE}=${staff}; dne_staff=signed-out`)
    .expect(403);
  expect(f.staffList).not.toHaveBeenCalled();
});
it("STAFF-01-COEXIST staff mutation selects staff CSRF while preserving the learner token", async () => {
  const f = fixture();
  server = await listenLoopback(f.application);
  const cookie = `${COOKIE}=${learner}; dne_staff=${staff}`;
  await request(server)
    .post("/OPERATOR/local-ai/")
    .set("Host", host)
    .set("Origin", origin)
    .set("Cookie", cookie)
    .type("form")
    .send({ csrf: csrf(staff, secret), state: "paused", confirm: "yes" })
    .expect(303);
  expect(f.set).toHaveBeenCalledWith(staff, true);
  await request(server)
    .post("/operator/local-ai")
    .set("Host", host)
    .set("Origin", origin)
    .set("Cookie", cookie)
    .type("form")
    .send({ csrf: csrf(learner, secret), state: "paused", confirm: "yes" })
    .expect(403);
});
