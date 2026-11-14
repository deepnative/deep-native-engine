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
it("ADMINNAV-01/HIDE-01 an administrator's staff page is More tools: the menu, plain grouped links, nothing the menu already has", async () => {
  const f = fixture(true, {
    administratorEntry: {
      status: vi.fn(),
      enter: vi.fn(),
      end: vi.fn(),
    },
    administratorDiagnostics: {
      site: vi.fn(),
      email: vi.fn(),
      work: vi.fn(),
    } as unknown as Parameters<typeof app>[1]["administratorDiagnostics"],
    circleDiscussionEnabled: true,
    circleDiscussion: {} as Parameters<typeof app>[1]["circleDiscussion"],
  });
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
  expect(html).toContain("<title>More tools ·");
  // Roles are off in this fixture, so Roles and History get no menu link.
  expect(main).toContain(
    '<div class="portal-page"><nav class="admin-menu" aria-label="Administration"><a href="/operator">Students</a><a href="/operator/invoices">Invoices</a><a href="/staff" aria-current="page">More</a></nav><h1>More tools</h1>',
  );
  expect(main).not.toContain("eyebrow");
  expect(main).not.toContain("portal-tools");
  expect(main).not.toContain("portal-card");
  expect([...main.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1])).toEqual([
    "Reports",
    "Test and simulation tools",
    "Staff session",
  ]);
  expect(main).toContain(
    '<section class="admin-section"><h2>Reports</h2><ul class="more-tools"><li><a href="/operator/coaching">Coaching hours by month</a></li><li><a href="/operator/invoice-reconciliation">Invoice and cash reconciliation</a></li><li><a href="/operator/diagnostics">Diagnostics</a></li></ul></section>',
  );
  // No second link to what the menu holds, and no circle report pages: an
  // administrator has no per-circle grant, so those would answer 403.
  const tools = main.slice(main.indexOf("<h1>"));
  for (const gone of [
    'href="/operator"',
    'href="/operator/invoices"',
    'href="/operator/roles"',
    'href="/operator/changes"',
    "/moderate/circles/",
    "Administration console",
    "member",
    "learner",
  ])
    expect(tools).not.toContain(gone);
  expect(main).toMatch(
    /<section class="admin-section"><h2>Staff session<\/h2>[\s\S]*action="\/staff\/sign-out"/,
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
it("ADMINNAV-01 More tools groups every tool that is on under plain headings, and says so when none is", async () => {
  const on = {} as never;
  const all = fixture(true, {
    supportRequests: { time: on } as never,
    supportAssignment: on,
    localSupportAssignment: true,
    reviewTimeGrantAdmin: on,
    reviewTimeGrantAdministration: "enabled",
    supportTimeGrantAdmin: on,
    supportTimeGrantAdministration: "enabled",
    sampleAssignments: on,
    sampleAssignmentAdministration: true,
    tracks: on,
    metrics: on,
    ledgerReconciliation: on,
    proposals: on,
    circleGrantAdmin: on,
    eventCancellations: on,
    eventAttendance: on,
    studyUnitFixtures: on,
    localTestUnitIssuance: true,
    eventRehearsals: on,
    workflowReviewStaff: on,
    staffCapacity: on,
    memberRecordAccess: on,
    sampleHoldCancellations: on,
    agreementOutcomes: on,
    manualObservations: on,
  });
  let opened: Server | undefined;
  const page = async (f: ReturnType<typeof fixture>) => {
    f.admit.mockResolvedValue({
      kind: "ready",
      role: "platform_admin",
      deadline: performance.now() + 60000,
      expiresAt: new Date(Date.now() + 60000),
    });
    // One server at a time; afterEach closes the last one.
    if (opened) await closeLoopback(opened);
    opened = server = await listenLoopback(f.application);
    return mainHtml(
      (
        await request(server)
          .get("/staff")
          .set("Host", host)
          .set("Cookie", `dne_staff=${staff}`)
          .expect(200)
      ).text,
    );
  };
  const main = await page(all);
  expect([...main.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1])).toEqual([
    "Reports",
    "Support and reviews",
    "Permissions",
    "Events",
    "Test and simulation tools",
    "Staff session",
  ]);
  for (const [href, label] of [
    ["/operator/course-agreements", "Course agreement outcomes"],
    ["/operator/staff-capacity", "Staff capacity"],
    ["/operator/delivery-cost", "Delivery cost"],
    ["/operator/metrics/report", "Learning and participation snapshot"],
    ["/operator/support", "Your granted support requests"],
    ["/operator/support-assignment", "Support request assignments"],
    ["/operator/sample-assignments/pending", "Pending feedback requests"],
    ["/operator/sample-assignments", "Private sample assignments"],
    ["/operator/workflow-reviews", "Assign private workflow review"],
    ["/moderate/proposals", "Private proposal moderation"],
    [
      "/operator/member-records",
      "Download a student&#39;s records (with their permission)",
    ],
    ["/operator/circle-grants", "Circle moderation grants"],
    ["/moderate/circle-reference", "My moderation reference"],
    ["/operator/review-time-grants", "Private review-minute permissions"],
    ["/operator/support-time-grants", "Private support-minute permissions"],
    ["/operator/event-rehearsals", "Schedule a private rehearsal"],
    ["/operator/event-attendance", "Private rehearsal attendance"],
    ["/operator/event-cancellations", "Event cancellation"],
    ["/operator/support-time", "Your granted support test effort"],
    ["/operator/experts", "Synthetic expert registry"],
    ["/operator/sample-holds", "Staff sample holds"],
    ["/operator/ledger-reconciliation", "Synthetic accounting inspection"],
    ["/operator/study-test-units", "Issue local study test units"],
    ["/operator/local-ai", "Local simulation control"],
    ["/operator/test-receipts", "Synthetic observation register"],
  ])
    expect(main).toContain(`<li><a href="${href}">${label}</a></li>`);
  const bare = await page(
    fixture(false, { localAiControl: undefined, catalog: undefined }),
  );
  expect(bare).toContain(
    "<h1>More tools</h1><p>No other tools are switched on for this site.</p>",
  );
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
