import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { csrf } from "../../src/session.ts";
import { mountSampleAssignmentRoutes } from "../../src/sample-assignment-routes.ts";
import type {
  SampleAssignmentStore,
  SampleAssignmentRow,
} from "../../src/sample-assignment-values.ts";
import { withLoopback } from "../support/loopback-server.ts";
const origin = "http://127.0.0.1:3000",
  host = "127.0.0.1:3000",
  secret = "invented-route-secret",
  token = "a".repeat(64);
const base = "/operator/sample-assignments",
  reference = "/review/sample-assignment-reference";
const evidenceId = "11111111-1111-4111-8111-111111111111",
  reviewerId = "22222222-2222-4222-8222-222222222222",
  operationId = "33333333-3333-4333-8333-333333333333",
  grantId = "44444444-4444-4444-8444-444444444444";
const refs = { evidenceId, sourceRevision: 1, reviewerId };
const input = {
  ...refs,
  operationId,
  startsAt: "2026-10-06T09:00:00.000Z",
  expiresAt: "2026-10-06T10:00:00.000Z",
};
const payload = () => ({
  ...input,
  sourceRevision: "1",
  csrf: csrf(token, secret),
  confirm: "yes",
});
function fixture(
  options: {
    missing?: boolean;
    enabled?: boolean;
    localStaffEntry?: boolean;
    mode?: "test" | "live";
  } = {},
) {
  const row: SampleAssignmentRow = {
    ...refs,
    exactGrantId: grantId,
    receiptId: operationId,
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
    createdAt: input.startsAt,
    revokedAt: null,
    state: "active",
    canRevoke: true,
  };
  const deadline = performance.now() + 60000;
  const port = {
    open: vi
      .fn<SampleAssignmentStore["open"]>()
      .mockResolvedValue({ kind: "ready", deadline }),
    selfReference: vi
      .fn<SampleAssignmentStore["selfReference"]>()
      .mockResolvedValue({
        kind: "ready",
        deadline,
        reference: { reviewerId, expiresAt: input.expiresAt },
      }),
    check: vi.fn<SampleAssignmentStore["check"]>().mockResolvedValue({
      kind: "ready",
      deadline,
      check: {
        ...refs,
        sourceStatus: "eligible",
        reviewerExpiresAt: input.expiresAt,
      },
    }),
    assign: vi
      .fn<SampleAssignmentStore["assign"]>()
      .mockResolvedValue({ kind: "applied", deadline, row }),
    history: vi.fn<SampleAssignmentStore["history"]>().mockResolvedValue({
      kind: "ready",
      deadline,
      history: { evidenceId, sourceRevision: 1, rows: [row], next: null },
    }),
    recover: vi
      .fn<SampleAssignmentStore["recover"]>()
      .mockResolvedValue({ kind: "ready", deadline, row }),
    revoke: vi
      .fn<SampleAssignmentStore["revoke"]>()
      .mockResolvedValue({ kind: "revoked", deadline, row }),
  };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  mountSampleAssignmentRoutes(app, options.missing ? undefined : port, {
    origin,
    secret,
    mode: "test",
    enabled: true,
    localStaffEntry: true,
    ...options,
  });
  return { app, port, row };
}
const get = (
  s: Parameters<typeof request>[0],
  path: string,
  cookie = `dne_staff=${token}`,
) => request(s).get(path).set("Host", host).set("Cookie", cookie);
const post = (s: Parameters<typeof request>[0], path: string, body: object) =>
  request(s)
    .post(path)
    .set("Host", host)
    .set("Cookie", `dne_staff=${token}`)
    .set("Origin", origin)
    .type("form")
    .send(body);

it("REVADM-01/02 opens exact-reference and own-reference forms through explicit staff selection", async () => {
  const f = fixture();
  await withLoopback(f.app, async (s) => {
    const home = await get(s, base)
      .expect(200)
      .expect("Cache-Control", "no-store");
    expect(home.text).toContain("Check exact sample references");
    const own = await get(s, reference).expect(200);
    expect(own.text).toContain(reviewerId);
    expect(own.text).not.toContain(token);
    expect(f.port.open).toHaveBeenCalledWith(token);
    expect(f.port.selfReference).toHaveBeenCalledWith(token);
  });
});
it.each([
  { missing: true },
  { enabled: false },
  { localStaffEntry: false },
  { mode: "live" as const },
])("REVADM-06 independently disables entry %j", async (options) => {
  const f = fixture(options);
  await withLoopback(f.app, async (s) => {
    await get(s, base).expect(404);
    expect(f.port.open).not.toHaveBeenCalled();
  });
});
it.each([
  "",
  `dne_session=${token}`,
  "dne_staff=bad",
  `dne_staff=${token}; dne_staff=${token}`,
  `DNE_STAFF=${token}`,
])(
  "REVADM-06 denies ambiguous or absent explicit staff cookie %s",
  async (cookie) => {
    const f = fixture();
    await withLoopback(f.app, async (s) => {
      await get(s, base, cookie).expect(403);
      expect(f.port.open).not.toHaveBeenCalled();
    });
  },
);
it("REVADM-06 denies a mismatched Host without calling the store", async () => {
  const f = fixture();
  await withLoopback(f.app, async (s) => {
    await request(s)
      .get(base)
      .set("Host", "elsewhere.invalid")
      .set("Cookie", `dne_staff=${token}`)
      .expect(403);
    expect(f.port.open).not.toHaveBeenCalled();
  });
});
it.each(["origin", "csrf", "media"])(
  "REVADM-06 rejects forged POST %s",
  async (change) => {
    const f = fixture();
    await withLoopback(f.app, async (s) => {
      let call = request(s)
        .post(base + "/assign")
        .set("Host", host)
        .set("Cookie", `dne_staff=${token}`)
        .set(
          "Origin",
          change === "origin" ? "http://elsewhere.invalid" : origin,
        );
      call = change === "media" ? call.type("json") : call.type("form");
      await call
        .send({
          ...payload(),
          csrf: change === "csrf" ? "forged" : csrf(token, secret),
        })
        .expect(403);
      expect(f.port.assign).not.toHaveBeenCalled();
    });
  },
);
it("REVADM-03 checks only structural references and produces an unchecked confirmation", async () => {
  const f = fixture();
  await withLoopback(f.app, async (s) => {
    const response = await post(s, base + "/check", {
      csrf: csrf(token, secret),
      ...refs,
      sourceRevision: "1",
    }).expect(200);
    expect(f.port.check).toHaveBeenCalledWith(token, refs);
    expect(response.text).toContain("Confirm private sample assignment");
    expect(response.text).not.toMatch(/name="confirm"[^>]*checked/);
  });
});
it.each(["applied", "replayed"] as const)(
  "REVADM-03 returns the safe %s receipt for the exact original payload",
  async (kind) => {
    const f = fixture();
    f.port.assign.mockResolvedValue({
      kind,
      deadline: performance.now() + 60000,
      row: f.row,
    });
    await withLoopback(f.app, async (s) => {
      const response = await post(s, base + "/assign", payload()).expect(200);
      expect(f.port.assign).toHaveBeenCalledWith(token, input);
      expect(response.text).toContain("data-receipt");
      expect(response.text).not.toContain(token);
    });
  },
);
it.each(["denied", "invalid", "conflict", "unavailable"] as const)(
  "REVADM-08 preserves actual store failure %s",
  async (kind) => {
    const f = fixture();
    f.port.assign.mockResolvedValue({ kind });
    await withLoopback(f.app, async (s) => {
      const response = await post(s, base + "/assign", payload()).expect(
        { denied: 403, invalid: 422, conflict: 409, unavailable: 503 }[kind],
      );
      if (kind === "unavailable") {
        expect(response.text).toContain(operationId);
        expect(response.text).toContain("Retry this exact assignment");
        expect(response.text).not.toMatch(/name="confirm"[^>]*checked/);
      } else expect(response.text).not.toContain("Retry this exact assignment");
    });
  },
);
it("REVADM-08 retains the original immutable attempt after a thrown uncertain write", async () => {
  const f = fixture();
  f.port.assign.mockRejectedValue(Error("PRIVATE raw database credential"));
  await withLoopback(f.app, async (s) => {
    const response = await post(s, base + "/assign", payload()).expect(503);
    expect(response.text).toContain(operationId);
    expect(response.text).toContain(input.startsAt);
    expect(response.text).toContain("readonly");
    expect(response.text).not.toContain("PRIVATE raw");
    expect(f.port.assign).toHaveBeenCalledOnce();
  });
});
it.each([
  "extra",
  "duplicate",
  "confirmation",
  "bad-source",
  "bad-window",
  "query",
])(
  "REVADM-06 rejects altered assignment input %s before a write",
  async (change) => {
    const f = fixture();
    await withLoopback(f.app, async (s) => {
      const body: Record<string, unknown> = payload();
      if (change === "extra") body.actorId = grantId;
      if (change === "duplicate") body.reviewerId = [reviewerId, reviewerId];
      if (change === "confirmation") body.confirm = "no";
      if (change === "bad-source") body.sourceRevision = "0";
      if (change === "bad-window") body.expiresAt = "bad";
      await post(
        s,
        base + "/assign" + (change === "query" ? "?extra=1" : ""),
        body,
      ).expect(422);
      expect(f.port.assign).not.toHaveBeenCalled();
    });
  },
);
it("REVADM-05 forwards exact history navigation and POST-only own-key recovery", async () => {
  const f = fixture();
  await withLoopback(f.app, async (s) => {
    await get(
      s,
      `${base}/history?evidenceId=${evidenceId}&sourceRevision=1&after=cursor`,
    ).expect(200);
    expect(f.port.history).toHaveBeenCalledWith(
      token,
      { evidenceId, sourceRevision: 1 },
      "cursor",
    );
    await post(s, base + "/recover", {
      csrf: csrf(token, secret),
      operationId,
    }).expect(200);
    expect(f.port.recover).toHaveBeenCalledWith(token, operationId);
    await get(s, base + "/recover?operationId=" + operationId).expect(404);
  });
});
it("REVADM-08 treats absent recovery as uncertainty rather than a proven failed write", async () => {
  const f = fixture();
  f.port.recover.mockResolvedValue({
    kind: "absent",
    deadline: performance.now() + 60000,
  });
  await withLoopback(f.app, async (s) => {
    const response = await post(s, base + "/recover", {
      csrf: csrf(token, secret),
      operationId,
    }).expect(200);
    expect(response.text).toContain(
      "does not establish that no write committed",
    );
    expect(f.port.assign).not.toHaveBeenCalled();
  });
});
it.each(["revoked", "unchanged"] as const)(
  "REVADM-04 explicitly revokes one exact grant, result=%s",
  async (kind) => {
    const f = fixture();
    f.port.revoke.mockResolvedValue({
      kind,
      deadline: performance.now() + 60000,
      row: f.row,
    });
    await withLoopback(f.app, async (s) => {
      await post(s, base + "/revoke", {
        csrf: csrf(token, secret),
        evidenceId,
        sourceRevision: "1",
        exactGrantId: grantId,
        confirm: "yes",
      }).expect(200);
      expect(f.port.revoke).toHaveBeenCalledWith(
        token,
        { evidenceId, sourceRevision: 1 },
        grantId,
      );
    });
  },
);
it("REVADM-07 withholds reference data after rendering exhausts the authority deadline", async () => {
  const f = fixture();
  const now = vi.spyOn(performance, "now");
  f.port.selfReference.mockImplementation(async () => ({
    kind: "ready",
    deadline: performance.now() + 100,
    reference: {
      reviewerId,
      get expiresAt() {
        now.mockReturnValue(1e12);
        return input.expiresAt;
      },
    },
  }));
  try {
    await withLoopback(f.app, async (s) => {
      const response = await get(s, reference).expect(403);
      expect(response.text).not.toContain(reviewerId);
    });
  } finally {
    now.mockRestore();
  }
});
it("REVADM-08 withholds a late assignment receipt but preserves the original manual retry", async () => {
  const f = fixture();
  f.port.assign.mockResolvedValue({
    kind: "applied",
    deadline: -1,
    row: f.row,
  });
  await withLoopback(f.app, async (s) => {
    const response = await post(s, base + "/assign", payload()).expect(503);
    expect(response.text).not.toContain("data-receipt");
    expect(response.text).toContain(operationId);
    expect(response.text).toContain("Retry this exact assignment");
  });
});

it.each([
  "open",
  "selfReference",
  "check",
  "history",
  "recover",
  "revoke",
] as const)(
  "REVADM-06 does not disclose metadata when current store authority denies %s",
  async (method) => {
    const f = fixture();
    f.port[method].mockResolvedValue({ kind: "denied" });
    await withLoopback(f.app, async (s) => {
      const response =
        method === "open"
          ? await get(s, base).expect(403)
          : method === "selfReference"
            ? await get(s, reference).expect(403)
            : method === "history"
              ? await get(
                  s,
                  `${base}/history?evidenceId=${evidenceId}&sourceRevision=1`,
                ).expect(403)
              : method === "check"
                ? await post(s, base + "/check", {
                    csrf: csrf(token, secret),
                    ...refs,
                    sourceRevision: "1",
                  }).expect(403)
                : method === "recover"
                  ? await post(s, base + "/recover", {
                      csrf: csrf(token, secret),
                      operationId,
                    }).expect(403)
                  : await post(s, base + "/revoke", {
                      csrf: csrf(token, secret),
                      evidenceId,
                      sourceRevision: "1",
                      exactGrantId: grantId,
                      confirm: "yes",
                    }).expect(403);
      expect(response.text).not.toContain("data-receipt");
      expect(response.text).not.toContain("data-reviewer-reference");
    });
  },
);
it.each([base, reference])(
  "REVADM-06 rejects unaccepted discovery filters at %s",
  async (path) => {
    const f = fixture();
    await withLoopback(f.app, async (s) => {
      await get(s, path + "?member=all").expect(422);
      expect(f.port.open).not.toHaveBeenCalled();
      expect(f.port.selfReference).not.toHaveBeenCalled();
    });
  },
);
it.each(["extra", "source"])(
  "REVADM-06 rejects invalid reference checks: %s",
  async (variant) => {
    const f = fixture();
    await withLoopback(f.app, async (s) => {
      const body = {
        csrf: csrf(token, secret),
        ...refs,
        sourceRevision: variant === "source" ? "0" : "1",
        ...(variant === "extra" ? { authority: "admin" } : {}),
      };
      await post(s, base + "/check", body).expect(422);
      expect(f.port.check).not.toHaveBeenCalled();
    });
  },
);
it.each(["extra", "source", "cursor"])(
  "REVADM-06 rejects unaccepted history navigation: %s",
  async (variant) => {
    const f = fixture();
    await withLoopback(f.app, async (s) => {
      await get(
        s,
        `${base}/history?evidenceId=${evidenceId}&sourceRevision=${variant === "source" ? "0" : "1"}${variant === "extra" ? "&owner=all" : variant === "cursor" ? "&after=" + "x".repeat(1025) : ""}`,
      ).expect(422);
      expect(f.port.history).not.toHaveBeenCalled();
    });
  },
);
it.each(["extra", "key", "query"])(
  "REVADM-06 rejects unaccepted operation recovery: %s",
  async (variant) => {
    const f = fixture();
    await withLoopback(f.app, async (s) => {
      await post(
        s,
        base + "/recover" + (variant === "query" ? "?key=foreign" : ""),
        {
          csrf: csrf(token, secret),
          operationId: variant === "key" ? "bad" : operationId,
          ...(variant === "extra" ? { evidenceId } : {}),
        },
      ).expect(422);
      expect(f.port.recover).not.toHaveBeenCalled();
    });
  },
);
it.each(["extra", "confirmation", "grant", "source"])(
  "REVADM-06 rejects unaccepted exact revocation: %s",
  async (variant) => {
    const f = fixture();
    await withLoopback(f.app, async (s) => {
      await post(s, base + "/revoke", {
        csrf: csrf(token, secret),
        evidenceId,
        sourceRevision: variant === "source" ? "0" : "1",
        exactGrantId: variant === "grant" ? "bad" : grantId,
        confirm: variant === "confirmation" ? "no" : "yes",
        ...(variant === "extra" ? { reviewerId } : {}),
      }).expect(422);
      expect(f.port.revoke).not.toHaveBeenCalled();
    });
  },
);
it("REVADM-08 sanitizes a thrown read failure without creating a retry assignment", async () => {
  const f = fixture();
  f.port.open.mockRejectedValue(Error("PRIVATE SQL source"));
  await withLoopback(f.app, async (s) => {
    const response = await get(s, base).expect(503);
    expect(response.text).not.toContain("PRIVATE SQL");
    expect(response.text).not.toContain("Retry this exact assignment");
    expect(f.port.assign).not.toHaveBeenCalled();
  });
});
it("REVADM-07 refuses a nonfinite provider deadline before publishing history", async () => {
  const f = fixture();
  f.port.history.mockResolvedValue({
    kind: "ready",
    deadline: NaN,
    history: { evidenceId, sourceRevision: 1, rows: [f.row], next: null },
  });
  await withLoopback(f.app, async (s) => {
    const response = await get(
      s,
      `${base}/history?evidenceId=${evidenceId}&sourceRevision=1`,
    ).expect(403);
    expect(response.text).not.toContain("data-exact-grant");
  });
});

it("REVADM-08 withholds a late revocation receipt without creating an assignment retry", async () => {
  const f = fixture();
  f.port.revoke.mockResolvedValue({
    kind: "revoked",
    deadline: -1,
    row: f.row,
  });
  await withLoopback(f.app, async (s) => {
    const response = await post(s, base + "/revoke", {
      csrf: csrf(token, secret),
      evidenceId,
      sourceRevision: "1",
      exactGrantId: grantId,
      confirm: "yes",
    }).expect(503);
    expect(response.text).not.toContain("data-receipt");
    expect(response.text).not.toContain("Retry this exact assignment");
    expect(f.port.revoke).toHaveBeenCalledOnce();
    expect(f.port.assign).not.toHaveBeenCalled();
  });
});
