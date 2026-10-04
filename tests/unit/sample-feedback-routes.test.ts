import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { withLoopback } from "../support/loopback-server.ts";
import { mountSampleFeedbackRoutes } from "../../src/sample-feedback-routes.ts";
import type {
  SampleFeedbackStore,
  SampleFeedbackView,
} from "../../src/sample-feedback.ts";
const id = "11111111-1111-4111-8111-111111111111";
const ownerPath = `/evidence/${id}/feedback`;
const staffPath = `/review${ownerPath}`;
function fixture() {
  const view: SampleFeedbackView = {
    kind: "ready",
    evidenceId: id,
    submissionId: id,
    title: "Invented source",
    source: "repeat and repeat",
    sourceSha256: "a".repeat(64),
    sourceRevision: 1,
    consent: true,
    records: [],
    next: null,
  };
  const saved = { kind: "saved" as const, id, revision: 1 };
  const store = {
    beginReview: vi
      .fn<SampleFeedbackStore["beginReview"]>()
      .mockResolvedValue({ kind: "unavailable" }),
    owner: vi.fn<SampleFeedbackStore["owner"]>().mockResolvedValue(view),
    reviewer: vi.fn<SampleFeedbackStore["reviewer"]>().mockResolvedValue(view),
    save: vi.fn<SampleFeedbackStore["save"]>().mockResolvedValue(saved),
    publish: vi.fn<SampleFeedbackStore["publish"]>().mockResolvedValue(saved),
    clarify: vi.fn<SampleFeedbackStore["clarify"]>().mockResolvedValue(saved),
    answer: vi.fn<SampleFeedbackStore["answer"]>().mockResolvedValue(saved),
  };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.token = "session";
    res.locals.csrf = "csrf-token";
    next();
  });
  mountSampleFeedbackRoutes(app, store);
  return { app, store, view };
}
it("shows owner empty state and reviewer draft without inventing a publication", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    const owner = await request(server).get(ownerPath).expect(200);
    expect(owner.text).toContain("No published feedback");
    expect(owner.text).not.toContain("Save private feedback draft");
    const staff = await request(server).get(staffPath).expect(200);
    expect(staff.text).toContain("Save private feedback draft");
    expect(staff.text).not.toContain("Publish saved feedback");
    expect(f.store.owner).toHaveBeenCalledWith("session", id, undefined);
    expect(f.store.reviewer).toHaveBeenCalledWith("session", id);
  });
});
it("passes an owner continuation but rejects extra filters and reviewer continuations", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    await request(server)
      .get(ownerPath + "?after=" + id)
      .expect(200);
    expect(f.store.owner).toHaveBeenCalledWith("session", id, id);
    await request(server)
      .get(ownerPath + "?other=1")
      .expect(403);
    await request(server)
      .get(staffPath + "?after=" + id)
      .expect(403);
    expect(f.store.owner).toHaveBeenCalledOnce();
    expect(f.store.reviewer).not.toHaveBeenCalled();
  });
});
it("binds a repeated quote to the selected occurrence and leaves blank effort unspecified", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    await request(server)
      .post(staffPath + "/draft")
      .send({
        revision: "0",
        operationId: id,
        preparationMinutes: "",
        reviewMinutes: "3",
        label0: "Clarity",
        comment0: "Explain the second example",
        quote0: "repeat",
        occurrence0: "2",
      })
      .expect(303)
      .expect("Location", staffPath);
    expect(f.store.save).toHaveBeenCalledWith("session", id, {
      revision: 0,
      operationId: id,
      preparationMinutes: null,
      reviewMinutes: 3,
      criteria: [
        {
          label: "Clarity",
          comment: "Explain the second example",
          quote: "repeat",
          start: 11,
          end: 17,
        },
      ],
    });
  });
});
it("requires explicit publication confirmation and submits only the saved revision", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    await request(server)
      .post(staffPath + "/publish")
      .send({ revision: "2", operationId: id })
      .expect(422);
    expect(f.store.publish).not.toHaveBeenCalled();
    await request(server)
      .post(staffPath + "/publish")
      .send({ revision: "2", operationId: id, confirm: "yes" })
      .expect(303);
    expect(f.store.publish).toHaveBeenCalledWith(
      "session",
      id,
      2,
      id,
      undefined,
    );
  });
});
it.each(["clarify", "answer"] as const)(
  "submits a bounded %s request without replaying it",
  async (action) => {
    const f = fixture();
    await withLoopback(f.app, async (server) => {
      const path = action === "answer" ? staffPath : ownerPath;
      await request(server)
        .post(path + "/" + action)
        .send({
          feedbackId: id,
          message: "Explain this example",
          operationId: id,
        })
        .expect(303)
        .expect("Location", path);
      expect(f.store[action]).toHaveBeenCalledExactlyOnceWith(
        "session",
        id,
        id,
        "Explain this example",
        id,
      );
    });
  },
);
it.each([
  ["denied", 403],
  ["invalid", 422],
  ["conflict", 409],
  ["unavailable", 503],
] as const)(
  "preserves attempted text safely for %s writes",
  async (kind, status) => {
    const f = fixture();
    f.store.clarify.mockResolvedValue({ kind });
    await withLoopback(f.app, async (server) => {
      const response = await request(server)
        .post(ownerPath + "/clarify")
        .send({
          message: "<script>invented</script>",
          csrf: "secret-csrf",
          operationId: id,
        })
        .expect(status);
      expect(response.text).toContain("&lt;script&gt;invented&lt;/script&gt;");
      expect(response.text).not.toContain("<script>invented");
      expect(response.text).not.toContain("secret-csrf");
      expect(response.text).toContain("Nothing is retried automatically");
      expect(f.store.clarify).toHaveBeenCalledOnce();
    });
  },
);
it("contains a thrown dependency error and retains only the caller's attempted text", async () => {
  const f = fixture();
  f.store.answer.mockRejectedValue(Error("private database diagnostic"));
  await withLoopback(f.app, async (server) => {
    const response = await request(server)
      .post(staffPath + "/answer")
      .send({ message: "My attempted answer" })
      .expect(503);
    expect(response.text).toContain("My attempted answer");
    expect(response.text).not.toContain("private database diagnostic");
    expect(response.text).not.toContain(f.view.source);
    expect(f.store.answer).toHaveBeenCalledOnce();
  });
});
it("rejects unexpected or structured form fields before any write", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    await request(server)
      .post(staffPath + "/draft")
      .send({ administrator: "true" })
      .expect(422);
    await request(server)
      .post(staffPath + "/draft")
      .send({ label0: ["one", "two"] })
      .expect(422);
    expect(f.store.save).not.toHaveBeenCalled();
    expect(f.store.reviewer).not.toHaveBeenCalled();
  });
});
it.each(["denied", "unavailable"] as const)(
  "withholds feedback reads and draft writes when current access is %s",
  async (kind) => {
    const f = fixture();
    f.store.reviewer.mockResolvedValue({ kind });
    f.store.owner.mockResolvedValue({ kind });
    await withLoopback(f.app, async (server) => {
      await request(server)
        .get(ownerPath)
        .expect(kind === "denied" ? 403 : 503);
      const response = await request(server)
        .post(staffPath + "/draft")
        .send({ comment0: "Keep my attempted comment" })
        .expect(kind === "denied" ? 403 : 503);
      expect(response.text).toContain("Keep my attempted comment");
      expect(response.text).not.toContain(f.view.source);
      expect(f.store.save).not.toHaveBeenCalled();
    });
  },
);
it("handles a failed read without requiring a submitted form", async () => {
  const f = fixture();
  f.store.owner.mockRejectedValue(Error("private diagnostic"));
  await withLoopback(f.app, async (server) => {
    const response = await request(server).get(ownerPath).expect(503);
    expect(response.text).not.toContain("private diagnostic");
    expect(response.text).not.toContain("Your attempted text");
  });
});
it.each(["missing", "out of range", "unmatched", "malformed"])(
  "preserves an invalid %s quote selection for correction",
  async (reason) => {
    const f = fixture();
    f.store.save.mockResolvedValue({ kind: "invalid" });
    const body: Record<string, string> = {
      label0: "Clarity",
      comment0: "Keep this comment",
      quote0: "repeat",
      occurrence0: "2",
      revision: "bad",
      preparationMinutes: "0",
    };
    if (reason === "missing") delete body.quote0;
    if (reason === "out of range") body.occurrence0 = "999";
    if (reason === "unmatched") body.quote0 = "absent";
    if (reason === "malformed") body.occurrence0 = "-1";
    await withLoopback(f.app, async (server) => {
      const response = await request(server)
        .post(staffPath + "/draft")
        .send(body)
        .expect(422);
      expect(response.text).toContain("Keep this comment");
      expect(f.store.save).toHaveBeenCalledWith(
        "session",
        id,
        expect.objectContaining({
          revision: NaN,
          reviewMinutes: NaN,
          preparationMinutes: 0,
          criteria: [expect.objectContaining({ start: -1 })],
        }),
      );
    });
  },
);
it("rejects a publication missing its revision and operation through the store contract", async () => {
  const f = fixture();
  f.store.publish.mockResolvedValue({ kind: "invalid" });
  await withLoopback(f.app, async (server) => {
    await request(server)
      .post(staffPath + "/publish")
      .send({ confirm: "yes" })
      .expect(422);
    expect(f.store.publish).toHaveBeenCalledWith(
      "session",
      id,
      NaN,
      "",
      undefined,
    );
  });
});
it("passes absent exchange fields as invalid empty values rather than inventing data", async () => {
  const f = fixture();
  f.store.clarify.mockResolvedValue({ kind: "invalid" });
  await withLoopback(f.app, async (server) => {
    await request(server)
      .post(ownerPath + "/clarify")
      .send({})
      .expect(422);
    expect(f.store.clarify).toHaveBeenCalledWith("session", id, "", "", "");
  });
});
it("keeps both optional effort fields unspecified when the form leaves them blank", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    await request(server)
      .post(staffPath + "/draft")
      .send({
        revision: "0",
        operationId: id,
        preparationMinutes: "",
        reviewMinutes: "",
        label0: "Clarity",
        comment0: "Explain",
        quote0: "repeat",
        occurrence0: "1",
      })
      .expect(303);
    expect(f.store.save).toHaveBeenCalledWith(
      "session",
      id,
      expect.objectContaining({
        preparationMinutes: null,
        reviewMinutes: null,
      }),
    );
  });
});

it("passes exact reviewer begin references and does not begin on malformed bodies", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    for (const body of [
      [],
      { allocationId: id, grantId: id, operationId: id, unexpected: "x" },
    ]) {
      expect(
        (await request(server).post(`${staffPath}/begin`).send(body)).status,
      ).toBe(422);
    }
    expect(f.store.beginReview).not.toHaveBeenCalled();
    expect(
      (await request(server).post(`${staffPath}/begin`).send({})).status,
    ).toBe(503);
    expect(f.store.beginReview).toHaveBeenLastCalledWith(
      "session",
      id,
      "",
      "",
      "",
    );
    const receipt = {
      allocationId: id,
      state: "begun" as const,
      ceiling: 20,
      held: 20,
      consumed: 0,
      released: 0,
      reviewMinutes: 0,
      preparationMinutes: 0,
      sourceAvailable: true,
    };
    for (const kind of ["applied", "replayed"] as const) {
      f.store.beginReview.mockResolvedValue({ kind, receipt });
      const result = await request(server)
        .post(`${staffPath}/begin`)
        .send({ allocationId: id, grantId: id, operationId: id });
      expect(result.status).toBe(303);
      expect(result.headers.location).toBe(staffPath);
    }
    expect(f.store.beginReview).toHaveBeenLastCalledWith(
      "session",
      id,
      id,
      id,
      id,
    );
  });
});
it.each([false, true])(
  "passes explicit allocated publication intervals with preparation=%s",
  async (prep) => {
    const f = fixture();
    await withLoopback(f.app, async (server) => {
      const reviewStart = "2026-10-04T12:00:00Z",
        reviewEnd = "2026-10-04T12:10:00Z";
      const response = await request(server)
        .post(`${staffPath}/publish`)
        .send({
          confirm: "yes",
          revision: "1",
          operationId: id,
          allocationId: id,
          grantId: id,
          reviewStart,
          reviewEnd,
          ...(prep
            ? {
                preparationStart: "2026-10-04T11:55:00Z",
                preparationEnd: reviewStart,
              }
            : {}),
        });
      expect(response.status).toBe(303);
      expect(f.store.publish).toHaveBeenCalledWith("session", id, 1, id, {
        allocationId: id,
        grantId: id,
        intervals: {
          reviewStart: new Date(reviewStart),
          reviewEnd: new Date(reviewEnd),
          preparationStart: prep ? new Date("2026-10-04T11:55:00Z") : null,
          preparationEnd: prep ? new Date(reviewStart) : null,
        },
      });
    });
  },
);
it("passes missing allocated fields as invalid values, never inventing a time grant or interval", async () => {
  const f = fixture();
  await withLoopback(f.app, async (server) => {
    f.store.publish.mockResolvedValue({ kind: "invalid" });
    expect(
      (
        await request(server).post(`${staffPath}/publish`).send({
          confirm: "yes",
          revision: "1",
          operationId: id,
          allocationId: id,
        })
      ).status,
    ).toBe(422);
    const input = f.store.publish.mock.calls[0]![4]!;
    expect(input.grantId).toBe("");
    expect(Number.isNaN(+input.intervals.reviewStart)).toBe(true);
    expect(Number.isNaN(+input.intervals.reviewEnd)).toBe(true);
  });
});
it.each([false, true])(
  "preserves the exact allocated publication for manual reconciliation after uncertainty (throw=%s)",
  async (throws) => {
    const f = fixture();
    if (throws)
      f.store.publish.mockRejectedValue(Error("private database detail"));
    else f.store.publish.mockResolvedValue({ kind: "unavailable" });
    await withLoopback(f.app, async (server) => {
      const original = {
        csrf: "stale-csrf",
        confirm: "yes",
        revision: "3",
        operationId: id,
        allocationId: id,
        grantId: id,
        reviewStart: "2026-10-04T12:00:00Z",
        reviewEnd: "2026-10-04T12:10:00Z",
        preparationStart: "2026-10-04T11:55:00Z",
        preparationEnd: "2026-10-04T12:00:00Z",
      };
      const result = await request(server)
        .post(staffPath + "/publish")
        .send(original)
        .expect(503);
      expect(result.text).toContain("Reconcile original publication");
      expect(result.text).toContain('action="' + staffPath + '/publish"');
      for (const [key, value] of Object.entries(original).filter(
        ([key]) => key !== "csrf",
      ))
        expect(result.text).toContain(
          'type="hidden" name="' + key + '" value="' + value + '"',
        );
      expect(result.text).toContain('name="csrf" value="csrf-token"');
      expect(result.text).not.toContain("stale-csrf");
      expect(result.text).not.toContain("private database detail");
      expect(f.store.publish).toHaveBeenCalledOnce();
      f.store.publish.mockResolvedValue({ kind: "saved", id, revision: 3 });
      await request(server)
        .post(staffPath + "/publish")
        .send({ ...original, csrf: "csrf-token" })
        .expect(303);
      expect(f.store.publish.mock.calls[1]).toEqual(
        f.store.publish.mock.calls[0],
      );
    });
  },
);
it.each(["conflict", "denied", "invalid"] as const)(
  "does not offer publication replay after %s",
  async (kind) => {
    const f = fixture();
    f.store.publish.mockResolvedValue({ kind });
    await withLoopback(f.app, async (server) => {
      const result = await request(server)
        .post(staffPath + "/publish")
        .send({
          confirm: "yes",
          revision: "1",
          operationId: id,
          allocationId: id,
        });
      expect(result.text).not.toContain("Reconcile original publication");
    });
  },
);
