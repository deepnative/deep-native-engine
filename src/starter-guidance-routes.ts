import type { Express } from "express";
import type { Learner } from "./store.ts";
import {
  STARTER_GUIDANCE_VERSION,
  STARTER_GUIDES,
} from "./starter-guidance.ts";
import {
  starterGuidanceExample,
  starterGuidanceQuestion,
  starterGuidanceRecovery,
} from "./starter-guidance-views.ts";

// Mounted after the existing /lesson active-member guard. The common form
// middleware enforces same origin and CSRF. This aid never writes learner data.
export function mountStarterGuidanceRoutes(app: Express) {
  app.get("/lesson/guide", (_req, res) => {
    res.send(starterGuidanceExample((res.locals.learner as Learner).goal));
  });
  for (const step of ["practise", "transfer"] as const) {
    app.get(`/lesson/guide/${step}`, (_req, res) => {
      res.send(
        starterGuidanceQuestion(
          (res.locals.learner as Learner).goal,
          step,
          res.locals.csrf as string,
        ),
      );
    });
  }
  app.post("/lesson/guide/check", (req, res) => {
    const fields = (req.body ?? {}) as Record<string, unknown>;
    const learner = res.locals.learner as Learner;
    if (
      Object.keys(req.query).length ||
      Object.keys(fields).some(
        (key) => !["csrf", "version", "goal", "step", "choice"].includes(key),
      ) ||
      typeof fields.version !== "string" ||
      typeof fields.goal !== "string" ||
      (fields.step !== "practise" && fields.step !== "transfer") ||
      typeof fields.choice !== "string"
    ) {
      return res
        .status(422)
        .send(
          starterGuidanceRecovery(
            "Choose an answer from the lesson",
            "Open the current guide and use one of its choices. Your saved exercise has not changed.",
          ),
        );
    }
    if (
      fields.version !== STARTER_GUIDANCE_VERSION ||
      fields.goal !== learner.goal
    ) {
      return res
        .status(409)
        .send(
          starterGuidanceRecovery(
            "Your lesson direction has changed",
            "This form belongs to an earlier goal or guide version. Start the guide for your current direction; your saved exercise is unchanged.",
          ),
        );
    }
    const answer = STARTER_GUIDES[learner.goal][fields.step].choices.find(
      (choice) => choice.id === fields.choice,
    );
    if (!answer) {
      return res
        .status(422)
        .send(
          starterGuidanceRecovery(
            "Choose an answer from the lesson",
            "That choice is not part of this question. Open the current guide and try again.",
          ),
        );
    }
    return res.send(
      starterGuidanceQuestion(
        learner.goal,
        fields.step,
        res.locals.csrf as string,
        answer,
      ),
    );
  });
}
