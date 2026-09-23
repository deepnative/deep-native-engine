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
  offerHypothesesPage,
  libraryPage,
  contentPreview,
  staffLibraryPage,
  trackReadinessPage,
  expertRegistryPage,
  proposalListPage,
  proposalPreviewPage,
  moderationPage,
  errorPage,
} from "./views.ts";
import type { Store, Learner } from "./store.ts";
import {
  adapterReadiness,
  type AdapterReadiness,
  type ApplicationMode,
} from "./adapters.ts";
import {
  disabledAuthorizationStore,
  type AuthorizationStore,
} from "./authorization.ts";
import {
  disabledEvidenceStore,
  MAX_EVIDENCE_BYTES,
  type EvidenceStore,
} from "./evidence.ts";
import { FOUNDATION_ACCESS, COACHING_OFFERS } from "./offers.ts";
import {
  disabledCatalogStore,
  type CatalogStore,
  type DraftContent,
} from "./catalog.ts";
import { disabledTrackStore, type TrackStore } from "./track-readiness.ts";
import { disabledProposalStore, type ProposalStore } from "./proposals.ts";
export function app(
  store: Store,
  options: {
    origin: string;
    secret: string;
    mode?: ApplicationMode;
    adapters?: AdapterReadiness[];
    authorization?: AuthorizationStore;
    evidence?: EvidenceStore;
    catalog?: CatalogStore;
    tracks?: TrackStore;
    proposals?: ProposalStore;
  },
) {
  const app = express();
  const mode = options.mode ?? "demo";
  const adapters = options.adapters ?? adapterReadiness({}, mode);
  const authorization = options.authorization ?? disabledAuthorizationStore();
  const evidence = options.evidence ?? disabledEvidenceStore();
  const catalog = options.catalog ?? disabledCatalogStore();
  const tracks = options.tracks ?? disabledTrackStore();
  const proposals = options.proposals ?? disabledProposalStore();
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
  app.use(
    "/api/evidence",
    express.raw({ type: "*/*", limit: MAX_EVIDENCE_BYTES }),
  );
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    const session = token(req.cookies[COOKIE]);
    res.locals.token = session;
    res.locals.csrf = csrf(session, options.secret);
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      (req.get("origin") !== options.origin ||
        !validCsrf(
          req.get("x-csrf-token") ?? (req.body as Fields | undefined)?.csrf,
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
  app.get("/readiness/offers", (_req, res) => res.send(offerHypothesesPage()));
  app.get("/readiness/tracks", async (_req, res) =>
    res.send(trackReadinessPage(await tracks.snapshot())),
  );
  app.get("/operator/experts", async (_req, res) => {
    const records = await tracks.registry(res.locals.token as string);
    if (!records) {
      res
        .status(403)
        .send(
          errorPage("Registry unavailable", "Operator access is required."),
        );
      return;
    }
    res.send(expertRegistryPage(records));
  });
  app.get("/moderate/proposals", async (_req, res) => {
    const queue = await proposals.moderationQueue(res.locals.token as string);
    if (!queue) {
      res
        .status(403)
        .send(
          errorPage("Moderation unavailable", "Moderator access is required."),
        );
      return;
    }
    res.send(moderationPage(queue, res.locals.csrf as string));
  });
  app.post("/moderate/proposals/:id/:action", async (req, res) => {
    const action = req.params.action;
    if (
      (action !== "quarantine" && action !== "reject") ||
      !(await proposals.moderate(
        res.locals.token as string,
        req.params.id as string,
        action,
      ))
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Proposal unchanged",
            "Check moderation access and current state.",
          ),
        );
      return;
    }
    res.redirect(303, "/moderate/proposals");
  });
  app.get("/api/offer-hypotheses", (_req, res) =>
    res.json({
      foundation: FOUNDATION_ACCESS,
      coaching: COACHING_OFFERS,
    }),
  );
  app.get("/api/workspaces/:workspaceId/private", async (req, res) => {
    const purpose =
      typeof req.query.purpose === "string" ? req.query.purpose : undefined;
    const access = await authorization.readWorkspace(
      res.locals.token as string,
      req.params.workspaceId as string,
      purpose,
    );
    if (access.kind === "denied") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.json(access);
  });
  app.get("/api/cohorts/:cohortId/content/:contentId", async (req, res) => {
    const access = await authorization.readCohort(
      res.locals.token as string,
      req.params.cohortId as string,
      req.params.contentId as string,
    );
    if (access.kind === "denied") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.json(access);
  });
  app.post("/api/evidence", async (req, res) => {
    const scopes = (req.get("x-evidence-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    const learningCircle = scopes.includes("learning-circle")
      ? (req.get("x-learning-circle-id") ?? "")
      : undefined;
    const result = await evidence.upload(res.locals.token as string, {
      name: req.get("x-evidence-name") ?? "",
      mediaType: (req.get("content-type") ?? "").split(";", 1)[0]!,
      consent: {
        rightsConfirmed: req.get("x-evidence-rights") === "confirmed",
        privateReview: scopes.includes("private-review"),
        communityPublication: scopes.includes("community-publication"),
        learningCircleId: learningCircle,
      },
      data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    });
    if (result.kind === "denied") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (result.kind === "invalid") {
      res.status(422).json({ error: "invalid_evidence" });
      return;
    }
    res.status(201).json(result);
  });
  app.post("/api/evidence/:evidenceId/review", async (req, res) => {
    if (
      !(await evidence.submitForReview(
        res.locals.token as string,
        req.params.evidenceId as string,
      ))
    ) {
      res.status(409).json({ error: "evidence_not_ready" });
      return;
    }
    res.status(204).end();
  });
  app.post("/api/evidence/:evidenceId/download-link", async (req, res) => {
    const result = await evidence.issueDownload(
      res.locals.token as string,
      req.params.evidenceId as string,
    );
    if (result.kind === "denied") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.json({
      href: `/api/evidence/${req.params.evidenceId as string}/download?capability=${result.capability}`,
      expiresAt: result.expiresAt.toISOString(),
    });
  });
  app.get("/api/evidence/:evidenceId/download", async (req, res) => {
    const result = await evidence.download(
      res.locals.token as string,
      req.params.evidenceId as string,
      typeof req.query.capability === "string" ? req.query.capability : "",
    );
    if (result.kind === "denied") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res
      .type(result.mediaType)
      .set("Content-Disposition", `attachment; filename="${result.name}"`)
      .send(result.data);
  });
  app.delete("/api/evidence/:evidenceId", async (req, res) => {
    if (
      !(await evidence.remove(
        res.locals.token as string,
        req.params.evidenceId as string,
      ))
    ) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.status(204).end();
  });
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
            "Choose valid starting point, goal, time zone, weekly time and optional interests, and confirm you will use sample information.",
          ]),
        );
      return;
    }
    await store.create(res.locals.token as string, input);
    res.redirect(303, "/learn");
  });
  app.use(
    [
      "/learn",
      "/lesson",
      "/exercise",
      "/profile",
      "/delete",
      "/library",
      "/contribute",
    ],
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
  app.get("/contribute", async (_req, res) =>
    res.send(
      proposalListPage(
        await proposals.owned(res.locals.token as string),
        res.locals.csrf as string,
      ),
    ),
  );
  app.post("/contribute", async (req, res) => {
    const fields = req.body as Fields;
    const value = (name: string) =>
      typeof fields[name] === "string" ? (fields[name] as string) : "";
    const id = await proposals.createDraft(
      res.locals.token as string,
      { title: value("title"), body: value("body"), sources: value("sources") },
      fields.sample_confirmed === "yes",
    );
    if (!id) {
      res
        .status(422)
        .send(
          errorPage(
            "Proposal not saved",
            "Use sample information and complete every field.",
          ),
        );
      return;
    }
    res.redirect(303, `/contribute/${id}`);
  });
  app.get("/contribute/:id", async (req, res) => {
    const proposal = await proposals.preview(
      res.locals.token as string,
      req.params.id as string,
    );
    if (!proposal) {
      res
        .status(404)
        .send(
          errorPage(
            "Proposal unavailable",
            "Only your own proposal can be opened.",
          ),
        );
      return;
    }
    res.send(proposalPreviewPage(proposal, res.locals.csrf as string));
  });
  app.post("/contribute/:id/submit", async (req, res) => {
    if (
      !(await proposals.submit(
        res.locals.token as string,
        req.params.id as string,
        req.body.rights_confirmed === "yes",
      ))
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Proposal not submitted",
            "Confirm original rights and check draft state.",
          ),
        );
      return;
    }
    res.redirect(303, `/contribute/${req.params.id}`);
  });
  app.post("/contribute/:id/withdraw", async (req, res) => {
    if (
      req.body.confirm !== "yes" ||
      !(await proposals.withdraw(
        res.locals.token as string,
        req.params.id as string,
      ))
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Proposal not withdrawn",
            "Confirm withdrawal and check the current state.",
          ),
        );
      return;
    }
    res.redirect(303, `/contribute/${req.params.id}`);
  });
  app.get("/library", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const goal =
      typeof req.query.goal === "string" ? req.query.goal : undefined;
    const background =
      typeof req.query.background === "string"
        ? req.query.background
        : undefined;
    const domain =
      typeof req.query.domain === "string" ? req.query.domain : undefined;
    res.send(
      libraryPage(await catalog.search({ q, goal, background, domain }), {
        q,
        goal,
        background,
        domain,
      }),
    );
  });
  app.get("/library/:id", async (req, res) => {
    const item = await catalog.published(req.params.id as string);
    if (!item) {
      res
        .status(404)
        .send(
          errorPage(
            "Content unavailable",
            "Only published versions appear in the learning library.",
          ),
        );
      return;
    }
    res.send(contentPreview(item, false));
  });
  app.get("/editor/library", async (_req, res) => {
    res.send(
      staffLibraryPage(
        await catalog.staffList(res.locals.token as string),
        res.locals.csrf as string,
      ),
    );
  });
  app.get("/editor/library/:id/:version", async (req, res) => {
    const item = await catalog.preview(
      res.locals.token as string,
      req.params.id as string,
      Number(req.params.version),
    );
    if (!item) {
      res
        .status(403)
        .send(
          errorPage(
            "Staff preview unavailable",
            "A current editor or reviewer identity is required.",
          ),
        );
      return;
    }
    res.send(contentPreview(item, true, res.locals.csrf as string));
  });
  app.post("/editor/library", async (req, res) => {
    const fields = req.body as Fields;
    const value = (name: string) =>
      typeof fields[name] === "string" ? (fields[name] as string) : "";
    const draft: DraftContent = {
      id: value("id"),
      version: Number(value("version")),
      kind: value("kind") as DraftContent["kind"],
      origin: "curated",
      title: value("title"),
      body: value("body"),
      owner: value("owner"),
      sources: value("sources"),
      rights: value("rights"),
      goals: [],
      backgrounds: [],
      domains: [],
      prerequisites: "",
      rubric: null,
      rubricVersion: null,
    };
    if (!(await catalog.createDraft(res.locals.token as string, draft))) {
      res
        .status(422)
        .send(
          errorPage(
            "Draft not saved",
            "Check the fields, next version and editor access.",
          ),
        );
      return;
    }
    res.redirect(303, `/editor/library/${draft.id}/${draft.version}`);
  });
  app.post("/editor/library/:id/:version/:action", async (req, res) => {
    const credential = res.locals.token as string;
    const id = req.params.id as string;
    const version = Number(req.params.version);
    const action = req.params.action;
    const changed =
      action === "submit"
        ? await catalog.submit(credential, id, version)
        : action === "approve"
          ? await catalog.approve(
              credential,
              id,
              version,
              req.body.rights_confirmed === "yes",
            )
          : action === "publish"
            ? await catalog.publish(credential, id, version)
            : false;
    if (!changed) {
      res
        .status(409)
        .send(
          errorPage(
            "Content state unchanged",
            "Check your staff role and the current review state.",
          ),
        );
      return;
    }
    res.redirect(303, `/editor/library/${id}/${version}`);
  });
  app.post("/editor/library/:id/retire", async (req, res) => {
    if (
      !(await catalog.retire(
        res.locals.token as string,
        req.params.id as string,
      ))
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Content state unchanged",
            "Only a published version can be retired by an editor.",
          ),
        );
      return;
    }
    res.redirect(303, "/editor/library");
  });
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
  app.post("/profile", async (req, res) => {
    const member = res.locals.learner as Learner;
    const input = profile({ ...(req.body as Fields), synthetic: "yes" });
    if (!input) {
      res
        .status(422)
        .send(
          dashboard(
            member,
            await store.progress(member.id),
            res.locals.csrf as string,
            [
              "Choose valid profile, time zone and weekly time options before saving.",
            ],
          ),
        );
      return;
    }
    await store.updateProfile(member.id, input);
    res.redirect(303, "/learn");
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
    await evidence.removeWorkspace(res.locals.token as string);
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
  const failure: ErrorRequestHandler = (error, _req, res, _next) => {
    if ((error as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: "invalid_evidence" });
      return;
    }
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
