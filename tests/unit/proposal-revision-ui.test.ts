import { expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import {
  disabledProposalStore,
  type OwnerProposal,
  type ProposalStore,
} from "../../src/proposals.ts";
import {
  proposalPreviewPage,
  proposalListPage,
  moderationPage,
  proposalChangesRecoveryPage,
  proposalSubmissionRecoveryPage,
} from "../../src/views.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
const id = "11111111-1111-4111-8111-111111111111",
  token = "a".repeat(64),
  origin = "http://127.0.0.1:3000",
  secret = "synthetic",
  date = new Date("2026-10-02T12:00:00Z");
const returned: OwnerProposal = {
  id,
  title: "Invented title",
  body: "Sample body",
  sources: "Original source",
  state: "changes_requested",
  revision: 1,
  createdAt: date,
  submittedAt: date,
  feedback: {
    text: "  Private <feedback>\n",
    reviewedRevision: 1,
    requestedAt: date,
  },
  rightsAttestedRevision: null,
  rightsAttestedAt: null,
};
function fixture() {
  const session = vi.fn<Store["session"]>().mockResolvedValue({
    kind: "active",
    learner: { id: "owned", background: "explorer", goal: "everyday" },
  });
  const proposals = {
    ...disabledProposalStore(),
    requestChanges: vi
      .fn<ProposalStore["requestChanges"]>()
      .mockResolvedValue("requested"),
    preview: vi.fn<ProposalStore["preview"]>().mockResolvedValue(returned),
    editDraft: vi.fn<ProposalStore["editDraft"]>().mockResolvedValue("saved"),
    submit: vi.fn<ProposalStore["submit"]>().mockResolvedValue("submitted"),
    createDraft: vi.fn<ProposalStore["createDraft"]>().mockResolvedValue(id),
    withdraw: vi.fn<ProposalStore["withdraw"]>().mockResolvedValue(true),
  };
  const application = app({ session } as unknown as Store, {
    origin,
    secret,
    proposals,
  });
  const post = (path: string, body: Record<string, unknown> = {}) =>
    withLoopback(application, (server) =>
      request(server)
        .post(path)
        .set("Host", "127.0.0.1:3000")
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${token}`)
        .type("form")
        .send({ csrf: csrf(token, secret), ...body }),
    );
  return { session, proposals, application, post };
}
const form = {
    revision: "1",
    feedback: "  Private <feedback>\n",
    confirm: "yes",
  },
  action = `/moderate/proposals/${id}/request-changes`;
it.each(["requested", "replayed"] as const)(
  "acknowledges %s exact feedback through the actual app without member middleware",
  async (outcome) => {
    const f = fixture();
    f.proposals.requestChanges.mockResolvedValue(outcome);
    const response = await f.post(action, form);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/moderate/proposals");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(f.proposals.requestChanges).toHaveBeenCalledExactlyOnceWith(
      token,
      id,
      { expectedRevision: 1, feedback: form.feedback },
    );
    expect(f.session).not.toHaveBeenCalled();
  },
);
it.each([
  ["missing confirmation", { ...form, confirm: undefined }],
  ["missing feedback", { ...form, feedback: undefined }],
  ["duplicate feedback", { ...form, feedback: ["a", "b"] }],
  ["blank feedback", { ...form, feedback: " \n" }],
  ["overlong feedback", { ...form, feedback: "a".repeat(1001) }],
  ["NUL", { ...form, feedback: "a\0" }],
  ["missing revision", { ...form, revision: undefined }],
  ["noninteger revision", { ...form, revision: "1.1" }],
  ["overflow revision", { ...form, revision: "2147483648" }],
  ["forged role", { ...form, role: "moderator" }],
  ["forged feedback revision", { ...form, reviewedRevision: "1" }],
] as const)("rejects %s before the decision store", async (_name, body) => {
  const f = fixture(),
    response = await f.post(action, body);
  expect(response.status).toBe(422);
  expect(f.proposals.requestChanges).not.toHaveBeenCalled();
  expect(response.text).not.toContain("<feedback>");
  expect(response.text).not.toContain("<form");
});
it("rejects query-forged scope and bodyless requests", async () => {
  const f = fixture();
  expect((await f.post(action + "?actor=forged", form)).status).toBe(422);
  const response = await withLoopback(f.application, (server) =>
    request(server)
      .post(action)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .set("x-csrf-token", csrf(token, secret)),
  );
  expect(response.status).toBe(422);
  expect(f.proposals.requestChanges).not.toHaveBeenCalled();
});
it.each([
  ["invalid", 422],
  ["conflict", 409],
  ["denied", 403],
] as const)(
  "handles %s without saved text or any automatic retry",
  async (outcome, status) => {
    const f = fixture();
    f.proposals.requestChanges.mockResolvedValue(outcome);
    const response = await f.post(action, form);
    expect(response.status).toBe(status);
    expect(response.text).not.toContain("<feedback>");
    expect(f.proposals.requestChanges).toHaveBeenCalledTimes(1);
    if (outcome === "denied")
      expect(response.text).not.toContain("Private &lt;feedback&gt;");
  },
);
it("preserves escaped attempted feedback after uncertain storage or stale CSRF without claiming success", async () => {
  const f = fixture();
  f.proposals.requestChanges.mockRejectedValue(
    new Error("PRIVATE SQL actor credential"),
  );
  const response = await f.post(action, form);
  expect(response.status).toBe(503);
  expect(response.text).toContain("Change request outcome unknown");
  expect(response.text).toContain("Private &lt;feedback&gt;");
  expect(response.text).not.toContain("PRIVATE SQL");
  expect(f.proposals.requestChanges).toHaveBeenCalledTimes(1);
  const stale = await f.post(action, { ...form, csrf: "bad" });
  expect(stale.status).toBe(403);
  expect(stale.text).toContain("Private &lt;feedback&gt;");
  expect(f.proposals.requestChanges).toHaveBeenCalledTimes(1);
});
it("never echoes attempted feedback to a foreign Origin", async () => {
  const f = fixture(),
    response = await withLoopback(f.application, (server) =>
      request(server)
        .post(action)
        .set("Host", "127.0.0.1:3000")
        .set("Origin", "https://foreign.invalid")
        .set("Cookie", `${COOKIE}=${token}`)
        .type("form")
        .send({ ...form, csrf: csrf(token, secret) }),
    );
  expect(response.status).toBe(403);
  expect(response.text).not.toContain("Private &lt;feedback&gt;");
  expect(f.proposals.requestChanges).not.toHaveBeenCalled();
});
it.each(["submitted", "replayed"] as const)(
  "accepts a %s result for freshly affirmed exact owner revision",
  async (result) => {
    const f = fixture();
    f.proposals.submit.mockResolvedValue(result);
    const response = await f.post(`/contribute/${id}/submit`, {
      revision: "2",
      rights_confirmed: "yes",
    });
    expect(response.status).toBe(303);
    expect(f.proposals.submit).toHaveBeenCalledExactlyOnceWith(
      token,
      id,
      true,
      2,
    );
  },
);
it("reports uncertain submission without a new checked rights form or automatic replay", async () => {
  const f = fixture();
  f.proposals.submit.mockRejectedValue(new Error("private SQL"));
  const response = await f.post(`/contribute/${id}/submit`, {
    revision: "2",
    rights_confirmed: "yes",
  });
  expect(response.status).toBe(503);
  expect(response.text).toContain("Proposal submission outcome unknown");
  expect(response.text).toContain("Nothing is retried automatically");
  expect(response.text).not.toContain("private SQL");
  expect(response.text).not.toContain("<form");
  expect(f.proposals.submit).toHaveBeenCalledTimes(1);
});
it("bounds encoded contribution forms independently of the unchanged global parser", async () => {
  const f = fixture(),
    text = {
      title: "汉".repeat(160),
      body: "汉".repeat(4000),
      sources: "汉".repeat(1000),
    };
  expect(
    (await f.post("/contribute", { ...text, sample_confirmed: "yes" })).status,
  ).toBe(303);
  expect(f.proposals.createDraft).toHaveBeenCalledWith(
    token,
    text,
    true,
    undefined,
  );
  expect(
    (await f.post(`/contribute/${id}/edit`, { ...text, revision: "1" })).status,
  ).toBe(303);
  expect(f.proposals.editDraft).toHaveBeenCalledWith(token, id, text, 1);
  expect(
    (await f.post(action, { ...form, feedback: "汉".repeat(2000) })).status,
  ).toBe(413);
  expect(
    (await f.post("/contribute", { body: "x".repeat(65536) })).status,
  ).toBe(413);
});
it.each([
  "/contribute",
  `/contribute/${id}/edit`,
  `/contribute/${id}/submit`,
  `/contribute/${id}/withdraw`,
])("rejects query and forged fields on %s", async (path) => {
  const f = fixture();
  const body = {
    title: "Sample",
    body: "Sample",
    sources: "Original",
    revision: "1",
    confirm: "yes",
    rights_confirmed: "yes",
    sample_confirmed: "yes",
  };
  expect(
    (await f.post(path + "?member=forged", body)).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (await f.post(path, { actor: "forged" })).status,
  ).toBeGreaterThanOrEqual(400);
  for (const method of [
    f.proposals.createDraft,
    f.proposals.editDraft,
    f.proposals.submit,
    f.proposals.withdraw,
  ])
    expect(method).not.toHaveBeenCalled();
});
it("rejects invalid correction text before calling the owner store", async () => {
  const f = fixture();
  expect(
    (
      await f.post(`/contribute/${id}/edit`, {
        title: "Sample",
        body: "NUL\0",
        sources: "Original",
        revision: "1",
      })
    ).status,
  ).toBe(422);
  expect(f.proposals.editDraft).not.toHaveBeenCalled();
});
it("shows requested changes only in owner preview and requires an edit before fresh rights", () => {
  const html = proposalPreviewPage(returned, "csrf");
  expect(html).toContain("CHANGES REQUESTED");
  expect(html).toContain("Private &lt;feedback&gt;");
  expect(html).toContain("feedback on revision 1");
  expect(html).toContain("Save a correction after the reviewed revision");
  expect(html).toContain("Save corrections");
  expect(html).not.toContain('name="rights_confirmed"');
  expect(html).not.toContain("<feedback>");
  const edited = proposalPreviewPage({ ...returned, revision: 2 }, "csrf");
  expect(edited).toContain("Resubmit to private moderation");
  expect(edited).toContain('name="revision" value="2"');
  expect(edited).not.toContain(" checked");
  expect(edited).toContain(
    "earlier confirmation does not cover corrected text",
  );
  expect(proposalListPage([returned], "csrf")).not.toContain(
    "Private &lt;feedback&gt;",
  );
});
it("never enables resubmission without pinned feedback, or editing a stale source", () => {
  expect(
    proposalPreviewPage({ ...returned, feedback: null, revision: 2 }, "csrf"),
  ).not.toContain("Resubmit to private moderation");
  const stale = proposalPreviewPage(
    { ...returned, workflowId: "WF-001", workflowVersion: 1 },
    "csrf",
    false,
  );
  expect(stale).toContain("no longer current");
  expect(stale).toContain("Private &lt;feedback&gt;");
  expect(stale).toContain("Withdraw and redact");
  expect(stale).not.toContain("Save corrections");
});
it.each(["submitted", "quarantined"] as const)(
  "labels retained %s feedback as prior-cycle and never offers edit/resubmit",
  (state) => {
    const html = proposalPreviewPage(
      {
        ...returned,
        state,
        revision: 2,
        rightsAttestedRevision: 2,
        rightsAttestedAt: date,
      },
      "csrf",
    );
    expect(html).toContain("Prior-cycle requested changes");
    expect(html).toContain("Rights confirmed for revision 2");
    expect(html).not.toContain("Save corrections");
    expect(html).not.toContain("Resubmit to private moderation");
  },
);
it.each(["rejected", "withdrawn"] as const)(
  "defends terminal %s rendering from accidental retained feedback",
  (state) => {
    const html = proposalPreviewPage(
      { ...returned, state, title: null, body: null, sources: null },
      "csrf",
    );
    expect(html).not.toContain("Private &lt;feedback&gt;");
    expect(html).toContain("proposal text has been removed");
    expect(html).not.toContain("Withdraw and redact");
  },
);
it("does not invent an exact rights record for legacy or incomplete metadata", () => {
  expect(
    proposalPreviewPage(
      {
        ...returned,
        state: "submitted",
        feedback: null,
        rightsAttestedAt: date,
      },
      "csrf",
    ),
  ).not.toContain("Rights confirmed for revision");
  expect(
    proposalPreviewPage({ ...returned, rightsAttestedRevision: 2 }, "csrf"),
  ).not.toContain("Rights confirmed for revision");
});
it("renders an explicit revision-bound change request only for submitted queue items without owner feedback", () => {
  const html = moderationPage(
    [{ ...returned, state: "submitted" }],
    "csrf",
    date,
  );
  expect(html).toContain(`/moderate/proposals/${id}/request-changes`);
  expect(html).toContain('name="revision" value="1"');
  expect(html).toContain('name="feedback" maxlength="1000" required');
  expect(html).not.toContain("Private &lt;feedback&gt;");
  expect(html).not.toContain(" checked");
  expect(
    moderationPage([{ ...returned, state: "quarantined" }], "csrf", date),
  ).not.toContain("Request changes");
});
it("bounds and escapes recovery text and links without a replay form", () => {
  const html = proposalChangesRecoveryPage(
    "<problem>",
    "</textarea>" + "x".repeat(1000),
  );
  expect(html).toContain("&lt;problem&gt;");
  expect(html).toContain("&lt;/textarea&gt;");
  expect(html).not.toContain("<form");
  expect(html).not.toContain("x".repeat(1000));
  expect(proposalSubmissionRecoveryPage('id"')).toContain(
    'href="/contribute/id&quot;"',
  );
});
