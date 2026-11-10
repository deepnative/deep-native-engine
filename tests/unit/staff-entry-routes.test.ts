import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import { disabledCatalogStore } from "../../src/catalog.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { expectPortalActions, mainHtml } from "../support/portal-layout.ts";
const origin = "http://127.0.0.1:3000",
  host = "127.0.0.1:3000",
  secret = "invented-staff-test";
const learner = "a".repeat(64),
  staff = "b".repeat(64);
let server: Server;
afterEach(async () => {
  if (server) await closeLoopback(server);
});
function fixture(
  invoices = false,
  extra: Partial<Parameters<typeof app>[1]> = {},
) {
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
    simpleInvoices: invoices
      ? ({} as import("../../src/simple-invoice-store.ts").SimpleInvoiceStore)
      : undefined,
    localStaffEntry: true,
    staffEntry: { admit },
    catalog: { ...disabledCatalogStore(), staffList },
    localAiControl: {
      current: vi.fn().mockResolvedValue("enabled"),
      read: vi.fn().mockResolvedValue({ paused: false }),
      set,
    },
    ...extra,
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

it("OFFPUR-05 exposes configured billing tools only to the current platform administrator", async () => {
  const f = fixture(true);
  server = await listenLoopback(f.application);
  const get = () =>
    request(server)
      .get("/staff")
      .set("Host", host)
      .set("Cookie", `dne_staff=${staff}`);
  expect((await get()).text).not.toContain('href="/operator/invoices"');
  f.admit.mockResolvedValue({
    kind: "ready",
    role: "platform_admin",
    deadline: performance.now() + 60000,
    expiresAt: new Date(Date.now() + 60000),
  });
  expect((await get()).text).toContain('href="/operator/invoices"');
});
it("ADMIN-LAYOUT-01 staff tools render as a titled button list with grouped session actions", async () => {
  const f = fixture(true);
  f.admit.mockResolvedValue({
    kind: "ready",
    role: "platform_admin",
    deadline: performance.now() + 60000,
    expiresAt: new Date(Date.now() + 60000),
  });
  server = await listenLoopback(f.application);
  const html = (
    await request(server)
      .get("/staff")
      .set("Host", host)
      .set("Cookie", `dne_staff=${staff}`)
  ).text;
  const main = mainHtml(html);
  expect(main).toContain('<div class="portal-page">');
  expect(main).toContain(
    '<li><a href="/operator/invoices" class="button secondary">Course billing and invoices</a></li>',
  );
  expect(main).toMatch(/<ul class="portal-tools">/);
  expect(main).toMatch(
    /<section class="portal-card"><h2>Staff session<\/h2>[\s\S]*action="\/staff\/sign-out"/,
  );
  expectPortalActions(html, [
    ["/learn", "Your learning space"],
    ["/staff/sign-in", "Use another staff credential"],
  ]);
  const denied = (await request(server).get("/staff").set("Host", host)).text;
  expectPortalActions(denied, [
    ["/staff/sign-in", "Open staff sign-in"],
    ["/learn", "Your learning space"],
  ]);
});

it("HOLDCANCEL-NAV-01/02 links Staff sample holds for operators and administrators only", async () => {
  const holds = { list: vi.fn(), cancel: vi.fn() };
  const link = 'href="/operator/sample-holds"';
  let opened: Server | undefined;
  const open = async (
    role: string,
    extra: Partial<Parameters<typeof app>[1]>,
  ) => {
    const f = fixture(false, extra);
    f.admit.mockResolvedValue({
      kind: "ready",
      role,
      deadline: performance.now() + 60000,
      expiresAt: new Date(Date.now() + 60000),
    });
    // One server at a time; afterEach closes the last one.
    if (opened) await closeLoopback(opened);
    opened = server = await listenLoopback(f.application);
    return (
      await request(server)
        .get("/staff")
        .set("Host", host)
        .set("Cookie", `dne_staff=${staff}`)
        .expect(200)
    ).text;
  };
  for (const role of ["operator", "platform_admin"]) {
    const html = await open(role, { sampleHoldCancellations: holds });
    expect(html).toContain(link);
    expect(html).toContain(">Staff sample holds</a>");
    // Not configured here: no link to a page that can only refuse.
    expect(await open(role, {})).not.toContain(link);
  }
  for (const role of ["coach", "reviewer", "moderator", "editor"])
    expect(await open(role, { sampleHoldCancellations: holds })).not.toContain(
      link,
    );
});
