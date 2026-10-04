import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { reviewTimeStore } from "./review-time-store.ts";
import type { SampleFeedbackStore } from "./sample-feedback.ts";
import { sampleUuid } from "./sample-feedback-values.ts";
import { escape, hidden, page } from "./views.ts";

export function mountReviewTimeRoutes(
  app: Express,
  store: ReturnType<typeof reviewTimeStore>,
  feedback: SampleFeedbackStore,
  enabled: boolean,
) {
  const receiptPath = (id: string) =>
    `/review-minutes/${encodeURIComponent(id)}`;
  function failure(res: Response, kind: string, req?: Request) {
    const body = req?.body as Record<string, unknown> | undefined;
    const recover =
      kind === "unavailable" &&
      req?.method === "POST" &&
      /^\/evidence\/[^/]+\/review-allocation$/.test(req.path) &&
      sampleUuid(String(req.params.id)) &&
      body &&
      typeof body.operationId === "string" &&
      sampleUuid(body.operationId) &&
      typeof body.ceiling === "string" &&
      /^[1-9][0-9]{0,2}$/.test(body.ceiling) &&
      Number(body.ceiling) <= 120;
    const recovery = recover
      ? `<form method="post" action="/evidence/${encodeURIComponent(String(req.params.id))}/review-allocation">${hidden(res.locals.csrf as string)}<input type="hidden" name="operationId" value="${escape(body.operationId as string)}"><input type="hidden" name="ceiling" value="${escape(body.ceiling as string)}"><p>This repeats only your original allocation request with the same reference and ceiling. It does not reserve a second allocation if the first request committed.</p><button>Reconcile this same allocation</button></form>`
      : "";
    return res
      .status(
        kind === "denied"
          ? 404
          : kind === "conflict" || kind === "insufficient"
            ? 409
            : 503,
      )
      .send(
        page(
          "Review minutes unavailable",
          `<h1>Review minutes unavailable</h1><p role="alert">This operation cannot be confirmed. Nothing is retried automatically.</p><p><a href="/review-minutes">Inspect your review-minute history</a></p>${recovery}<a href="/evidence">Your private evidence</a>`,
        ),
      );
  }
  const wrap =
    (use: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await use(req, res);
      } catch {
        failure(res, "unavailable", req);
      }
    };
  app.get(
    "/review-minutes",
    wrap(async (req, res) => {
      if (
        Object.keys(req.query).some((key) => key !== "after") ||
        (req.query.after !== undefined && typeof req.query.after !== "string")
      )
        return failure(res, "denied");
      const result = await store.history(
        res.locals.token as string,
        req.query.after as string | undefined,
      );
      if (result.kind !== "ready") return failure(res, result.kind, req);
      res.send(
        page(
          "Your review-minute history",
          `<section class="reading"><h1>Your review-minute history</h1><p>Private local test-unit receipts, including retained receipts for removed samples.</p>${result.receipts.length ? `<ul>${result.receipts.map((r) => `<li><a href="${escape(receiptPath(r.allocationId))}">Review allocation ${escape(r.allocationId)}</a>: ${escape(r.state)}; held ${r.held}, consumed ${r.consumed}, returned ${r.released}.</li>`).join("")}</ul>` : "<p>No review allocations yet.</p>"}${result.next ? `<a href="/review-minutes?after=${encodeURIComponent(result.next)}">Next receipts</a>` : ""}<p><a href="/evidence">Your private evidence</a></p></section>`,
        ),
      );
    }),
  );
  app.get(
    "/evidence/:id/review-allocation",
    wrap(async (req, res) => {
      const id = String(req.params.id);
      const source = await feedback.owner(res.locals.token as string, id);
      if (source.kind !== "ready") return failure(res, source.kind);
      const path = `/evidence/${encodeURIComponent(id)}/review-allocation`;
      res.send(
        page(
          "Reserve review test minutes",
          `<section class="reading"><h1>Reserve review test minutes</h1><p>Private local rehearsal using existing test units. No payment, professional qualification or response time is promised.</p>${enabled ? `<form method="post" action="${escape(path)}">${hidden(res.locals.csrf as string)}<label>Operation reference<input name="operationId" value="${randomUUID()}" readonly></label><p>Keep this reference until the result is confirmed. Reuse it with the same ceiling to reconcile an uncertain request.</p><label>Maximum minutes<input name="ceiling" type="number" min="1" max="120" required></label><button>Reserve test minutes</button></form>` : "<p>New review allocations are paused. Existing receipts and cancellation remain available.</p>"}<a href="/review-minutes">Your review-minute history</a><p><a href="/evidence">Your private evidence</a></p></section>`,
        ),
      );
    }),
  );
  app.post(
    "/evidence/:id/review-allocation",
    wrap(async (req, res) => {
      const body = req.body as Record<string, unknown> | undefined;
      if (
        !body ||
        typeof body.operationId !== "string" ||
        !sampleUuid(body.operationId) ||
        typeof body.ceiling !== "string" ||
        !/^[1-9][0-9]{0,2}$/.test(body.ceiling)
      )
        return failure(res, "denied");
      const result = await store.allocate(
        res.locals.token as string,
        String(req.params.id),
        body.operationId,
        Number(body.ceiling),
      );
      if (result.kind !== "applied" && result.kind !== "replayed")
        return failure(res, result.kind, req);
      res.redirect(303, receiptPath(result.receipt.allocationId));
    }),
  );
  app.get(
    "/review-minutes/:id",
    wrap(async (req, res) => {
      const result = await store.receipt(
        res.locals.token as string,
        String(req.params.id),
      );
      if (result.kind !== "applied" && result.kind !== "replayed")
        return failure(res, result.kind, req);
      const r = result.receipt;
      res.send(
        page(
          "Your review-minute receipt",
          `<section class="reading"><h1>Your review-minute receipt</h1><p>Local test units only.</p><dl><dt>State</dt><dd>${escape(r.state)}</dd><dt>Reserved</dt><dd>${r.held}</dd><dt>Consumed</dt><dd>${r.consumed}</dd><dt>Returned</dt><dd>${r.released}</dd></dl>${!r.sourceAvailable ? "<p>The private source is no longer available. This receipt retains accounting metadata only.</p>" : ""}${r.state === "allocated" ? `<form method="post" action="${escape(receiptPath(r.allocationId))}/cancel">${hidden(res.locals.csrf as string)}<button>Cancel unused allocation</button></form>` : "<p>Only an allocation that has not begun can be cancelled here.</p>"}<a href="/review-minutes">Your review-minute history</a><p><a href="/evidence">Your private evidence</a></p></section>`,
        ),
      );
    }),
  );
  app.post(
    "/review-minutes/:id/cancel",
    wrap(async (req, res) => {
      const result = await store.cancel(
        res.locals.token as string,
        String(req.params.id),
      );
      if (result.kind !== "applied" && result.kind !== "replayed")
        return failure(res, result.kind, req);
      res.redirect(303, receiptPath(result.receipt.allocationId));
    }),
  );
}
