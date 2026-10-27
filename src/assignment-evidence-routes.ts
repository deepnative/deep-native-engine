import type { Express, Response } from "express";
import type { AssignmentEvidenceStore } from "./assignment-evidence.ts";
import {
  assignmentEvidenceInstruction,
  type AssignmentEvidenceInstruction,
} from "./assignment-evidence-values.ts";
import {
  ASSIGNMENT_INSPECT_PATH,
  assignmentHandoffPage,
  assignmentReceiptPage,
  assignmentRecoveryPage,
} from "./assignment-evidence-views.ts";

const exact = (
  value: unknown,
  names: string[],
): value is Record<string, string> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === names.length &&
  names.every(
    (name) =>
      Object.hasOwn(value, name) &&
      typeof (value as Record<string, unknown>)[name] === "string",
  );
const integer = (value: string) =>
  /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;

export function mountAssignmentEvidenceRoutes(
  app: Express,
  store: AssignmentEvidenceStore | undefined,
  enabled: boolean,
) {
  function failure(
    res: Response,
    kind: string,
    instruction?: AssignmentEvidenceInstruction,
  ) {
    return res
      .status(
        kind === "invalid"
          ? 422
          : kind === "conflict"
            ? 409
            : kind === "disabled"
              ? 404
              : kind === "denied"
                ? 403
                : 503,
      )
      .send(
        assignmentRecoveryPage(
          res.locals.csrf as string,
          kind === "invalid"
            ? "Choose an exact submitted version and confirm the private copy."
            : kind === "conflict"
              ? "This request does not match the original submitted version or saved request."
              : kind === "disabled"
                ? "Creating assignment feedback copies is currently unavailable."
                : kind === "denied"
                  ? "Open a submitted assignment from your own active learning account."
                  : "The saved result cannot be confirmed. No new request was made automatically.",
          kind === "unavailable" ? instruction : undefined,
        ),
      );
  }
  function send(
    res: Response,
    deadline: number,
    html: string,
    instruction?: AssignmentEvidenceInstruction,
  ) {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      return failure(res, instruction ? "unavailable" : "denied", instruction);
    return res.send(html);
  }
  const path = "/assignments/attempts/:id/handoff";
  app.get(path, async (req, res) => {
    if (!enabled || !store) return failure(res, "disabled");
    if (!exact(req.query, ["sequence"])) return failure(res, "invalid");
    try {
      const result = await store.open(
        res.locals.token as string,
        req.params.id as string,
        integer(req.query.sequence!),
      );
      if (result.kind !== "ready") return failure(res, result.kind);
      return send(
        res,
        result.deadline,
        assignmentHandoffPage(res.locals.csrf as string, result.source),
      );
    } catch {
      return failure(res, "unavailable");
    }
  });
  app.post(path, async (req, res) => {
    if (!enabled || !store) return failure(res, "disabled");
    if (
      !exact(req.query, []) ||
      !exact(req.body, [
        "csrf",
        "operationId",
        "sequence",
        "contentId",
        "contentVersion",
        "rubricVersion",
        "sourceSha256",
        "privateReview",
      ])
    )
      return failure(res, "invalid");
    const b = req.body;
    const instruction = assignmentEvidenceInstruction({
      operationId: b.operationId,
      attemptId: req.params.id,
      sequence: integer(b.sequence!),
      contentId: b.contentId,
      contentVersion: integer(b.contentVersion!),
      rubricVersion: integer(b.rubricVersion!),
      sourceSha256: b.sourceSha256,
      privateReview: b.privateReview === "yes",
    });
    if (!instruction) return failure(res, "invalid");
    try {
      const result = await store.create(
        res.locals.token as string,
        instruction,
      );
      if (result.kind !== "created" && result.kind !== "replayed")
        return failure(res, result.kind, instruction);
      return send(
        res,
        result.deadline,
        assignmentReceiptPage(
          result.receipt,
          result.kind === "created"
            ? "Your private assignment copy was saved."
            : "Your original request was recovered. No new copy or permission was created.",
        ),
        instruction,
      );
    } catch {
      return failure(res, "unavailable", instruction);
    }
  });
  app.post(ASSIGNMENT_INSPECT_PATH, async (req, res) => {
    // Inspection remains available when new creation is disabled.
    if (!store) return failure(res, "disabled");
    if (!exact(req.query, []) || !exact(req.body, ["csrf", "operationId"]))
      return failure(res, "invalid");
    try {
      const result = await store.inspect(
        res.locals.token as string,
        req.body.operationId!,
      );
      if (result.kind !== "ready" && result.kind !== "absent")
        return failure(res, result.kind);
      return send(
        res,
        result.deadline,
        result.kind === "ready"
          ? assignmentReceiptPage(result.receipt)
          : assignmentRecoveryPage(
              res.locals.csrf as string,
              "No owned receipt was found. This does not establish that the request failed or permit an automatic new copy.",
            ),
      );
    } catch {
      return failure(res, "unavailable");
    }
  });
}
