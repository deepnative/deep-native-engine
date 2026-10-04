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
    expect(f.store.publish).toHaveBeenCalledWith("session", id, 2, id);
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
    expect(f.store.publish).toHaveBeenCalledWith("session", id, NaN, "");
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
