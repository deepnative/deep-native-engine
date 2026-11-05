import type { Express, Request, Response } from "express";
import type { ApplicationMode } from "./adapters.ts";
import type { StudyAllowanceStore } from "./study-allowances.ts";
import {
  STUDY_ALLOWANCE_PATH,
  studyAllowanceInstruction,
  studyAllowanceKey,
} from "./study-allowance-values.ts";
import {
  studyAllowanceNotice,
  studyAllowancePage,
} from "./study-allowance-views.ts";

const fields = ["confirm", "csrf", "key", "periodStart", "policyVersion"];
const statuses = { denied: 403, invalid: 422, conflict: 409, unavailable: 503 };
type Failure = keyof typeof statuses;

export function mountStudyAllowanceRoutes(
  app: Express,
  store: StudyAllowanceStore | undefined,
  mode: ApplicationMode | undefined,
) {
  const fail = (res: Response, kind: Failure) =>
    res.status(statuses[kind]).send(studyAllowanceNotice(kind));
  const safely =
    (use: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await use(req, res);
      } catch {
        fail(res, "unavailable");
      }
    };
  app.use(STUDY_ALLOWANCE_PATH, (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!store || mode === "live")
      return res.status(404).send(studyAllowanceNotice("unavailableRoute"));
    if (Object.keys(req.query).length) return fail(res, "invalid");
    next();
  });
  app.get(
    STUDY_ALLOWANCE_PATH,
    safely(async (_req, res) => {
      const result = await store!.member(res.locals.token as string);
      if (result.kind !== "ready") return fail(res, result.kind);
      const body = studyAllowancePage(res.locals.csrf as string, result.value);
      if (performance.now() >= result.deadline) return fail(res, "denied");
      return res.send(body);
    }),
  );
  app.post(
    `${STUDY_ALLOWANCE_PATH}/claim`,
    safely(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const instruction = studyAllowanceInstruction(body);
      if (
        Object.keys(body).sort().join() !== fields.join() ||
        body.confirm !== "yes" ||
        !studyAllowanceKey(body.key) ||
        !instruction
      )
        return fail(res, "invalid");
      const result = await store!.claim(
        res.locals.token as string,
        body.key,
        instruction,
      );
      if (result.kind !== "ready") return fail(res, result.kind);
      if (performance.now() >= result.deadline) return fail(res, "unavailable");
      return res.redirect(303, STUDY_ALLOWANCE_PATH);
    }),
  );
}
