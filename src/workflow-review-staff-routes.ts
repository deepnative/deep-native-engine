import { randomUUID } from "node:crypto";
import type { Express, Response } from "express";
import type { ApplicationMode } from "./adapters.ts";
import { sampleUuid } from "./sample-feedback-values.ts";
import { csrf, validCsrf } from "./session.ts";
import { staffCookie, staffCredential } from "./staff-entry-selection.ts";
import { escape, page, hidden } from "./views.ts";
import type {
  WorkflowReviewStaffStore,
  WorkflowReviewGrant,
} from "./workflow-review-staff.ts";
const base = "/operator/workflow-reviews",
  reference = "/moderate/workflow-review-reference",
  read = "/moderate/workflow-reviews";
const field = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${escape(value)}">`;
const notice =
  "<p>Private local preview. Assignment permits finite reading only; it does not establish qualified review or publication.</p>";
function fields(
  value: unknown,
  names: string[],
): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every(
      (n) =>
        Object.hasOwn(value, n) &&
        typeof (value as Record<string, unknown>)[n] === "string",
    )
  );
}
interface Original {
  operationId: string;
  checked?: string;
  grantId?: string;
}
function recovery(message: string, csrf: string, original?: Original) {
  const inspect = original
    ? `<form method="post" action="${base}/inspect" target="_blank" rel="noopener">${hidden(csrf)}${field("operationId", original.operationId)}<button type="submit">Inspect the original operation</button></form><p>Inspection opens a separate tab so this original recovery form stays available.</p>`
    : "";
  const repeat = original?.checked
    ? `<form method="post" action="${base}/assign">${hidden(csrf)}${field("checked", original.checked)}${field("operationId", original.operationId)}<label><input type="checkbox" name="confirm" value="yes" required> Deliberately repeat this exact original assignment without extending its deadline</label><button type="submit">Repeat exact assignment</button></form>`
    : original?.grantId
      ? `<form method="post" action="${base}/revoke">${hidden(csrf)}${field("grantId", original.grantId)}${field("operationId", original.operationId)}<label><input type="checkbox" name="confirm" value="yes" required> Deliberately repeat this exact original revocation</label><button type="submit">Repeat exact revocation</button></form>`
      : "";
  return page(
    "Private workflow review unavailable",
    `${notice}<h1>Private workflow review unavailable</h1><p role="alert">${escape(message)}</p><p>A write may have committed before its response was lost. No automatic retry or replacement operation key is used.</p>${inspect}${repeat}`,
  );
}
function receipt(grant: WorkflowReviewGrant) {
  return page(
    "Private workflow review assignment",
    `${notice}<h1>Private workflow review assignment</h1><dl><dt>Grant reference</dt><dd data-grant-id="${escape(grant.grantId)}">${escape(grant.grantId)}</dd><dt>Request</dt><dd>${escape(grant.requestId)}</dd><dt>Assigned moderator</dt><dd>${escape(grant.moderatorId)}</dd><dt>Reading starts</dt><dd>${escape(grant.startsAt)}</dd><dt>Reading ends</dt><dd>${escape(grant.expiresAt)}</dd></dl><p>Assignment status: ${escape(grant.state ?? (grant.revokedAt ? "revoked" : "recorded"))}. This receipt contains no private note.</p><p><a href="${base}/receipts/${escape(grant.grantId)}">Reload this assignment receipt</a></p>`,
  );
}
export function mountWorkflowReviewStaffRoutes(
  app: Express,
  store: WorkflowReviewStaffStore | undefined,
  options: {
    origin: string;
    secret: string;
    mode?: ApplicationMode;
    localStaffEntry?: boolean;
  },
) {
  const fail = (res: Response, kind: string, original?: Original) =>
    res
      .status(
        kind === "denied"
          ? 403
          : kind === "invalid"
            ? 422
            : kind === "conflict"
              ? 409
              : kind === "disabled"
                ? 404
                : 503,
      )
      .send(
        recovery(
          kind === "unavailable"
            ? "The result cannot be confirmed. Retain the original operation and inspect it before a deliberate repeat."
            : "Current selected authority and the exact permitted source are required.",
          res.locals.workflowReviewStaffCsrf ?? "",
          kind === "unavailable" ? original : undefined,
        ),
      );
  app.use([base, reference, read], (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!store || options.localStaffEntry !== true || options.mode === "live")
      return fail(res, "disabled");
    const selected = staffCookie(req.headers.cookie);
    if (
      selected.kind !== "value" ||
      !staffCredential(selected.value) ||
      req.get("host") !== new URL(options.origin).host
    )
      return fail(res, "denied");
    res.locals.workflowReviewStaffToken = selected.value;
    res.locals.workflowReviewStaffCsrf = csrf(selected.value, options.secret);
    if (
      req.method === "POST" &&
      (req.get("origin") !== options.origin ||
        !req.is("application/x-www-form-urlencoded") ||
        !validCsrf(req.body?.csrf, selected.value, options.secret))
    )
      return fail(res, "denied");
    next();
  });
  const token = (res: Response) =>
    res.locals.workflowReviewStaffToken as string;
  const nonce = (res: Response) => res.locals.workflowReviewStaffCsrf as string;
  const send = (
    res: Response,
    deadline: number,
    render: () => string,
    original?: Original,
  ) => {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      return fail(res, original ? "unavailable" : "denied", original);
    const html = render();
    if (performance.now() >= deadline)
      return fail(res, original ? "unavailable" : "denied", original);
    return res.send(html);
  };
  app.get(base, async (_req, res) => {
    const result = await store!.entry(token(res), "platform_admin");
    if (result.kind !== "ready") return fail(res, result.kind);
    return send(res, result.deadline, () =>
      page(
        "Assign private workflow review",
        `${notice}<h1>Assign private workflow review</h1><form method="post" action="${base}/inspect">${hidden(nonce(res))}<label>Original operation key<input name="operationId" required></label><button type="submit">Inspect original operation</button></form><form method="post" action="${base}/revoke">${hidden(nonce(res))}<label>Exact grant reference<input name="grantId" required></label>${field("operationId", randomUUID())}<label><input type="checkbox" name="confirm" value="yes" required> Revoke this exact reading grant</label><button type="submit">Revoke private workflow review</button></form>${result.enabled ? `<form method="post" action="${base}/check">${hidden(nonce(res))}<label>Member request reference<input name="requestId" required></label><label>Moderator reference<input name="moderatorId" required></label><label>Reading starts (UTC)<input name="startsAt" value="${escape(result.startsAt)}" required></label><label>Reading ends (UTC)<input name="expiresAt" value="${escape(result.endsAt)}" required></label><button type="submit">Check exact assignment</button></form>` : "<p>New private review assignments are paused.</p>"}`,
      ),
    );
  });
  app.get(reference, async (_req, res) => {
    const result = await store!.entry(token(res), "moderator");
    if (result.kind !== "ready") return fail(res, result.kind);
    return send(res, result.deadline, () =>
      page(
        "My private workflow review reference",
        `${notice}<h1>My private workflow review reference</h1><p>${escape(result.actorId)}</p><p>Current staff access ends ${escape(result.expiresAt)}. A reference alone permits no reading.</p>`,
      ),
    );
  });
  app.post(`${base}/check`, async (req, res) => {
    const withWindow = fields(req.body, [
      "csrf",
      "requestId",
      "moderatorId",
      "startsAt",
      "expiresAt",
    ]);
    if (!withWindow && !fields(req.body, ["csrf", "requestId", "moderatorId"]))
      return fail(res, "invalid");
    const result = await store!.check(
      token(res),
      req.body.requestId!,
      req.body.moderatorId!,
      withWindow
        ? { startsAt: req.body.startsAt!, expiresAt: req.body.expiresAt! }
        : undefined,
    );
    if (result.kind !== "ready") return fail(res, result.kind);
    return send(res, result.deadline, () =>
      page(
        "Check private workflow assignment",
        `${notice}<h1>Check private workflow assignment</h1><p>${escape(result.workflowId)} · version ${result.workflowVersion} · note revision ${result.revision}</p><p>Request ${escape(result.requestId)} · moderator ${escape(result.moderatorId)}</p><p>Reading starts ${escape(result.startsAt)}</p><p>Reading ends ${escape(result.expiresAt)}</p><form method="post" action="${base}/assign">${hidden(nonce(res))}${field("checked", result.checked)}${field("operationId", randomUUID())}<label><input type="checkbox" name="confirm" value="yes" required> Assign only this exact private note to the checked moderator until the fixed deadline</label><button type="submit">Assign private workflow review</button></form>`,
      ),
    );
  });
  app.post(`${base}/assign`, async (req, res) => {
    if (!fields(req.body, ["csrf", "checked", "operationId", "confirm"]))
      return fail(res, "invalid");
    const original =
      typeof req.body.checked === "string" &&
      req.body.checked.length <= 2048 &&
      sampleUuid(req.body.operationId)
        ? { checked: req.body.checked, operationId: req.body.operationId }
        : undefined;
    const result = await store!.assign(
      token(res),
      req.body.checked,
      req.body.operationId!,
      req.body.confirm!,
    );
    if (result.kind !== "applied" && result.kind !== "replayed")
      return fail(res, result.kind, original);
    return send(res, result.deadline, () => receipt(result.grant), original);
  });
  app.post(`${base}/revoke`, async (req, res) => {
    if (!fields(req.body, ["csrf", "grantId", "operationId", "confirm"]))
      return fail(res, "invalid");
    const original =
      sampleUuid(req.body.operationId) && sampleUuid(req.body.grantId)
        ? { grantId: req.body.grantId, operationId: req.body.operationId }
        : undefined;
    const result = await store!.revoke(
      token(res),
      req.body.grantId!,
      req.body.operationId!,
      req.body.confirm!,
    );
    if (result.kind !== "applied" && result.kind !== "replayed")
      return fail(res, result.kind, original);
    return send(res, result.deadline, () => receipt(result.grant), original);
  });
  app.post(`${base}/inspect`, async (req, res) => {
    if (!fields(req.body, ["csrf", "operationId"])) return fail(res, "invalid");
    const result = await store!.inspect(token(res), req.body.operationId!);
    if (result.kind !== "ready") return fail(res, result.kind);
    return send(res, result.deadline, () =>
      result.grant
        ? receipt(result.grant)
        : page(
            "Original operation inspection",
            `${notice}<h1>Original operation inspection</h1><p>No visible receipt is currently available. This does not prove the write was uncommitted. Inspection does not create or renew permission.</p>`,
          ),
    );
  });
  app.get(`${base}/receipts/:id`, async (req, res) => {
    const result = await store!.receipt(token(res), req.params.id as string);
    if (result.kind !== "ready") return fail(res, result.kind);
    return send(res, result.deadline, () => receipt(result.grant));
  });
  app.get(read, async (req, res) => {
    if (
      Object.keys(req.query).some((k) => k !== "cursor") ||
      (req.query.cursor !== undefined && typeof req.query.cursor !== "string")
    )
      return fail(res, "invalid");
    const result = await store!.list(
      token(res),
      req.query.cursor as string | undefined,
    );
    if (result.kind !== "ready") return fail(res, result.kind);
    return send(res, result.deadline, () =>
      page(
        "My assigned private workflow reviews",
        `${notice}<h1>My assigned private workflow reviews</h1>${result.entries.length ? `<ul>${result.entries.map((r) => `<li><a href="${read}/${escape(r.grantId)}">${escape(r.workflowId)} · version ${r.workflowVersion} · revision ${r.revision}</a> · reading starts ${escape(r.startsAt)} · reading ends ${escape(r.expiresAt)}</li>`).join("")}</ul>` : "<p>No currently permitted exact assignments on this page.</p>"}${result.next ? `<a href="${read}?cursor=${encodeURIComponent(result.next)}">Next assigned reviews</a>` : ""}`,
      ),
    );
  });
  app.get(`${read}/:id`, async (req, res) => {
    const result = await store!.read(token(res), req.params.id as string);
    if (result.kind !== "ready") return fail(res, result.kind);
    return send(res, result.deadline, () =>
      page(
        "Assigned private workflow note",
        `${notice}<h1>Assigned private workflow note</h1><p>${escape(result.workflowId)} · version ${result.workflowVersion} · revision ${result.revision} · reading ends ${escape(result.expiresAt)}</p><pre>${escape(result.note)}</pre>`,
      ),
    );
  });
}
