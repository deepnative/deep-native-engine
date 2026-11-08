import type { Express, Request, Response } from "express";
import type { ContentVersion } from "./catalog.ts";
import {
  answerStudyQuestion,
  STUDY_QUESTION_MAX,
  validateStudyAnswer,
  type StudySource,
} from "./study-answer.ts";
import { studyQuestionPage } from "./study-question-views.ts";
import { errorPage } from "./views.ts";

// Returns the lesson only when this member may study its current version now.
export type StudyLesson = (
  token: string,
  id: string,
) => Promise<ContentVersion | null>;
export type StudyAnswerer = (source: StudySource, question: string) => unknown;

const unavailable = (res: Response, status: number) =>
  res
    .status(status)
    .send(
      errorPage(
        "Study source unavailable",
        "This lesson version is unavailable. Return to the learning library and open the current published version.",
      ),
    );

export function mountStudyQuestionRoutes(
  app: Express,
  lesson: StudyLesson,
  answerer: StudyAnswerer = answerStudyQuestion,
) {
  const path = "/library/:id/study/question";
  const safely =
    (use: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      res.set("Cache-Control", "no-store");
      try {
        await use(req, res);
      } catch {
        unavailable(res, 503);
      }
    };
  app.get(
    path,
    safely(async (req, res) => {
      const item = await lesson(
        res.locals.token as string,
        req.params.id as string,
      );
      if (!item) return unavailable(res, 404);
      return res.send(studyQuestionPage(item, res.locals.csrf as string));
    }),
  );
  app.post(
    path,
    safely(async (req, res) => {
      const fields = req.body as Record<string, unknown>;
      const version = Number(fields.content_version);
      if (!Number.isSafeInteger(version) || version < 1)
        return unavailable(res, 422);
      const item = await lesson(
        res.locals.token as string,
        req.params.id as string,
      );
      // A stale form never gets an answer from a different version.
      if (!item || item.version !== version) return unavailable(res, 409);
      const csrf = res.locals.csrf as string;
      const question =
        typeof fields.question === "string" ? fields.question.trim() : "";
      if (!question || question.length > STUDY_QUESTION_MAX)
        return res.status(422).send(
          studyQuestionPage(item, csrf, {
            error: `Write a question of at most ${STUDY_QUESTION_MAX} characters.`,
          }),
        );
      const source = { id: item.id, version: item.version, body: item.body };
      const answer = validateStudyAnswer(answerer(source, question), source);
      if (!answer) return unavailable(res, 503);
      return res.send(studyQuestionPage(item, csrf, { question, answer }));
    }),
  );
}
