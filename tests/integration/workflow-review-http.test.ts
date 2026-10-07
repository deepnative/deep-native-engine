import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { workflowReviewStore } from "../../src/workflow-review.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

const pool = testPool();
const db = store(pool);
const feedback = workflowFeedbackStore(pool);
beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(async () => pool.end());

it.each(["technical", "professional", "explorer"] as const)(
  "WFREV-01 %s member checks an exact saved note before offering private review",
  async (background) => {
    const token = randomBytes(32).toString("hex");
    await db.create(token, {
      background,
      goal: background === "explorer" ? "everyday" : "work",
    });
    const note =
      "Invented original feedback: make the example easier to follow.";
    expect(await feedback.save(token, "WF-001", 1, note, 0)).toBe(true);
    const options = {
      origin: "http://localhost",
      secret: "synthetic-workflow-review-test-secret",
      workflowFeedback: feedback,
      workflowReviewRequests: true,
      workflowReviews: workflowReviewStore(
        pool,
        { enabled: true, mode: "test" },
        "synthetic-workflow-review-test-secret",
      ),
      mode: "test" as const,
    };
    await withLoopback(app(db, options), async (server) => {
      const own = await request(server)
        .get("/workflow-feedback/WF-001")
        .set("Host", "localhost")
        .set("Cookie", `dne_preview=${token}`);
      expect(own.status).toBe(200);
      expect(own.text).toContain(note);
      // Passing owner-save/read baseline above is already delivered. This
      // request preview is missing behavior, not a module-import/setup red.
      const checked = await request(server)
        .get("/workflow-feedback/WF-001/review")
        .set("Host", "localhost")
        .set("Cookie", `dne_preview=${token}`);
      expect(checked.status).toBe(200);
      expect(checked.text).toContain("Request private review");
      expect(checked.text).toContain(note);
      expect(checked.text).toContain("revision 1");
      expect(checked.text).toContain("Permission ends");
      expect(checked.text).toMatch(/type="checkbox"[^>]*name="confirm"/);
      expect(checked.text).not.toMatch(/type="checkbox"[^>]*checked/);
      const field = (html: string, name: string) => {
        const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
        expect(match).not.toBeNull();
        return match![1]!;
      };
      const body = {
        csrf: field(checked.text, "csrf"),
        checked: field(checked.text, "checked"),
        operationId: field(checked.text, "operationId"),
        confirm: "yes",
      };
      const post = (path: string, data: Record<string, string>) =>
        request(server)
          .post(path)
          .set("Host", "localhost")
          .set("Origin", "http://localhost")
          .set("Cookie", `dne_preview=${token}`)
          .type("form")
          .send(data);
      const submitted = await post("/workflow-feedback/review/request", body);
      expect(submitted.status).toBe(200);
      expect(submitted.text).toContain("Private review request receipt");
      expect(submitted.text).toContain("pending");
      expect(submitted.text).not.toContain(note);
      const requestId = field(submitted.text, "requestId");
      const replayed = await post("/workflow-feedback/review/request", body);
      expect(replayed.status).toBe(200);
      expect(field(replayed.text, "requestId")).toBe(requestId);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM workflow_review_requests",
          )
        ).rows[0].n,
      ).toBe(1);
      const operation = (
        await pool.query(
          "SELECT instruction::text AS text FROM workflow_review_operations WHERE operation_id=$1",
          [body.operationId],
        )
      ).rows[0];
      expect(operation.text).not.toContain(note);
      const withdrawn = await post("/workflow-feedback/review/withdraw", {
        csrf: body.csrf,
        requestId,
        operationId: field(submitted.text, "operationId"),
        confirm: "yes",
      });
      expect(withdrawn.status).toBe(200);
      expect(withdrawn.text).toContain("withdrawn");
      const inspected = await post("/workflow-feedback/review/inspect", {
        csrf: body.csrf,
        operationId: body.operationId,
      });
      expect(inspected.status).toBe(200);
      expect(inspected.text).toContain("withdrawn");
    });
    expect((await feedback.list(token))?.[0]?.note).toBe(note);
  },
);
