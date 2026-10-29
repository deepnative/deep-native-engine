import type { Express, Response } from "express";
import {
  publicationInstruction,
  type PublicationStore,
  type PublicationInstruction,
  type PublicationResult,
} from "./proposal-publication.ts";
import {
  publicationOwnerPage,
  publicationReceiptPage,
  publicationInspectionPage,
  publicationRecoveryPage,
  contributionsPage,
  contributionPage,
} from "./proposal-publication-views.ts";
const exact = (
  value: unknown,
  keys: string[],
): value is Record<string, string> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every(
    (k) =>
      Object.hasOwn(value, k) &&
      typeof (value as Record<string, unknown>)[k] === "string",
  );
const revision = (v: string) => (/^[1-9][0-9]*$/.test(v) ? Number(v) : NaN);
function failure(
  res: Response,
  kind: string,
  instruction?: PublicationInstruction,
) {
  return res
    .set("Cache-Control", "no-store")
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
      publicationRecoveryPage(
        res.locals.csrf as string,
        kind === "denied"
          ? "Current permission or ownership is required."
          : kind === "invalid"
            ? "Use the current form and explicitly confirm the exact revision and audience."
            : kind === "conflict"
              ? "The source, accepted revision or original request changed. Inspect its current state."
              : kind === "disabled"
                ? "New contribution acceptance and sharing are unavailable."
                : "The operation could not be confirmed. No write is retried automatically.",
        kind === "unavailable" ? instruction : undefined,
      ),
    );
}
function send<T>(
  res: Response,
  result: PublicationResult<T>,
  render: (value: T) => string,
  instruction?: PublicationInstruction,
) {
  res.set("Cache-Control", "no-store");
  if (result.kind !== "ready") return failure(res, result.kind, instruction);
  const html = render(result.value);
  if (!Number.isFinite(result.deadline) || performance.now() >= result.deadline)
    return failure(res, instruction ? "unavailable" : "denied", instruction);
  return res.send(html);
}
export function mountPublicationStaffRoutes(
  app: Express,
  store: PublicationStore | undefined,
) {
  app.post("/moderate/proposals/:id/accept", async (req, res) => {
    if (!store) return failure(res, "disabled");
    if (
      !exact(req.query, []) ||
      !exact(req.body, ["csrf", "revision", "confirm"])
    )
      return failure(res, "invalid");
    return send(
      res,
      await store.accept(
        res.locals.token as string,
        req.params.id as string,
        revision(req.body.revision!),
        req.body.confirm === "yes",
      ),
      publicationReceiptPage,
    );
  });
}
export function mountPublicationRoutes(
  app: Express,
  store: PublicationStore | undefined,
  enabled: boolean,
) {
  app.get("/contribute/:id/publication", async (req, res) => {
    if (!store) return failure(res, "disabled");
    if (!exact(req.query, [])) return failure(res, "invalid");
    return send(
      res,
      await store.owner(res.locals.token as string, req.params.id as string),
      (v) =>
        publicationOwnerPage(
          res.locals.csrf as string,
          v.source,
          v.receipt,
          enabled,
        ),
    );
  });
  app.post("/contribute/:id/publish", async (req, res) => {
    if (!store) return failure(res, "disabled");
    if (
      !exact(req.query, []) ||
      !exact(req.body, [
        "csrf",
        "operationId",
        "revision",
        "attribution",
        "audience",
        "permissionVersion",
        "confirmed",
      ])
    )
      return failure(res, "invalid");
    const b = req.body;
    const instruction = publicationInstruction({
      operationId: b.operationId,
      proposalId: req.params.id,
      revision: revision(b.revision!),
      attribution: b.attribution,
      audience: b.audience,
      permissionVersion: b.permissionVersion,
      confirmed: b.confirmed === "yes",
    });
    if (!instruction) return failure(res, "invalid");
    return send(
      res,
      await store.publish(res.locals.token as string, instruction),
      publicationReceiptPage,
      instruction,
    );
  });
  app.post("/contribute/:id/unshare", async (req, res) => {
    if (!store) return failure(res, "disabled");
    if (
      !exact(req.query, []) ||
      !exact(req.body, ["csrf", "revision", "confirm"]) ||
      req.body.confirm !== "yes"
    )
      return failure(res, "invalid");
    return send(
      res,
      await store.withdraw(
        res.locals.token as string,
        req.params.id as string,
        revision(req.body.revision!),
      ),
      publicationReceiptPage,
    );
  });
  app.get("/contribution-requests/inspect", (req, res) => {
    if (!store) return failure(res, "disabled");
    if (!exact(req.query, [])) return failure(res, "invalid");
    return res
      .set("Cache-Control", "no-store")
      .send(publicationInspectionPage(res.locals.csrf as string));
  });
  app.post("/contribution-requests/inspect", async (req, res) => {
    if (!store) return failure(res, "disabled");
    if (!exact(req.query, []) || !exact(req.body, ["csrf", "operationId"]))
      return failure(res, "invalid");
    return send(
      res,
      await store.inspect(res.locals.token as string, req.body.operationId!),
      (r) =>
        r
          ? publicationReceiptPage(r)
          : publicationRecoveryPage(
              res.locals.csrf as string,
              "No owned receipt was found. This does not prove the original write failed; do not create a replacement automatically.",
            ),
    );
  });
  app.get("/contributions", async (req, res) => {
    if (!store) return failure(res, "disabled");
    if (!exact(req.query, [])) return failure(res, "invalid");
    return send(
      res,
      await store.list(res.locals.token as string),
      contributionsPage,
    );
  });
  app.get("/contributions/:id", async (req, res) => {
    if (!store) return failure(res, "disabled");
    if (!exact(req.query, [])) return failure(res, "invalid");
    return send(
      res,
      await store.detail(res.locals.token as string, req.params.id as string),
      (v) => contributionPage(v.source, v.receipt),
    );
  });
}
