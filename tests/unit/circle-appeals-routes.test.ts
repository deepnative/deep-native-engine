import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { registerCircleDiscussion } from "../../src/circle-discussion-routes.ts";
import {
  disabledCircleDiscussionStore,
  type CircleAppeal,
  type CircleDiscussionStore,
} from "../../src/circle-discussion.ts";
import { withLoopback } from "../support/loopback-server.ts";

const circle = "everyday-ai",
  id = "00000000-0000-4000-8000-000000000001",
  postId = "00000000-0000-4000-8000-000000000002",
  key = "00000000-0000-4000-8000-000000000003";
const root = `/circles/${circle}/discussion`,
  member = `${root}/posts/${postId}/appeals`,
  receipt = `${root}/appeals/${id}`,
  staff = `/moderate/circles/${circle}/appeals`;
const appeal = (): CircleAppeal => ({
  id,
  postId,
  decisionRevision: 2,
  decisionReason: "privacy",
  decisionAt: "2026-10-28T10:00:00Z",
  requestReason: "missing_context",
  requestedAt: "2026-10-28T10:01:00Z",
  state: "pending",
  closedAt: null,
  postState: "hidden",
  postRevision: 2,
  availability: "available",
  resolution: null,
});
function fixture() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ strict: false }));
  app.use((_req, res, next) => {
    res.locals.token = "invented-token";
    res.locals.csrf = "invented-csrf";
    next();
  });
  const mocks = Object.fromEntries(
    Object.keys(disabledCircleDiscussionStore()).map((name) => [
      name,
      vi.fn().mockResolvedValue({ kind: "denied" }),
    ]),
  ) as Record<keyof CircleDiscussionStore, ReturnType<typeof vi.fn>>;
  registerCircleDiscussion(app, mocks as unknown as CircleDiscussionStore);
  return { app, mocks };
}
const page = (canRequest = true, items: CircleAppeal[] = []) => ({
  postId,
  postState: "hidden",
  postRevision: 2,
  decisionRevision: 2,
  canRequest,
  items,
});
const target = {
  id: postId,
  body: "Invented currently shared <script>source</script>",
  pseudonym: "Peer <invented>",
  state: "hidden",
  revision: 2,
  createdAt: "2026-10-28T10:00:00Z",
};
const reads = [
  {
    path: member,
    operation: "appeals",
    value: page(),
    heading: "Request reconsideration of this decision",
  },
  {
    path: receipt,
    operation: "appealReceipt",
    value: appeal(),
    heading: "Your private reconsideration request",
  },
  {
    path: `${root}/appeals/download`,
    operation: "appealHistory",
    value: { appealsVersion: 1, circleId: circle, items: [appeal()] },
    heading: "",
  },
  {
    path: staff,
    operation: "appealQueue",
    value: { items: [{ appeal: appeal(), target }], nextCursor: null },
    heading: "Scoped reconsideration requests",
  },
] as const;
it.each(reads)(
  "MODA-01/03/06 normal read $operation renders its own bounded purpose",
  async (entry) => {
    const f = fixture();
    f.mocks[entry.operation].mockResolvedValue({
      kind: "ready",
      value: entry.value,
    });
    await withLoopback(f.app, async (server) => {
      const response = await request(server).get(entry.path).expect(200);
      if (entry.heading) expect(response.text).toContain(entry.heading);
      else expect(response.body.items).toHaveLength(1);
      expect(response.text).not.toContain("<script>source</script>");
    });
  },
);
it.each(["denied", "invalid", "conflict", "limit"])(
  "MODA-02 all new reads handle %s without an attachment or retained fields",
  async (kind) => {
    const f = fixture();
    for (const entry of reads)
      f.mocks[entry.operation].mockResolvedValue({ kind });
    await withLoopback(f.app, async (server) => {
      for (const entry of reads) {
        const response = await request(server)
          .get(entry.path)
          .expect(kind === "denied" ? 403 : kind === "invalid" ? 422 : 409);
        expect(response.headers["content-disposition"]).toBeUndefined();
        expect(response.text).not.toContain("missing_context");
      }
    });
  },
);
it("MODA-02 new read query allowlists reject arrays and extra fields before store access", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    for (const entry of reads)
      await request(server)
        .get(entry.path + "?extra=true")
        .expect(422);
    await request(server)
      .get(staff + "?cursor=a&cursor=b")
      .expect(422);
  });
  for (const entry of reads)
    expect(f.mocks[entry.operation]).not.toHaveBeenCalled();
});
it("MODA-01 no eligible decision or existing request offers no new form, retaining truthful history and export link", async () => {
  const f = fixture();
  f.mocks.appeals.mockResolvedValue({
    kind: "ready",
    value: { ...page(false, [appeal()]), decisionRevision: null },
  });
  await withLoopback(f.app, async (server) => {
    const response = await request(server).get(member).expect(200);
    expect(response.text).toContain("Latest recorded decision revision: none");
    expect(response.text).toContain("No new request is available");
    expect(response.text).not.toContain('name="decisionRevision"');
    expect(response.text).toContain(
      "Download all your retained appeals in this circle",
    );
  });
});
it.each([
  "available",
  "unavailable",
  "superseded",
  "write_paused",
  "withdrawn",
  "upheld",
  "restored",
])(
  "MODA-05/06 member receipt accurately renders %s without implying independent review",
  async (state) => {
    const f = fixture(),
      value = appeal();
    if (["withdrawn", "upheld", "restored"].includes(state)) {
      value.state = state as CircleAppeal["state"];
      value.availability = "closed";
      value.closedAt = "2026-10-28T10:02:00Z";
    } else value.availability = state as CircleAppeal["availability"];
    if (state === "upheld" || state === "restored")
      value.resolution = {
        reason: state === "upheld" ? "rule_applies" : "decision_corrected",
        postRevision: state === "upheld" ? 2 : 3,
        occurredAt: value.closedAt!,
      };
    f.mocks.appealReceipt.mockResolvedValue({ kind: "ready", value });
    await withLoopback(f.app, async (server) => {
      const response = await request(server).get(receipt).expect(200);
      expect(response.text).toContain(`Recorded request: ${value.state}`);
      expect(response.text).toContain("general activity export");
      expect(response.text.includes("Withdraw reconsideration request")).toBe(
        value.state === "pending",
      );
      if (value.resolution)
        expect(response.text).toContain("not independent or qualified review");
    });
  },
);
it("MODA-06 JSON download uses an explicit nested whitelist and safe no-store attachment", async () => {
  const f = fixture(),
    value = {
      ...appeal(),
      state: "restored",
      resolution: {
        reason: "decision_corrected",
        postRevision: 3,
        occurredAt: "2026-10-28T10:02:00Z",
        actor: "must-not-export",
      },
      body: "must-not-export",
      idempotencyKey: key,
      reporter: "must-not-export",
    };
  f.mocks.appealHistory.mockResolvedValue({
    kind: "ready",
    value: {
      appealsVersion: 1,
      circleId: circle,
      items: [value],
      token: "must-not-export",
    },
  });
  await withLoopback(f.app, async (server) => {
    const response = await request(server)
      .get(`${root}/appeals/download`)
      .expect(200);
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="circle-moderation-appeals.json"',
    );
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(Object.keys(response.body).sort()).toEqual([
      "appealsVersion",
      "circleId",
      "items",
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(
      /must-not-export|idempotency|reporter/,
    );
    expect(response.body.items[0].resolution).toEqual({
      reason: "decision_corrected",
      postRevision: 3,
      occurredAt: "2026-10-28T10:02:00Z",
    });
  });
});
it("MODA-03 moderator queue escapes shared source and offers only current exact-decision actions", async () => {
  const f = fixture();
  f.mocks.appealQueue.mockResolvedValue({
    kind: "ready",
    value: {
      items: [
        { appeal: appeal(), target },
        {
          appeal: { ...appeal(), id: postId, availability: "superseded" },
          target,
        },
      ],
      nextCursor: "invented<&cursor",
    },
  });
  await withLoopback(f.app, async (server) => {
    const response = await request(server)
      .get(staff + "?cursor=old")
      .expect(200);
    expect(f.mocks.appealQueue).toHaveBeenCalledWith(
      "invented-token",
      circle,
      "old",
    );
    expect(response.text).toContain("&lt;script&gt;source&lt;/script&gt;");
    expect(response.text).toContain(
      "This earlier request is no longer actionable",
    );
    expect(
      response.text.match(/Record reconsideration result<\/button>/g),
    ).toHaveLength(1);
    expect(response.text).toContain("invented%3C%26cursor");
  });
  f.mocks.appealQueue.mockResolvedValue({
    kind: "ready",
    value: { items: [], nextCursor: null },
  });
  await withLoopback(f.app, async (server) =>
    expect((await request(server).get(staff).expect(200)).text).toContain(
      "No currently available reconsideration requests",
    ),
  );
});
it("MODA-01 owner request passes only validated structured fields and redirects to its durable receipt", async () => {
  const f = fixture();
  f.mocks.requestAppeal.mockResolvedValue({ kind: "ready", value: { id } });
  await withLoopback(f.app, async (server) => {
    await request(server)
      .post(member)
      .type("form")
      .send({
        csrf: "unused",
        idempotencyKey: key,
        decisionRevision: "2",
        reason: "recheck_rule",
        confirm: "yes",
      })
      .expect(303)
      .expect("Location", receipt);
  });
  expect(f.mocks.requestAppeal).toHaveBeenCalledWith(
    "invented-token",
    circle,
    postId,
    key,
    2,
    "recheck_rule",
    true,
  );
});
it.each([
  "missing-revision",
  "zero-revision",
  "array-reason",
  "private-extra",
  "query",
])(
  "MODA-02 rejects malformed request %s without store access",
  async (kind) => {
    const f = fixture(),
      fields: Record<string, unknown> = {
        idempotencyKey: key,
        decisionRevision: "2",
        reason: "other",
        confirm: "yes",
      };
    if (kind === "missing-revision") delete fields.decisionRevision;
    if (kind === "zero-revision") fields.decisionRevision = "0";
    if (kind === "array-reason") fields.reason = ["other", "private"];
    if (kind === "private-extra") fields.body = "Never copy private work";
    await withLoopback(f.app, async (server) => {
      await request(server)
        .post(member + (kind === "query" ? "?extra=true" : ""))
        .send(fields)
        .expect(422);
    });
    expect(f.mocks.requestAppeal).not.toHaveBeenCalled();
  },
);
it("MODA-02 missing confirmation is delegated as false and a denied request never redirects", async () => {
  const f = fixture();
  f.mocks.requestAppeal.mockResolvedValue({ kind: "invalid" });
  await withLoopback(f.app, async (server) => {
    await request(server)
      .post(member)
      .send({ idempotencyKey: key, decisionRevision: "2", reason: "other" })
      .expect(422);
  });
  expect(f.mocks.requestAppeal).toHaveBeenCalledWith(
    "invented-token",
    circle,
    postId,
    key,
    2,
    "other",
    false,
  );
});
it.each(["uphold", "restore"] as const)(
  "MODA-04 staff %s maps to its bounded recorded reason and redirects only after success",
  async (outcome) => {
    const f = fixture();
    f.mocks.resolveAppeal.mockResolvedValue({
      kind: "ready",
      value: { id, revision: outcome === "uphold" ? 2 : 3 },
    });
    await withLoopback(f.app, async (server) => {
      await request(server)
        .post(staff + `/${id}/resolve`)
        .send({
          idempotencyKey: key,
          expectedRevision: "2",
          outcome,
          confirm: "yes",
        })
        .expect(303)
        .expect("Location", staff);
    });
    expect(f.mocks.resolveAppeal).toHaveBeenCalledWith(
      "invented-token",
      circle,
      id,
      key,
      outcome,
      2,
      outcome === "uphold" ? "rule_applies" : "decision_corrected",
    );
  },
);
it.each([
  "confirmation",
  "missing-revision",
  "zero-revision",
  "extra",
  "query",
  "array",
])("MODA-04 malformed resolution %s cannot reach the store", async (kind) => {
  const f = fixture(),
    fields: Record<string, unknown> = {
      idempotencyKey: key,
      expectedRevision: "2",
      outcome: "uphold",
      confirm: "yes",
    };
  if (kind === "confirmation") fields.confirm = "no";
  if (kind === "missing-revision") delete fields.expectedRevision;
  if (kind === "zero-revision") fields.expectedRevision = "0";
  if (kind === "extra") fields.body = "Never retain source";
  if (kind === "array") fields.outcome = ["uphold", "restore"];
  await withLoopback(f.app, async (server) => {
    await request(server)
      .post(staff + `/${id}/resolve` + (kind === "query" ? "?extra=true" : ""))
      .send(fields)
      .expect(422);
  });
  expect(f.mocks.resolveAppeal).not.toHaveBeenCalled();
});
it("MODA-04 unknown outcome remains invalid rather than acquiring an inferred result", async () => {
  const f = fixture();
  f.mocks.resolveAppeal.mockResolvedValue({ kind: "invalid" });
  await withLoopback(f.app, async (server) => {
    await request(server)
      .post(staff + `/${id}/resolve`)
      .send({
        idempotencyKey: key,
        expectedRevision: "2",
        outcome: "unknown",
        confirm: "yes",
      })
      .expect(422);
  });
  expect(f.mocks.resolveAppeal).toHaveBeenCalledWith(
    "invented-token",
    circle,
    id,
    key,
    "unknown",
    2,
    "",
  );
});
it("MODA-05 withdrawal accepts confirmation only and redirects to current retained state", async () => {
  const f = fixture();
  f.mocks.withdrawAppeal.mockResolvedValue({ kind: "ready", value: { id } });
  await withLoopback(f.app, async (server) => {
    await request(server)
      .post(receipt + "/withdraw")
      .send({ confirm: "yes" })
      .expect(303)
      .expect("Location", receipt);
    await request(server)
      .post(receipt + "/withdraw?extra=true")
      .send({ confirm: "yes" })
      .expect(422);
    await request(server)
      .post(receipt + "/withdraw")
      .send({ confirm: "yes", body: "private" })
      .expect(422);
  });
  expect(f.mocks.withdrawAppeal).toHaveBeenCalledTimes(1);
  expect(f.mocks.withdrawAppeal).toHaveBeenCalledWith(
    "invented-token",
    circle,
    id,
    true,
  );
  f.mocks.withdrawAppeal.mockResolvedValue({ kind: "conflict" });
  await withLoopback(f.app, async (server) => {
    await request(server)
      .post(receipt + "/withdraw")
      .send({})
      .expect(409);
  });
  expect(f.mocks.withdrawAppeal).toHaveBeenLastCalledWith(
    "invented-token",
    circle,
    id,
    false,
  );
});
it("MODA-07 every read failure is sanitized with no attachment", async () => {
  const f = fixture();
  for (const entry of reads)
    f.mocks[entry.operation].mockRejectedValue(
      Error("PRIVATE-DATABASE-CREDENTIAL"),
    );
  await withLoopback(f.app, async (server) => {
    for (const entry of reads) {
      const response = await request(server).get(entry.path).expect(503);
      expect(response.headers["content-disposition"]).toBeUndefined();
      expect(response.text).not.toContain("PRIVATE-DATABASE-CREDENTIAL");
    }
  });
});
it("MODA-07 uncertain request/result use the original authorized key; withdrawal offers current receipt inspection", async () => {
  const f = fixture();
  for (const name of [
    "requestAppeal",
    "resolveAppeal",
    "withdrawAppeal",
  ] as const)
    f.mocks[name].mockRejectedValue(Error("PRIVATE-DATABASE-CREDENTIAL"));
  await withLoopback(f.app, async (server) => {
    const fields = {
      idempotencyKey: key,
      decisionRevision: "2",
      reason: "other",
      confirm: "yes",
    };
    const requestResult = await request(server)
      .post(member)
      .send(fields)
      .expect(503);
    expect(requestResult.text).toContain(
      `${root}/reconcile?kind=appeal&amp;key=${key}`,
    );
    const resolution = await request(server)
      .post(staff + `/${id}/resolve`)
      .send({
        idempotencyKey: key,
        expectedRevision: "2",
        outcome: "uphold",
        confirm: "yes",
      })
      .expect(503);
    expect(resolution.text).toContain(
      `/moderate/circles/${circle}/reconcile?kind=appeal-resolution&amp;key=${key}`,
    );
    const withdrawn = await request(server)
      .post(receipt + "/withdraw")
      .send({ confirm: "yes" })
      .expect(503);
    expect(withdrawn.text).toContain(
      "Inspect the current private request before another withdrawal",
    );
    const malformed = await request(server)
      .post(member)
      .send({ ...fields, idempotencyKey: "bad" })
      .expect(503);
    expect(malformed.text).not.toContain("Check the original form key</a>");
    const unknown = await request(server)
      .post(`${root}/appeals/bad/withdraw`)
      .send({ confirm: "yes" })
      .expect(503);
    expect(unknown.text).not.toContain(
      "Inspect the current private request before another withdrawal",
    );
    for (const response of [
      requestResult,
      resolution,
      withdrawn,
      malformed,
      unknown,
    ])
      expect(response.text).not.toContain("PRIVATE-DATABASE-CREDENTIAL");
  });
});
it.each(["appeal", "appeal-resolution"])(
  "MODA-07 normal original-key %s recovery is explicitly a retained receipt, never automatic submission",
  async (kind) => {
    const f = fixture();
    f.mocks.reconcile.mockResolvedValue({
      kind: "ready",
      value: { found: true, id, status: "pending", revision: 2 },
    });
    await withLoopback(f.app, async (server) => {
      const prefix = kind === "appeal" ? root : `/moderate/circles/${circle}`;
      const response = await request(server)
        .get(`${prefix}/reconcile?kind=${kind}&key=${key}`)
        .expect(200);
      expect(response.text).toContain("Original-key receipt: pending");
      expect(response.text).toContain(
        "not permission to publish or a promise of moderation",
      );
    });
    expect(f.mocks.reconcile).toHaveBeenCalledWith(
      "invented-token",
      circle,
      kind,
      key,
    );
  },
);
