import type { Express, Request, Response } from "express";
import type { Store } from "./store.ts";
import { COOKIE, cookieOptions, csrf } from "./session.ts";
import {
  PROGRAM_CONFIRM_PATH,
  PROGRAM_PATH,
  programIntent,
  programKey,
  publicProgramReceipt,
  type ProgramStore,
} from "./program-values.ts";
import {
  PROGRAM_SELECTION_COOKIE,
  PROGRAM_SELECTION_MS,
  issueProgramSelection,
  readProgramSelection,
} from "./program-selection.ts";
import {
  myCoursesPage,
  programAccountPage,
  programAdminPage,
  programConfirmPage,
  programOverviewPage,
  programProblemPage,
} from "./program-views.ts";

export function mountProgramRoutes(
  application: Express,
  members: Store,
  programs: ProgramStore,
  origin: string,
  secret: string,
) {
  const token = (res: Response) => res.locals.token as string;
  const protect = (res: Response) =>
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
  function valid(req: Request, res: Response, fields: string[] = []) {
    protect(res);
    if (
      Object.keys(req.query).length ||
      (req.method === "POST" &&
        (!req.body ||
          Array.isArray(req.body) ||
          Object.keys(req.body).some(
            (key) => !["csrf", ...fields].includes(key),
          )))
    ) {
      res.status(400).send(programProblemPage("Use the current program form."));
      return false;
    }
    return true;
  }
  async function currentMember(req: Request, res: Response) {
    let session;
    try {
      session = await members.session(token(res), "account");
    } catch {
      res
        .status(503)
        .send(
          programProblemPage(
            "Current account access is temporarily unavailable.",
          ),
        );
      return false;
    }
    if (session.kind !== "active") {
      res
        .status(401)
        .send(
          programAccountPage(
            readProgramSelection(req.headers.cookie, secret) === "ready",
          ),
        );
      return false;
    }
    return true;
  }
  async function exploration(req: Request, res: Response) {
    if (!valid(req, res)) return;
    const result = await programs.overview();
    if (result.kind !== "ready")
      return res
        .status(503)
        .send(
          programProblemPage(
            "Program availability is temporarily unavailable.",
          ),
        );
    if (req.cookies[COOKIE] !== token(res))
      res.cookie(COOKIE, token(res), cookieOptions(origin));
    return res.send(
      programOverviewPage(result.value, csrf(token(res), secret), true),
    );
  }
  application.get("/programs", exploration);
  application.get(PROGRAM_PATH, exploration);
  application.post(`${PROGRAM_PATH}/choose`, async (req, res) => {
    if (!valid(req, res, ["confirm"])) return;
    if (req.body.confirm !== "yes")
      return res
        .status(422)
        .send(programProblemPage("Confirm your public program choice."));
    const result = await programs.overview();
    if (result.kind !== "ready")
      return res
        .status(503)
        .send(
          programProblemPage(
            "Program availability is temporarily unavailable.",
          ),
        );
    if (result.value.availability !== "ready")
      return res
        .status(409)
        .send(
          programProblemPage(
            "This term cannot be chosen right now. Refresh actual availability.",
          ),
        );
    res.cookie(PROGRAM_SELECTION_COOKIE, issueProgramSelection(secret), {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(origin).protocol === "https:",
      path: "/",
      maxAge: PROGRAM_SELECTION_MS,
    });
    const session = await members
      .session(token(res), "account")
      .catch(() => null);
    if (!session)
      return res
        .status(503)
        .send(
          programProblemPage(
            "Account access is temporarily unavailable; your public selection remains separate from enrollment.",
          ),
        );
    return session.kind === "active"
      ? res.redirect(303, PROGRAM_CONFIRM_PATH)
      : res.send(programAccountPage(true));
  });
  application.get(PROGRAM_CONFIRM_PATH, async (req, res) => {
    if (!valid(req, res) || !(await currentMember(req, res))) return;
    const prior = await programs.mine(token(res));
    if (prior.kind === "ready" && prior.value)
      return res.redirect(303, "/my-courses");
    if (prior.kind !== "ready")
      return res
        .status(prior.kind === "denied" ? 401 : 503)
        .send(
          programProblemPage("Your current enrollment cannot be inspected."),
        );
    if (readProgramSelection(req.headers.cookie, secret) !== "ready")
      return res
        .status(409)
        .send(
          programProblemPage(
            "Choose the exact public program again; this selection is missing or expired.",
          ),
        );
    const result = await programs.overview();
    if (result.kind !== "ready")
      return res
        .status(503)
        .send(
          programProblemPage(
            "Program availability is temporarily unavailable.",
          ),
        );
    if (result.value.availability !== "ready")
      return res
        .status(409)
        .send(
          programProblemPage(
            "Availability changed. Refresh before confirming.",
          ),
        );
    return res.send(programConfirmPage(result.value, csrf(token(res), secret)));
  });
  application.post(`${PROGRAM_PATH}/enroll`, async (req, res) => {
    if (
      !valid(req, res, [
        "confirm",
        "key",
        "programVersion",
        "termVersion",
        "digest",
        "revision",
      ]) ||
      !(await currentMember(req, res))
    )
      return;
    const intent = programIntent(req.body);
    if (req.body.confirm !== "yes" || !programKey(req.body.key) || !intent)
      return res
        .status(422)
        .send(
          programProblemPage("Use a fresh explicit enrollment confirmation."),
        );
    const result = await programs.enroll(token(res), req.body.key, intent);
    if (result.kind === "ready") return res.redirect(303, "/my-courses");
    return res
      .status(
        result.kind === "unavailable"
          ? 503
          : result.kind === "denied"
            ? 401
            : 409,
      )
      .send(
        programProblemPage(
          result.kind === "unavailable"
            ? "The enrollment response is unconfirmed. Inspect the original key before acting again."
            : "Enrollment was not accepted with this form. Inspect your current record and refresh availability.",
          result.kind === "unavailable" ? req.body.key : undefined,
        ),
      );
  });
  application.get("/my-courses/inspect", async (req, res) => {
    protect(res);
    if (
      Object.keys(req.query).some((key) => key !== "key") ||
      !programKey(req.query.key)
    )
      return res
        .status(400)
        .send(programProblemPage("Supply only the original enrollment key."));
    if (!(await currentMember(req, res))) return;
    const result = await programs.inspect(token(res), req.query.key);
    if (result.kind !== "ready")
      return res
        .status(result.kind === "denied" ? 401 : 503)
        .send(
          programProblemPage(
            "Original enrollment inspection is unavailable.",
            req.query.key,
          ),
        );
    if (!result.value)
      return res.send(
        programProblemPage(
          "No receipt was found for this key in your current account. This read did not submit an enrollment; inspect My courses before choosing another explicit action.",
        ),
      );
    return res.send(myCoursesPage(result.value, null));
  });
  async function owned(req: Request, res: Response) {
    if (!valid(req, res) || !(await currentMember(req, res))) return;
    const result = await programs.mine(token(res));
    if (result.kind !== "ready") {
      res
        .status(result.kind === "denied" ? 401 : 503)
        .send(
          programProblemPage(
            "Your enrollment record is temporarily unavailable.",
          ),
        );
      return;
    }
    const id = req.params.id;
    if (id && (!programKey(id) || result.value?.id !== id)) {
      res
        .status(404)
        .send(
          programProblemPage(
            "This receipt is unavailable for your current account.",
          ),
        );
      return;
    }
    return result;
  }
  async function dashboard(req: Request, res: Response) {
    const result = await owned(req, res);
    if (!result) return;
    const current = await programs.overview();
    return res.send(
      myCoursesPage(
        result.value,
        current.kind === "ready" ? current.value : null,
      ),
    );
  }
  application.get("/my-courses", dashboard);
  application.get("/my-courses/:id", dashboard);
  application.get("/my-courses/:id/download", async (req, res) => {
    const result = await owned(req, res);
    if (!result?.value) return;
    res.set(
      "Content-Disposition",
      'attachment; filename="program-enrollment.json"',
    );
    return res.json({
      programEnrollmentsVersion: 1,
      enrollment: publicProgramReceipt(result.value),
    });
  });
  application.get("/operator/programs", async (req, res) => {
    if (!valid(req, res)) return;
    const result = await programs.admin(token(res));
    return result.kind === "ready"
      ? res.send(programAdminPage(result.value, csrf(token(res), secret)))
      : res
          .status(result.kind === "denied" ? 403 : 503)
          .send(
            programProblemPage(
              "Current local program administration is unavailable.",
            ),
          );
  });
  for (const action of ["open", "close"] as const)
    application.post(`/operator/programs/${action}`, async (req, res) => {
      if (!valid(req, res, ["revision", "digest", "confirm"])) return;
      if (
        req.body.confirm !== "yes" ||
        !/^[1-3]$/.test(String(req.body.revision ?? "")) ||
        typeof req.body.digest !== "string"
      )
        return res
          .status(422)
          .send(
            programProblemPage(
              "Inspect current inventory and confirm its exact revision.",
            ),
          );
      const result = await programs.change(
        token(res),
        action,
        Number(req.body.revision),
        req.body.digest,
      );
      return result.kind === "ready"
        ? res.redirect(303, "/operator/programs")
        : res
            .status(
              result.kind === "denied"
                ? 403
                : result.kind === "unavailable"
                  ? 503
                  : 409,
            )
            .send(
              programProblemPage(
                "Inventory change is unconfirmed or unavailable. Inspect /operator/programs before another explicit command; no command is replayed automatically.",
              ),
            );
    });
}
