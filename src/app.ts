import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "node:url";
import { COOKIE, COOKIE_OPTIONS, token, csrf, validCsrf } from "./session.ts";
import { profile, submission, type Fields } from "./validation.ts";
import {
  welcome,
  dashboard,
  lesson,
  readinessPage,
  errorPage,
} from "./views.ts";
import type { Store, Learner } from "./store.ts";
import {
  adapterReadiness,
  type AdapterReadiness,
  type ApplicationMode,
} from "./adapters.ts";
export function app(
  store: Store,
  options: {
    origin: string;
    secret: string;
    mode?: ApplicationMode;
    adapters?: AdapterReadiness[];
  },
) {
  const app = express();
  const mode = options.mode ?? "demo";
  const adapters = options.adapters ?? adapterReadiness({}, mode);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { "upgrade-insecure-requests": null },
      },
      strictTransportSecurity: false,
      referrerPolicy: { policy: "same-origin" },
    }),
  );
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use((req, res, next) => {
    if (req.get("host") !== new URL(options.origin).host) {
      res
        .status(403)
        .send(
          errorPage(
            "Unrecognized address",
            "Open this preview using its configured loopback address.",
          ),
        );
      return;
    }
    next();
  });
  app.use(
    "/assets",
    express.static(fileURLToPath(new URL("../public", import.meta.url))),
  );
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    const session = token(req.cookies[COOKIE]);
    res.locals.token = session;
    res.locals.csrf = csrf(session, options.secret);
    if (
      req.method === "POST" &&
      (req.get("origin") !== options.origin ||
        !validCsrf(
          (req.body as Fields | undefined)?.csrf,
          session,
          options.secret,
        ))
    ) {
      res
        .status(403)
        .send(
          errorPage(
            "Your form needs a refresh",
            "Open your learning path again, then retry. Your saved work is unchanged.",
          ),
        );
      return;
    }
    next();
  });
  app.get("/readiness", (_req, res) => res.send(readinessPage(mode, adapters)));
  app.get("/", async (req, res) => {
    const session = await store.session(res.locals.token as string);
    if (session.kind === "active") {
      res.redirect(303, "/learn");
      return;
    }
    const fresh =
      session.kind === "expired"
        ? token(undefined)
        : (res.locals.token as string);
    res.cookie(COOKIE, fresh, COOKIE_OPTIONS);
    res.send(welcome(csrf(fresh, options.secret)));
  });
  app.post("/start", async (req, res) => {
    const input = profile(req.body as Fields);
    if (!input) {
      res
        .status(422)
        .send(
          welcome(res.locals.csrf as string, [
            "Choose your starting point and goal, and confirm you will use sample information.",
          ]),
        );
      return;
    }
    await store.create(res.locals.token as string, input);
    res.redirect(303, "/learn");
  });
  app.use(
    ["/learn", "/lesson", "/exercise", "/delete"],
    async (_req, res, next) => {
      const session = await store.session(res.locals.token as string);
      if (session.kind !== "active") {
        res.redirect(303, "/");
        return;
      }
      res.locals.learner = session.learner;
      next();
    },
  );
  app.get("/learn", async (_req, res) => {
    const member = res.locals.learner as Learner;
    res.send(
      dashboard(
        member,
        await store.progress(member.id),
        res.locals.csrf as string,
      ),
    );
  });
  app.get("/lesson", async (_req, res) => {
    const member = res.locals.learner as Learner;
    res.send(
      lesson(
        member,
        await store.progress(member.id),
        res.locals.csrf as string,
      ),
    );
  });
  app.post("/exercise", async (req, res) => {
    const member = res.locals.learner as Learner;
    const input = submission(req.body as Fields);
    if (input.errors.length) {
      res
        .status(422)
        .send(
          lesson(
            member,
            { ...input, completed_at: null },
            res.locals.csrf as string,
            input.errors,
          ),
        );
      return;
    }
    await store.save(member.id, input);
    res.redirect(303, "/lesson");
  });
  app.post("/delete", async (req, res) => {
    if (req.body.confirm !== "yes") {
      res
        .status(422)
        .send(
          errorPage(
            "Confirm before deleting",
            "Check the confirmation box on your learning path before deleting this preview.",
          ),
        );
      return;
    }
    await store.remove((res.locals.learner as Learner).id);
    res.clearCookie(COOKIE, { httpOnly: true, sameSite: "strict", path: "/" });
    res.redirect(303, "/");
  });
  app.use((_req, res) =>
    res
      .status(404)
      .send(
        errorPage(
          "This page is not here",
          "Use your learning path to find the lesson and saved work.",
        ),
      ),
  );
  const failure: ErrorRequestHandler = (_error, _req, res, _next) => {
    res
      .status(503)
      .send(
        errorPage(
          "We could not save or load that",
          "We could not confirm the result. Return to your learning path to check saved work before trying again.",
        ),
      );
  };
  app.use(failure);
  return app;
}
