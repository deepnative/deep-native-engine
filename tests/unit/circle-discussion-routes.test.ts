import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { registerCircleDiscussion } from "../../src/circle-discussion-routes.ts";
import {
  disabledCircleDiscussionStore,
  type CircleDiscussionStore,
} from "../../src/circle-discussion.ts";
import { withLoopback } from "../support/loopback-server.ts";
const id = "00000000-0000-4000-8000-000000000003",
  key = "00000000-0000-4000-8000-000000000004",
  root = "/circles/everyday-ai/discussion",
  mod = "/moderate/circles/everyday-ai";
function fixture() {
  const application = express();
  application.use(express.urlencoded({ extended: false }));
  application.use(express.json({ strict: false }));
  application.use((_req, res, next) => {
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
  registerCircleDiscussion(
    application,
    mocks as unknown as CircleDiscussionStore,
  );
  return { application, mocks };
}
const post = {
  id,
  body: "Invented text <script>do-not-execute</script>",
  pseudonym: "Peer <sample>",
  state: "visible" as const,
  revision: 1,
  createdAt: "2026-10-03T00:00:00Z",
  rootId: null,
};
const receipt = {
  id,
  category: "privacy" as const,
  status: "reported" as const,
  createdAt: "2026-10-03T00:00:00Z",
};
interface ReadCase {
  path: string;
  operation: keyof CircleDiscussionStore;
  value: unknown;
  heading: string;
}
const reads: ReadCase[] = [
  {
    path: root + "/choice",
    operation: "choice",
    value: { generation: "1", active: false },
    heading: "Choose circle sharing",
  },
  {
    path: root,
    operation: "list",
    value: { items: [post], nextCursor: "invented-cursor" },
    heading: "Invented circle questions",
  },
  {
    path: root + "/owned",
    operation: "owned",
    value: { items: [post], nextCursor: "invented-cursor" },
    heading: "Your retained circle contributions",
  },
  {
    path: root + "/threads/" + id,
    operation: "thread",
    value: {
      root: post,
      replies: {
        items: [{ ...post, id: key, rootId: id }],
        nextCursor: "invented-cursor",
      },
    },
    heading: "Invented question and replies",
  },
  {
    path: mod + "/reports",
    operation: "moderationQueue",
    value: {
      items: [{ id: key, category: "privacy", target: post }],
      nextCursor: "invented-cursor",
    },
    heading: "Synthetic circle report worklist",
  },
  {
    path: root + "/reports",
    operation: "reports",
    value: { items: [receipt], nextCursor: "invented-cursor" },
    heading: "Your private sample reports",
  },
  {
    path: root + "/reports/" + id,
    operation: "reportReceipt",
    value: receipt,
    heading: "Your private sample report receipt",
  },
];
it.each(reads)(
  "renders the bounded authorized $operation result with invented-data warnings",
  async ({ path, operation, value, heading }) => {
    const f = fixture();
    f.mocks[operation].mockResolvedValue({ kind: "ready", value });
    await withLoopback(f.application, async (server) => {
      const response = await request(server).get(path).expect(200);
      expect(response.text).toContain(heading);
      expect(response.text).toContain("INVENTED LOCAL CIRCLE");
      expect(response.text).toContain("no staffed moderation");
      expect(response.text).not.toContain("<script>do-not-execute</script>");
      expect(response.text).not.toContain("Peer <sample>");
      expect(f.mocks[operation]).toHaveBeenCalledOnce();
    });
  },
);
it.each(reads)(
  "withholds the $operation page when the store denies current access",
  async ({ path, operation }) => {
    const f = fixture();
    await withLoopback(f.application, async (server) => {
      const response = await request(server).get(path).expect(403);
      expect(response.text).toContain("Circle request unavailable");
      expect(response.text).not.toContain("Invented text");
      expect(f.mocks[operation]).toHaveBeenCalledOnce();
    });
  },
);
it.each(["conflict", "invalid", "limit"] as const)(
  "maps a %s store result to a safe request error",
  async (kind) => {
    const f = fixture();
    f.mocks.list.mockResolvedValue({ kind });
    await withLoopback(f.application, async (server) => {
      const response = await request(server)
        .get(root)
        .expect(kind === "invalid" ? 422 : 409);
      expect(response.text).toContain(`(${kind})`);
      expect(response.text).not.toContain("<textarea");
    });
  },
);
interface WriteCase {
  path: string;
  operation: keyof CircleDiscussionStore;
  input: Record<string, string>;
  status: number;
  destination?: string;
}
const writes: WriteCase[] = [
  {
    path: root + "/choice",
    operation: "choose",
    input: {
      idempotencyKey: key,
      generation: "1",
      policyVersion: "circle-discussion-test-v1",
      confirm: "yes",
    },
    status: 303,
    destination: root,
  },
  {
    path: root + "/choice/withdraw",
    operation: "withdrawChoice",
    input: { confirm: "yes" },
    status: 303,
    destination: root + "/owned",
  },
  {
    path: root + "/posts",
    operation: "post",
    input: {
      idempotencyKey: key,
      body: "Invented submitted text",
      confirm: "yes",
    },
    status: 303,
    destination: root + "/owned",
  },
  {
    path: root + "/posts/" + id + "/withdraw",
    operation: "withdraw",
    input: { confirm: "yes" },
    status: 303,
    destination: root + "/owned",
  },
  {
    path: root + "/posts/" + id + "/reports",
    operation: "report",
    input: { idempotencyKey: key, category: "privacy" },
    status: 200,
  },
  {
    path: mod + "/posts/" + id,
    operation: "moderate",
    input: {
      idempotencyKey: key,
      expectedRevision: "1",
      action: "hide",
      reason: "privacy",
    },
    status: 303,
    destination: mod + "/reports",
  },
];
it.each(writes)(
  "acknowledges only a confirmed $operation store outcome",
  async ({ path, operation, input, status, destination }) => {
    const f = fixture();
    f.mocks[operation].mockResolvedValue({
      kind: "ready",
      value: { id, revision: 2 },
    });
    await withLoopback(f.application, async (server) => {
      const response = await request(server)
        .post(path)
        .type("form")
        .send(input)
        .expect(status);
      expect(f.mocks[operation]).toHaveBeenCalledOnce();
      if (destination) expect(response.headers.location).toBe(destination);
      else {
        expect(response.text).toContain("Sample report saved");
        expect(response.text).toContain(root + "/reports/" + id);
      }
    });
  },
);
it.each(writes)(
  "does not redirect or report success for a denied $operation",
  async ({ path, operation, input }) => {
    const f = fixture();
    await withLoopback(f.application, async (server) => {
      const response = await request(server)
        .post(path)
        .type("form")
        .send(input)
        .expect(403);
      expect(response.headers.location).toBeUndefined();
      expect(response.text).not.toContain("Sample report saved");
      expect(f.mocks[operation]).toHaveBeenCalledOnce();
    });
  },
);
it.each(writes)(
  "rejects forged or multi-valued $operation input before delegation",
  async ({ path, operation, input }) => {
    const f = fixture();
    await withLoopback(f.application, async (server) => {
      await request(server)
        .post(path)
        .type("form")
        .send({ ...input, extra: "forged" })
        .expect(422);
      const first = Object.keys(input)[0]!;
      await request(server)
        .post(path)
        .type("form")
        .send({ ...input, [first]: [input[first], input[first]] })
        .expect(422);
      expect(f.mocks[operation]).not.toHaveBeenCalled();
    });
  },
);
it("requires post text and a bounded positive integer moderation revision at the HTTP boundary", async () => {
  const f = fixture();
  await withLoopback(f.application, async (server) => {
    await request(server)
      .post(root + "/posts")
      .type("form")
      .send({ idempotencyKey: key, confirm: "yes" })
      .expect(422);
    for (const revision of [
      undefined,
      "0",
      "-1",
      "1.5",
      "0001",
      "10000000000",
      "<sample>",
    ])
      await request(server)
        .post(mod + "/posts/" + id)
        .type("form")
        .send({
          idempotencyKey: key,
          expectedRevision: revision,
          action: "hide",
          reason: "privacy",
        })
        .expect(422);
    expect(f.mocks.post).not.toHaveBeenCalled();
    expect(f.mocks.moderate).not.toHaveBeenCalled();
  });
});
it.each(reads.filter((r) => r.operation !== "choice"))(
  "rejects unrelated query fields on $operation without a data read",
  async ({ path, operation }) => {
    const f = fixture();
    await withLoopback(f.application, async (server) => {
      await request(server)
        .get(path + "?extra=forged")
        .expect(422);
      await request(server)
        .get(path + "?cursor=first&cursor=second")
        .expect(422);
      expect(f.mocks[operation]).not.toHaveBeenCalled();
    });
  },
);
it("forwards an optional reply destination and deliberate confirmation without inventing consent", async () => {
  const f = fixture();
  await withLoopback(f.application, async (server) => {
    await request(server)
      .post(root + "/posts")
      .type("form")
      .send({
        idempotencyKey: key,
        body: "Invented reply",
        rootId: id,
        confirm: "no",
      })
      .expect(403);
    expect(f.mocks.post).toHaveBeenCalledWith(
      "invented-token",
      "everyday-ai",
      key,
      "Invented reply",
      false,
      id,
    );
    await request(server)
      .post(root + "/choice")
      .type("form")
      .send({ ...writes[0]!.input, confirm: "no" })
      .expect(403);
    expect(f.mocks.choose).toHaveBeenCalledWith(
      "invented-token",
      "everyday-ai",
      key,
      "1",
      "circle-discussion-test-v1",
      false,
    );
    await request(server)
      .post(root + "/choice/withdraw")
      .type("form")
      .send({ confirm: "no" })
      .expect(403);
    expect(f.mocks.withdrawChoice).toHaveBeenCalledWith(
      "invented-token",
      "everyday-ai",
      false,
    );
    await request(server)
      .post(root + "/posts/" + id + "/withdraw")
      .type("form")
      .send({ confirm: "no" })
      .expect(403);
    expect(f.mocks.withdraw).toHaveBeenCalledWith(
      "invented-token",
      "everyday-ai",
      id,
      false,
    );
  });
});
it("keeps active choice withdrawal separate from choosing a fresh sharing generation", async () => {
  const f = fixture();
  f.mocks.choice.mockResolvedValue({
    kind: "ready",
    value: { generation: "2", active: true },
  });
  await withLoopback(f.application, async (server) => {
    const response = await request(server)
      .get(root + "/choice")
      .expect(200);
    expect(response.text).toContain("Your current sharing choice is active");
    expect(response.text).toContain('action="' + root + '/choice/withdraw"');
    expect(response.text).not.toContain(
      "Enable invented circle sharing</button>",
    );
  });
});
it("shows only own terminal markers and omits foreign-root identity and repeat withdrawal actions", async () => {
  const f = fixture();
  f.mocks.owned.mockResolvedValue({
    kind: "ready",
    value: {
      items: [
        {
          ...post,
          body: null,
          state: "withdrawn",
          rootId: "private-foreign-root",
        },
      ],
      nextCursor: null,
    },
  });
  await withLoopback(f.application, async (server) => {
    const response = await request(server)
      .get(root + "/owned")
      .expect(200);
    expect(response.text).toContain("Text withdrawn.");
    expect(response.text).not.toContain("Withdraw contribution</button>");
    expect(response.text).not.toContain("private-foreign-root");
  });
});
it.each(["list", "owned"] as const)(
  "renders empty %s without an artificial next page",
  async (operation) => {
    const f = fixture();
    f.mocks[operation].mockResolvedValue({
      kind: "ready",
      value: { items: [], nextCursor: null },
    });
    await withLoopback(f.application, async (server) => {
      const response = await request(server)
        .get(operation === "list" ? root : root + "/owned")
        .expect(200);
      expect(response.text).toContain(
        "No contributions available on this page",
      );
      expect(response.text).not.toContain("Next page</a>");
    });
  },
);
it.each(["reported", "hidden", "unavailable"] as const)(
  "renders content-free %s report history and exact receipt",
  async (status) => {
    const f = fixture();
    f.mocks.reports.mockResolvedValue({
      kind: "ready",
      value: { items: [{ ...receipt, status }], nextCursor: null },
    });
    f.mocks.reportReceipt.mockResolvedValue({
      kind: "ready",
      value: { ...receipt, status },
    });
    await withLoopback(f.application, async (server) => {
      for (const path of [root + "/reports", root + "/reports/" + id]) {
        const response = await request(server).get(path).expect(200);
        expect(response.text).toContain(
          status === "reported"
            ? "Sample report retained"
            : status === "hidden"
              ? "Sample target hidden"
              : "Target unavailable",
        );
        expect(response.text).not.toContain("Invented text");
      }
    });
  },
);
it("renders empty report history and worklist without implying a staffed service", async () => {
  const f = fixture();
  f.mocks.reports.mockResolvedValue({
    kind: "ready",
    value: { items: [], nextCursor: null },
  });
  f.mocks.moderationQueue.mockResolvedValue({
    kind: "ready",
    value: { items: [], nextCursor: null },
  });
  await withLoopback(f.application, async (server) => {
    const own = await request(server)
        .get(root + "/reports")
        .expect(200),
      queue = await request(server)
        .get(mod + "/reports")
        .expect(200);
    expect(own.text).toContain("No own sample reports");
    expect(queue.text).toContain("No reports available");
    expect(queue.text).not.toContain("Hide invented contribution</button>");
  });
});
it("shows restore only for an available hidden source, and no action for an unavailable source", async () => {
  const f = fixture();
  f.mocks.moderationQueue.mockResolvedValue({
    kind: "ready",
    value: {
      items: [
        {
          id: key,
          category: "off_topic",
          target: { ...post, state: "hidden", revision: 2 },
        },
        { id: "unavailable", category: "privacy", target: null },
      ],
      nextCursor: null,
    },
  });
  await withLoopback(f.application, async (server) => {
    const response = await request(server)
      .get(mod + "/reports")
      .expect(200);
    expect(response.text).toContain("Restore invented contribution</button>");
    expect(response.text).toContain('name="expectedRevision" value="2"');
    expect(response.text).toContain(
      "Target unavailable. No text or restoration action",
    );
    expect(response.text).not.toContain("Hide invented contribution</button>");
  });
});

it.each([null, [], "invented-string", 123])(
  "rejects malformed parsed request bodies without exceptions or private echoes: %j",
  async (body) => {
    const f = fixture();
    await withLoopback(f.application, async (server) => {
      const response = await request(server)
        .post(root + "/posts")
        .type("json")
        .send(JSON.stringify(body))
        .expect(422);
      expect(response.text).toContain("Circle request unavailable");
      expect(f.mocks.post).not.toHaveBeenCalled();
    });
  },
);
it.each(["choice", "report"] as const)(
  "renders a content-free %s reconciliation without implying current sharing permission",
  async (kind) => {
    const f = fixture();
    f.mocks.reconcile.mockResolvedValue({
      kind: "ready",
      value: { found: true, id, status: "retained", revision: null },
    });
    await withLoopback(f.application, async (server) => {
      const response = await request(server)
        .get(`${root}/reconcile?kind=${kind}&key=${key}`)
        .expect(200);
      expect(response.text).toContain("Original-key receipt: retained");
      expect(response.text).not.toContain("revision null");
      expect(response.text).toContain("not permission to publish");
    });
  },
);
it("renders a staff action receipt without exposing the source post identity", async () => {
  const f = fixture();
  f.mocks.reconcile.mockResolvedValue({
    kind: "ready",
    value: { found: true, id: null, status: "hidden", revision: 2 },
  });
  await withLoopback(f.application, async (server) => {
    const response = await request(server)
      .get(`${mod}/reconcile?kind=moderation&key=${key}`)
      .expect(200);
    expect(response.text).toContain("Original-key receipt: hidden");
    expect(response.text).toContain("revision 2");
    expect(response.text).not.toContain("receipt null");
    expect(response.text).toContain(mod + "/reports");
  });
});
it("keeps withdrawal uncertainty generic when there is no original submission key", async () => {
  const f = fixture();
  f.mocks.withdraw.mockRejectedValue(
    Error("Invented private withdrawal fault"),
  );
  await withLoopback(f.application, async (server) => {
    const response = await request(server)
      .post(root + "/posts/" + id + "/withdraw")
      .type("form")
      .send({ confirm: "yes" })
      .expect(503);
    expect(response.text).toContain("Circle result unconfirmed");
    expect(response.text).not.toContain("Invented private withdrawal fault");
    expect(response.text).not.toContain("Check the original form key</a>");
  });
});
