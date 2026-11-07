import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import type { AnonymousWriteAdmission } from "../../src/anonymous-write-admission.ts";
import { disabledCareerStore, type CareerStore } from "../../src/career.ts";
import { proposalNotSavedPage } from "../../src/member-record-admission-views.ts";
import {
  disabledProposalStore,
  type ProposalStore,
} from "../../src/proposals.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import type { Store } from "../../src/store.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #42: the four routes that create a private text record are counted before
// anything is saved, and a refusal keeps what the member typed.
const origin = "http://127.0.0.1:3000";
const secret = "member-record-unit";
const token = "b".repeat(64);
afterEach(() => vi.restoreAllMocks());

const milestone = {
  goal_title: "Invented goal <marker>",
  milestone_title: "Invented milestone",
  evidence_note: "Invented evidence",
  next_action: "Invented next action",
  sample_only: "yes",
};
const entry = {
  kind: "career",
  title: "Invented entry <marker>",
  note: "Invented note",
  next_action: "Invented next",
  self_reported_outcome: "Invented outcome",
  sample_only: "yes",
};
const draft = {
  kind: "proposal",
  title: "Invented draft <marker>",
  body: "An invented draft with enough useful detail to review.",
  sample_only: "yes",
};
const proposal = {
  title: "Invented proposal <marker>",
  body: "Invented proposal body",
  sources: "Invented sources",
  sample_confirmed: "yes",
};

function setup(
  result: AnonymousWriteAdmission,
  reads: { milestones?: unknown; snapshot?: unknown } = {},
) {
  const admit = vi.fn().mockResolvedValue(result);
  const db = {
    session: vi.fn().mockResolvedValue({
      kind: "active",
      expiresAt: new Date(Date.now() + 3600000),
      learner: { id: "member", background: "explorer", goal: "everyday" },
    }),
    milestones: vi
      .fn()
      .mockResolvedValue("milestones" in reads ? reads.milestones : []),
    createMilestone: vi.fn().mockResolvedValue("created"),
  } as unknown as Store;
  const career = {
    ...disabledCareerStore(),
    snapshot: vi
      .fn<CareerStore["snapshot"]>()
      .mockResolvedValue(
        ("snapshot" in reads
          ? reads.snapshot
          : { enabled: true, entries: [], drafts: [] }) as never,
      ),
    createEntry: vi.fn<CareerStore["createEntry"]>().mockResolvedValue(true),
    createDraft: vi.fn<CareerStore["createDraft"]>().mockResolvedValue(true),
  };
  const proposals = {
    ...disabledProposalStore(),
    createDraft: vi
      .fn<ProposalStore["createDraft"]>()
      .mockResolvedValue("a4ff1471-0226-4d5b-8677-99c0a94cdf40"),
  };
  const application = app(db, {
    origin,
    secret,
    career,
    proposals,
    anonymousWrites: { admit },
  });
  return {
    admit,
    saves: () => [
      vi.mocked(db.createMilestone).mock.calls.length,
      career.createEntry.mock.calls.length,
      career.createDraft.mock.calls.length,
      proposals.createDraft.mock.calls.length,
    ],
    post: (path: string, form: Record<string, string>) =>
      withLoopback(application, (server) =>
        request(server)
          .post(path)
          .set("Host", "127.0.0.1:3000")
          .set("Origin", origin)
          .set("Cookie", `${COOKIE}=${token}`)
          .set("X-Forwarded-For", "203.0.113.5")
          .type("form")
          .send({ ...form, csrf: csrf(token, secret) }),
      ),
  };
}
const ROUTES: [string, Record<string, string>][] = [
  ["/milestones", milestone],
  ["/career/entries", entry],
  ["/career/drafts", draft],
  ["/contribute", proposal],
];

it("RECORD-01 refuses every creation route before saving and keeps the escaped typed text", async () => {
  const route = setup({
    kind: "refused",
    limit: "visitor",
    retryAfterSeconds: 120,
  });
  for (const [path, form] of ROUTES) {
    const refused = await route.post(path, form);
    expect.soft(refused.status, path).toBe(429);
    expect.soft(refused.headers["retry-after"], path).toBe("120");
    expect.soft(refused.headers["cache-control"], path).toContain("no-store");
    expect
      .soft(refused.text, path)
      .toContain(
        "Too many new records have been saved from this network. Wait 2 minutes, then save again. Nothing was saved.",
      );
    expect.soft(refused.text, path).toContain("&lt;marker&gt;");
    expect.soft(refused.text, path).not.toContain("<marker>");
  }
  expect(route.admit).toHaveBeenCalledTimes(4);
  expect(route.admit).toHaveBeenCalledWith(
    "member_record",
    expect.objectContaining({ scope: "public" }),
  );
  expect(route.saves()).toEqual([0, 0, 0, 0]);
});

it("RECORD-03 answers 503 and saves nothing when the limiter cannot answer", async () => {
  const route = setup({ kind: "unavailable" });
  for (const [path, form] of ROUTES) {
    const held = await route.post(path, form);
    expect.soft(held.status, path).toBe(503);
    expect.soft(held.headers["retry-after"], path).toBe("60");
  }
  expect(route.saves()).toEqual([0, 0, 0, 0]);
});

it("RECORD-01 saves after admission and does not count a malformed proposal", async () => {
  const route = setup({ kind: "admitted" });
  for (const [path, form] of ROUTES)
    expect((await route.post(path, form)).status, path).toBe(303);
  expect(route.saves()).toEqual([1, 1, 1, 1]);
  route.admit.mockClear();
  // The store refuses it as invalid; it must not be counted first.
  await route.post("/contribute", { ...proposal, title: " " });
  expect(route.admit).not.toHaveBeenCalled();
});

it("RECORD-01 still withholds the page when a refused member's records can no longer be read", async () => {
  const route = setup(
    { kind: "refused", limit: "service", retryAfterSeconds: 60 },
    { milestones: null, snapshot: null },
  );
  for (const [path, form] of ROUTES.slice(0, 3)) {
    const refused = await route.post(path, form);
    expect.soft(refused.status, path).toBe(403);
    expect.soft(refused.text, path).not.toContain("<marker>");
    expect.soft(refused.text, path).not.toContain("&lt;marker&gt;");
  }
  expect(route.saves()).toEqual([0, 0, 0, 0]);
});

it("keeps a workflow reference and the sample choice in the kept proposal form", () => {
  const html = proposalNotSavedPage("Refused.", "c".repeat(64), {
    title: 'A "quoted" title',
    body: "Body",
    sources: "Sources",
    workflow_id: "workflow-<1>",
    workflow_version: "2",
    sample_confirmed: "yes",
  });
  expect(html).toContain(
    '<input type="hidden" name="workflow_id" value="workflow-&lt;1&gt;">',
  );
  expect(html).toContain(
    '<input type="hidden" name="workflow_version" value="2">',
  );
  expect(html).toContain(
    '<input type="hidden" name="sample_confirmed" value="yes">',
  );
  expect(html).toContain('value="A &quot;quoted&quot; title"');
  const bare = proposalNotSavedPage("Refused.", "c".repeat(64), {});
  expect(bare).not.toContain('name="workflow_id"');
  expect(bare).toContain('name="title" maxlength="160" required value=""');
});
