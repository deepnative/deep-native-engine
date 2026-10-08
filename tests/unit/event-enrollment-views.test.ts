import { expect, it } from "vitest";
import {
  eventEnrollmentPage,
  eventEnrollmentReceiptPage,
  eventEnrollmentHistoryPage,
  eventEnrollmentRecovery,
} from "../../src/event-enrollment-views.ts";
import type {
  EventEnrollmentReceipt,
  EventEnrollmentPreview,
} from "../../src/event-enrollments.ts";
const receipt: EventEnrollmentReceipt = {
  id: "00000000-0000-4000-8000-000000000001",
  eventId: "local-rehearsal",
  eventVersion: 2,
  title: '<script>alert("invented")</script>',
  startsAt: new Date("2030-11-03T05:30:00.000Z"),
  endsAt: new Date("2030-11-03T06:30:00.000Z"),
  createdAt: new Date("2030-10-01T12:00:00.000Z"),
  withdrawnAt: null,
  cancelledAt: null,
};
const preview: EventEnrollmentPreview = {
  event: {
    id: receipt.eventId,
    version: 2,
    title: receipt.title,
    description: "Invented",
    agenda: [],
    goals: ["everyday"],
    domainTags: [],
    itRoles: [],
    status: "current",
    startsAt: receipt.startsAt.toISOString(),
    endsAt: receipt.endsAt.toISOString(),
    fixtureCapacity: 1,
    localRegistration: true,
  },
  canEnroll: true,
  remaining: 1,
  activeReceiptId: null,
  cancelledAt: null,
};
it("ATTEND-03 private receipt links to its exact owning attendance when the runtime supplies that capability", () => {
  expect(
    eventEnrollmentReceiptPage(receipt, "csrf", "America/Toronto", true),
  ).toContain(`href="/events/registrations/${receipt.id}/attendance"`);
  expect(
    eventEnrollmentReceiptPage(receipt, "csrf", "America/Toronto", false),
  ).not.toContain("My private attendance receipt");
});
it("requires deliberate invented-data enrollment and escapes text and hidden values", () => {
  const html = eventEnrollmentPage(
    preview,
    'csrf"<',
    receipt.id,
    "America/Toronto",
  );
  expect(html).toContain("not a real appointment");
  expect(html).toContain('name="synthetic" value="yes" required');
  expect(html).toContain('name="operation_id"');
  expect(html).toContain("Exact version 2");
  expect(html).toContain("America/Toronto");
  expect(html).toContain("2030-11-03T05:30:00.000Z");
  expect(html).toContain("2030-11-03T06:30:00.000Z");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain(receipt.title);
  expect(html).not.toContain('value="csrf"<');
});
it("offers only own receipt when registered and no enrollment button for full or paused events", () => {
  const active = eventEnrollmentPage(
    { ...preview, activeReceiptId: receipt.id },
    "csrf",
    "new",
  );
  expect(active).toContain(`/events/registrations/${receipt.id}`);
  expect(active).not.toContain('action="/events/local-rehearsal/2/enroll"');
  for (const [state, message] of [
    [{ ...preview, remaining: 0 }, "This local rehearsal is full."],
    [
      { ...preview, canEnroll: false, remaining: null },
      "New local registrations are unavailable.",
    ],
  ] as const) {
    const html = eventEnrollmentPage(state, "csrf", "new");
    expect(html).toContain(message);
    expect(html).not.toContain("Enroll in local rehearsal</button>");
    expect(html).toContain("Set your time zone");
  }
});
it("withdrawal targets the exact attempt and withdrawn receipts cannot reactivate it", () => {
  const active = eventEnrollmentReceiptPage(receipt, "csrf");
  expect(active).toContain(
    `action="/events/registrations/${receipt.id}/withdraw"`,
  );
  expect(active).toContain('name="confirm" value="yes" required');
  expect(active).toContain("Download private preview records");
  const withdrawn = eventEnrollmentReceiptPage(
    { ...receipt, withdrawnAt: new Date("2030-10-02T12:00:00.000Z") },
    "csrf",
    "America/Toronto",
  );
  expect(withdrawn).toContain("This attempt cannot be reactivated");
  expect(withdrawn).toContain("Withdrawn 2030-10-02T12:00:00.000Z");
  expect(withdrawn).not.toContain("Withdraw registration</button>");
});
it("renders bounded history navigation and escaped uncertainty without automatic retry", () => {
  expect(eventEnrollmentHistoryPage({ items: [], nextCursor: null })).toContain(
    "No sample registrations are saved",
  );
  const html = eventEnrollmentHistoryPage({
    items: [receipt, { ...receipt, withdrawnAt: new Date() }],
    nextCursor: receipt.id,
  });
  expect(html).toContain(`?after=${receipt.id}`);
  expect(html).toContain("version 2 · registered");
  expect(html).toContain("version 2 · withdrawn");
  expect(html).not.toContain(receipt.title);
  const recovery = eventEnrollmentRecovery(
    "<script>unknown</script>",
    receipt.id,
  );
  expect(recovery).toContain("&lt;script&gt;unknown&lt;/script&gt;");
  expect(recovery).toContain("Check this registration attempt");
  expect(recovery).toContain("No automatic retry occurs");
  expect(eventEnrollmentRecovery("Unknown outcome")).not.toContain(
    "Check this registration attempt",
  );
});

it("shows event cancellation separately from withdrawal and offers no new registration", () => {
  const cancelledAt = new Date("2029-10-01T12:00:00.000Z");
  const saved = { ...receipt, cancelledAt };
  const html = eventEnrollmentReceiptPage(saved, "csrf");
  expect(html).toContain("Event cancelled");
  expect(html).toContain(cancelledAt.toISOString());
  expect(html).toContain("Withdraw registration");
  expect(html).not.toContain("Check this version for a new registration");
  const history = eventEnrollmentHistoryPage({
    items: [saved],
    nextCursor: null,
  });
  expect(history).toContain("event cancelled");
  const rehearsal = eventEnrollmentPage(
    { ...preview, cancelledAt, canEnroll: false, remaining: null },
    "csrf",
    "new",
  );
  expect(rehearsal).toContain("Event cancelled");
  expect(rehearsal).not.toContain("Enroll in local rehearsal");
  const withdrawn = eventEnrollmentReceiptPage(
    { ...saved, withdrawnAt: new Date("2029-10-02") },
    "csrf",
  );
  expect(withdrawn).toContain("Registration withdrawn");
  expect(withdrawn).toContain("Event cancelled");
});
